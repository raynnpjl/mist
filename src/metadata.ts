import { Cache, Pool, readLimited } from "./cache.js";
import { normalized, value } from "./model.js";
import { Fetcher } from "./providers.js";

export interface VideoRequest {
  type: "movie" | "series";
  id: string;
  season?: number;
  episode?: number;
}
export interface Title { names: string[]; displayName: string; nativeName?: string; year: number; tmdbId: string }
export interface EpisodeInfo { year?: number; date?: string; name?: string }

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
  private responses = new Cache<any>(512);
  private pool = new Pool(4);
  constructor(private fetcher: Fetcher, private tmdbKey: string, private timeout = 8000) {
    if (!tmdbKey) throw new Error("Configure a TMDB API key on the Mist website");
  }

  private json(url: URL): Promise<any> {
    return this.responses.get(url.href, 6 * 60 * 60_000, () => this.pool.run(async () => {
      const response = await this.fetcher(url, { headers: { "User-Agent": "Mist/1.4.2 (Stremio addon)", Accept: "application/json" },
        signal: AbortSignal.timeout(this.timeout) });
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

  private tmdb(path: string, params: Record<string, string> = {}) {
    const url = new URL(`https://api.themoviedb.org/3/${path}`);
    url.search = new URLSearchParams({ api_key: this.tmdbKey, language: "zh-CN", ...params }).toString();
    return this.json(url);
  }

  title(request: VideoRequest): Promise<Title | undefined> {
    return this.titles.get(`${request.type}:${request.id}`, 6 * 60 * 60_000,
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
      const found = await this.tmdb(`find/${request.id}`, { external_source: "imdb_id" });
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
    return { names, displayName: names[0], nativeName: value(data.original_title || data.original_name) || undefined, year, tmdbId: id };
  }

  episode(title: Title, request: VideoRequest): Promise<EpisodeInfo | undefined> {
    if (request.type !== "series") return Promise.resolve(undefined);
    return this.episodes.get(`${request.id}:${request.season}:${request.episode}`, 60 * 60_000, async () => {
      const episode = await this.tmdb(`tv/${title.tmdbId}/season/${request.season}/episode/${request.episode}`);
      if (!episode) return;
      const date = value(episode.air_date).slice(0, 10);
      return { date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined,
        year: yearOf(date) || undefined, name: value(episode.name) };
    });
  }
}
