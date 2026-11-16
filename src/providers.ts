import { Cache, Pool, readLimited } from "./cache.js";
import { Category, Page, Vod, categoryKind, Kind, value } from "./model.js";
import { MKVDRAMA_SOURCE } from "./mkvdrama.js";

export const SOURCES = [
  { id: "hongniu", name: "红牛" },
  { id: "tiantang", name: "天堂" },
  { id: "baofeng", name: "暴风" },
  { id: "liangzi", name: "量子" },
  { id: "youku", name: "优酷" }
];
export const STREAM_SOURCES = [...SOURCES, MKVDRAMA_SOURCE];
export type Source = typeof SOURCES[number] & { url: string };

export function loadSources(env: NodeJS.ProcessEnv = process.env): Source[] {
  return SOURCES.map(source => {
    const key = `${source.id.toUpperCase()}_API_URL`;
    const value = env[key]?.trim();
    if (!value) throw new Error(`Missing ${key}. Set it in .env or the server environment.`);
    let url: URL;
    try { url = new URL(value); }
    catch { throw new Error(`${key} must be a valid HTTPS URL`); }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error(`${key} must be a valid HTTPS URL`);
    return { ...source, url: url.href };
  });
}
export const UPSTREAM_HEADERS = { "User-Agent": "Mozilla/5.0", Accept: "application/json" };
export type Fetcher = typeof fetch;

export class Provider {
  private cache = new Cache<Record<string, unknown>>(256);
  private checks = new Cache<{ available: boolean; checkedAt: string; responseMs?: number; error?: string }>(1);
  private retryAt = 0;
  private state: { lastSuccess?: string; lastError?: string } = {};
  constructor(readonly source: Source, private pool: Pool,
    private fetcher: Fetcher = fetch, private timeout = 8000) {}

  status() { return { id: this.source.id, name: this.source.name, ...this.state }; }

  private async read(url: URL): Promise<Record<string, unknown>> {
    const response = await this.fetcher(url, { headers: UPSTREAM_HEADERS, signal: AbortSignal.timeout(this.timeout) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
    const data = JSON.parse(await readLimited(response, 8 * 1024 * 1024));
    if (!data || Number(data.code) !== 1 || !Array.isArray(data.list)) throw new Error("Invalid VOD response");
    return data;
  }

  private request(params: Record<string, string>, ttl: number): Promise<Record<string, unknown>> {
    const url = new URL(this.source.url);
    for (const [key, val] of Object.entries(params)) url.searchParams.set(key, val);
    return this.cache.get(url.href, ttl, () => this.pool.run(async () => {
      if (Date.now() < this.retryAt) throw new Error(`${this.source.id}: temporarily unavailable`);
      try {
        const data = await this.read(url);
        this.state = { lastSuccess: new Date().toISOString() };
        this.retryAt = 0;
        return data;
      } catch (error) {
        this.retryAt = Date.now() + 20_000;
        this.state.lastError = error instanceof Error ? error.message : "Request failed";
        throw new Error(`${this.source.id}: ${this.state.lastError}`);
      }
    }));
  }

  async categories(kind: Kind): Promise<Category[]> {
    const data = await this.request({ ac: "list" }, 24 * 60 * 60_000);
    if (!Array.isArray(data.class)) throw new Error(`${this.source.id}: missing categories`);
    return data.class.map(c => ({ id: value(c.type_id), name: value(c.type_name) }))
      .filter(c => c.id && categoryKind(c.name) === kind);
  }

  async page(page: number, category?: string, search?: string): Promise<Page> {
    const params: Record<string, string> = { ac: "detail", pg: String(page) };
    if (category) params.t = category;
    if (search) params.wd = search;
    const data = await this.request(params, 2 * 60_000);
    const pages = Number(data.pagecount);
    if (!Number.isInteger(pages) || pages < 0) throw new Error(`${this.source.id}: invalid page count`);
    return { items: data.list as Vod[], pages };
  }

  check() {
    return this.checks.get("availability", 30_000, async () => {
      const start = performance.now();
      try {
        const url = new URL(this.source.url);
        url.searchParams.set("ac", "list");
        await this.read(url);
        return { available: true, checkedAt: new Date().toISOString(), responseMs: Math.round(performance.now() - start) };
      } catch (error) {
        return { available: false, checkedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : "Source unavailable" };
      }
    });
  }

}

export function createProviders(sources: Source[], fetcher: Fetcher = fetch, timeout = 8000): Provider[] {
  const pool = new Pool(6);
  return sources.map(source => new Provider(source, pool, fetcher, timeout));
}
