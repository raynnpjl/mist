import { createHmac, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Pool, readLimited } from "./cache.js";
import { webUrl } from "./model.js";
import { probeSegmentClock, SegmentClock, SegmentProbe } from "./media.js";
import { Fetcher, UPSTREAM_HEADERS } from "./providers.js";

const injectedAd = "# ppvod-ad-injected v1";
const discontinuity = "#EXT-X-DISCONTINUITY";

function playlistLines(body: string): string[] {
  const lines = body.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines[0] !== "#EXTM3U") throw new Error("Upstream did not return an HLS playlist");
  return lines;
}

function canSplice(lines: string[]): boolean {
  return lines.includes("#EXT-X-ENDLIST") && !lines.some(line =>
    /^#EXT-X-(KEY|MAP|BYTERANGE|PROGRAM-DATE-TIME|DATERANGE|DISCONTINUITY-SEQUENCE|I-FRAMES-ONLY)(:|$)/.test(line));
}

interface Block { start: number; end: number; duration: number; segments: string[]; marked: boolean }

function blocks(lines: string[]): Block[] {
  const boundaries = lines.flatMap((line, index) => line === discontinuity ? [index] : []);
  return boundaries.slice(0, -1).flatMap((start, index) => {
    const end = boundaries[index + 1], block = lines.slice(start + 1, end);
    const complete = block.length > 0 && block.length % 2 === 0 && block.every((line, i) =>
      i % 2 === 0 ? /^#EXTINF:\d+(?:\.\d+)?,/.test(line) && Number(line.slice(8).split(",")[0]) > 0 : !line.startsWith("#"));
    if (!complete) return [];
    return [{ start, end, duration: block.reduce((sum, line, i) => sum + (i % 2 === 0 ? Number(line.slice(8).split(",")[0]) : 0), 0),
      segments: block.filter((_line, i) => i % 2 === 1), marked: lines[start - 1] === injectedAd }];
  });
}

function explicitAd(block: Block, source: string): boolean {
  const directory = (uri: string) => new URL(".", new URL(uri, source)).href;
  const adDirectory = directory(block.segments[0]);
  return adDirectory !== directory(source) && block.segments.every(uri => directory(uri) === adDirectory) &&
    (block.marked || block.segments.every(uri => /^\/video\/adjump\/time\/\d+\.ts$/.test(new URL(uri, source).pathname)));
}

export function rewritePlaylist(body: string, source: string, playlistUrl: (url: string) => string, clockBreaks = new Set<number>()): string {
  const lines = playlistLines(body), removed = new Set<number>();
  if (canSplice(lines)) for (const block of blocks(lines)) {
    if (!explicitAd(block, source) && !clockBreaks.has(block.start)) continue;
    for (let i = block.start - Number(block.marked); i <= block.end; i++) removed.add(i);
  }
  const kept = lines.filter((_line, index) => !removed.has(index));
  let variant = false;
  return kept.map(line => {
    if (!line.startsWith("#")) {
      const absolute = new URL(line, source).href;
      const result = variant ? playlistUrl(absolute) : absolute;
      variant = false;
      return result;
    }
    if (line.startsWith("#EXT-X-STREAM-INF:")) variant = true;
    const child = /^#EXT-X-(MEDIA|I-FRAME-STREAM-INF|RENDITION-REPORT):/.test(line);
    return line.replace(/URI="([^"]+)"/g, (_match, uri: string) => {
      const absolute = new URL(uri, source).href;
      return `URI="${child ? playlistUrl(absolute) : absolute}"`;
    });
  }).join("\n") + "\n";
}

export class HlsPlaylists {
  private key: Buffer;
  private probes = new Pool(4);

  constructor(key: string, private fetcher: Fetcher = fetch, private probe: SegmentProbe = probeSegmentClock) {
    if (!/^[a-f0-9]{64}$/i.test(key.trim())) throw new Error("MIST_ENCRYPTION_KEY must contain 64 hexadecimal characters (32 bytes)");
    this.key = Buffer.from(key.trim(), "hex");
  }

  private signature(payload: string, installation: string): Buffer {
    return createHmac("sha256", this.key).update(`mist:hls:v1\0${installation}\0${payload}`).digest();
  }

  url(source: string, installation: string, origin: string): string {
    if (!webUrl(source)) throw new Error("Invalid playlist URL");
    const payload = Buffer.from(source).toString("base64url");
    return `${origin}/${installation}/hls/${payload}.${this.signature(payload, installation).toString("base64url")}.m3u8`;
  }

  source(token: string, installation: string): string | undefined {
    if (token.length > 8192) return;
    const match = token.match(/^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/);
    if (!match) return;
    const [, payload, signature] = match;
    const bytes = Buffer.from(signature, "base64url");
    const expected = this.signature(payload, installation);
    if (bytes.length !== expected.length || !timingSafeEqual(bytes, expected)) return;
    return webUrl(Buffer.from(payload, "base64url").toString("utf8"));
  }

  async read(source: string, installation: string, origin: string): Promise<string> {
    const deadline = Date.now() + 8000;
    const response = await this.fetcher(source, { headers: { "User-Agent": UPSTREAM_HEADERS["User-Agent"] }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) {
      await response.body?.cancel();
      // Temporary preview probe: compare clients from the same deployment.
      if (response.status === 404) {
        let curl = "failed";
        try {
          const { stdout } = await promisify(execFile)("curl", ["--disable", "--silent", "--location", "--compressed",
            "--proto", "=http,https", "--proto-redir", "=http,https", "--max-time", "4", "--max-filesize", "1048576",
            "--user-agent", UPSTREAM_HEADERS["User-Agent"], "--output", "/dev/null", "--write-out", "%{http_code} HTTP/%{http_version}", "--url", source],
          { timeout: 4500, killSignal: "SIGKILL", maxBuffer: 1024, windowsHide: true });
          curl = stdout.trim();
        } catch { /* Log only the outcome, never the private source URL. */ }
        console.warn("[Mist HLS] CDN client comparison", { host: new URL(source).hostname, node: response.status, curl });
      }
      throw new Error(`Playlist HTTP ${response.status}`);
    }
    const body = await readLimited(response, 1024 * 1024);
    const base = response.url || source;
    const detected = await this.detectClockBreaks(body, base, deadline);
    return rewritePlaylist(body, base, child => this.url(child, installation, origin), detected);
  }

  private async detectClockBreaks(body: string, source: string, deadline: number): Promise<Set<number>> {
    const lines = playlistLines(body), detected = new Set<number>();
    if (!canSplice(lines)) return detected;
    const clocks = new Map<string, Promise<SegmentClock | undefined>>();
    const clock = (uri: string) => {
      const url = new URL(uri, source).href;
      if (!clocks.has(url)) clocks.set(url, this.probes.run(async () => {
        const timeout = deadline - Date.now();
        return timeout > 0 ? this.probe(url, timeout) : undefined;
      }).catch(() => undefined));
      return clocks.get(url)!;
    };
    await Promise.all(blocks(lines).filter(block => block.duration <= 120 && !explicitAd(block, source)).map(async block => {
      const before = lines.slice(0, block.start - Number(block.marked)).reverse().find(line => !line.startsWith("#"));
      const after = lines.slice(block.end + 1).find(line => !line.startsWith("#"));
      if (!before || !after) return;
      const [previous, first, last, next] = await Promise.all([before, block.segments[0], block.segments.at(-1)!, after].map(clock));
      if (previous && first && last && next && first.start >= 0 && first.start <= 2 && last.end < previous.end &&
        Math.abs(last.end - first.start - block.duration) <= 0.1 && Math.abs(next.start - previous.end) <= 0.1) detected.add(block.start);
    }));
    return detected;
  }
}
