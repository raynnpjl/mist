import { Cache, Pool, readLimited } from "./cache.js";
import { Category, Page, Vod, categoryKind, Kind, value } from "./model.js";
import { MKVDRAMA_SOURCE } from "./mkvdrama.js";
import { count, timed } from "./loading.js";
import { ApiSource, sourceConfig } from "./config.js";

export const SOURCES = sourceConfig.apis.map(({ id, name }) => ({ id, name }));
export const STREAM_SOURCES = [...SOURCES, MKVDRAMA_SOURCE];
export type Source = ApiSource;

export function loadSources(): Source[] { return sourceConfig.apis; }
export const UPSTREAM_HEADERS = { "User-Agent": "Mozilla/5.0", Accept: "application/json" };
export type Fetcher = typeof fetch;
interface ApiResult { data: Record<string, unknown>; endpoint: string }

export class Provider {
  private cache = new Cache<ApiResult>(256);
  private matches = new Cache<{ ids: string[]; endpoint: string }>(512);
  private checks = new Cache<{ available: boolean; checkedAt: string; responseMs?: number; error?: string }>(1);
  private failed = new Map<string, number>();
  private state: { lastSuccess?: string; lastError?: string } = {};
  constructor(readonly source: Source, private pool: Pool,
    private fetcher: Fetcher = fetch, private timeout = 8000) {}

  status() { return { id: this.source.id, name: this.source.name, ...this.state }; }

  private async read(params: Record<string, string>, cooldown = true): Promise<ApiResult> {
    const endpoints = [this.source.url, ...this.source.backups || []]
      .filter(url => !cooldown || Date.now() >= (this.failed.get(url) || 0));
    const deadline = Date.now() + this.timeout;
    let error: unknown = new Error("temporarily unavailable");
    for (const [index, endpoint] of endpoints.entries()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      // Reserve time for backups within the original request budget.
      const signal = AbortSignal.timeout(Math.max(1, Math.floor(remaining / (endpoints.length - index))));
      try {
        const response = await timed("vod.http", () => this.fetcher(this.url(params, endpoint), { headers: UPSTREAM_HEADERS, signal }));
        if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
        let data: Record<string, unknown>;
        try { data = JSON.parse(await readLimited(response, 8 * 1024 * 1024)); }
        catch (failure) { if (failure instanceof SyntaxError) throw new Error("Invalid VOD response"); throw failure; }
        if (!data || Number(data.code) !== 1 || !Array.isArray(data.list)) throw new Error("Invalid VOD response");
        if (params.pg && (!Number.isInteger(Number(data.pagecount)) || Number(data.pagecount) < 0)) throw new Error("invalid page count");
        if (cooldown) this.failed.delete(endpoint);
        return { data, endpoint };
      } catch (failure) {
        error = failure;
        if (cooldown) this.failed.set(endpoint, Date.now() + 20_000);
      }
    }
    throw error;
  }

  private url(params: Record<string, string>, endpoint = this.source.url): URL {
    const url = new URL(endpoint);
    for (const [key, val] of Object.entries(params)) url.searchParams.set(key, val);
    return url;
  }

  private request(params: Record<string, string>, ttl: number): Promise<ApiResult> {
    const url = this.url(params);
    return this.cache.get(url.href, ttl, () => this.pool.run(async () => {
      try {
        const result = await this.read(params);
        this.state = { lastSuccess: new Date().toISOString() };
        return result;
      } catch (error) {
        this.state.lastError = error instanceof Error ? error.message : "Request failed";
        throw new Error(`${this.source.id}: ${this.state.lastError}`);
      }
    }));
  }

  async categories(kind: Kind): Promise<Category[]> {
    const { data } = await this.request({ ac: "list" }, 24 * 60 * 60_000);
    if (!Array.isArray(data.class)) throw new Error(`${this.source.id}: missing categories`);
    return data.class.map(c => ({ id: value(c.type_id), name: value(c.type_name) }))
      .filter(c => c.id && categoryKind(c.name) === kind);
  }

  async page(page: number, category?: string, search?: string): Promise<Page> {
    const params: Record<string, string> = { ac: "detail", pg: String(page) };
    if (category) params.t = category;
    if (search) params.wd = search;
    const { data, endpoint } = await this.request(params, 2 * 60_000);
    const pages = Number(data.pagecount);
    return { items: data.list as Vod[], pages, endpoint };
  }

  cachedMatch(key: string): Promise<Vod[]> | undefined {
    const match = this.matches.peek(key);
    count(match ? "vod.mappingHits" : "vod.mappingMisses");
    return match?.then(async ({ ids, endpoint }) => {
      const result = await this.request({ ac: "detail", ids: ids.join(",") }, 2 * 60_000);
      // Different endpoints can assign the same numeric ID to unrelated titles.
      if (result.endpoint !== endpoint) return [];
      const { data } = result;
      const records = new Map((data.list as Vod[]).map(vod => [value(vod.vod_id), vod]));
      // A partial response must rediscover replacements rather than hide missing sources.
      return ids.every(id => records.has(id)) ? ids.map(id => records.get(id)!) : [];
    });
  }

  rememberMatch(key: string, records: Vod[], endpoint: string): void {
    const ids = [...new Set(records.map(vod => value(vod.vod_id)))];
    if (!ids.length || ids.length > 100 || ids.some(id => !/^[1-9]\d*$/.test(id))) return;
    this.matches.set(key, { ids, endpoint }, 30 * 60_000);
    // Reuse the search response for warm episode requests without an extra detail call.
    this.cache.set(this.url({ ac: "detail", ids: ids.join(",") }).href, { data: { code: 1, list: records }, endpoint }, 2 * 60_000);
  }

  forgetMatch(key: string): void { this.matches.delete(key); }

  check() {
    return this.checks.get("availability", 30_000, async () => {
      const start = performance.now();
      try {
        await this.read({ ac: "list" }, false);
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
