import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Cache, Pool, readLimited } from "./cache.js";
import { webUrl } from "./model.js";
import { Fetcher, UPSTREAM_HEADERS } from "./providers.js";

export interface MediaInfo {
  reachable: boolean;
  width?: number;
  height?: number;
  bitrate?: number;
  videoCodec?: string;
  audioCodec?: string;
  channelLayout?: string;
}
export type MediaProbe = (url: string, timeoutMs: number) => Promise<Partial<MediaInfo>>;
const run = promisify(execFile);
const SAMPLE_BYTES = 1024;

function positive(input: unknown): number | undefined {
  const n = Number(input);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export const probeMedia: MediaProbe = async (url, timeoutMs) => {
  const { stdout } = await run("ffprobe", ["-v", "error", "-protocol_whitelist", "http,https,tcp,tls,crypto",
    "-rw_timeout", "2000000", "-user_agent", UPSTREAM_HEADERS["User-Agent"],
    "-analyzeduration", "1000000", "-probesize", "262144", "-show_entries",
    "stream=codec_type,codec_name,width,height,channel_layout:format=format_name,bit_rate", "-of", "json", url],
  { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 256 * 1024, windowsHide: true });
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
    channelLayout: typeof audio?.channel_layout === "string" ? audio.channel_layout : undefined };
}

interface Playlist {
  next?: string;
  segment?: string;
  width?: number;
  height?: number;
  bitrate?: number;
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
    if (next) variants.push({ next, width: positive(dimensions?.[1]), height: positive(dimensions?.[2]), bitrate: positive(rate?.[1]) });
  }
  if (variants.length) return variants.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0))[0];
  const path = lines.find(line => line && !line.startsWith("#"));
  return { segment: path ? webUrl(new URL(path, base).href) : undefined };
}

export class MediaInspector {
  private cache = new Cache<MediaInfo>(512);
  private pool = new Pool(8);
  constructor(private fetcher: Fetcher = fetch, private probe: MediaProbe = probeMedia, private timeoutMs = 6500) {}

  inspect(url: string): Promise<MediaInfo> {
    return this.cache.get(url, 5 * 60_000, () => {
      const deadline = Date.now() + this.timeoutMs;
      const signal = AbortSignal.timeout(this.timeoutMs);
      return this.pool.run(async () => {
        const declared: MediaInfo = { reachable: false };
        const timeout = deadline - Date.now();
        if (timeout < 1) return declared;
        const [, probed] = await Promise.allSettled([
          this.inspectPlaylist(url, declared, signal), this.probe(url, timeout)
        ]);
        const detected = probed.status === "fulfilled" ? probed.value : {};
        // Prefer codec-detected dimensions to sometimes inaccurate playlist labels.
        return { ...declared, ...Object.fromEntries(Object.entries(detected).filter(([, v]) => v !== undefined)),
          reachable: declared.reachable || detected.reachable === true };
      });
    });
  }

  private async inspectPlaylist(url: string, info: MediaInfo, signal: AbortSignal): Promise<void> {
    let segment: string | undefined;
    for (let depth = 0; depth < 4; depth++) {
      const response = await this.fetcher(url, { headers: { "User-Agent": UPSTREAM_HEADERS["User-Agent"] }, signal });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Media HTTP ${response.status}`); }
      const hls = /\.m3u8$/i.test(new URL(url).pathname);
      if (!hls) {
        await response.body?.cancel(); segment = url; break;
      }
      const text = await readLimited(response, 1024 * 1024);
      if (!text.trimStart().startsWith("#EXTM3U")) throw new Error("Invalid HLS playlist");
      info.reachable = true;
      const playlist = parsePlaylist(text, response.url || url);
      for (const field of ["width", "height", "bitrate"] as const) if (playlist[field]) info[field] = playlist[field];
      if (playlist.next) { url = playlist.next; continue; }
      segment = playlist.segment; break;
    }
    if (!segment) return;
    const response = await this.fetcher(segment, { signal, headers: { "User-Agent": UPSTREAM_HEADERS["User-Agent"],
      Range: `bytes=0-${SAMPLE_BYTES - 1}`, "Accept-Encoding": "identity" } });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Media HTTP ${response.status}`); }
    const reader = response.body?.getReader();
    if (!reader) return;
    let bytes = 0;
    try {
      while (bytes < SAMPLE_BYTES) {
        const chunk = await reader.read();
        if (chunk.done) break;
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
