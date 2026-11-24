import { createHmac, timingSafeEqual } from "node:crypto";
import { Pool } from "./cache.js";
import { workCount } from "./loading.js";
import { PlaylistFetcher, playlistHeaders, type PlaylistSnapshot } from "./playlist-fetch.js";
import { CACHE_BYTES, identity, requestHeaders, ResultCache, SharedJobs, urlLifetime } from "./shared-jobs.js";
import { webUrl } from "./model.js";
import { probeSegmentClock, SegmentClock, SegmentProbe } from "./media.js";
import type { Fetcher } from "./providers.js";

const injectedAd = "# ppvod-ad-injected v1";
const discontinuity = "#EXT-X-DISCONTINUITY";

function playlistLines(body: string): string[] {
  const lines = body.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines[0] !== "#EXTM3U") throw new Error("Upstream did not return an HLS playlist");
  return lines;
}

function canSplice(lines: string[]): boolean {
  return lines.includes("#EXT-X-ENDLIST") && !lines.some(line =>
    /^#EXT-X-(KEY|SESSION-KEY|MAP|BYTERANGE|PROGRAM-DATE-TIME|DATERANGE|DISCONTINUITY-SEQUENCE|I-FRAMES-ONLY|GAP|SKIP|DEFINE|PART|PRELOAD-HINT)(:|$)/.test(line));
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

function removalPlan(blocks: Block[], source: string, clockBreaks: ReadonlySet<number> = new Set()): [number, number][] {
  return blocks.filter(block => clockBreaks.has(block.start) || explicitAd(block, source))
    .map(block => [block.start - Number(block.marked), block.end]);
}

function renderPlaylist(lines: string[], source: string, playlistUrl: (url: string) => string, removals: [number, number][]): string {
  const removed = new Set<number>();
  for (const [start, end] of removals) for (let i = start; i <= end; i++) removed.add(i);
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

export function rewritePlaylist(body: string, source: string, playlistUrl: (url: string) => string, clockBreaks = new Set<number>()): string {
  const lines = playlistLines(body);
  return renderPlaylist(lines, source, playlistUrl, canSplice(lines) ? removalPlan(blocks(lines), source, clockBreaks) : []);
}

interface Analysis { status: "completed" | "partial" | "failed"; removals: [number, number][]; reuseUntil?: number }
interface HlsOptions { playlists?: PlaylistFetcher; ttlMs?: number; cacheBytes?: number }

export class HlsPlaylists {
  private key: Buffer;
  private probes = new Pool(4);
  private analysis = new SharedJobs<Analysis>("hls.analysis", 32);
  private progress = new Map<string, Set<number>>();
  private clocks = new SharedJobs<SegmentClock>("hls.clock", 64);
  private results: ResultCache<Analysis>;
  private playlists: PlaylistFetcher;
  private ttlMs: number;

  constructor(key: string, fetcher: Fetcher = fetch, private probe: SegmentProbe = (url, timeout, signal) =>
    probeSegmentClock(url, timeout, fetcher, undefined, signal), options: HlsOptions = {}) {
    if (!/^[a-f0-9]{64}$/i.test(key.trim())) throw new Error("MIST_ENCRYPTION_KEY must contain 64 hexadecimal characters (32 bytes)");
    this.key = Buffer.from(key.trim(), "hex");
    this.playlists = options.playlists ?? new PlaylistFetcher(fetcher);
    this.results = new ResultCache(512, options.cacheBytes ?? CACHE_BYTES / 2);
    this.ttlMs = options.ttlMs ?? 30_000;
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

  async read(source: string, installation: string, origin: string, caller?: AbortSignal): Promise<string> {
    const deadline = Date.now() + 8000;
    const budget = AbortSignal.timeout(8000);
    const signal = caller ? AbortSignal.any([budget, caller]) : budget;
    const snapshot = await this.playlists.read(source, signal, "hls.http");
    const lines = playlistLines(snapshot.body);
    const supported = canSplice(lines) && lines.some(line => line.startsWith("#EXTINF:"));
    const removals = !supported ? [] : Date.now() < deadline
      ? await this.analyze(source, snapshot, lines, signal) : removalPlan(blocks(lines), snapshot.base);
    caller?.throwIfAborted();
    return renderPlaylist(lines, snapshot.base, child => this.url(child, installation, origin), removals);
  }

  private async analyze(source: string, snapshot: PlaylistSnapshot, lines: string[], signal: AbortSignal): Promise<[number, number][]> {
    const key = identity("clock-splice-v1", source, snapshot.base, snapshot.hash, requestHeaders(playlistHeaders), this.playlists.context);
    const cached = this.results.get(key);
    if (cached) { workCount("hls.analysisHits"); return cached.removals; }
    workCount("hls.analysisMisses");
    try {
      const analysis = await this.analysis.run(key, 8000, async job => {
        const breaks = new Set<number>();
        this.progress.set(key, breaks);
        try {
          const result = await this.detectClockBreaks(lines, snapshot.base, job, breaks);
          workCount(`hls.analysis.${result.status}`);
          if (result.status === "completed" && !job.aborted) {
            let ttl = urlLifetime(source, urlLifetime(snapshot.base, this.ttlMs));
            for (const line of lines) if (ttl && !line.startsWith("#")) ttl = urlLifetime(new URL(line, snapshot.base).href, ttl);
            this.results.set(key, result, Math.min(ttl, (result.reuseUntil ?? Infinity) - Date.now()));
          }
          return result;
        } finally { this.progress.delete(key); }
      }, signal);
      return analysis.removals;
    } catch {
      return removalPlan(blocks(lines), snapshot.base, this.progress.get(key));
    }
  }

  private async detectClockBreaks(lines: string[], source: string, signal: AbortSignal, breaks: Set<number>): Promise<Analysis> {
    const deadline = Date.now() + 8000;
    let failed = false, verified = false, reuseUntil = Infinity;
    const clocks = new Map<string, Promise<SegmentClock | undefined>>();
    const clock = (uri: string) => {
      const url = new URL(uri, source).href;
      if (!clocks.has(url)) {
        // Stateful playlists with byte ranges or keys never reach this path.
        const key = identity("segment-clock-v1", url, requestHeaders(playlistHeaders), this.playlists.context);
        clocks.set(url, this.clocks.run(key, 8000, job => this.probes.run(() => this.probe(url, 8000, job), job),
          signal).then(value => {
          if (!Number.isFinite(value?.start) || !Number.isFinite(value?.end) || value.end <= value.start) throw new Error("Invalid segment clock");
          verified = true;
          reuseUntil = Math.min(reuseUntil, value.reuseUntil ?? Infinity);
          return value;
        }).catch(() => { failed = true; return undefined; }));
      }
      return clocks.get(url)!;
    };
    const spliceBlocks = blocks(lines);
    const candidates = spliceBlocks.filter(block => block.duration <= 120 && !explicitAd(block, source));
    // Find the adjacent program segments without scanning the entire prefix for each block.
    const segments = lines.flatMap((line, index) => line.startsWith("#") ? [] : [index]);
    let position = 0;
    const adjacent = candidates.map(block => {
      while (segments[position] < block.start - Number(block.marked)) position++;
      const before = lines[segments[position - 1]];
      while (segments[position] <= block.end) position++;
      return { block, before, after: lines[segments[position]] };
    });
    for (let start = 0; start < adjacent.length; start += 16) {
      if (signal.aborted || Date.now() >= deadline) { failed = true; break; }
      await Promise.all(adjacent.slice(start, start + 16).map(async ({ block, before, after }) => {
        if (!before || !after) { failed = true; return; }
        const first = await clock(block.segments[0]);
        if (!first || !(first.start >= 0 && first.start <= 2)) return;
        const [previous, last, next] = await Promise.all([before, block.segments.at(-1)!, after].map(clock));
        if (previous && last && next && last.end < previous.end &&
          Math.abs(last.end - first.start - block.duration) <= 0.1 && Math.abs(next.start - previous.end) <= 0.1) breaks.add(block.start);
      }));
    }
    return { status: failed ? (verified ? "partial" : "failed") : "completed",
      removals: removalPlan(spliceBlocks, source, breaks), reuseUntil: Number.isFinite(reuseUntil) ? reuseUntil : undefined };
  }
}
