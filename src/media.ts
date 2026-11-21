import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Cache, Pool, readBytes, readLimited } from "./cache.js";
import { subtitleLanguages, webUrl } from "./model.js";
import { Fetcher, UPSTREAM_HEADERS } from "./providers.js";
import { count, duration, timed } from "./loading.js";

export interface MediaInfo {
  reachable: boolean;
  width?: number;
  height?: number;
  bitrate?: number;
  videoCodec?: string;
  audioCodec?: string;
  channelLayout?: string;
  subtitles?: string;
}
export type MediaProbe = (url: string, timeoutMs: number) => Promise<Partial<MediaInfo>>;
export interface SegmentClock { start: number; end: number }
export type SegmentProbe = (url: string, timeoutMs: number) => Promise<SegmentClock>;
const run = promisify(execFile);
const SAMPLE_BYTES = 1024;

export const probeSegmentClock = async (url: string, timeoutMs: number, fetcher: Fetcher = fetch): Promise<SegmentClock> => {
  const deadline = Date.now() + timeoutMs;
  const response = await fetcher(url, { headers: { "User-Agent": UPSTREAM_HEADERS["User-Agent"] }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Segment HTTP ${response.status}`); }
  const bytes = await readBytes(response, 4 * 1024 * 1024);
  const pending = run("ffprobe", ["-v", "error", "-protocol_whitelist", "pipe", "-select_streams", "v:0",
    "-show_entries", "packet=dts_time,duration_time", "-of", "json", "pipe:0"],
  { timeout: Math.max(1, deadline - Date.now()), killSignal: "SIGKILL", maxBuffer: 256 * 1024, windowsHide: true });
  pending.child.stdin?.on("error", () => { /* The process result reports failed probes. */ });
  pending.child.stdin?.end(bytes);
  const { stdout } = await pending;
  const packets = JSON.parse(stdout).packets;
  const start = Number(packets?.[0]?.dts_time), last = Number(packets?.at(-1)?.dts_time);
  const duration = Number(packets?.at(-1)?.duration_time), end = last + duration;
  if (![start, last, duration].every(Number.isFinite) || duration <= 0 || end <= start) throw new Error("Invalid segment clock");
  return { start, end };
};

function positive(input: unknown): number | undefined {
  const n = Number(input);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function availabilityLifetime(input: string, maximum: number): number {
  const url = new URL(input);
  const expiries = [...url.searchParams].filter(([key]) => /^(exp|expires|expiry|expire|e)$/i.test(key));
  // Cache inspection facts about this exact URL, never a newly generated playback URL.
  if (!expiries.length) return maximum;
  for (const [, raw] of expiries) {
    const expiry = Number(raw);
    if (!Number.isFinite(expiry)) return 0;
    maximum = Math.min(maximum, (expiry < 1e12 ? expiry * 1000 : expiry) - Date.now() - 5000);
  }
  return Math.max(0, maximum);
}

export const probeMedia = async (url: string, timeoutMs: number, proxy?: string): Promise<Partial<MediaInfo>> => {
  const { stdout } = await run("ffprobe", ["-v", "error", "-protocol_whitelist", "http,https,tcp,tls,crypto,httpproxy",
    ...(proxy ? ["-http_proxy", proxy] : []),
    "-rw_timeout", String(timeoutMs * 1000), "-user_agent", UPSTREAM_HEADERS["User-Agent"],
    "-analyzeduration", "1000000", "-probesize", "262144", "-show_entries",
    "stream=codec_type,codec_name,width,height,channel_layout:stream_tags=language:format=format_name,bit_rate", "-of", "json", url],
  { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 256 * 1024, windowsHide: true,
    env: proxy ? { ...process.env, no_proxy: "", NO_PROXY: "" } : process.env });
  return parseProbe(JSON.parse(stdout), url);
};

export function parseProbe(data: any, url: string): Partial<MediaInfo> {
  const hls = /\.m3u8$/i.test(new URL(url).pathname) || /(?:^|,)(hls|applehttp)(?:,|$)/.test(data.format?.format_name || "");
  const video = data.streams?.filter((s: any) => s.codec_type === "video")
    .sort((a: any, b: any) => (Number(b.height) || 0) - (Number(a.height) || 0))[0];
  const audio = data.streams?.find((s: any) => s.codec_type === "audio");
  const codec = (name: unknown): string | undefined => typeof name === "string" && /^[a-z0-9_]+$/i.test(name) ? name : undefined;
  return { reachable: Boolean(video), width: positive(video?.width), height: positive(video?.height),
    // HLS format.bit_rate can be computed from playlist text size, not media size.
    bitrate: hls ? undefined : positive(data.format?.bit_rate), videoCodec: codec(video?.codec_name), audioCodec: codec(audio?.codec_name),
    subtitles: subtitleLanguages((Array.isArray(data.streams) ? data.streams : [])
      .filter((stream: any) => stream?.codec_type === "subtitle").map((stream: any) => stream.tags?.language)),
    channelLayout: typeof audio?.channel_layout === "string" ? audio.channel_layout : undefined };
}

interface Playlist {
  next?: string;
  segment?: string;
  range?: string;
  width?: number;
  height?: number;
  bitrate?: number;
  subtitles?: string;
}

export function parsePlaylist(text: string, base: string): Playlist {
  const lines = text.split(/\r?\n/).map(line => line.trim());
  const variants: Playlist[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF:")) continue;
    const dimensions = lines[i].match(/(?:[:,])RESOLUTION=(\d+)x(\d+)/i);
    const rate = lines[i].match(/(?:[:,])AVERAGE-BANDWIDTH=(\d+)/i) || lines[i].match(/(?:[:,])BANDWIDTH=(\d+)/i);
    const path = lines.slice(i + 1).find(line => line && !line.startsWith("#"));
    const next = path && webUrl(new URL(path, base).href);
    const group = lines[i].match(/(?:[:,])SUBTITLES="([^"]+)"/)?.[1];
    const subtitles = subtitleLanguages(lines.filter(line => line.startsWith("#EXT-X-MEDIA:") && /(?:[:,])TYPE=SUBTITLES(?:,|$)/.test(line) &&
      line.match(/(?:[:,])GROUP-ID="([^"]+)"/)?.[1] === group).map(line => line.match(/(?:[:,])LANGUAGE="([^"]+)"/)?.[1]));
    if (next) variants.push({ next, width: positive(dimensions?.[1]), height: positive(dimensions?.[2]), bitrate: positive(rate?.[1]),
      ...(subtitles ? { subtitles } : {}) });
  }
  if (variants.length) return variants.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0))[0];
  const first = lines.findIndex(line => line && !line.startsWith("#")), path = lines[first];
  const byteRange = lines.slice(0, first).reverse().find(line => line.startsWith("#EXT-X-BYTERANGE:"));
  let range: string | undefined;
  if (byteRange) {
    const match = byteRange.match(/^#EXT-X-BYTERANGE:(\d+)@(\d+)$/);
    const length = Number(match?.[1]), start = Number(match?.[2]), end = start + Math.min(length, SAMPLE_BYTES) - 1;
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length < 1 || !Number.isSafeInteger(end)) {
      throw new Error("Invalid HLS byte range");
    }
    range = `bytes=${start}-${end}`;
  }
  return { segment: path ? webUrl(new URL(path, base).href) : undefined, ...(range ? { range } : {}) };
}

export class MediaInspector {
  private cache = new Cache<MediaInfo>(512);
  private recent = new Cache<MediaInfo>(512);
  private verified = new Cache<{ facts: Partial<MediaInfo>; expires: number }>(512);
  private pool = new Pool(8);
  constructor(private fetcher: Fetcher = fetch, private probe: MediaProbe = probeMedia, private timeoutMs = 6500) {}

  inspect(url: string, timeoutMs = this.timeoutMs): Promise<MediaInfo> {
    const recent = this.recent.peek(url);
    if (recent) { count("media.resultHits"); return recent; }
    const key = JSON.stringify([url, timeoutMs, Boolean(this.verified.peek(url))]);
    return this.cache.get(key, result => result.reachable ? 0 : 5000, () => {
      const queued = performance.now(), queueSignal = AbortSignal.timeout(30_000);
      return this.pool.run(async () => {
        duration("media.queue", performance.now() - queued);
        const started = performance.now();
        const recent = this.recent.peek(url);
        if (recent) { count("media.resultHits"); return recent; }
        // Queue time must not consume the installation's media inspection window.
        const signal = AbortSignal.timeout(timeoutMs);
        const declared: MediaInfo = { reachable: false };
        const entry = await this.verified.peek(url), known = entry?.facts;
        if (known) count("media.factHits");
        const [playlist, probed] = await Promise.allSettled([
          this.inspectPlaylist(url, declared, signal, Boolean(known)),
          known ? Promise.resolve(known) : timed("media.probe", () => this.probe(url, timeoutMs))
        ]);
        const detected = probed.status === "fulfilled" ? probed.value : {};
        const subtitles = new Set([declared.subtitles, detected.subtitles].filter(Boolean));
        // Prefer codec-detected dimensions to sometimes inaccurate playlist labels.
        const result = { ...declared, ...Object.fromEntries(Object.entries(detected).filter(([, v]) => v !== undefined)),
          subtitles: subtitles.size > 1 ? "Multiple" : [...subtitles][0],
          reachable: declared.reachable || detected.reachable === true };
        if (detected.height && detected.videoCodec) {
          if (!known) {
            const { reachable, ...facts } = detected;
            this.verified.set(url, { facts, expires: Date.now() + 5 * 60_000 }, 5 * 60_000);
          }
          if (playlist.status === "fulfilled" && result.reachable) this.recent.set(url, result,
            Math.min(playlist.value, availabilityLifetime(url, 30_000), entry ? entry.expires - Date.now() : 5 * 60_000));
        }
        duration("media.active", performance.now() - started);
        return result;
      }, queueSignal).catch(error => {
        if (error !== queueSignal.reason) throw error;
        duration("media.queue", performance.now() - queued, true);
        count("media.queueTimeouts");
        return { reachable: false };
      });
    });
  }

  private async inspectPlaylist(url: string, info: MediaInfo, signal: AbortSignal, checkMedia: boolean): Promise<number> {
    let segment: string | undefined, range: string | undefined;
    let lifetime = availabilityLifetime(url, 30_000);
    if (!/\.m3u8$/i.test(new URL(url).pathname)) {
      if (checkMedia) await this.checkMedia(url, info, signal);
      return lifetime;
    }
    for (let depth = 0; depth < 4; depth++) {
      const response = await timed("media.http", () => this.fetcher(url, { headers: { "User-Agent": UPSTREAM_HEADERS["User-Agent"] }, signal }));
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Media HTTP ${response.status}`); }
      lifetime = Math.min(lifetime, availabilityLifetime(response.url || url, 30_000));
      const text = await readLimited(response, 1024 * 1024);
      if (!text.trimStart().startsWith("#EXTM3U")) throw new Error("Invalid HLS playlist");
      const playlist = parsePlaylist(text, response.url || url);
      for (const field of ["width", "height", "bitrate"] as const) if (playlist[field]) info[field] = playlist[field];
      if (playlist.subtitles) info.subtitles = playlist.subtitles;
      if (playlist.next) { url = playlist.next; continue; }
      segment = playlist.segment; range = playlist.range; break;
    }
    if (!segment) return 0;
    lifetime = Math.min(lifetime, availabilityLifetime(segment, 30_000));
    if (checkMedia) await this.checkMedia(segment, info, signal, range);
    return lifetime;
  }

  private async checkMedia(url: string, info: MediaInfo, signal: AbortSignal, range = `bytes=0-${SAMPLE_BYTES - 1}`): Promise<void> {
    const response = await timed("media.http", () => this.fetcher(url, { signal, headers: { "User-Agent": UPSTREAM_HEADERS["User-Agent"],
      Range: range, "Accept-Encoding": "identity" } }));
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Media HTTP ${response.status}`); }
    const reader = response.body?.getReader();
    if (!reader) return;
    let bytes = 0;
    try {
      while (bytes < SAMPLE_BYTES) {
        const chunk = await reader.read();
        if (chunk.done) break;
        count("bodyBytesRead", chunk.value.length);
        if (!bytes && /^\s*[<{]/.test(Buffer.from(chunk.value).toString("utf8", 0, 40))) return;
        bytes += Math.min(chunk.value.length, SAMPLE_BYTES - bytes);
      }
    } finally { await reader.cancel(); }
    if (bytes) info.reachable = true;
  }
}

export function codecTags(info: MediaInfo): string[] {
  const video: Record<string, string> = { h264: "H.264", hevc: "HEVC", av1: "AV1", vp9: "VP9", mpeg4: "MPEG4" };
  const audio: Record<string, string> = { aac: "AAC", ac3: "AC3", eac3: "EAC3", dts: "DTS", truehd: "TrueHD", flac: "FLAC", opus: "OPUS" };
  const layout = info.channelLayout;
  const channels = layout === "stereo" ? "2.0" : layout === "mono" ? "1.0" : layout?.match(/^[567]\.1/)?.[0];
  return [video[info.videoCodec || ""], audio[info.audioCodec || ""], channels].filter((v): v is string => Boolean(v));
}
