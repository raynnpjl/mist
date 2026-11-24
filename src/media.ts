import { Pool, readBytes } from "./cache.js";
import { type CodecHeader, mp4InitCodecHeader, tsCodecHeader } from "./codec-header.js";
import { NotPlaylist, PlaylistFetcher, playlistHeaders } from "./playlist-fetch.js";
import { standaloneProbeScheduler, ProbeError } from "./probe-scheduler.js";
import { CACHE_BYTES, identity, requestHeaders, ResultCache, SharedJobs, urlLifetime, waitFor } from "./shared-jobs.js";
import { subtitleLanguages, webUrl } from "./model.js";
import { Fetcher, UPSTREAM_HEADERS } from "./providers.js";
import { timed, workCount, workDuration } from "./loading.js";

export interface MediaInfo {
  reachable: boolean;
  width?: number;
  height?: number;
  bitrate?: number;
  videoCodec?: string;
  audioCodec?: string;
  channelLayout?: string;
  subtitles?: string;
  resolutionEvidence?: ResolutionEvidence;
}
type ProbedMedia = Partial<MediaInfo> & { hls?: true };
export type MediaProbe = (url: string, timeoutMs: number, signal?: AbortSignal) => Promise<ProbedMedia>;
export interface SegmentClock { start: number; end: number; reuseUntil?: number }
export type SegmentProbe = (url: string, timeoutMs: number, signal?: AbortSignal) => Promise<SegmentClock>;
const SAMPLE_BYTES = 1024;
const HEADER_BYTES = 64 * 1024;
const FACT_TTL = 5 * 60_000;

export const probeSegmentClock = async (url: string, timeoutMs: number, fetcher: Fetcher = fetch,
  scheduler = standaloneProbeScheduler(), caller?: AbortSignal): Promise<SegmentClock> => {
  const deadline = Date.now() + timeoutMs;
  const budget = AbortSignal.timeout(timeoutMs);
  const signal = caller ? AbortSignal.any([budget, caller]) : budget;
  const response = await fetcher(url, { headers: playlistHeaders, signal });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Segment HTTP ${response.status}`); }
  const reuseFor = urlLifetime(response.url || url, Infinity);
  const reuseUntil = Number.isFinite(reuseFor) ? Date.now() + reuseFor : undefined;
  const bytes = await readBytes(response, 4 * 1024 * 1024);
  workCount("hls.clock.sampleBytes", bytes.length);
  const stdout = await scheduler.run(["-v", "error", "-protocol_whitelist", "pipe", "-select_streams", "v:0",
    "-show_entries", "packet=dts_time,duration_time", "-of", "json", "pipe:0"],
  { timeoutMs: Math.max(1, deadline - Date.now()), input: bytes, signal, priority: "playback" });
  const packets = JSON.parse(stdout).packets;
  const start = Number(packets?.[0]?.dts_time), last = Number(packets?.at(-1)?.dts_time);
  const duration = Number(packets?.at(-1)?.duration_time), end = last + duration;
  if (![start, last, duration].every(Number.isFinite) || duration <= 0 || end <= start) throw new Error("Invalid segment clock");
  return { start, end, ...(reuseUntil === undefined ? {} : { reuseUntil }) };
};

function positive(input: unknown): number | undefined {
  const n = Number(input);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export const probeMedia = async (url: string, timeoutMs: number, proxy?: string,
  scheduler = standaloneProbeScheduler(), signal?: AbortSignal): Promise<Partial<MediaInfo>> => {
  const stdout = await scheduler.run(["-v", "error", "-protocol_whitelist", "http,https,tcp,tls,crypto,httpproxy",
    ...(proxy ? ["-http_proxy", proxy] : []),
    "-rw_timeout", String(timeoutMs * 1000), "-user_agent", UPSTREAM_HEADERS["User-Agent"],
    "-analyzeduration", "1000000", "-probesize", "262144", "-show_entries",
    "stream=codec_type,codec_name,width,height,channel_layout:stream_tags=language:format=format_name,bit_rate", "-of", "json", url],
  { timeoutMs, signal, env: proxy ? { ...process.env, no_proxy: "", NO_PROXY: "" } : process.env });
  return parseProbe(JSON.parse(stdout), url);
};

export const tsSampleProbe = (scheduler = standaloneProbeScheduler()) =>
  async (bytes: Buffer, url: string, timeoutMs: number, signal: AbortSignal): Promise<ProbedMedia> => {
    const stdout = await scheduler.run(["-v", "error", "-protocol_whitelist", "pipe", "-f", "mpegts",
      "-analyzeduration", "1000000", "-probesize", "262144", "-show_entries",
      "stream=codec_type,codec_name,width,height,channel_layout:stream_tags=language:format=format_name,bit_rate", "-of", "json", "pipe:0"],
    { timeoutMs, input: bytes, signal });
    return parseProbe(JSON.parse(stdout), url);
  };

export function parseProbe(data: any, url: string): ProbedMedia {
  const hls = /\.m3u8$/i.test(new URL(url).pathname) || /(?:^|,)(hls|applehttp)(?:,|$)/.test(data.format?.format_name || "");
  const video = data.streams?.filter((s: any) => s.codec_type === "video")
    .sort((a: any, b: any) => (Number(b.height) || 0) - (Number(a.height) || 0))[0];
  const audio = data.streams?.find((s: any) => s.codec_type === "audio");
  const codec = (name: unknown): string | undefined => typeof name === "string" && /^[a-z0-9_]+$/i.test(name) ? name : undefined;
  return { ...(hls ? { hls: true } : {}), reachable: Boolean(video), width: positive(video?.width), height: positive(video?.height),
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
  sampleRange?: ByteRange;
  init?: Sample;
  headerUnsupported?: boolean;
  encrypted?: boolean;
  separateRenditions?: boolean;
  singleSegment?: boolean;
}

interface ByteRange { start: number; length: number }
interface Sample { url: string; range?: ByteRange }

function byteRange(raw: string): ByteRange {
  const match = raw.match(/^(\d+)@(\d+)$/);
  const length = Number(match?.[1]), start = Number(match?.[2]);
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length < 1 ||
    !Number.isSafeInteger(start + length - 1)) throw new Error("Invalid HLS byte range");
  return { start, length };
}

function rangeHeader(range: ByteRange | undefined, cap: number): string {
  const start = range?.start ?? 0;
  return `bytes=${start}-${start + Math.min(range?.length ?? cap, cap) - 1}`;
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
      ...(subtitles ? { subtitles } : {}),
      ...(/(?:[:,])(?:AUDIO|VIDEO|SUBTITLES|CLOSED-CAPTIONS)="[^"]+"/.test(lines[i]) ? { separateRenditions: true } : {}) });
  }
  if (variants.length) return variants.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0))[0];
  const first = lines.findIndex(line => line && !line.startsWith("#")), path = lines[first];
  const prefix = lines.slice(0, first);
  const rangeTag = prefix.slice().reverse().find(line => line.startsWith("#EXT-X-BYTERANGE:"));
  const sampleRange = rangeTag ? byteRange(rangeTag.slice("#EXT-X-BYTERANGE:".length)) : undefined;
  const map = prefix.slice().reverse().find(line => line.startsWith("#EXT-X-MAP:"));
  const mapUrl = map?.match(/(?:[:,])URI="([^"]+)"/)?.[1];
  const mapRange = map?.match(/(?:[:,])BYTERANGE="([^"]+)"/)?.[1];
  const initUrl = mapUrl && webUrl(new URL(mapUrl, base).href);
  const headerUnsupported = lines.some(line => /^#EXT-X-(KEY|SESSION-KEY|GAP|DEFINE|I-FRAMES-ONLY|DISCONTINUITY)(:|$)/.test(line)) ||
    !lines.includes("#EXT-X-ENDLIST") || Boolean(map && !initUrl);
  return { segment: path ? webUrl(new URL(path, base).href) : undefined,
    ...(sampleRange ? { sampleRange, range: rangeHeader(sampleRange, SAMPLE_BYTES) } : {}),
    ...(initUrl ? { init: { url: initUrl, range: mapRange ? byteRange(mapRange) : undefined } } : {}),
    ...(headerUnsupported ? { headerUnsupported } : {}),
    ...(lines.some(line => /^#EXT-X-KEY:/.test(line) && !/^#EXT-X-KEY:METHOD=NONE(?:,|$)/.test(line)) ? { encrypted: true } : {}),
    ...(first >= 0 && !lines.slice(first + 1).some(line => line && !line.startsWith("#")) ? { singleSegment: true } : {}) };
}

export interface ResolutionEvidence {
  width?: number;
  height: number;
  source: "provider" | "playlist" | "ffprobe" | "codec-header";
  verified: boolean;
  mediaIdentity: string;
  variantIdentity?: string;
  sampleIdentity?: string;
  observedAt: number;
  expiresAt: number;
  playbackExpiresAt?: number;
}

interface PlaylistPath {
  variant?: string;
  snapshots: string[];
  sample?: Sample;
  init?: Sample;
  lifetimes: string[];
  headerUnsupported: boolean;
  needsFullCheck: boolean;
  singleSegment?: boolean;
}

interface VerifiedFacts {
  facts: Partial<MediaInfo>;
  identity?: string;
  hls: boolean;
  expires: number;
  complete: boolean;
  detailBudget?: number;
  sampleValidator?: string;
  initValidator?: string;
  revision: string;
}

function canUseFacts(entry: VerifiedFacts | undefined, timeoutMs: number): entry is VerifiedFacts {
  return Boolean(entry?.complete && (entry.detailBudget === undefined || timeoutMs <= entry.detailBudget));
}

interface Availability {
  state: "reachable" | "unreachable" | "unknown";
  checkedAt: number;
  expiresAt: number;
  reason?: string;
  result: MediaInfo;
}

interface InspectorOptions {
  playlists?: PlaylistFetcher;
  lightweight?: boolean;
  sampleProbe?: ReturnType<typeof tsSampleProbe>;
  cacheBytes?: number;
}
class MediaHttpError extends Error {
  constructor(readonly status: number) { super(`Media HTTP ${status}`); }
}

function httpStatus(error: unknown): number | undefined {
  return error instanceof MediaHttpError ? error.status :
    error instanceof Error ? Number(error.message.match(/^Playlist HTTP (\d{3})$/)?.[1]) || undefined : undefined;
}

export class MediaInspector {
  private jobs = new SharedJobs<MediaInfo>("media.inspect", 48, () => ({ reachable: false }));
  private verified: ResultCache<VerifiedFacts>;
  private availability: ResultCache<Availability>;
  private pool = new Pool(8);
  private playlists: PlaylistFetcher;

  constructor(private fetcher: Fetcher = fetch, private probe: MediaProbe = (url, timeout, signal) =>
    probeMedia(url, timeout, undefined, undefined, signal), private timeoutMs = 6500,
    private options: InspectorOptions = {}) {
    this.playlists = options.playlists ?? new PlaylistFetcher(fetcher);
    const bytes = options.cacheBytes ?? CACHE_BYTES / 2;
    this.verified = new ResultCache(512, Math.floor(bytes / 2));
    this.availability = new ResultCache(512, Math.floor(bytes / 2));
  }

  inspect(url: string, timeoutMs = this.timeoutMs, caller?: AbortSignal): Promise<MediaInfo> {
    if (caller?.aborted) return Promise.reject(caller.reason);
    const key = identity(url, requestHeaders(playlistHeaders), this.playlists.context);
    const budgetKey = identity(key, timeoutMs);
    const known = this.verified.get(key);
    // A cached view is usable only for the current fact revision.
    const recent = (canUseFacts(known, timeoutMs) ? this.availability.get(identity(key, known.revision)) : undefined) ??
      this.availability.get(identity(budgetKey, known?.revision));
    if (recent) {
      workCount("media.resultHits");
      if (recent.result.resolutionEvidence?.verified) workCount("media.factHits");
      return Promise.resolve(recent.result);
    }
    const queued = performance.now();
    // The network and FFprobe queues each have their own wait limit.
    const jobLifetime = 60_000 + timeoutMs * 2;
    const waiting = caller ? AbortSignal.any([caller, AbortSignal.timeout(jobLifetime)]) : undefined;
    return this.jobs.run(budgetKey, jobLifetime, job => {
      const queue = AbortSignal.any([job, AbortSignal.timeout(30_000)]);
      return this.pool.run(async () => {
        workDuration("media.queue", performance.now() - queued);
        return timed("media.active", () => this.inspectActive(url, key, budgetKey, timeoutMs, job));
      }, queue).catch(error => {
        if (error === queue.reason && !job.aborted) {
          workDuration("media.queue", performance.now() - queued, true);
          workCount("media.queueTimeouts");
        }
        workCount("media.inspect.failed");
        return { reachable: false };
      });
    }, waiting);
  }

  private async inspectActive(url: string, key: string, budgetKey: string, timeoutMs: number, job: AbortSignal): Promise<MediaInfo> {
    let known = this.verified.get(key);
    const recent = canUseFacts(known, timeoutMs) && this.availability.get(identity(key, known.revision));
    if (recent) {
      workCount("media.resultHits");
      workCount("media.factHits");
      return recent.result;
    }
    const declared: MediaInfo = { reachable: false };
    const budget = AbortSignal.any([job, AbortSignal.timeout(timeoutMs)]);
    const pathname = new URL(url).pathname;
    let hls = known?.hls || /\.m3u8$/i.test(pathname);
    const possiblePlaylist = hls || Boolean(this.options.lightweight &&
      !/\.(?:mp4|m4v|mkv|webm|mov|avi|ts|mpd|m4s|flv|wmv|mpg|mpeg|aac|mp3)$/i.test(pathname));
    workCount(known ? "media.factHits" : "media.factMisses");
    const playlist = (possiblePlaylist ? this.inspectPlaylist(url, declared, budget, () => { hls = true; }) : Promise.resolve(undefined))
      .then(path => ({ path, error: undefined }), error => ({ path: undefined, error }));
    let path: PlaylistPath | undefined, failure: unknown;
    let live = false;
    let detected: Partial<MediaInfo> = {};
    let sampleIdentity: string | undefined, variantIdentity: string | undefined;
    let sampleValidator: string | undefined, initValidator: string | undefined;
    let reusable: Buffer | undefined, initFallback: Sample | undefined;
    const sampleBases: string[] = [];
    let fallback = "format", complete = false;
    const pathKey = (item: PlaylistPath) => identity(key, item.variant, item.sample, item.init, item.lifetimes, item.snapshots);
    const sampleKey = (sample: Sample, response?: { base: string; etag?: string }) =>
      identity(sample, response?.base ?? sample.url, response?.etag);
    const check = async (sample: Sample, strict: boolean) => {
      try {
        const checked = await this.sample(sample, SAMPLE_BYTES, budget, strict);
        sampleBases.push(checked.base);
        return /^\s*[<{]/.test(checked.bytes.toString("utf8", 0, 40)) || !checked.bytes.length ? undefined : checked;
      } catch (error) { failure = error; }
    };
    const invalidate = () => {
      if (this.verified.get(key)?.revision === known?.revision) this.verified.delete(key);
      known = undefined;
      live = false;
    };
    if (known) {
      ({ path, error: failure } = await playlist);
      if (path && known.identity !== pathKey(path)) invalidate();
      else if (canUseFacts(known, timeoutMs) && !path?.needsFullCheck) {
        if (path?.sample || !hls) {
          const sample = path?.sample ?? { url };
          const checked = await check(sample, Boolean(this.options.lightweight && path?.sample));
          if (checked) {
            live = true;
            sampleValidator = sampleKey(sample, checked);
            if (sampleValidator !== (known.sampleValidator ?? sampleKey(sample))) invalidate();
          }
          if (live && path?.init && known) {
            const init = await check(path.init, true);
            live = Boolean(init);
            if (init) {
              initValidator = sampleKey(path.init, init);
              if (initValidator !== (known.initValidator ?? sampleKey(path.init))) invalidate();
            }
          }
        }
        if (known) {
          detected = known.facts;
          complete = true;
        }
      }
    }

    if (!complete) {
      const began = performance.now();
      const retainHeader = (evidence: CodecHeader, sample: Sample, response: { base: string; etag?: string }) => {
        sampleIdentity = sampleKey(sample, response);
        if (sample === path?.init) initValidator = sampleIdentity;
        else sampleValidator = sampleIdentity;
        variantIdentity = path?.variant ? identity(path.variant) : undefined;
        workCount("media.header.success");
        const { complete: detailsComplete, ...facts } = evidence;
        detected = { ...detected, ...facts };
        return detailsComplete;
      };
      if (possiblePlaylist && this.options.lightweight) {
        const light = AbortSignal.any([budget, AbortSignal.timeout(Math.min(750, Math.floor(timeoutMs / 4)))]);
        try {
          const quick = await waitFor(playlist, light);
          path = quick.path;
          if (quick.error) throw quick.error;
          const sample = path?.sample;
          if (!sample || path?.headerUnsupported) fallback = "unsupported-playlist";
          else if (path?.init) {
            // An init segment alone cannot establish availability or complete the track details.
            initFallback = path.init;
            fallback = "missing-details-init";
          } else if (!/\.(?:mp4|m4s|mkv|aac|webm)$/i.test(new URL(sample.url).pathname)) {
            const response = await this.sample(sample, HEADER_BYTES, light, true);
            sampleBases.push(response.base);
            const evidence = tsCodecHeader(response.bytes);
            if (evidence) {
              complete = retainHeader(evidence, sample, response);
              live = true;
              if (!complete && path?.singleSegment && response.whole) reusable = response.bytes;
              fallback = "missing-details";
            } else fallback = "inconclusive-header";
          }
        } catch (error) {
          if (!(error instanceof NotPlaylist && !hls)) {
            failure = error;
            fallback = light.aborted ? "header-timeout" : "sample-error";
          }
        }
        if (!sampleIdentity && !initFallback) workCount("media.header.unsupported");
      }
      if (!complete) {
        workCount(`media.fallback.${fallback}`);
        try {
          let remaining = Math.max(1, timeoutMs - Math.floor(this.options.lightweight && possiblePlaylist ? performance.now() - began : 0));
          const { hls: probedHls, ...probed } = await timed("media.probe", async () => {
            if (reusable && this.options.sampleProbe) {
              workCount("media.sampleReused");
              const attempt = performance.now();
              try {
                const local = await this.options.sampleProbe(reusable, url, remaining, job);
                if (local.reachable && local.videoCodec) return local;
              } catch (error) {
                // A demux failure can use the URL path. Capacity, cancellation and timeout should propagate.
                if (error instanceof ProbeError && error.reason !== "process-error" || job.aborted) throw error;
              }
              remaining -= Math.floor(performance.now() - attempt);
              if (remaining <= 0) throw new ProbeError("timeout");
            }
            return this.probe(url, remaining, job);
          });
          hls ||= Boolean(probedHls);
          const codecDimensions = sampleIdentity ? { width: detected.width, height: detected.height, videoCodec: detected.videoCodec } : undefined;
          if (codecDimensions && probed.height && (probed.height !== codecDimensions.height ||
            probed.width && probed.width !== codecDimensions.width)) workCount("media.resolutionDisagreements");
          detected = { ...detected, ...Object.fromEntries(Object.entries(probed).filter(([, value]) => value !== undefined)), ...codecDimensions };
          live ||= probed.reachable === true;
          complete = Boolean(probed.height && probed.videoCodec && (live || probed.reachable === undefined));
        } catch (error) {
          failure ??= error;
          if (error instanceof ProbeError) workCount(`media.probeFailure.${error.reason}`);
        }
      }
      if (initFallback && !detected.height) {
        try {
          const light = AbortSignal.any([budget, AbortSignal.timeout(250)]);
          const response = await this.sample(initFallback, 128 * 1024, light, true);
          sampleBases.push(response.base);
          const evidence = mp4InitCodecHeader(response.bytes);
          if (evidence) retainHeader(evidence, initFallback, response);
          else workCount("media.header.unsupported");
        } catch { workCount("media.header.unsupported"); }
      }
      const resolved = await playlist;
      path = resolved.path;
      failure ??= resolved.error;
      if (!detected.height && known) detected = known.facts;
    }

    const checkedAt = Date.now();
    const urls = [url, ...(path?.lifetimes ?? []), ...sampleBases];
    const knownExpiry = urls.reduce((ttl, url) => urlLifetime(url, ttl), Infinity);
    const lifetime = Math.min(knownExpiry, 30_000);
    const playbackExpiresAt = Number.isFinite(knownExpiry) ? checkedAt + knownExpiry : undefined;
    const expires = known?.expires ?? checkedAt + FACT_TTL;
    const facts = { ...detected };
    delete facts.reachable;
    const verified = Boolean(detected.height);
    let revision = known?.revision;
    if (verified && !detected.width) delete declared.width;
    if (detected.height && declared.height && (detected.height !== declared.height ||
      detected.width && declared.width && detected.width !== declared.width)) workCount("media.resolutionDisagreements");
    if (verified) {
      facts.resolutionEvidence ??= {
        width: detected.width, height: detected.height!, source: sampleIdentity ? "codec-header" : "ffprobe", verified: true,
        mediaIdentity: key, variantIdentity: variantIdentity ??
          (path?.variant && path.snapshots.length === 1 ? identity(path.variant) : undefined),
        sampleIdentity, observedAt: checkedAt, expiresAt: expires, playbackExpiresAt
      };
      const existing = this.verified.get(key);
      if (!job.aborted && (sampleIdentity || detected.videoCodec) &&
        (!existing || (complete && (existing.revision === known?.revision || !canUseFacts(existing, timeoutMs))))) {
        const mediaPath = path && pathKey(path);
        const detailBudget = complete && (!facts.audioCodec || !facts.channelLayout)
          ? Math.max(timeoutMs, known?.detailBudget ?? 0) : undefined;
        sampleValidator ??= known?.sampleValidator;
        initValidator ??= known?.initValidator;
        if (known?.facts.resolutionEvidence && known.facts.resolutionEvidence.width === facts.width && known.facts.height === facts.height &&
          known.facts.resolutionEvidence?.source === facts.resolutionEvidence.source) {
          facts.resolutionEvidence = known.facts.resolutionEvidence;
        }
        revision = identity(facts, mediaPath, complete, detailBudget, sampleValidator, initValidator);
        this.verified.set(key, { facts, identity: mediaPath, hls, expires, complete, detailBudget,
          sampleValidator, initValidator, revision }, expires - checkedAt);
      }
    }
    if (declared.height) declared.resolutionEvidence = {
      width: declared.width, height: declared.height, source: "playlist", verified: false, mediaIdentity: key,
      variantIdentity: path?.variant ? identity(path.variant) : undefined, observedAt: checkedAt,
      expiresAt: checkedAt + lifetime, playbackExpiresAt
    };
    const subtitles = new Set([declared.subtitles, facts.subtitles].filter(Boolean));
    const result: MediaInfo = { ...declared, ...facts, reachable: live, subtitles: subtitles.size > 1 ? "Multiple" : [...subtitles][0] };
    if (!result.height) workCount("media.missing.resolution");
    if (!result.audioCodec || !result.videoCodec) workCount("media.missing.codecs");
    if (result.audioCodec && !result.channelLayout) workCount("media.missing.channels");
    if (!result.subtitles) workCount("media.missing.subtitles");
    const status = httpStatus(failure);
    const state = live ? "reachable" : status && [401, 403, 404, 410].includes(status) ? "unreachable" : "unknown";
    const ttl = live && verified && complete && (!hls || path?.sample)
      ? Math.min(lifetime, expires - checkedAt) : live ? 0 : Math.min(lifetime, verified ? expires - checkedAt : Infinity, 5000);
    if (ttl > 0 && !job.aborted && this.verified.get(key)?.revision === revision) {
      this.availability.set(identity(live ? key : budgetKey, revision), { state, checkedAt, expiresAt: checkedAt + ttl,
      reason: state === "reachable" ? undefined : status ? `http-${status}` :
        failure instanceof Error && failure.name === "TimeoutError" ? "timeout" : "unverified",
      result }, ttl);
    }
    return result;
  }

  private async inspectPlaylist(url: string, info: MediaInfo, signal: AbortSignal, found: () => void): Promise<PlaylistPath> {
    const lifetimes: string[] = [], snapshots: string[] = [];
    let needsFullCheck = false;
    for (let depth = 0; depth < 4; depth++) {
      const { body, base, hash } = await this.playlists.read(url, signal, "media.http");
      lifetimes.push(url, base);
      found();
      const parsed = parsePlaylist(body, base);
      for (const field of ["width", "height", "bitrate"] as const) if (parsed[field]) info[field] = parsed[field];
      if (parsed.subtitles) info.subtitles = parsed.subtitles;
      if (parsed.next) {
        needsFullCheck ||= Boolean(parsed.separateRenditions) || (body.match(/^\s*#EXT-X-STREAM-INF:/gm)?.length ?? 0) > 1 ||
          /^\s*#EXT-X-(?:SESSION-KEY|DEFINE):/m.test(body);
        // A bandwidth-label change refreshes declared bitrate without invalidating codec facts.
        snapshots.push(identity(body.replace(/^([ \t]*#EXT-X-STREAM-INF:.*)$/gm, line =>
          line.replace(/(?:[:,])(?:AVERAGE-BANDWIDTH|BANDWIDTH)=\d+(?=,|\s*$)/g, delimiter => delimiter[0]))));
        url = parsed.next;
        continue;
      }
      snapshots.push(hash);
      const sample = parsed.segment ? { url: parsed.segment, range: parsed.sampleRange } : undefined;
      if (sample) lifetimes.push(sample.url);
      if (parsed.init) lifetimes.push(parsed.init.url);
      return { variant: base, snapshots, sample, init: parsed.init, lifetimes, needsFullCheck: needsFullCheck || Boolean(parsed.encrypted),
        singleSegment: parsed.singleSegment, headerUnsupported: Boolean(parsed.headerUnsupported || needsFullCheck) };
    }
    return { snapshots, lifetimes, headerUnsupported: true, needsFullCheck: true };
  }

  private async sample(sample: Sample, cap: number, signal: AbortSignal, strict = false):
    Promise<{ bytes: Buffer; base: string; whole: boolean; etag?: string }> {
    const range = rangeHeader(sample.range, cap);
    const response = await timed("media.http", () => this.fetcher(sample.url, { signal, headers: { ...playlistHeaders,
      Range: range, "Accept-Encoding": "identity" } }));
    if (!response.ok) { await response.body?.cancel(); throw new MediaHttpError(response.status); }
    const start = sample.range?.start ?? 0, limit = Math.min(cap, sample.range?.length ?? cap);
    const encoding = response.headers.get("Content-Encoding");
    const contentRange = response.headers.get("Content-Range");
    let expected: number | undefined, whole = false;
    if (strict) {
      const match = contentRange?.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/i), end = Number(match?.[2]);
      if (response.status === 206 && match && Number(match[1]) === start && end >= start && end < start + limit &&
        (match[3] === "*" || Number(match[3]) > end)) {
        expected = end - start + 1;
        whole = sample.range ? expected === sample.range.length : Number(match[3]) === end + 1;
      }
      else if (response.status !== 200 || start !== 0) {
        await response.body?.cancel();
        throw new Error("Unverified sample byte range");
      }
      if (encoding && encoding.toLowerCase() !== "identity") {
        await response.body?.cancel();
        throw new Error("Unsupported sample content encoding");
      }
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0, received = 0;
    try {
      while (reader && size < limit) {
        const { done, value } = await reader.read();
        if (done) { if (response.status === 200) whole = true; break; }
        received += value.length;
        workCount("bodyBytesRead", value.length);
        workCount("media.sampleBytes", value.length);
        const part = value.subarray(0, limit - size);
        chunks.push(part);
        size += part.length;
      }
    } finally { await reader?.cancel(); }
    if (expected !== undefined && received !== expected) throw new Error("Truncated or oversized range response");
    if (response.status === 200 && sample.range) whole = size === sample.range.length;
    const etag = response.headers.get("ETag");
    return { bytes: Buffer.concat(chunks, size), base: response.url || sample.url, whole,
      etag: etag?.startsWith('"') ? etag : undefined };
  }
}

export function codecTags(info: MediaInfo): string[] {
  const video: Record<string, string> = { h264: "H.264", hevc: "HEVC", av1: "AV1", vp9: "VP9", mpeg4: "MPEG4" };
  const audio: Record<string, string> = { aac: "AAC", ac3: "AC3", eac3: "EAC3", dts: "DTS", truehd: "TrueHD", flac: "FLAC", opus: "OPUS" };
  const layout = info.channelLayout;
  const channels = layout === "stereo" ? "2.0" : layout === "mono" ? "1.0" : layout?.match(/^[567]\.1/)?.[0];
  return [video[info.videoCodec || ""], audio[info.audioCodec || ""], channels].filter((v): v is string => Boolean(v));
}
