import type { Edition } from "./episodes.js";
import { discoverVod } from "./vod-discovery.js";
import { MediaInfo, MediaInspector, codecTags } from "./media.js";
import { MetadataResolver, Title, VideoRequest, parseVideo } from "./metadata.js";
import { Vod, normalized, value } from "./model.js";
import { Fetcher, Provider } from "./providers.js";
import { DirectStream } from "./protocol.js";
import { MkvDrama, MkvFile } from "./mkvdrama.js";
import { RESOLUTIONS, resolutionFor } from "./resolutions.js";
import { MkvHeaderInspector, MkvMetadata } from "./mkv-metadata.js";
import { count, timed } from "./loading.js";

export type StreamProvider = Provider | MkvDrama;
interface Candidate { url: string; source: Provider["source"]; group: string; language: string; releaseType?: string; edition?: Edition;
  filename?: string; videoSize?: number; displayName?: string; host?: string; subtitles?: string; headers?: Record<string, string>; averageBitrate?: number }

function present(candidate: Candidate, title: Title, request: VideoRequest, info: MediaInfo): DirectStream {
  const quality = info.height ? `${Math.round(info.height)}p` : "Unknown";
  const episode = request.type === "movie" ? "Movie" :
    `S${String(request.season).padStart(2, "0")}E${String(request.episode).padStart(2, "0")}`;
  const mbps = (n: number) => n.toLocaleString("en-US", { maximumSignificantDigits: 3, useGrouping: false });
  const rate = candidate.averageBitrate || info.bitrate;
  const bitrate = rate ? `${mbps(rate / 1_000_000)} Mbps` : "Unavailable";
  const subtitles = info.subtitles || candidate.subtitles || "Unknown";
  count("streams");
  if (!info.height) count("missing.resolution");
  if (!info.videoCodec || !info.audioCodec) count("missing.codecs");
  if (!rate) count("missing.bitrate");
  if (subtitles === "Unknown") count("missing.subtitles");
  const sourceName = candidate.host ? `${candidate.source.name} · ${candidate.host}` : candidate.source.name;
  const edition = candidate.edition ? ` ${candidate.edition}` : "";
  const description = [`${candidate.displayName || title.displayName} ${episode}${edition}`, `Bitrate: ${bitrate}`,
    `Language: ${candidate.language || "Unknown"}`, `Subtitle: ${subtitles}`,
    sourceName].join("\n");
  const extension = (candidate.filename || new URL(candidate.url).pathname).match(/\.(mp4|mkv)$/i)?.[1].toLowerCase() || "m3u8";
  const facts = [title.displayName, episode, candidate.edition, info.height ? quality : undefined,
    info.width && info.height ? `${info.width}x${info.height}` : undefined, candidate.releaseType, ...codecTags(info), candidate.language];
  const filename = candidate.filename || facts.filter(Boolean).join(" ").replace(/[\\/:*?"<>|\r\n]/g, " ") + `.${extension}`;
  const resolution = resolutionFor(info.height);
  const name = resolution === 2160 ? "4K" : typeof resolution === "number" ? `${resolution}P` : "Unknown";
  return { name, description, url: candidate.url,
    behaviorHints: { notWebReady: Boolean(candidate.headers) || extension !== "mp4" || !candidate.url.startsWith("https:"),
      bingeGroup: `mist:${candidate.source.id}:${candidate.group}${candidate.edition ? `:${candidate.edition}` : ""}`, filename,
      ...(candidate.videoSize ? { videoSize: candidate.videoSize } : {}),
      ...(candidate.headers ? { proxyHeaders: { request: candidate.headers } } : {}) } };
}

function language(input: unknown): string {
  const raw = value(input);
  const labels: [RegExp, string][] = [[/国语|普通话|汉语/, "Chinese"], [/粤语|广东话/, "Chinese (Cantonese)"],
    [/闽南语|台语/, "Chinese (Hokkien)"], [/英语/, "English"], [/日语/, "Japanese"], [/韩语/, "Korean"]];
  return labels.filter(([pattern]) => pattern.test(raw)).map(([, name]) => name).join(" / ") ||
    (/^[a-z /,()-]+$/i.test(raw) ? raw : "");
}

function releaseType(vod: Vod): string | undefined {
  const text = [vod.vod_version, vod.vod_remarks].map(value).join(" ");
  const types: [RegExp, string][] = [[/\bWEB[ ._-]?DL\b/i, "WEB-DL"], [/\bWEB[ ._-]?RIP\b/i, "WEBRip"],
    [/\bREMUX\b/i, "Remux"], [/\bBLU[ ._-]?RAY\b/i, "BluRay"], [/\bHDTV\b/i, "HDTV"], [/\bDVDRIP\b/i, "DVDRip"]];
  return types.find(([pattern]) => pattern.test(text))?.[1];
}

export class AddonService {
  constructor(readonly providers: StreamProvider[], private metadata: MetadataResolver, fetcher: Fetcher = fetch,
    private inspector = new MediaInspector(fetcher), private resolutions = RESOLUTIONS,
    private mkvInspector = new MkvHeaderInspector(fetcher), private resolutionFirst = false, private inspectionTimeoutMs?: number,
    private includeEpisodeExtras = false) {}

  authenticate(): Promise<void> { return this.metadata.authenticate(); }

  private allowsResolution(height?: number): boolean {
    const resolution = resolutionFor(height);
    return resolution !== undefined && this.resolutions.includes(resolution);
  }

  async streams(type: string, videoId: string): Promise<DirectStream[]> {
    const request = parseVideo(type, videoId);
    if (!request) return [];
    const title = await timed("tmdb.title", () => this.metadata.title(request));
    if (!title) return [];
    const info = this.providers.some(provider => provider instanceof MkvDrama)
      ? timed("tmdb.episode", () => this.metadata.episode(title, request)).catch(() => undefined)
      : undefined;
    const season = request.type === "series" && this.providers.some(provider => !(provider instanceof MkvDrama))
      ? timed("tmdb.season", () => this.metadata.apiSeason(title, request))
      : Promise.resolve({ episodes: [], complete: false });
    const results = await Promise.allSettled(this.providers.map(provider => timed(`provider.${provider.source.id}`, async (): Promise<{ candidate: Candidate; media: MediaInfo }[]> => {
      if (provider instanceof MkvDrama) {
        const [english, episode] = await Promise.all([this.metadata.englishName(title, request).catch(() => undefined), info]);
        const primaryNames = [english, title.nativeName].filter((name): name is string => Boolean(name))
          .filter((name, index, names) => names.findIndex(other => normalized(other) === normalized(name)) === index);
        const names = [...new Set([...primaryNames, ...title.names])];
        const inspections = new Map<string, Promise<MkvMetadata>>();
        const invalid = new Set<string>();
        const fileKey = (file: MkvFile) => JSON.stringify([file.url, file.filename, file.size, file.version, file.headers]);
        const inspect = (file: MkvFile) => {
          const key = fileKey(file);
          if (!inspections.has(key) && this.allowsResolution(file.height)) inspections.set(key, this.mkvInspector.inspect(file, () => { invalid.add(key); }));
          return inspections.get(key) || Promise.resolve({} as MkvMetadata);
        };
        const files = (await provider.streams({ ...title, names }, request, episode?.year, async file => {
          await inspect(file); return invalid.has(fileKey(file));
        }, this.resolutions))
          .filter(file => this.allowsResolution(file.height));
        return Promise.all(files.map(async file => {
          const header = await inspect(file);
          return {
            candidate: { url: file.url, source: provider.source, group: `direct:${file.host}:${file.height || "unknown"}`,
              language: "Chinese", filename: file.filename, videoSize: file.size, host: file.host,
              subtitles: header.subtitles || file.subtitles || "Unknown", averageBitrate: header.averageBitrate, headers: file.headers,
              displayName: primaryNames.join(" ") || title.displayName },
            media: { reachable: false, height: file.height } as MediaInfo
          };
        }));
      }
      const matches = await discoverVod(provider, title, request, season, this.includeEpisodeExtras);
      const byUrl = new Map<string, Candidate>();
      for (const { vod, url, group, edition } of matches) {
        const previous = byUrl.get(url);
        if (!previous || previous.edition && !edition) byUrl.set(url, { source: provider.source,
          language: language(vod.vod_lang), url, group, edition, releaseType: releaseType(vod) });
      }
      return Promise.all([...byUrl.values()].map(async candidate => ({ candidate,
        media: await this.inspector.inspect(candidate.url, this.inspectionTimeoutMs) })));
    })));
    if (results.length && results.every(r => r.status === "rejected")) throw new Error("All stream providers are temporarily unavailable");
    const unique = new Map<string, { candidate: Candidate; media: MediaInfo }>();
    for (const result of results) if (result.status === "fulfilled") {
      for (const item of result.value) {
        const previous = unique.get(item.candidate.url);
        if (!previous || previous.candidate.edition && !item.candidate.edition) unique.set(item.candidate.url, item);
      }
    }
    const inspected = [...unique.values()].filter(({ media }) => this.allowsResolution(media.height)).map(({ candidate, media }) => {
      const resolution = resolutionFor(media.height);
      return { stream: present(candidate, title, request, media), resolution: typeof resolution === "number" ? resolution : 0,
        supplemental: Number(Boolean(candidate.edition)),
        priority: this.providers.findIndex(provider => provider.source.id === candidate.source.id),
        rank: Number(media.reachable) * 2 + Number(candidate.url.startsWith("https:")) };
    });
    return inspected.sort((a, b) => a.supplemental - b.supplemental || (this.resolutionFirst ? b.resolution - a.resolution : 0) ||
      a.priority - b.priority || b.rank - a.rank).map(item => item.stream);
  }
}
