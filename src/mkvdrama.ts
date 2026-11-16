import { createDecipheriv, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { load } from "cheerio";
import { Impit } from "impit";
import { Cache, Pool, readLimited } from "./cache.js";
import type { Title, VideoRequest } from "./metadata.js";
import { normalized, webUrl } from "./model.js";
import type { Fetcher } from "./providers.js";

export const MKVDRAMA_SOURCE = { id: "mkvdrama", name: "MKVDrama" };
export interface MkvFile { url: string; filename: string; size?: number; height?: number }
interface Lookup { signal: AbortSignal; remaining: number; cookies: Map<string, string> }
const ORIGIN = "https://mkvdrama.net";
const PAGE_HOSTS = new Set(["mkvdrama.net", "ouo.io", "ouo.press", "viewcrate.cc", "filecrypt.cc", "pixeldrain.com"]);

function pageFetcher(): Fetcher {
  const client = new Impit({ browser: "chrome" });
  return async (input, options) => {
    const response = await client.fetch(input, { method: options?.method === "POST" ? "POST" : "GET",
      headers: new Headers(options?.headers), body: options?.body == null ? undefined : String(options.body),
      signal: options?.signal || undefined, redirect: "manual" });
    return new Response([204, 205, 304].includes(response.status) ? null : response.body,
      { status: response.status, statusText: response.statusText, headers: response.headers });
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
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.s, "hex"));
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
  const height = Number((filename + " " + quality).match(/\b(2160|1440|1080|720|540|480)p/i)?.[1]) || undefined;
  return [{ url, filename, height, ...(Number.isSafeInteger(size) && size! > 0 ? { size } : {}) }];
}

export class MkvDrama {
  readonly source = { ...MKVDRAMA_SOURCE, url: ORIGIN };
  private cache = new Cache<MkvFile[]>(128);
  private checks = new Cache<{ available: boolean; checkedAt: string; responseMs?: number; error?: string }>(1);
  private pool = new Pool(2);
  private retryAt = 0;
  private state: { lastSuccess?: string; lastError?: string } = {};
  constructor(private fetcher: Fetcher = pageFetcher(), private timeout = 8000) {}

  status() { return { ...MKVDRAMA_SOURCE, ...this.state }; }

  private lookup(): Lookup { return { signal: AbortSignal.timeout(this.timeout), remaining: 32, cookies: new Map() }; }

  private async read(url: string, lookup: Lookup, init: RequestInit = {}): Promise<{ text: string; redirect?: string }> {
    const target = new URL(url);
    if (target.protocol !== "https:" || target.port || target.username || target.password || !PAGE_HOSTS.has(target.hostname)) {
      throw new Error("Unsupported download page");
    }
    lookup.signal.throwIfAborted();
    if (--lookup.remaining < 0) throw new Error("Download lookup exceeded its request budget");
    const headers = new Headers(init.headers);
    if (!headers.has("Accept")) headers.set("Accept", "text/html");
    const cookie = lookup.cookies.get(target.origin);
    if (cookie) headers.set("Cookie", cookie);
    const response = await this.fetcher(url, { ...init, headers, signal: lookup.signal, redirect: "manual" });
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

  streams(title: Title, request: VideoRequest, episodeYear?: number): Promise<MkvFile[]> {
    const key = JSON.stringify([title.names, title.year, request.type, request.season, request.episode, episodeYear]);
    return this.cache.get(key, 2 * 60_000, () => this.pool.run(async () => {
      if (Date.now() < this.retryAt) throw new Error("MKVDrama: temporarily unavailable");
      try {
        const files = await this.find(title, request, this.lookup(), episodeYear);
        this.state = { lastSuccess: new Date().toISOString() };
        this.retryAt = 0;
        return files;
      } catch (error) {
        this.retryAt = Date.now() + 20_000;
        this.state.lastError = error instanceof Error ? error.message : "Lookup failed";
        throw error;
      }
    }));
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

  private async find(title: Title, request: VideoRequest, lookup: Lookup, episodeYear?: number): Promise<MkvFile[]> {
    const names = new Set(title.names.map(name => identity(name).name));
    const visited = new Set<string>();
    for (const name of title.names.slice(0, 3)) {
      const search = await this.read(`${ORIGIN}/search?${new URLSearchParams({ q: name })}`, lookup);
      if (search.redirect) throw new Error("Search redirected instead of returning results");
      const $ = load(search.text);
      if (!$(".listupd, article.bs").length) throw new Error("Search page not readable");
      const matches = $("article.bs").toArray().filter(element => {
        const card = $(element), link = card.find('a[itemprop="url"], a.tip').first();
        const found = identity(link.attr("title") || card.find("b, h2").first().text());
        return names.has(found.name) && (!found.season || found.season === request.season);
      }).slice(0, 4);
      for (const match of matches) {
        const url = absolute($(match).find('a[itemprop="url"], a.tip').first().attr("href"), ORIGIN);
        if (!url || new URL(url).origin !== ORIGIN || visited.has(url)) continue;
        visited.add(url);
        const page = await this.read(url, lookup);
        if (page.redirect) continue;
        const detail = load(page.text), found = identity(detail("h1.entry-title, h1").first().text());
        if (!names.has(found.name) || found.season && found.season !== request.season) continue;
        const facts = detail(".infox .spe span").toArray().map(element => detail(element).text().trim());
        const year = Number(facts.find(fact => /^Aired:|^Release(?:d)?:/i.test(fact))?.match(/\b(?:19|20)\d{2}\b/)?.[0]);
        const type = facts.find(fact => /^Type:/i.test(fact)) || "";
        const expectedYear = found.season && found.season > 1 ? episodeYear || title.year : title.year;
        if (year !== expectedYear || !type || /movie/i.test(type) !== (request.type === "movie")) continue;
        if (!detail(".soraddlx").length && detail("#mlx-root").length) {
          const html = await this.downloads(url, lookup, Number(detail("#mlx-root").attr("data-min-age")) || 0);
          detail("#mlx-root").html(html);
        }
        if (!detail(".soraddlx").length) throw new Error("Download links require browser rendering or verification");
        const files: MkvFile[] = [];
        const errors: unknown[] = [];
        const links = detail(".soraurlx a[href]").toArray().map(link => ({
          url: absolute(detail(link).attr("href"), url), quality: detail(link).closest(".soraurlx").find("strong").text()
        })).sort((a, b) => (Number(b.quality.match(/\d+/)?.[0]) || 0) - (Number(a.quality.match(/\d+/)?.[0]) || 0)).slice(0, 12);
        for (const link of links) {
          if (!link.url) continue;
          try { files.push(...await this.resolve(link.url, request, found.season || 1, link.quality, lookup)); }
          catch (error) { errors.push(error); }
        }
        if (files.length) return [...new Map(files.map(file => [file.url, file])).values()];
        if (errors.length) throw errors[0];
      }
    }
    return [];
  }

  private async resolve(url: string, request: VideoRequest, season: number, quality: string, lookup: Lookup,
    depth = 0, init: RequestInit = {}): Promise<MkvFile[]> {
    if (depth >= 8) throw new Error("Too many download redirects");
    const target = new URL(url);
    if (target.protocol !== "https:" || target.username || target.password) return [];
    if (/\.(mkv|mp4)$/i.test(target.pathname)) {
      return file(url, decodeURIComponent(target.pathname.split("/").pop()!), request, season, quality);
    }
    if (target.hostname === "pixeldrain.com") {
      const id = target.pathname.match(/^\/u\/([a-zA-Z0-9]+)\/?$/)?.[1] ||
        target.pathname.match(/^\/api\/file\/([a-zA-Z0-9]+)\/?$/)?.[1];
      if (!id) return [];
      const info = JSON.parse((await this.read(`https://pixeldrain.com/api/file/${id}/info`, lookup)).text);
      if (info.success === false || typeof info.name !== "string" || info.can_download === false) return [];
      return file(`https://pixeldrain.com/api/file/${id}`, info.name, request, season, quality, info.size);
    }
    if (!PAGE_HOSTS.has(target.hostname)) return [];
    // OUO quick-share links include their destination; decoding avoids a page request.
    if (["ouo.io", "ouo.press"].includes(target.hostname) && target.pathname.startsWith("/qs/")) {
      const encoded = target.searchParams.get("s");
      const destination = encoded && webUrl(Buffer.from(encoded, "base64").toString("utf8"));
      if (destination) return this.resolve(destination, request, season, quality, lookup, depth + 1);
    }
    const page = await this.read(url, lookup, init);
    if (page.redirect) return this.resolve(page.redirect, request, season, quality, lookup, depth + 1);
    const $ = load(page.text);
    if (target.hostname === "viewcrate.cc" && /^\/c\/[a-f0-9]+\/?$/i.test(target.pathname)) {
      const id = target.pathname.split("/").filter(Boolean).pop();
      const data = JSON.parse((await this.read(`https://viewcrate.cc/api/cnl_encrypt/${id}`, lookup, { method: "POST" })).text);
      const key = typeof data.jk === "string" && data.jk.match(/return\s+['"]([a-f0-9]{32})['"]/i)?.[1];
      if (!key || typeof data.crypted !== "string") throw new Error("Link container not readable");
      const bytes = Buffer.from(data.crypted, "base64");
      const decipher = createDecipheriv("aes-128-cbc", Buffer.from(key, "hex"), bytes.subarray(0, 16));
      decipher.setAutoPadding(false);
      const links = Buffer.concat([decipher.update(bytes.subarray(16)), decipher.final()]).toString("utf8")
        .match(/https:\/\/[^\s\x00"'<>]+/g) || [];
      let pixelLinks = links.filter(link => new URL(link).hostname === "pixeldrain.com");
      const filenames = [...new Set($("[data-resolve-url] span").toArray().map(element => $(element).text().trim())
        .filter(name => /\.(mkv|mp4)$/i.test(name)))];
      // Verify the filename through the host API even when the container supplies an index.
      if (filenames.length === pixelLinks.length) pixelLinks = pixelLinks.filter((_, index) => wanted(filenames[index], request, season));
      const files: MkvFile[] = [], errors: unknown[] = [];
      for (const link of pixelLinks.slice(0, 100)) {
        try { files.push(...await this.resolve(link, request, season, quality, lookup, depth + 1)); }
        catch (error) { errors.push(error); }
      }
      if (!files.length && errors.length) throw errors[0];
      return files;
    }
    const refresh = $('meta[http-equiv="refresh" i]').attr("content")?.match(/url\s*=\s*['"]?([^'"]+)$/i)?.[1];
    const redirect = absolute(refresh, url);
    if (redirect) return this.resolve(redirect, request, season, quality, lookup, depth + 1);
    if (["ouo.io", "ouo.press"].includes(target.hostname)) {
      if ($("#form-captcha, .g-recaptcha, .cf-turnstile, script[src*='recaptcha']").length) throw new Error("OUO requires CAPTCHA verification");
      const form = $("#form-go, #form-shorten").first();
      const action = absolute(form.attr("action"), url);
      if (action && new URL(action).origin === target.origin && form.attr("method")?.toLowerCase() === "post") {
        const body = new URLSearchParams();
        form.find("input[name]").each((_, input) => { body.set($(input).attr("name")!, $(input).attr("value") || ""); });
        return this.resolve(action, request, season, quality, lookup, depth + 1,
          { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: url }, body });
      }
      throw new Error("OUO destination requires browser verification");
    }
    const files: MkvFile[] = [];
    for (const element of $("ul.link-list a[href], a#download, a.download, a.external_link").toArray().slice(0, 16)) {
      const link = absolute($(element).attr("href"), url);
      if (link) files.push(...await this.resolve(link, request, season, quality, lookup, depth + 1));
    }
    if (!files.length) throw new Error("No readable direct download links");
    return files;
  }
}
