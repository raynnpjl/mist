import { Cache, Pool, readLimited } from "./cache.js";
import { normalized, value } from "./model.js";
import { Fetcher } from "./providers.js";
import { timed } from "./loading.js";
import { isoDate } from "./episodes.js";

export interface VideoRequest {
  type: "movie" | "series";
  id: string;
  season?: number;
  episode?: number;
}
export interface Title { names: string[]; displayName: string; nativeName?: string; year: number; tmdbId: string;
  seasons?: { number: number; name: string; year?: number; episodeCount?: number }[]; apiAliases?: string[] }
export interface EpisodeInfo { year?: number; date?: string; name?: string }
export interface CatalogEpisode extends EpisodeInfo { number: number }
export interface ApiSeason { episodes: CatalogEpisode[]; complete: boolean; year?: number; name?: string }

export function parseVideo(type: string, id: string): VideoRequest | undefined {
  if (type !== "movie" && type !== "series") return;
  const match = id.match(/^(tt\d{7,12}|tmdb:[1-9]\d{0,11})(?::(\d{1,3}):(\d{1,5}))?$/);
  if (!match) return;
  const [, root, season, episode] = match;
  if (type === "movie") return season === undefined ? { type, id: root } : undefined;
  if (season === undefined || !episode || Number(episode) < 1) return;
  return { type, id: root, season: Number(season), episode: Number(episode) };
}

const yearOf = (input: unknown): number => Number(value(input).match(/[12]\d{3}/)?.[0] || 0);
const aliases = (items: unknown[]): string[] => [...new Map(items.map(value).filter(Boolean)
  .map(name => [normalized(name), name])).values()]
  .sort((a, b) => Number(/\p{Script=Han}/u.test(b)) - Number(/\p{Script=Han}/u.test(a)));

export class MetadataResolver {
  private titles = new Cache<Title | undefined>(512);
  private episodes = new Cache<EpisodeInfo | undefined>(1024);
  private apiSeasons = new Cache<ApiSeason | undefined>(128);
  private responses = new Cache<any>(512);
  private pool = new Pool(4);
  constructor(private fetcher: Fetcher, private tmdbKey: string, private timeout = 8000) {
    if (!tmdbKey) throw new Error("Configure a TMDB API key on the Mist website");
  }

  private json(url: URL, ttl = 6 * 60 * 60_000): Promise<any> {
    return this.responses.get(url.href, value => value === undefined ? 5000 : ttl, () => this.pool.run(async () => {
      const response = await timed("tmdb.http", () => this.fetcher(url, { headers: { "User-Agent": "Mist/1.5.0 (Stremio addon)", Accept: "application/json" },
        signal: AbortSignal.timeout(this.timeout) }));
      if (response.status === 404) { await response.body?.cancel(); return undefined; }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`${url.hostname}: metadata HTTP ${response.status}`);
      }
      const data = JSON.parse(await readLimited(response, 4 * 1024 * 1024));
      if (data.error) throw new Error(`${url.hostname}: metadata API error`);
      return data;
    }));
  }

  private tmdb(path: string, params: Record<string, string> = {}, ttl?: number) {
    const url = new URL(`https://api.themoviedb.org/3/${path}`);
    url.search = new URLSearchParams({ api_key: this.tmdbKey, language: "zh-CN", ...params }).toString();
    return this.json(url, ttl);
  }

  title(request: VideoRequest): Promise<Title | undefined> {
    return this.titles.get(`${request.type}:${request.id}`, value => value ? 6 * 60 * 60_000 : 5000,
      () => this.tmdbTitle(request));
  }

  async authenticate(): Promise<void> {
    if (!(await this.tmdb("authentication"))?.success) throw new Error("TMDB authentication failed");
  }

  async englishName(title: Title, request: VideoRequest): Promise<string | undefined> {
    const data = await this.tmdb(`${request.type === "movie" ? "movie" : "tv"}/${title.tmdbId}`, { language: "en-US" });
    return value(data?.title || data?.name) || undefined;
  }

  private async tmdbTitle(request: VideoRequest): Promise<Title | undefined> {
    let id = request.id.startsWith("tmdb:") ? request.id.slice(5) : undefined;
    const endpoint = request.type === "movie" ? "movie" : "tv";
    if (!id) {
      const found = await this.tmdb(`find/${request.id}`, { external_source: "imdb_id" }, 5000);
      const matches = found?.[`${endpoint}_results`];
      if (!Array.isArray(matches) || matches.length !== 1) return;
      id = value(matches[0].id);
    }
    const data = await this.tmdb(`${endpoint}/${id}`, { append_to_response: "alternative_titles" });
    if (!data) return;
    const countries: string[] = data.origin_country || data.production_countries?.map((c: any) => c.iso_3166_1) || [];
    if (countries.length && !countries.some(c => ["CN", "HK", "TW", "MO"].includes(c))) return;
    const alternatives = data.alternative_titles?.titles || data.alternative_titles?.results || [];
    const names = aliases([data.original_title, data.original_name, data.title, data.name,
      ...alternatives.filter((a: any) => ["CN", "HK", "TW", "MO"].includes(a.iso_3166_1)).map((a: any) => a.title)]);
    const year = yearOf(data.release_date || data.first_air_date);
    if (!names.length || !year) return;
    return { names, displayName: names[0], nativeName: value(data.original_title || data.original_name) || undefined, year, tmdbId: id,
      apiAliases: aliases(alternatives.map((a: any) => a.title)),
      ...(Array.isArray(data.seasons) ? { seasons: data.seasons.map((season: any) => ({ number: season.season_number,
        name: value(season.name), year: yearOf(season.air_date) || undefined, episodeCount: season.episode_count })) } : {}) };
  }

  async apiSeason(title: Title, request: VideoRequest): Promise<ApiSeason> {
    const path = `tv/${title.tmdbId}/season/${request.season}`;
    const ttl = 60 * 60_000;
    const expected = title.seasons?.find(summary => summary.number === request.season)?.episodeCount;
    const season = await this.apiSeasons.get(`${path}:${expected || 0}`, season => season ? ttl : 5000, async () => {
      const data = await this.tmdb(path, {}, ttl);
      if (!Array.isArray(data?.episodes) || data.season_number !== undefined && data.season_number !== request.season) return;
      const episodes: CatalogEpisode[] = [];
      const seen = new Set<number>();
      for (const item of data.episodes) {
        const number = item?.episode_number;
        if (!Number.isSafeInteger(number) || number < 1 || number > 99_999 || seen.has(number) ||
          item.season_number !== undefined && item.season_number !== request.season) return;
        seen.add(number);
        const date = isoDate(value(item.air_date));
        episodes.push({ number, date, year: yearOf(date) || undefined, name: value(item.name) });
      }
      if (!episodes.length) return;
      episodes.sort((a, b) => a.number - b.number);
      return { episodes, complete: !expected || episodes.length >= expected,
        year: yearOf(data.air_date) || episodes[0].year, name: value(data.name) };
    }).catch(() => undefined);
    if (season?.episodes.some(episode => episode.number === request.episode)) return season;
    // An absent season response or a stale episode list can still yield a verified individual episode.
    const episode = await timed("tmdb.episode", () => this.episode(title, request)).catch(() => undefined);
    return { ...season, complete: false, episodes: [...season?.episodes || [], { ...episode, number: request.episode! }] };
  }

  episode(title: Title, request: VideoRequest): Promise<EpisodeInfo | undefined> {
    if (request.type !== "series") return Promise.resolve(undefined);
    return this.episodes.get(`${request.id}:${request.season}:${request.episode}`, value => value ? 60 * 60_000 : 5000, async () => {
      const episode = await this.tmdb(`tv/${title.tmdbId}/season/${request.season}/episode/${request.episode}`, {}, 60 * 60_000);
      if (!episode) return;
      const date = value(episode.air_date).slice(0, 10);
      return { date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined,
        year: yearOf(date) || undefined, name: value(episode.name) };
    });
  }
}
