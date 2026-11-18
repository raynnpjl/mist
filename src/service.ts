import { episodeFor, playables } from "./episodes.js";
import { MediaInfo, MediaInspector, codecTags } from "./media.js";
import { EpisodeInfo, MetadataResolver, Title, VideoRequest, parseVideo } from "./metadata.js";
import { Playable, Vod, chineseKind, normalized, value } from "./model.js";
import { Fetcher, Provider } from "./providers.js";
import { DirectStream } from "./protocol.js";
import { MkvDrama, MkvFile } from "./mkvdrama.js";
import { RESOLUTIONS } from "./settings.js";
import { MkvHeaderInspector, MkvMetadata } from "./mkv-metadata.js";

export type StreamProvider = Provider | MkvDrama;
interface Candidate { url: string; source: Provider["source"]; group: string; language: string; releaseType?: string;
  filename?: string; videoSize?: number; displayName?: string; host?: string; subtitles: string; headers?: Record<string, string>; averageBitrate?: number }

function present(candidate: Candidate, title: Title, request: VideoRequest, info: MediaInfo): DirectStream {
  const quality = info.height ? `${Math.round(info.height)}p` : "Unknown";
  const episode = request.type === "movie" ? "Movie" :
    `S${String(request.season).padStart(2, "0")}E${String(request.episode).padStart(2, "0")}`;
  const mbps = (n: number) => n.toLocaleString("en-US", { maximumSignificantDigits: 3, useGrouping: false });
  const rate = candidate.averageBitrate || info.bitrate;
  const bitrate = rate ? `${mbps(rate / 1_000_000)} Mbps` : "Unavailable";
  const description = [`${candidate.displayName || title.displayName} ${episode}`, `Bitrate: ${bitrate}`,
    `Language: ${candidate.language || "Unknown"}`, `Subtitle: ${candidate.subtitles}`,
    candidate.host ? `MKVDrama · ${candidate.host}` : `${candidate.source.name}云播`].join("\n");
  const extension = (candidate.filename || new URL(candidate.url).pathname).match(/\.(mp4|mkv)$/i)?.[1].toLowerCase() || "m3u8";
  const facts = [title.displayName, episode, info.height ? quality : undefined,
    info.width && info.height ? `${info.width}x${info.height}` : undefined, candidate.releaseType, ...codecTags(info), candidate.language];
  const filename = candidate.filename || facts.filter(Boolean).join(" ").replace(/[\\/:*?"<>|\r\n]/g, " ") + `.${extension}`;
  return { name: !candidate.filename && info.height && info.height > 720 ? "1080P" : quality.replace(/p$/, "P"), description, url: candidate.url,
    behaviorHints: { notWebReady: Boolean(candidate.headers) || extension !== "mp4" || !candidate.url.startsWith("https:"),
      bingeGroup: `mist:${candidate.source.id}:${candidate.group}`, filename,
      ...(candidate.videoSize ? { videoSize: candidate.videoSize } : {}),
      ...(candidate.headers ? { proxyHeaders: { request: candidate.headers } } : {}) } };
}

function chineseOrdinal(number: number): string {
  const digits = "零一二三四五六七八九";
  if (number < 10) return digits[number];
  if (number < 100) return `${number >= 20 ? digits[Math.floor(number / 10)] : ""}十${number % 10 ? digits[number % 10] : ""}`;
  return String(number);
}

function titleNames(title: Title, request: VideoRequest): string[] {
  if (!request.season) return title.names;
  if (request.season === 1) return title.names.flatMap(name => [name, `${name}第1季`, `${name}第一季`]);
  return title.names.flatMap(name => [
    `${name}第${request.season}季`, `${name}第${chineseOrdinal(request.season!)}季`,
    `${name}${request.season}`, name
  ]);
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

function selected(playable: Playable, vod: Vod, request: VideoRequest, info?: EpisodeInfo): boolean {
  if (request.type === "movie") return true;
  const key = playable.episode.key;
  // A season-specific provider entry numbers its own episodes from season 1.
  const name = normalized(value(vod.vod_name));
  const ownSeason = request.season! > 1 && new RegExp(`(?:第(?:${request.season}|${chineseOrdinal(request.season!)})季|${request.season})$`).test(name);
  const part = catalogPart(info?.name || "");
  if (info?.name && chineseKind(vod) === "variety") {
    const reference = episodeFor(info.name, value(vod.vod_name), "variety").key.match(/^episode:(\d+):(\d+):(.+)$/);
    const actual = key.match(/^episode:(\d+):(\d+):(.+)$/);
    if (reference && actual) return (Number(actual[1]) === request.season || ownSeason && actual[1] === "1") &&
      actual[2] === reference[2] && (actual[3] === reference[3] || actual[3] === (part || "main"));
  }
  if (key === `episode:${request.season}:${request.episode}:main`) return true;
  if (ownSeason && key === `episode:1:${request.episode}:main`) return true;
  if (info?.date && key.startsWith(`date:${info.date}:`)) {
    return key === `date:${info.date}:${part || "main"}`;
  }
  return false;
}

function catalogPart(name: string): string | undefined {
  const chinese = name.match(/[（(]([上中下])[）)]|(?:第)?[\d零〇一二两三四五六七八九十百]+\s*[集期话回]\s*([上中下])(?:[：:\s]|$)/);
  if (chinese) return chinese[1] || chinese[2];
  const english = name.match(/\bpart\s*([12])\b/i)?.[1];
  return english === "1" ? "上" : english === "2" ? "下" : undefined;
}

export class AddonService {
  constructor(readonly providers: StreamProvider[], private metadata: MetadataResolver, fetcher: Fetcher = fetch,
    private inspector = new MediaInspector(fetcher), private resolutions = RESOLUTIONS,
    private mkvInspector = new MkvHeaderInspector(fetcher)) {}

  authenticate(): Promise<void> { return this.metadata.authenticate(); }

  private allowsResolution(height?: number): boolean {
    const resolution = height ? RESOLUTIONS.find(value => typeof value === "number" && height <= value) : "unknown";
    return resolution !== undefined && this.resolutions.includes(resolution);
  }

  private async find(provider: Provider, title: Title, request: VideoRequest, episodeInfo: Promise<EpisodeInfo | undefined>): Promise<Candidate[]> {
    // TMDB keeps the four 奔跑吧兄弟 seasons before 奔跑吧 restarts its numbering in 2017.
    const keepRunning = request.type === "series" && title.tmdbId === "98031";
    const lookup = keepRunning && request.season! > 4 ? { ...request, season: request.season! - 4 } : request;
    const lookupTitle = keepRunning ? { ...title,
      names: [...new Set([request.season! > 4 ? "奔跑吧" : "奔跑吧兄弟", ...title.names])] } : title;
    const names = titleNames(lookupTitle, lookup);
    const allowed = new Set(names.map(normalized));
    const searches = lookup.season === 1 ? lookupTitle.names : names;
    for (const search of searches.slice(0, lookup.season! > 1 ? 6 : 3)) {
      for (let page = 1; page <= 5; page++) {
        const [data, info] = await Promise.all([provider.page(page, undefined, search), episodeInfo]);
        const year = request.season && request.season > 1 ? info?.year || title.year : title.year;
        const streams: Candidate[] = [];
        for (const vod of data.items) {
          const kind = chineseKind(vod);
          const name = normalized(value(vod.vod_name));
          const vodYear = value(vod.vod_year).replace(/\s*[（(][^）)]*[）)]$/, "");
          const collection = request.season! > 1 && title.names.some(n => normalized(n) === name) &&
            vodYear === String(title.year);
          if (!kind || (request.type === "movie" ? kind !== "movie" : kind === "movie") ||
            (!collection && vodYear !== String(year)) || !allowed.has(name)) continue;
          const parts = playables(vod, kind).filter(p => selected(p, vod, collection ? request : lookup, info));
          for (const part of parts) streams.push({ source: provider.source, language: language(vod.vod_lang), subtitles: "Chinese",
            url: part.url, group: part.group, releaseType: releaseType(vod) });
        }
        if (streams.length) return streams;
        if (page >= data.pages) break;
      }
    }
    return [];
  }

  async streams(type: string, videoId: string): Promise<DirectStream[]> {
    const request = parseVideo(type, videoId);
    if (!request) return [];
    const title = await this.metadata.title(request);
    if (!title) return [];
    // Numeric episodes remain usable when optional air-date metadata is unavailable.
    const info = this.metadata.episode(title, request).catch(() => undefined);
    const results = await Promise.allSettled(this.providers.map(async provider => {
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
      const candidates = await this.find(provider, title, request, info);
      return Promise.all(candidates.map(async candidate => ({ candidate, media: await this.inspector.inspect(candidate.url) })));
    }));
    if (results.length && results.every(r => r.status === "rejected")) throw new Error("All stream providers are temporarily unavailable");
    const unique = new Map<string, { candidate: Candidate; media: MediaInfo }>();
    for (const result of results) if (result.status === "fulfilled") {
      for (const item of result.value) if (!unique.has(item.candidate.url)) unique.set(item.candidate.url, item);
    }
    const inspected = [...unique.values()].filter(({ media }) => this.allowsResolution(media.height)).map(({ candidate, media }) => {
      return { stream: present(candidate, title, request, media),
        rank: Number(media.reachable) * 2 + Number(candidate.url.startsWith("https:")) };
    });
    return inspected.sort((a, b) => b.rank - a.rank).map(item => item.stream);
  }
}
