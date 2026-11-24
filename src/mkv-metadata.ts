import { readBytes } from "./cache.js";
import { standaloneProbeScheduler } from "./probe-scheduler.js";
import { CACHE_BYTES, identity, requestHeaders, ResultCache, SharedJobs, urlLifetime } from "./shared-jobs.js";
import { discoveryKey, DiscoveryStore } from "./discovery-cache.js";
import { mkvNetwork } from "./mkv-work.js";
import { fileHost } from "./filehosts.js";
import { subtitleLanguages } from "./model.js";
import type { MkvFile } from "./mkvdrama.js";
import type { Fetcher } from "./providers.js";
import { timed, workCount } from "./loading.js";

export interface MkvMetadata { subtitles?: string; averageBitrate?: number }
type HeaderProbe = (prefix: Buffer, timeoutMs: number, signal?: AbortSignal) => Promise<any>;
const HEADER_BYTES = 128 * 1024;
const DAY = 24 * 60 * 60_000;
class InvalidPlayback extends Error {}

function metadata(value: unknown): value is MkvMetadata {
  const entry = value as MkvMetadata;
  return Boolean(entry && typeof entry === "object" && !Array.isArray(entry) &&
    Object.keys(entry).every(key => ["subtitles", "averageBitrate"].includes(key)) &&
    (entry.subtitles === undefined || typeof entry.subtitles === "string" && entry.subtitles.length <= 100) &&
    (entry.averageBitrate === undefined || Number.isFinite(entry.averageBitrate) && entry.averageBitrate > 0));
}

function stableIdentity(file: Pick<MkvFile, "url" | "filename" | "size" | "version" | "headers">, url: URL): string | undefined {
  if (!(Number.isSafeInteger(file.size) && file.size! > 0) && !file.version ||
    file.headers && Object.keys(file.headers).some(key => key !== "Referer")) return;
  let id: string | undefined;
  if (fileHost(url.hostname) === "pixeldrain") id = `pixeldrain:${url.pathname}`;
  else if (file.headers?.Referer) {
    try {
      const page = new URL(file.headers.Referer);
      if (page.origin === "https://send.now" && /^\/[a-zA-Z0-9_-]+\/?$/.test(page.pathname) && !page.search && !page.hash) id = page.href;
    } catch { /* No stable host identity: retain only the exact-URL memory entry. */ }
  }
  if (id) return JSON.stringify([id, file.filename, file.size, file.version]);
}

export const mkvHeaderProbe = (scheduler = standaloneProbeScheduler()): HeaderProbe => async (prefix, timeoutMs, signal) => {
  // FFprobe receives only the bounded prefix.
  const stdout = await scheduler.run(["-v", "error", "-max_alloc", "8388608", "-protocol_whitelist", "pipe",
    "-f", "matroska", "-probesize", String(HEADER_BYTES), "-analyzeduration", "0",
    "-show_entries", "stream=codec_type:stream_tags=language:format=duration", "-of", "json", "pipe:0"],
  { timeoutMs, input: prefix, maxOutput: 64 * 1024, signal });
  return JSON.parse(stdout);
};

export function parseMkvMetadata(data: any, size: number): MkvMetadata {
  const result: MkvMetadata = {};
  const duration = Number(data?.format?.duration);
  if (Number.isFinite(duration) && duration > 0 && Number.isSafeInteger(size) && size > 0) {
    const bitrate = size * 8 / duration;
    if (Number.isFinite(bitrate)) result.averageBitrate = bitrate;
  }
  const subtitles = subtitleLanguages((Array.isArray(data?.streams) ? data.streams : [])
    .filter((stream: any) => stream?.codec_type === "subtitle").map((stream: any) => stream.tags?.language));
  if (subtitles) result.subtitles = subtitles;
  return result;
}

export class MkvHeaderInspector {
  private cache: ResultCache<MkvMetadata>;
  private jobs = new SharedJobs<MkvMetadata>("mkv.header", 40);
  constructor(private fetcher: Fetcher = fetch, private probe: HeaderProbe = mkvHeaderProbe(), private timeoutMs = 3000,
    private store = new DiscoveryStore(), cacheBytes = CACHE_BYTES / 8) {
    this.cache = new ResultCache(512, cacheBytes);
  }

  inspect(file: Pick<MkvFile, "url" | "filename" | "headers" | "size" | "version">, invalid?: () => void, caller?: AbortSignal): Promise<MkvMetadata> {
    let url: URL;
    try { url = new URL(file.url); } catch { return Promise.resolve({}); }
    const host = fileHost(url.hostname);
    if (!/\.mkv$/i.test(file.filename) || url.protocol !== "https:" || url.username || url.password || url.port ||
      !(host === "pixeldrain" && /^\/api\/file\/[a-zA-Z0-9]+\/?$/.test(url.pathname) || host === "send" && url.pathname.startsWith("/d/"))) {
      return Promise.resolve({});
    }
    const headers = new Headers(file.headers);
    headers.set("Range", `bytes=0-${HEADER_BYTES - 1}`);
    headers.set("Accept-Encoding", "identity");
    const key = identity(file.url, file.filename, file.size, file.version, requestHeaders(headers), this.timeoutMs);
    const inspect = async (signal: AbortSignal) => {
      const deadline = Date.now() + this.timeoutMs;
      const { prefix, size } = await mkvNetwork.run(async () => {
        signal.throwIfAborted();
        const response = await timed("mkv.headerHttp", () => this.fetcher(url.href, { headers, signal, redirect: "manual" }));
        const range = response.headers.get("Content-Range")?.match(/^bytes 0-(\d+)\/(\d+)$/i);
        const end = Number(range?.[1]), size = Number(range?.[2]);
        const encoding = response.headers.get("Content-Encoding");
        const length = response.headers.get("Content-Length");
        if (response.status === 404 || response.status === 410 || response.status === 206 && file.size !== undefined && range && file.size !== size) {
          await response.body?.cancel();
          throw new InvalidPlayback("MKV file unavailable or changed");
        }
        if (response.status !== 206 || !range || !Number.isSafeInteger(end) || end < 0 || end >= HEADER_BYTES ||
          !Number.isSafeInteger(size) || size <= end || encoding && encoding.toLowerCase() !== "identity" ||
          length !== null && Number(length) !== end + 1 || file.size !== undefined && file.size !== size) {
          await response.body?.cancel();
          throw new Error("MKV host did not honor the bounded range");
        }
        const prefix = await readBytes(response, HEADER_BYTES);
        workCount("mkv.header.sampleBytes", prefix.length);
        if (prefix.length !== end + 1 || prefix.length < 4 || prefix.readUInt32BE(0) !== 0x1a45dfa3) {
          throw new Error("Invalid Matroska header prefix");
        }
        return { prefix, size };
      }, signal, true);
      signal.throwIfAborted();
      const result = parseMkvMetadata(await timed("mkv.headerProbe",
        () => this.probe(prefix, Math.max(1, deadline - Date.now()), signal)), size);
      signal.throwIfAborted();
      return result;
    };
    const stable = stableIdentity(file, url);
    const stableKey = stable ? discoveryKey("metadata", stable) : undefined;
    const cached = this.cache.get(stableKey ?? key);
    if (cached) return Promise.resolve(cached);
    const jobLifetime = this.timeoutMs + 6000;
    const waiting = caller ? AbortSignal.any([caller, AbortSignal.timeout(jobLifetime)]) : undefined;
    return this.jobs.run(key, jobLifetime, async job => {
      if (stableKey) {
        const shared = await this.store.read(stableKey, metadata, job);
        if (shared) {
          this.cache.set(stableKey, shared.value, shared.expires - Date.now());
          return shared.value;
        }
      }
      job.throwIfAborted();
      const value = await inspect(AbortSignal.any([job, AbortSignal.timeout(this.timeoutMs)]));
      if (stableKey) {
        this.cache.set(stableKey, value, DAY);
        await this.store.write(stableKey, { value, expires: Date.now() + DAY }, job);
      } else this.cache.set(key, value, urlLifetime(url.href, DAY));
      return value;
    }, waiting).catch(error => {
      if (caller?.aborted) return {};
      if (error instanceof InvalidPlayback) invalid?.();
      return {};
    });
  }
}
