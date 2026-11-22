import { createHash } from "node:crypto";
import { Cache } from "./cache.js";
import { extractPlayback, episodeNormalizer, type Edition } from "./episodes.js";
import { reconcileSeason, type SeasonMatches, type SeasonScope } from "./episode-matching.js";
import { count, timed } from "./loading.js";
import type { ApiSeason, Title, VideoRequest } from "./metadata.js";
import { chineseKind, normalized, value, type Kind, type Page, type Vod } from "./model.js";
import type { Provider } from "./providers.js";

export interface VodMatch { vod: Vod; url: string; group: string; edition?: Edition }
interface VerifiedRecord {
  vod: Vod;
  kind: Kind;
  scope: SeasonScope;
}

function chineseOrdinal(number: number): string {
  const digits = "零一二三四五六七八九";
  if (number < 10) return digits[number];
  if (number < 100) return `${number >= 20 ? digits[Math.floor(number / 10)] : ""}十${number % 10 ? digits[number % 10] : ""}`;
  return String(number);
}

const keepRunning = {
  regular: { id: "98031", renameAfter: 4, original: "奔跑吧兄弟", renamed: "奔跑吧" },
  special: { id: "239870", prefix: "奔跑吧" }
};

function listingTitles(names: string[], season: number) {
  if (season < 1) return names;
  return names.flatMap(name => [
    `${name}第${season}季`, `${name}第${chineseOrdinal(season)}季`,
    ...(season > 1 ? [`${name}${season}`, `${name} Season ${season}`, `${name} S${season}`, `${name} S${String(season).padStart(2, "0")}`] : []),
    name
  ]);
}

const digest = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
const reconciliations = new WeakMap<Provider, Cache<SeasonMatches>>();
const extracted = new WeakMap<Vod, ReturnType<typeof extractPlayback>>();
const fingerprints = new WeakMap<Vod, string>();
const seasonFingerprints = new WeakMap<ApiSeason, string>();

function entriesFor(vod: Vod, provider: Provider) {
  let entries = extracted.get(vod);
  if (!entries) {
    entries = extractPlayback(vod, provider.source.id);
    extracted.set(vod, entries);
  }
  return entries;
}

function matchRecord(provider: Provider, vod: Vod, endpoint: string, kind: Kind, season: ApiSeason, scope: SeasonScope, names: string[]) {
  let cache = reconciliations.get(provider);
  if (!cache) reconciliations.set(provider, cache = new Cache(16));
  let recordKey = fingerprints.get(vod);
  if (!recordKey) {
    recordKey = digest([vod.vod_id, vod.vod_name, vod.vod_year, vod.vod_play_from, vod.vod_play_url]);
    fingerprints.set(vod, recordKey);
  }
  let seasonKey = seasonFingerprints.get(season);
  if (!seasonKey) {
    seasonKey = digest(season);
    seasonFingerprints.set(season, seasonKey);
  }
  const compute = async () => {
    const entries = entriesFor(vod, provider);
    const labels = await timed("vod.normalize", async () => {
      const normalize = episodeNormalizer(names, kind === "variety");
      return entries.map(entry => normalize(entry.label));
    });
    return timed("vod.reconcile", async () => reconcileSeason(entries, labels, season, scope));
  };
  // Keep oversized seasons and playlists out of the derived cache. They can still reconcile on demand.
  if (value(vod.vod_play_url).length > 128 * 1024 || season.episodes.length > 1500) return compute();
  const key = JSON.stringify([endpoint, recordKey, seasonKey, scope, kind, names]);
  const hit = cache.peek(key);
  if (hit) { count("vod.reconciliationHits"); return hit; }
  return cache.get(key, 2 * 60_000, compute);
}

const { Converter } = require("opencc-js") as typeof import("opencc-js", { with: { "resolution-mode": "import" } });
const simplify = Converter({ from: "t", to: "cn" });
const traditionalize = Converter({ from: "cn", to: "t" });

export async function discoverVod(provider: Provider, title: Title, request: VideoRequest,
  seasonData: Promise<ApiSeason>, includeExtras: boolean): Promise<VodMatch[]> {
  const episodic = request.type === "series";
  const catalogSeason = request.season ?? 0;
  const primaryNames = [...new Set([...title.names, title.nativeName, ...title.apiAliases || []].filter((name): name is string => Boolean(name)))];
  const special = episodic && title.tmdbId === keepRunning.special.id;
  const renamed = episodic && title.tmdbId === keepRunning.regular.id;
  const local = renamed && catalogSeason > keepRunning.regular.renameAfter ? catalogSeason - keepRunning.regular.renameAfter : catalogSeason;
  let summary = title.seasons?.find(season => season.number === catalogSeason);
  if (special && (!summary?.name || !summary.year)) {
    const season = await seasonData;
    if (season.name && season.year) summary = { number: catalogSeason, name: season.name, year: season.year };
  }
  const theme = special && summary && normalized(summary.name).match(/^(.*篇)(?:第(\d+)季)?$/);
  if (special && (!theme || !summary?.year)) { count("vod.discovery.seasonMismatch"); return []; }
  const providerSeason = theme ? Number(theme[2] || 1) : local;
  const names = theme ? [`${keepRunning.special.prefix}·${theme[1]}`] :
    renamed ? [...new Set([local !== catalogSeason ? keepRunning.regular.renamed : keepRunning.regular.original, ...primaryNames])] : primaryNames;
  const seasonName = !special && !renamed && summary?.name && !/^(?:season|第)?\s*\d+\s*(?:[季輯辑])?$/i.test(summary.name) &&
    !/^(?:specials|特别篇|特別篇|特别节目)$/i.test(summary.name) ? summary.name : undefined;
  // A localized season title is usable by itself only when it contains a verified series identity.
  const themedNames = seasonName ? names.flatMap(name => normalized(seasonName).startsWith(normalized(name))
    ? [seasonName] : [`${name} ${seasonName}`]) : [];
  const plain = (name: string) => name.normalize("NFKC").replace(/[\p{P}\p{Z}\s]/gu, "");
  const variants = [...new Set([...names, ...names.flatMap(name => [simplify(name), traditionalize(name)])])];
  const titles = [...listingTitles(variants, providerSeason), ...themedNames];
  const identity = (name: string) => normalized(simplify(name));
  const allowed = new Set(titles.map(identity));
  const base = new Set(names.map(identity));
  const exactQueries = [
    ...(providerSeason > 1 ? listingTitles(names.slice(0, 2), providerSeason).filter(name => !names.includes(name)) : []),
    ...themedNames, ...names.slice(0, 5)
  ];
  const queries = [...new Set([...exactQueries, ...exactQueries.map(plain), ...variants.slice(0, 8), ...(special ? [keepRunning.special.prefix] : [])])].slice(0, 24);
  const mappingKey = JSON.stringify([request.type, title.tmdbId, catalogSeason, names, summary, title.year]);

  function identify(vod: Vod, year: number, broadcastYears: Set<number>): VerifiedRecord | undefined {
    const kind = chineseKind(vod);
    if (!kind || (episodic ? kind === "movie" : kind !== "movie")) return;
    const vodYear = Number(value(vod.vod_year).replace(/\s*[（(][^）)]*[）)]$/, ""));
    if (!vodYear) return;
    let name = identity(value(vod.vod_name));
    const annual = kind === "variety" ? name.match(/^(.*)((?:19|20)\d{2})$/) : undefined;
    if (annual?.[2] === String(vodYear) && base.has(annual[1])) name = annual[1];
    if (kind === "animation" && providerSeason === 1 && name.endsWith("1") && base.has(name.slice(0, -1))) name = name.slice(0, -1);
    const collection = !special && base.has(name) && (catalogSeason === 0 && episodic || catalogSeason > 1 && vodYear === title.year);
    const annualSlice = !collection && annual?.[2] === String(vodYear) && vodYear !== year && broadcastYears.has(vodYear);
    if (!allowed.has(name) || (!collection && !annualSlice && vodYear !== year)) return;
    return { vod, kind, scope: { providerSeason: collection ? catalogSeason : providerSeason,
      collection: collection || annualSlice, localNumbering: !collection && (special || !base.has(name)), fullBroadcast: special } };
  }

  async function verify(page: Pick<Page, "items" | "endpoint">, hydrate = false): Promise<VerifiedRecord[]> {
    const season = await seasonData;
    const requested = season.episodes.find(episode => episode.number === request.episode);
    const year = episodic ? summary?.year || season.year || (catalogSeason > 1 ? requested?.year : undefined) || title.year : title.year;
    const broadcastYears = new Set(season.episodes.flatMap(episode => episode.year ? [episode.year] : []));
    const verified = (items: Vod[]) => items.flatMap(vod => identify(vod, year, broadcastYears) || []);
    const records = verified(page.items);
    if (!hydrate) return records;
    const ids = [...new Set(records.flatMap(({ vod }) => !value(vod.vod_play_url) && /^[1-9]\d*$/.test(value(vod.vod_id))
      ? [value(vod.vod_id)] : []))];
    if (!ids.length) return records;
    const byId = new Map<string, Vod>();
    for (let start = 0; start < ids.length; start += 100) {
      const detail = await provider.details(ids.slice(start, start + 100));
      // ID namespaces are endpoint-specific, including when a backup serves the detail request.
      if (detail.endpoint !== page.endpoint) { count("vod.discovery.endpointMismatch"); break; }
      for (const vod of detail.items) byId.set(value(vod.vod_id), vod);
    }
    return verified(records.map(({ vod }) => byId.get(value(vod.vod_id)) || vod));
  }

  async function select(records: VerifiedRecord[], endpoint: string): Promise<VodMatch[]> {
    const season = await seasonData;
    const matches = await Promise.all(records.map(async ({ vod, kind, scope }): Promise<VodMatch[]> => {
      if (kind === "movie") return entriesFor(vod, provider).flatMap(entry =>
        entry.url && entry.label ? [{ vod, url: entry.url, group: entry.group }] : []);
      const result = await matchRecord(provider, vod, endpoint, kind, season, scope,
        [...new Set([value(vod.vod_name), ...titles])]);
      if (!result.results.length) count("vod.discovery.emptyPlayback");
      for (const [reason, total] of result.counts) count(reason, total);
      return (result.byEpisode.get(request.episode!) || []).flatMap(({ entry, label }) =>
        entry.url && (includeExtras || !label.edition) ? [{ vod, url: entry.url, group: entry.group, edition: label.edition }] : []);
    }));
    return matches.flat();
  }

  const mapped = provider.cachedMatch(mappingKey);
  let cachedExtras: VodMatch[] = [];
  if (mapped) {
    const page = await mapped;
    const records = await verify(page);
    if (records.length && records.length === page.items.length) {
      const streams = await select(records, page.endpoint);
      if (streams.some(stream => !stream.edition)) return streams;
      cachedExtras = streams;
    } else provider.forgetMatch(mappingKey);
  }
  let discovered = false;
  let extras = cachedExtras;
  const seen = new Set<string>();
  const discoveredRecords = new Map<string, Map<string | Vod, Vod>>();
  let remaining = 24;
  const searchDeadline = performance.now() + 12_000;
  for (const query of queries) {
    for (let number = 1; number <= 5 && remaining > 0 && performance.now() < searchDeadline; number++) {
      remaining--;
      const page = await provider.page(number, undefined, query);
      const unique = page.items.filter(vod => {
        const id = value(vod.vod_id);
        if (!id) return true;
        const key = JSON.stringify([page.endpoint, id, value(vod.vod_play_url)]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const verified = await verify({ ...page, items: unique }, true);
      if (verified.length) {
        discovered = true;
        // Remember show identity independently of whether this episode exists.
        let records = discoveredRecords.get(page.endpoint);
        if (!records) discoveredRecords.set(page.endpoint, records = new Map());
        for (const { vod } of verified) records.set(value(vod.vod_id) || vod, vod);
        provider.rememberMatch(mappingKey, [...records.values()], page.endpoint);
      }
      const streams = await select(verified, page.endpoint);
      if (streams.some(stream => !stream.edition)) return [...streams, ...extras];
      extras = [...extras, ...streams];
      if (number >= page.pages) break;
      if (number === 5) count("vod.discovery.pageLimit");
    }
    if (remaining <= 0 || performance.now() >= searchDeadline) { count("vod.discovery.queryLimit"); break; }
  }
  if (!discovered && !mapped) count("vod.discovery.showNotFound");
  return extras;
}
