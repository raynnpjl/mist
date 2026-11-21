import { createDecipheriv, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { load } from "cheerio";
import { Cache, readLimited } from "./cache.js";
import { DiscoveryCache, DiscoveryStore } from "./discovery-cache.js";
import { mkvNetwork } from "./mkv-work.js";
import type { Title, VideoRequest } from "./metadata.js";
import { normalized, webUrl } from "./model.js";
import type { Fetcher } from "./providers.js";
import { resolveOuo } from "./ouo.js";
import { MKVDRAMA_HOSTS, fileHost, hostLabel, resolveSend } from "./filehosts.js";
import { RESOLUTIONS, Resolution, resolutionFor } from "./resolutions.js";
import { timed } from "./loading.js";
import { sourceConfig } from "./config.js";

export const MKVDRAMA_SOURCE = { id: sourceConfig.mkvdrama.id, name: sourceConfig.mkvdrama.name };
export interface MkvFile { url: string; filename: string; size?: number; version?: string; height?: number; host: string; subtitles?: string; headers?: Record<string, string> }
type FileObserver = (file: MkvFile) => void | Promise<boolean>;
interface Lookup { signal: AbortSignal; budget: { remaining: number; failed?: boolean }; cookies: Map<string, string>; refreshed: Set<string>; invalid: Set<string>; resolutions: Resolution[]; onFile?: FileObserver }
interface FileReference { page: string; filename: string; size?: number; version?: string; height?: number; subtitles?: string }
interface EpisodeMapping { completed: boolean; files: FileReference[] }
const ORIGIN = sourceConfig.mkvdrama.url;
const PAGE_HOSTS = new Set([new URL(ORIGIN).hostname, "ouo.io", "ouo.press", "viewcrate.cc", "filecrypt.cc", "pixeldrain.com", "send.now"]);
const HOSTS = new Set(MKVDRAMA_HOSTS.map(host => host.id));
const HOUR = 60 * 60_000;
const HEIGHT = /\b(2160|1440|1080|720|540|480|360)p/i;

class InvalidLink extends Error {}

function stablePage(input: unknown): input is string {
  if (typeof input !== "string" || input.length > 2048) return false;
  try {
    const url = new URL(input);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.search && !url.hash;
  } catch { return false; }
}

function hostLink(input: string | undefined): boolean {
  if (!input) return true;
  const url = new URL(input);
  return HOSTS.has(fileHost(url.hostname) || "") || /\.(mkv|mp4)$/i.test(url.pathname);
}

function reference(file: MkvFile): FileReference | undefined {
  const page = fileHost(new URL(file.url).hostname) === "send" ? file.headers?.Referer : file.url;
  if (!stablePage(page) || file.headers && Object.keys(file.headers).some(key => key !== "Referer")) return;
  const url = new URL(page);
  const host = fileHost(new URL(file.url).hostname);
  if (!(host === "send" && url.hostname === "send.now" && /^\/[a-zA-Z0-9_-]+\/?$/.test(url.pathname) ||
    host === "pixeldrain" && url.hostname === "pixeldrain.com" && /^\/api\/file\/[a-zA-Z0-9]+\/?$/.test(url.pathname))) return;
  return { page, filename: file.filename, ...(file.size ? { size: file.size } : {}), ...(file.version ? { version: file.version } : {}),
    ...(file.height ? { height: file.height } : {}), ...(file.subtitles ? { subtitles: file.subtitles } : {}) };
}

function episodeMapping(value: unknown): value is EpisodeMapping {
  const entry = value as EpisodeMapping;
  return Boolean(entry && typeof entry.completed === "boolean" && Array.isArray(entry.files) && entry.files.length > 0 && entry.files.length <= 128 &&
    Object.keys(entry).every(key => ["completed", "files"].includes(key)) && entry.files.every(file => file && stablePage(file.page) &&
      typeof file.filename === "string" && file.filename.length <= 1024 &&
      (file.size === undefined || Number.isSafeInteger(file.size) && file.size > 0) &&
      (file.version === undefined || typeof file.version === "string" && file.version.length <= 256) &&
      (file.height === undefined || Number.isSafeInteger(file.height) && file.height > 0) &&
      (file.subtitles === undefined || typeof file.subtitles === "string" && file.subtitles.length <= 100) &&
      Object.keys(file).every(key => ["page", "filename", "size", "version", "height", "subtitles"].includes(key))));
}

// Unknown signature lifetimes are deliberately not cached. Shared records never contain playback URLs.
function playbackTtl(files: MkvFile[]): number {
  if (!files.length || Buffer.byteLength(JSON.stringify(files)) > 64 * 1024) return 0;
  let ttl = 2 * 60_000;
  for (const file of files) {
    const url = new URL(file.url);
    const expiry = [...url.searchParams].find(([key]) => /^(exp|expires|expiry|expire|e)$/i.test(key))?.[1];
    if (expiry) {
      const value = Number(expiry);
      if (!Number.isFinite(value)) return 0;
      ttl = Math.min(ttl, (value < 1e12 ? value * 1000 : value) - Date.now() - 5000);
    } else if (url.search || url.hostname !== "pixeldrain.com" || !/^\/api\/file\/[a-zA-Z0-9]+\/?$/.test(url.pathname)) return 0;
  }
  return Math.max(0, ttl);
}

export function pageFetcher(env: NodeJS.ProcessEnv = process.env): Fetcher {
  const encryptedHellos = new Cache<string>(1);
  let proxy: string | undefined;
  const value = env.MKVDRAMA_PROXY_URL?.trim();
  if (value) {
    const message = "MKVDRAMA_PROXY_URL must be an HTTP, HTTPS, SOCKS5 or SOCKS5H proxy URL without a path, query or fragment";
    let url: URL;
    try { url = new URL(value); } catch { throw new Error(message); }
    if (!["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol) || !url.hostname ||
      url.pathname && url.pathname !== "/" || url.search || url.hash) throw new Error(message);
    proxy = url.href;
  }
  return async (input, options) => {
    const { Session, CurlOpt } = await import("impers");
    options?.signal?.throwIfAborted();
    // Lookup cookies are managed by read(); never share a native client's cookie jar between lookups.
    const client = new Session({ impersonate: "chrome", allowRedirects: false, proxy });
    const limit = new AbortController();
    const signal = options?.signal ? AbortSignal.any([options.signal, limit.signal]) : limit.signal;
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      const curlOptions = proxy ? { [CurlOpt.NOPROXY]: "" } : undefined;
      if (curlOptions && new URL(String(input)).hostname === "viewcrate.cc") {
        // CONNECT skips the origin DNS lookup that normally supplies Chrome's ECH configuration.
        curlOptions[CurlOpt.ECH] = "ecl:" + await encryptedHellos.get("viewcrate.cc", 60_000, async () => {
          const response = await timed("mkv.dnsHttp", () => fetch("https://dns.google/resolve?name=viewcrate.cc&type=HTTPS", { signal, redirect: "error" }));
          if (!response.ok) { await response.body?.cancel(); throw new Error("ViewCrate TLS configuration unavailable"); }
          const dns = JSON.parse(await readLimited(response, 16 * 1024));
          const record = (Array.isArray(dns.Answer) ? dns.Answer : []).find(
            (record: { type?: number; data?: string }) => record?.type === 65 && typeof record.data === "string");
          const config = record?.data.match(/(?:^|\s)ech="?([a-zA-Z0-9+/]+={0,2})(?:"|\s|$)/)?.[1];
          if (dns.Status !== 0 || !config) throw new Error("ViewCrate TLS configuration unavailable");
          return config;
        });
      }
      const response = await client.request(options?.method === "POST" ? "POST" : "GET", String(input), {
        headers: Object.fromEntries(new Headers(options?.headers)),
        content: options?.body == null ? undefined : String(options.body), signal, stream: true, curlOptions,
        headerCallback(chunk) {
          if (/^content-type:\s*(video|audio)\//im.test(chunk.toString())) limit.abort(new Error("Download page returned media instead of links"));
        },
        contentCallback(chunk) {
          size += chunk.length;
          if (size > 1024 * 1024) limit.abort(new Error("Response exceeded size limit"));
          else chunks.push(chunk);
        }
      });
      return new Response([204, 205, 304].includes(response.status) ? null : Buffer.concat(chunks),
        { status: response.status, statusText: response.statusText, headers: [...response.headers] });
    } catch (error) {
      signal.throwIfAborted();
      if (proxy) throw new Error("MKVDrama proxy request failed; check proxy connectivity, credentials and TLS certificate");
      throw error;
    }
    finally { await client.close(); }
  };
}

function absolute(input: string | undefined, base: string): string | undefined {
  if (!input) return;
  try { return webUrl(new URL(input, base).href); } catch { return; }
}

function identity(input: string): { name: string; season?: number } {
  const name = input.replace(/\s*\((?:19|20)\d{2}\)\s*$/, "").trim();
  const season = name.match(/\s+(?:season\s*|s)(\d+)$/i);
  return { name: normalized(season ? name.slice(0, season.index) : name), season: season ? Number(season[1]) : undefined };
}

function decryptPayload(payload: { d: string; s: string }, key: Buffer): string {
  const bytes = Buffer.from(payload.d, "base64");
  const decipher = createDecipheriv(key.length === 16 ? "aes-128-gcm" : "aes-256-gcm", key, Buffer.from(payload.s, "hex"));
  decipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString("utf8");
}

function wanted(filename: string, request: VideoRequest, season: number): boolean {
  if (!/\.(mkv|mp4)$/i.test(filename) || /\b(?:trailer|preview|sample|teaser|bonus)\b/i.test(filename)) return false;
  const numbered = filename.match(/\bS(\d+)E(\d+)\b/i);
  if (request.type === "movie") return !numbered;
  if (numbered) return Number(numbered[1]) === request.season && Number(numbered[2]) === request.episode;
  const episode = filename.match(/(?:^|[. _-])(?:EP?|Episode[. _-]*)(\d+)(?=[. _-]|$)/i);
  return season === request.season && Number(episode?.[1]) === request.episode;
}

function file(url: string, filename: string, request: VideoRequest, season: number, quality: string, size?: number): MkvFile[] {
  if (!wanted(filename, request, season)) return [];
  const height = Number((filename + " " + quality).match(HEIGHT)?.[1]) || undefined;
  return [{ url, filename, height, host: hostLabel(url), ...(Number.isSafeInteger(size) && size! > 0 ? { size } : {}) }];
}

function disabledBundle(quality: string, url: string | undefined, text: string, resolutions: Resolution[]): boolean {
  if (resolutions.length === RESOLUTIONS.length) return false;
  const match = quality.match(HEIGHT);
  // Only a standalone resolution label (including the site's "1080pHD" form) proves exclusivity.
  if (!match || !/^(?:HD)?$/i.test(quality.replace(HEIGHT, "").trim())) return false;
  const height = Number(match[1]);
  let hints = text;
  if (url) {
    const path = new URL(url).pathname;
    if (/\.(mkv|mp4)$/i.test(path)) {
      try { hints += " " + decodeURIComponent(path.split("/").pop()!); }
      catch { return false; }
    }
  }
  if ([...hints.matchAll(new RegExp(HEIGHT, "gi"))].some(hint => Number(hint[1]) !== height)) return false;
  const resolution = resolutionFor(height);
  return resolution === undefined || !resolutions.includes(resolution);
}

export class MkvDrama {
  readonly source = { ...MKVDRAMA_SOURCE, url: ORIGIN };
  private cache = new Cache<MkvFile[]>(128);
  private checks = new Cache<{ available: boolean; checkedAt: string; responseMs?: number; error?: string }>(1);
  private redirects = new Cache<string>(128);
  private pages: DiscoveryCache<string[]>;
  private episodes: DiscoveryCache<EpisodeMapping>;
  private retryAt = 0;
  private state: { lastSuccess?: string; lastError?: string } = {};
  constructor(private fetcher: Fetcher = pageFetcher(), private timeout = 30_000, store = new DiscoveryStore()) {
    this.pages = new DiscoveryCache("shows", 128, (value): value is string[] => Array.isArray(value) && value.length > 0 && value.length <= 4 &&
      value.every(url => stablePage(url) && new URL(url).origin === ORIGIN), store);
    this.episodes = new DiscoveryCache("episodes", 256, episodeMapping, store);
  }

  status() { return { ...MKVDRAMA_SOURCE, ...this.state }; }

  private lookup(onFile?: FileObserver, resolutions = RESOLUTIONS): Lookup {
    return { signal: AbortSignal.timeout(this.timeout), budget: { remaining: 96 }, cookies: new Map(), refreshed: new Set(), invalid: new Set(), resolutions, onFile };
  }

  private async read(url: string, lookup: Lookup, init: RequestInit = {}): Promise<{ text: string; redirect?: string }> {
    return mkvNetwork.run(() => this.readPage(url, lookup, init), lookup.signal);
  }

  private async readPage(url: string, lookup: Lookup, init: RequestInit): Promise<{ text: string; redirect?: string }> {
    const target = new URL(url);
    const verification = target.hostname === "www.google.com" && /^\/recaptcha\/api2\/(anchor|reload)$/.test(target.pathname);
    if (target.protocol !== "https:" || target.port || target.username || target.password || !PAGE_HOSTS.has(target.hostname) && !verification) {
      throw new Error("Unsupported download page");
    }
    lookup.signal.throwIfAborted();
    if (--lookup.budget.remaining < 0) throw new Error("Download lookup exceeded its request budget");
    const headers = new Headers(init.headers);
    if (!headers.has("Accept")) headers.set("Accept", "text/html");
    const cookie = lookup.cookies.get(target.origin);
    if (cookie) headers.set("Cookie", cookie);
    const response = await timed("mkv.http", () => this.fetcher(url, { ...init, headers, signal: lookup.signal, redirect: "manual" }));
    const cookies = response.headers.getSetCookie().map(value => value.split(";", 1)[0]);
    if (cookies.length) lookup.cookies.set(target.origin, [...new Map([...(cookie?.split("; ") || []), ...cookies]
      .map(value => [value.slice(0, value.indexOf("=")), value])).values()].join("; "));
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const redirect = absolute(response.headers.get("Location") || undefined, url);
      if (!redirect) throw new Error("Download redirect has no destination");
      return { text: "", redirect };
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404 || response.status === 410) throw new InvalidLink(`Download page HTTP ${response.status}`);
      throw new Error(response.status === 403 ? "Access blocked (HTTP 403; browser verification may be required)" : `Download page HTTP ${response.status}`);
    }
    if (/^(video|audio)\//i.test(response.headers.get("Content-Type") || "")) {
      await response.body?.cancel();
      throw new Error("Download page returned media instead of links");
    }
    if (response.status === 204 || response.status === 205) return { text: "" };
    const text = await readLimited(response, 1024 * 1024);
    if (/<title>\s*(?:Just a moment|Attention Required)|id=["']challenge-form/i.test(text)) {
      throw new Error("Browser verification required");
    }
    return { text };
  }

  check() {
    return this.checks.get("availability", 30_000, async () => {
      const start = performance.now();
      try {
        const page = await this.read(`${ORIGIN}/search?q=drama`, this.lookup());
        if (page.redirect || !load(page.text)("article.bs, .listupd").length) throw new Error("Search page not readable");
        return { available: true, checkedAt: new Date().toISOString(), responseMs: Math.round(performance.now() - start) };
      } catch (error) {
        return { available: false, checkedAt: new Date().toISOString(), error: error instanceof Error ? error.message : "Source unavailable" };
      }
    });
  }

  streams(title: Title, request: VideoRequest, episodeYear?: number, onFile?: FileObserver, resolutions: readonly Resolution[] = RESOLUTIONS): Promise<MkvFile[]> {
    const selection = RESOLUTIONS.filter(resolution => resolutions.includes(resolution));
    const key = JSON.stringify([title.names, title.year, request.type, request.season, request.episode, episodeYear, selection]);
    const lookup = this.lookup(onFile, selection);
    let loaded = false;
    const discover = async () => {
      loaded = true;
      if (Date.now() < this.retryAt) throw new Error("MKVDrama: temporarily unavailable");
      try {
        const files = await this.find(title, request, lookup, episodeYear);
        this.state = { lastSuccess: new Date().toISOString() };
        this.retryAt = 0;
        return files;
      } catch (error) {
        this.retryAt = Date.now() + 20_000;
        this.state.lastError = error instanceof Error ? error.message : "Lookup failed";
        throw error;
      }
    };
    return this.cache.get(key, playbackTtl, discover).then(async files => {
      if (!loaded) await this.observed(files, lookup);
      if (lookup.invalid.size) {
        this.cache.delete(key);
        if (!loaded) {
          lookup.invalid.clear();
          lookup.refreshed.add("playback");
          files = await this.cache.get(key, playbackTtl, discover);
          if (lookup.invalid.size) this.cache.delete(key);
        }
      }
      return files;
    });
  }

  private async observed(files: MkvFile[], lookup: Lookup): Promise<MkvFile[]> {
    await Promise.all(files.map(async file => { if (await lookup.onFile?.(file)) lookup.invalid.add(file.url); }));
    return files;
  }

  private async downloads(url: string, lookup: Lookup, minAge: number): Promise<string> {
    const headers = { Accept: "application/json", Origin: ORIGIN, Referer: url,
      "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty", "Sec-Fetch-Site": "same-origin" };
    // This is the current public site's anonymous download-panel preparation route.
    const seed = JSON.parse((await this.read(url.replace(/\/$/, "") + "/_vb3k_mnxr_w", lookup, { method: "POST", headers })).text);
    const gate = absolute(seed.gate_path, ORIGIN), pass = absolute(seed.pass_path, ORIGIN);
    if (!gate || !pass || new URL(gate).origin !== ORIGIN || new URL(pass).origin !== ORIGIN ||
      typeof seed.dec_key !== "string" || !/^[a-f0-9]{64}$/i.test(seed.dec_key)) throw new Error("Download access seed not readable");
    const cookie = lookup.cookies.get(ORIGIN)?.split("; ").find(value => value.startsWith("_akx="))?.slice(5);
    if (!cookie) throw new Error("Download access cookie missing");
    const access = JSON.parse(decryptPayload(JSON.parse(Buffer.from(cookie, "base64url").toString("utf8")), Buffer.from(seed.dec_key, "hex")));
    if (typeof access.n !== "string" || typeof access.v !== "string") throw new Error("Download access payload not readable");
    await delay(Math.min(Math.max(minAge, 0), 2000), undefined, { signal: lookup.signal });
    const options = { method: "POST", headers: { ...headers, "Content-Type": "application/json" } };
    await this.read(gate, lookup, { ...options, body: JSON.stringify({ r: null, i: false, w: false, [access.n]: access.v }) });
    const payload = JSON.parse((await this.read(pass, lookup, { ...options,
      body: JSON.stringify({ r: null, w: false, [access.n]: access.v }) })).text);
    const gateUrl = new URL(gate);
    return decryptPayload(payload, createHash("sha256").update(`access-payload:${gateUrl.pathname}${gateUrl.search}`).digest());
  }

  private branch(lookup: Lookup): Lookup { return { ...lookup, cookies: new Map(lookup.cookies) }; }

  private async together<T>(items: T[], work: (item: T, lookup: Lookup) => Promise<MkvFile[]>, lookup: Lookup, limit = 2): Promise<MkvFile[]> {
    // Let chains reach a host before a wide listing spends the shared budget on every sibling's first steps.
    const results: PromiseSettledResult<MkvFile[]>[] = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        try {
          lookup.signal.throwIfAborted();
          results[index] = { status: "fulfilled", value: await work(items[index], this.branch(lookup)) };
        } catch (reason) { results[index] = { status: "rejected", reason }; }
      }
    }));
    if (results.some(result => result.status === "rejected")) lookup.budget.failed = true;
    const files = results.flatMap(result => result.status === "fulfilled" ? result.value : []);
    if (!files.length) {
      const error = results.find(result => result.status === "rejected");
      if (error?.status === "rejected") throw error.reason;
    }
    return files;
  }

  private async find(title: Title, request: VideoRequest, lookup: Lookup, episodeYear?: number): Promise<MkvFile[]> {
    const names = new Set(title.names.map(name => identity(name).name));
    const visited = new Set<string>(), excluded = new Set<string>();
    for (const name of title.names.slice(0, 3)) {
      const key = JSON.stringify([title.names, title.year, request.type, request.season, episodeYear, name]);
      let searched = false;
      const search = async () => {
        searched = true;
        const page = await this.read(`${ORIGIN}/search?${new URLSearchParams({ q: name })}`, lookup);
        if (page.redirect) throw new Error("Search redirected instead of returning results");
        const $ = load(page.text);
        if (!$(".listupd, article.bs").length) throw new Error("Search page not readable");
        return $("article.bs").toArray().filter(element => {
          const card = $(element), link = card.find('a[itemprop="url"], a.tip').first();
          const found = identity(link.attr("title") || card.find("b, h2").first().text());
          return names.has(found.name) && (!found.season || found.season === request.season);
        }).slice(0, 4).map(element => absolute($(element).find('a[itemprop="url"], a.tip').first().attr("href"), ORIGIN))
          .filter((url): url is string => Boolean(url && new URL(url).origin === ORIGIN));
      };
      let urls = await this.pages.get(key, urls => urls.length ? 6 * HOUR : 0, search, lookup.signal);
      for (let attempt = 0; attempt < 2; attempt++) {
        for (const url of urls) {
          if (visited.has(url)) continue;
          visited.add(url);
          const episodeKey = JSON.stringify([url, title.names, title.year, request.type, request.season, request.episode, episodeYear, lookup.resolutions]);
          let fresh: MkvFile[] | undefined;
          const discover = async (): Promise<EpisodeMapping> => {
            const result = await this.discover(url, title, names, request, lookup, episodeYear);
            if (result.excluded) excluded.add(url);
            fresh = result.files;
            const refs = fresh.map(reference);
            // Never save a partial source set when one host has only a transient locator.
            return { completed: result.completed, files: !lookup.budget.failed && !lookup.invalid.size && refs.every(ref => ref !== undefined) ? refs : [] };
          };
          const ttl = (entry: EpisodeMapping) => entry.files.length ? (entry.completed ? 24 * HOUR : HOUR / 2) : 0;
          let mapping: EpisodeMapping;
          const refresh = lookup.refreshed.has("playback") && !lookup.refreshed.has(episodeKey);
          if (refresh) lookup.refreshed.add(episodeKey);
          try { mapping = await this.episodes.get(episodeKey, ttl, discover, lookup.signal, refresh); }
          catch (error) { if (error instanceof InvalidLink) continue; throw error; }
          if (!fresh) {
            let invalid = false;
            fresh = await this.together(mapping.files, async (ref, branch) => {
              try {
                const files = await this.resolve(ref.page, request, request.season || 1, ref.height ? `${ref.height}p` : "", branch);
                if (!files.length || files.some(file => file.filename !== ref.filename ||
                  ref.size !== undefined && file.size !== undefined && file.size !== ref.size ||
                  ref.version !== undefined && file.version !== undefined && file.version !== ref.version)) invalid = true;
                return files.map(file => ({ ...file, height: file.height || ref.height, subtitles: file.subtitles || ref.subtitles }));
              } catch (error) { if (error instanceof InvalidLink) { invalid = true; return []; } throw error; }
            }, lookup);
            invalid ||= fresh.some(file => lookup.invalid.has(file.url));
            if (invalid && !lookup.refreshed.has(episodeKey)) {
              lookup.refreshed.add(episodeKey);
              lookup.invalid.clear();
              const available = fresh;
              fresh = undefined;
              try { await this.episodes.get(episodeKey, ttl, discover, lookup.signal, true); }
              catch (error) { if (available.length) fresh = available; else throw error; }
            }
          }
          if (fresh?.length) return [...new Map(fresh.map(file => [file.url, file])).values()];
        }
        if (urls.some(url => excluded.has(url))) break;
        // A cached show locator may predate a newly posted episode or replacement listing.
        if (searched || lookup.refreshed.has(key)) break;
        lookup.refreshed.add(key);
        urls = await this.pages.get(key, urls => urls.length ? 6 * HOUR : 0, search, lookup.signal, true);
      }
    }
    return [];
  }

  private async discover(url: string, title: Title, names: Set<string>, request: VideoRequest, lookup: Lookup,
    episodeYear?: number): Promise<{ files: MkvFile[]; completed: boolean; excluded?: boolean }> {
    const empty = { files: [], completed: false };
    const page = await this.read(url, lookup);
    if (page.redirect) return empty;
    const detail = load(page.text), found = identity(detail("h1.entry-title, h1").first().text());
    if (!names.has(found.name) || found.season && found.season !== request.season) return empty;
    const facts = detail(".infox .spe span").toArray().map(element => detail(element).text().trim());
    const year = Number(facts.find(fact => /^Aired:|^Release(?:d)?:/i.test(fact))?.match(/\b(?:19|20)\d{2}\b/)?.[0]);
    const type = facts.find(fact => /^Type:/i.test(fact)) || "";
    const expectedYear = found.season && found.season > 1 ? episodeYear || title.year : title.year;
    if (year !== expectedYear || !type || /movie/i.test(type) !== (request.type === "movie")) return empty;
    if (!detail(".soraddlx").length && detail("#mlx-root").length) {
      const html = await this.downloads(url, lookup, Number(detail("#mlx-root").attr("data-min-age")) || 0);
      detail("#mlx-root").html(html);
    }
    if (!detail(".soraddlx").length) throw new Error("Download links require browser rendering or verification");
    const candidates = detail(".soraurlx a[href]").toArray().map(link => ({
      url: absolute(detail(link).attr("href"), url), quality: detail(link).closest(".soraurlx").find("strong").text(), text: detail(link).text()
    }));
    const links = candidates.filter(link => !disabledBundle(link.quality, link.url, link.text, lookup.resolutions))
      .sort((a, b) => (Number(b.quality.match(/\d+/)?.[0]) || 0) - (Number(a.quality.match(/\d+/)?.[0]) || 0)).slice(0, 12);
    if (!links.length && candidates.length) return { ...empty, excluded: true };
    const files = await this.together(links, (link, branch) => link.url ?
      this.resolve(link.url, request, found.season || 1, link.quality, branch) : Promise.resolve([]), lookup,
    links.every(link => hostLink(link.url)) ? 2 : 1);
    const subtitleText = facts.find(fact => /^Subtitles?:/i.test(fact))?.replace(/^Subtitles?:\s*/i, "") ||
      detail('meta[name="description"]').attr("content")?.match(/with\s+(.{1,100}?)\s+subtitles/i)?.[1];
    const subtitles = /multi(?:ple|sub)?/i.test(subtitleText || "") ? "Multiple" : subtitleText?.trim();
    const status = facts.find(fact => /^Status:/i.test(fact))?.replace(/^Status:\s*/i, "").trim();
    return { completed: /^(completed|complete|finished)$/i.test(status || ""),
      files: [...new Map(files.map(file => [file.url, { ...file,
        ...(file.subtitles || subtitles ? { subtitles: file.subtitles || subtitles } : {}) }])).values()] };
  }

  private async resolve(url: string, request: VideoRequest, season: number, quality: string, lookup: Lookup,
    depth = 0): Promise<MkvFile[]> {
    if (depth >= 8) throw new Error("Too many download redirects");
    const target = new URL(url);
    if (target.protocol !== "https:" || target.username || target.password) return [];
    const host = fileHost(target.hostname);
    if (host && !HOSTS.has(host)) return [];
    if (target.hostname === "send.now") {
      const result = await resolveSend(url, (url, options) => this.read(url, lookup, options));
      const files = file(result.url, result.filename, request, season, quality).map(file => ({ ...file, subtitles: result.subtitles, headers: result.headers }));
      return this.observed(files, lookup);
    }
    if (/\.(mkv|mp4)$/i.test(target.pathname)) {
      const files = file(url, decodeURIComponent(target.pathname.split("/").pop()!), request, season, quality);
      return this.observed(files, lookup);
    }
    if (target.hostname === "pixeldrain.com") {
      const id = target.pathname.match(/^\/u\/([a-zA-Z0-9]+)\/?$/)?.[1] ||
        target.pathname.match(/^\/api\/file\/([a-zA-Z0-9]+)\/?$/)?.[1];
      if (!id) return [];
      const info = JSON.parse((await this.read(`https://pixeldrain.com/api/file/${id}/info`, lookup)).text);
      if (info.success === false || typeof info.name !== "string" || info.can_download === false) throw new InvalidLink("PixelDrain file unavailable");
      const files = file(`https://pixeldrain.com/api/file/${id}`, info.name, request, season, quality, info.size)
        .map(file => typeof info.hash_sha256 === "string" && /^[a-f0-9]{64}$/i.test(info.hash_sha256) ? { ...file, version: info.hash_sha256 } : file);
      return this.observed(files, lookup);
    }
    if (!PAGE_HOSTS.has(target.hostname)) return [];
    // OUO quick-share links include their destination; decoding avoids a page request.
    if (["ouo.io", "ouo.press"].includes(target.hostname) && target.pathname.startsWith("/qs/")) {
      const encoded = target.searchParams.get("s");
      const destination = encoded && webUrl(Buffer.from(encoded, "base64").toString("utf8"));
      if (destination) return this.resolve(destination, request, season, quality, lookup, depth + 1);
    }
    if (["ouo.io", "ouo.press"].includes(target.hostname)) {
      const destination = await this.redirects.get(url, destination => stablePage(destination) &&
        ["pixeldrain.com", "send.now", "viewcrate.cc", "filecrypt.cc"].includes(new URL(destination).hostname) &&
        !/\.(mkv|mp4)$/i.test(new URL(destination).pathname) ? 2 * 60_000 : 0,
      () => resolveOuo(url, (url, options) => this.read(url, lookup, options)));
      return this.resolve(destination, request, season, quality, lookup, depth + 1);
    }
    const page = await this.read(url, lookup);
    if (page.redirect) return this.resolve(page.redirect, request, season, quality, lookup, depth + 1);
    const $ = load(page.text);
    if (target.origin === ORIGIN && /^\/c\/[a-zA-Z0-9_-]+\/?$/.test(target.pathname) && $("#xd[data-n][data-k][data-v]").length) {
      const [nonce, key, iv] = ["n", "k", "v"].map(attribute => {
        const pair = JSON.parse($("#xd").attr(`data-${attribute}`)!);
        if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(part => Array.isArray(part) && part.length > 0 &&
          part.length <= 64 && part.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) ||
          pair[0].length !== pair[1].length) throw new Error("Link container key not readable");
        return Buffer.from(pair[0].map((byte: number, index: number) => byte ^ pair[1][index]));
      });
      if (!/^[a-f0-9]{32}$/i.test(nonce.toString()) || key.length !== 16 || iv.length !== 12) throw new Error("Link container key not readable");
      const base = target.origin + target.pathname.replace(/\/$/, "");
      const raw = JSON.parse((await this.read(`${base}/p/${nonce}`, lookup, { headers: { Accept: "application/json", Referer: url } })).text);
      if (typeof raw.d !== "string") throw new Error("Link container not readable");
      const data = JSON.parse(decryptPayload({ d: raw.d, s: iv.toString("hex") }, key));
      if (!Array.isArray(data.links)) throw new Error("Link container file list missing");
      const links = (data.links as { url?: string; label?: string; quality?: string }[]).map(link => ({
        ...link, url: absolute(link.url, url)
      })).filter((link): link is typeof link & { url: string } => Boolean(link.url && HOSTS.has(fileHost(new URL(link.url).hostname) || "") &&
        typeof link.label === "string" && wanted(link.label, request, season)));
      return this.together(links.slice(0, 8), (link, branch) =>
        this.resolve(link.url, request, season, typeof link.quality === "string" ? link.quality : quality, branch, depth + 1), lookup);
    }
    if (target.hostname === "viewcrate.cc" && /^\/c\/[a-f0-9]+\/?$/i.test(target.pathname)) {
      const base = target.origin + target.pathname.replace(/\/$/, "");
      const raw = JSON.parse((await this.read(`${base}/bootstrap`, lookup, { headers: { Accept: "application/json", Referer: url } })).text);
      if (typeof raw.k !== "string" || typeof raw.i !== "string" || typeof raw.c !== "string") throw new Error("Link container not readable");
      const data = JSON.parse(decryptPayload({ d: raw.c, s: Buffer.from(raw.i, "base64").toString("hex") }, Buffer.from(raw.k, "base64")));
      if (!Array.isArray(data.d)) throw new Error("Link container file list missing");
      const links = (data.d as { l?: { n?: string; h?: string; u?: string }[] }[]).flatMap(group => Array.isArray(group.l) ? group.l : [])
        .filter(link => typeof link.h === "string" && HOSTS.has(fileHost(link.h) || "") && typeof link.n === "string" && typeof link.u === "string" &&
          /^[a-zA-Z0-9_-]{1,128}$/.test(link.u) && wanted(link.n.replace(/\s+\d+(?:\.\d+)?\s*[KMGT]i?B$/i, ""), request, season));
      // Confirm each filename at its host; bootstrap/open tokens never enter shared storage.
      return this.together(links.slice(0, 8), (link, branch) =>
        this.resolve(`${base}/open/${link.u}?privacy=noreferrer`, request, season, quality, branch, depth + 1), lookup);
    }
    const refresh = $('meta[http-equiv="refresh" i]').attr("content")?.match(/url\s*=\s*['"]?([^'"]+)$/i)?.[1];
    const redirect = absolute(refresh, url);
    if (redirect) return this.resolve(redirect, request, season, quality, lookup, depth + 1);
    const links = $("ul.link-list a[href], a#download, a.download, a.external_link").toArray().slice(0, 16)
      .map(element => absolute($(element).attr("href"), url)).filter((link): link is string => Boolean(link));
    const files = await this.together(links, (link, branch) => this.resolve(link, request, season, quality, branch, depth + 1), lookup,
      links.every(hostLink) ? 2 : 1);
    if (!files.length) throw new Error("No readable direct download links");
    return files;
  }
}
