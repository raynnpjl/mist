import { Vod, normalized, value, webUrl } from "./model.js";

export type Edition = "会员加更" | "会员版" | "加长版" | "未删减版" | "纯享版" | "花絮" | "幕后" | "特别篇" | "番外";
export type ContentType = "regular_candidate" | "member_extra" | "extended" | "alternate" | "preview" | "behind_scenes" | "special" | "unknown";

export interface EpisodeLabel {
  originalLabel: string;
  season?: number;
  number?: number;
  date?: string;
  monthDay?: string;
  compactDate?: boolean;
  part?: string;
  descriptor: string;
  finale: boolean;
  contentType: ContentType;
  edition?: Edition;
}

export interface PlaybackEntry {
  provider: string;
  showId: string;
  line: number;
  group: string;
  position: number;
  label: string;
  url?: string;
}

export function chineseNumber(input: string): number {
  if (/^\d+$/.test(input)) return Number(input);
  const digits = "零一二三四五六七八九";
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
  let total = 0, digit = 0;
  for (const char of input) {
    if (char in units) { total += (digit || 1) * units[char]; digit = 0; }
    else digit = char === "两" || char === "兩" ? 2 : char === "〇" ? 0 : digits.indexOf(char);
  }
  return total + digit;
}

const numeral = "[0-9零〇一二两兩三四五六七八九十百千]+";
const numbered = new RegExp(`^(?:第\\s*(${numeral})(?:\\s*[集期话話回]|$)|(?:episode|ep|e)\\s*(\\d+)(?![a-z0-9])|(${numeral})\\s*[集期话話回])`, "i");
const seasonPrefix = new RegExp(`^第\\s*(${numeral})\\s*[季輯辑]`);
const leadingPunctuation = /^[\p{P}\p{Z}\s]+/u;
const trim = (input: string) => input.replace(leadingPunctuation, "").trim();
const finaleTitle = /^(?:收官(?:之夜|特[辑輯]|篇|盛典)?|(?:年度)?[总總][决決][赛賽]|大[结結]局|[终終][极極]之[战戰]|finale|grandfinal)$/i;
const regularMarker = /^(?:正片|完整(?:版)?|高清|超清|\d{3,4}p|4k)$/i;

const editions: [RegExp, ContentType, Edition?][] = [
  [/^(?:[预預]告(?:片)?|(?:下期|下集|下一期)[预預]告|先[导導]片|宣[传傳]片|海[报報]|trailer|preview|teaser)$/i, "preview"],
  [/^[会會][员員]版(?:上|中|下)?$/, "member_extra", "会员版"],
  [/^(?:[会會][员員](?:[专專]享)?(?:加更|版|特[辑輯]|福利|[专專]享)?|加更(?:版)?|未播(?:片段)?|超前彩蛋|彩蛋)(?:上|中|下)?$/, "member_extra", "会员加更"],
  [/^(?:加[长長]版|[扩擴]展版|extended(?:edition|cut))$/i, "extended", "加长版"],
  [/^(?:未[删刪][减減]版|uncut)$/i, "extended", "未删减版"],
  [/^(?:舞台)?[纯純]享(?:版)?$/, "alternate", "纯享版"],
  [/^(?:花絮|拍[摄攝]花絮)$/, "behind_scenes", "花絮"],
  [/^(?:幕[后後](?:花絮|特[辑輯])?)$/, "behind_scenes", "幕后"],
  [/^(?:特[别別]篇|特[别別]版|特[别別]加更)$/, "special", "特别篇"],
  [/^番外(?:篇)?$/, "special", "番外"]
];

export function isoDate(input: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) return;
  const date = new Date(input + "T00:00:00.000Z");
  if (Number.isFinite(date.getTime()) && date.toISOString().startsWith(input)) return input;
}

function stripShow(label: string, prefixes: readonly string[]): string {
  if (!prefixes.length) return label;
  const compact = normalized(label);
  const prefix = prefixes.find(name => compact.startsWith(name));
  if (!prefix || compact.length === prefix.length) return label;
  let offset = 0, size = 0;
  for (const char of label) {
    offset += char.length;
    size += normalized(char).length;
    if (size === prefix.length) return trim(label.slice(offset));
  }
  return label;
}

export function episodeNormalizer(names: readonly string[], variety: boolean): (label: string) => EpisodeLabel {
  const prefixes = [...new Set(names.map(normalized).filter(Boolean))].sort((a, b) => b.length - a.length);
  return label => parseLabel(label, prefixes, variety);
}

export function normalizeEpisode(label: string, names: readonly string[] = [], variety = true): EpisodeLabel {
  return names.length ? episodeNormalizer(names, variety)(label) : parseLabel(label, [], variety);
}

function parseLabel(label: string, prefixes: readonly string[], variety: boolean): EpisodeLabel {
  let body = trim(stripShow(label.normalize("NFKC"), prefixes));
  let season: number | undefined;
  let number: number | undefined;
  let date: string | undefined;
  let monthDay: string | undefined;
  let compactDate = false;
  const seasonMatch = body.match(seasonPrefix) || body.match(/^season\s*(\d{1,3})(?!\d)/i);
  if (seasonMatch) {
    season = chineseNumber(seasonMatch[1]);
    body = trim(body.slice(seasonMatch[0].length));
  }
  const explicit = body.match(/^s(\d{1,3})[\s._-]*e(\d{1,5})(?!\d)/i);
  if (explicit) {
    season = Number(explicit[1]);
    number = Number(explicit[2]);
    body = trim(body.slice(explicit[0].length));
  }

  function readNumber() {
    const match = body.match(numbered);
    if (!match) return;
    number ??= chineseNumber(match[1] || match[2] || match[3]);
    body = trim(body.slice(match[0].length));
  }

  const prefix = body.match(numbered);
  const remainder = prefix && trim(body.slice(prefix[0].length));
  if (remainder && /^(?:20\d{2}(?:\d{4}|[./年-])|\d{1,2}[./月-]\d)/.test(remainder)) readNumber();
  // Keep the broadcast date and explicit period number as independent evidence.
  const full = body.match(/^(?:第\s*)?(20\d{2})(?:[./年-]\s*(\d{1,2})[./月-]\s*(\d{1,2})(?:日|號|号)?|(\d{2})(\d{2}))(?!\d)\s*期?/);
  if (full) {
    date = isoDate(`${full[1]}-${(full[2] || full[4]).padStart(2, "0")}-${(full[3] || full[5]).padStart(2, "0")}`);
    if (!date) return { originalLabel: label, season, descriptor: normalized(body), finale: false, contentType: "unknown" };
    body = trim(body.slice(full[0].length));
  } else if (variety) {
    const short = body.match(/^(?:第\s*)?(\d{1,2})[./月-]\s*(\d{1,2})(?!\d)\s*(?:日|號|号)?\s*期?/);
    const compact = short ? undefined : body.match(/^(?:第\s*)?(\d{2})(\d{2})(?=$|\s|[期上中下]|[^\x00-\x7f])/u);
    const match = short || compact;
    if (match) {
      const stamp = `${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
      if (isoDate("2000-" + stamp)) {
        monthDay = stamp;
        compactDate = Boolean(compact);
        body = trim(body.slice(match[0].length).replace(/^\s*期/, ""));
        if (compact) number ??= Number(compact[1] + compact[2]);
      } else if (short) {
        return { originalLabel: label, season, descriptor: normalized(body), finale: false, contentType: "unknown" };
      }
    }
  }
  readNumber();
  if (number === undefined) {
    const bare = body.match(/^(\d{1,5}|[零〇一二两兩三四五六七八九十百千]+)(?:$|(?=[\s\p{P}上中下]))/u);
    if (bare) {
      number = chineseNumber(bare[1]);
      body = trim(body.slice(bare[0].length));
    }
  }
  if (!number) number = undefined;

  const partMatch = body.match(/(?:^|[（(\s])([上中下])(?:[）):：\s]|$)/) ||
    body.match(/^([上中下])(?=加更|[会會][员員]|[纯純]享|花絮)/);
  const englishPart = body.match(/\bpart\s*([123])\b/i);
  const part = partMatch?.[1] || (englishPart ? ({ 1: "上", 2: "下", 3: "中" } as Record<string, string>)[englishPart[1]] : undefined);
  if (partMatch) body = body.replace(partMatch[0], "");
  else if (englishPart) body = body.replace(englishPart[0], "");
  let descriptor = normalized(body);
  if (regularMarker.test(descriptor)) descriptor = "";
  let classification = editions.find(([pattern]) => pattern.test(descriptor));
  if (classification) descriptor = "";
  else {
    // An edition marker separated from an episode title can carry the same title as its parent.
    const suffix = body.match(/^(.*?)\s*[\s(:：·|]\s*([^\s(:：·|]+)\s*\)?$/u);
    if (suffix) {
      classification = editions.find(([pattern]) => pattern.test(normalized(suffix[2])));
      if (classification) descriptor = normalized(suffix[1]);
    }
  }
  const finale = finaleTitle.test(descriptor);
  const [, contentType, edition] = classification ||
    [undefined, (number !== undefined || date || monthDay || part || finale) && (!descriptor || finale) ? "regular_candidate" : "unknown"];
  return { originalLabel: label, season, number, date, monthDay, compactDate, part, descriptor, finale, contentType, edition };
}

export function extractPlayback(vod: Vod, provider: string): PlaybackEntry[] {
  const groups = value(vod.vod_play_from).split("$$$");
  const entries: PlaybackEntry[] = [];
  for (const [line, playlist] of value(vod.vod_play_url).split("$$$").entries()) {
    if (!playlist) continue;
    for (const [position, entry] of playlist.split("#").entries()) {
      if (!entry.trim()) continue;
      const split = entry.indexOf("$");
      const url = split < 0 ? undefined : webUrl(entry.slice(split + 1));
      entries.push({ provider, showId: value(vod.vod_id), line, group: groups[line] || "HLS", position,
        label: (split < 0 ? entry : entry.slice(0, split)).trim(),
        url: url && /\.(m3u8|mp4)$/i.test(new URL(url).pathname) ? url : undefined });
    }
  }
  return entries;
}
