import { createHmac, timingSafeEqual } from "node:crypto";
import { readLimited } from "./cache.js";
import { webUrl } from "./model.js";
import { Fetcher } from "./providers.js";

const injectedAd = "# ppvod-ad-injected v1";
const discontinuity = "#EXT-X-DISCONTINUITY";

export function rewritePlaylist(body: string, source: string, playlistUrl: (url: string) => string): string {
  const lines = body.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines[0] !== "#EXTM3U") throw new Error("Upstream did not return an HLS playlist");
  // These states need more than a segment splice; keep their timelines intact.
  const splice = lines.includes("#EXT-X-ENDLIST") && !lines.some(line =>
    /^#EXT-X-(KEY|MAP|BYTERANGE|PROGRAM-DATE-TIME|DATERANGE|DISCONTINUITY-SEQUENCE):/.test(line));
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (splice && lines[i] === injectedAd && lines[i + 1] === discontinuity) {
      const end = lines.indexOf(discontinuity, i + 2);
      const block = end < 0 ? [] : lines.slice(i + 2, end);
      const complete = block.length > 0 && block.length % 2 === 0 && block.every((line, index) =>
        index % 2 === 0 ? /^#EXTINF:\d+(?:\.\d+)?,/.test(line) && Number(line.slice(8).split(",")[0]) > 0 : !line.startsWith("#"));
      if (complete) { i = end; continue; }
    }
    kept.push(lines[i]);
  }
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

  constructor(key: string, private fetcher: Fetcher = fetch) {
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
    const response = await this.fetcher(source, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Playlist HTTP ${response.status}`); }
    const body = await readLimited(response, 1024 * 1024);
    return rewritePlaylist(body, response.url || source, child => this.url(child, installation, origin));
  }
}
