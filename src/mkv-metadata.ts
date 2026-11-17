import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Cache, readBytes } from "./cache.js";
import { DiscoveryCache, DiscoveryStore } from "./discovery-cache.js";
import { mkvNetwork } from "./mkv-work.js";
import { fileHost } from "./filehosts.js";
import type { MkvFile } from "./mkvdrama.js";
import type { Fetcher } from "./providers.js";

export interface MkvMetadata { subtitles?: string; averageBitrate?: number }
type HeaderProbe = (prefix: Buffer, timeoutMs: number) => Promise<any>;
const run = promisify(execFile);
const HEADER_BYTES = 128 * 1024;
const languages = new Intl.DisplayNames(["en"], { type: "language" });
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

const probeHeader: HeaderProbe = async (prefix, timeoutMs) => {
  // FFprobe receives only the bounded prefix. It cannot open a URL or seek over the network.
  const pending = run("ffprobe", ["-v", "error", "-max_alloc", "8388608", "-protocol_whitelist", "pipe",
    "-f", "matroska", "-probesize", String(HEADER_BYTES), "-analyzeduration", "0",
    "-show_entries", "stream=codec_type:stream_tags=language:format=duration", "-of", "json", "pipe:0"],
  { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 * 1024, windowsHide: true });
  pending.child.stdin?.on("error", () => { /* The process result reports a failed or truncated probe. */ });
  pending.child.stdin?.end(prefix);
  return JSON.parse((await pending).stdout);
};

export function parseMkvMetadata(data: any, size: number): MkvMetadata {
  const result: MkvMetadata = {};
  const duration = Number(data?.format?.duration);
  if (Number.isFinite(duration) && duration > 0 && Number.isSafeInteger(size) && size > 0) {
    const bitrate = size * 8 / duration;
    if (Number.isFinite(bitrate)) result.averageBitrate = bitrate;
  }
  const names = new Set<string>();
  for (const stream of Array.isArray(data?.streams) ? data.streams : []) {
    const language = stream?.tags?.language;
    if (stream?.codec_type !== "subtitle" || typeof language !== "string") continue;
    const code = language.trim().replace(/_/g, "-").toLowerCase();
    if (code === "und" || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(code)) continue;
    try { names.add(languages.of(code) || code); } catch { /* Ignore malformed language tags. */ }
  }
  if (names.size) result.subtitles = names.size > 1 ? "Multiple" : [...names][0];
  return result;
}

export class MkvHeaderInspector {
  private cache = new Cache<MkvMetadata>(512);
  private shared: DiscoveryCache<MkvMetadata>;
  constructor(private fetcher: Fetcher = fetch, private probe: HeaderProbe = probeHeader, private timeoutMs = 3000, store = new DiscoveryStore()) {
    this.shared = new DiscoveryCache("metadata", 512, metadata, store);
  }

  inspect(file: Pick<MkvFile, "url" | "filename" | "headers" | "size" | "version">, invalid?: () => void): Promise<MkvMetadata> {
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
    const key = JSON.stringify([url.href, file.filename, file.size, file.version, [...headers].sort()]);
    const inspect = () => {
      const deadline = Date.now() + this.timeoutMs;
      const signal = AbortSignal.timeout(this.timeoutMs);
      return mkvNetwork.run(async () => {
        signal.throwIfAborted();
        const response = await this.fetcher(url.href, { headers, signal, redirect: "manual" });
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
        if (prefix.length !== end + 1 || prefix.length < 4 || prefix.readUInt32BE(0) !== 0x1a45dfa3) {
          throw new Error("Invalid Matroska header prefix");
        }
        signal.throwIfAborted();
        const result = parseMkvMetadata(await this.probe(prefix, Math.max(1, deadline - Date.now())), size);
        signal.throwIfAborted();
        return result;
      }, signal, true);
    };
    const identity = stableIdentity(file, url);
    return (identity ? this.shared.get(identity, DAY, inspect) : this.cache.get(key, DAY, inspect)).catch(error => {
      if (error instanceof InvalidPlayback) invalid?.();
      return {};
    });
  }
}
