export type Kind = "movie" | "drama" | "variety";
export type Vod = Record<string, unknown>;
export interface Category { id: string; name: string }
export interface Page { items: Vod[]; pages: number; endpoint: string }
export interface Episode {
  key: string;
  title: string;
  released?: string;
}
export interface Playable { episode: Episode; url: string; group: string }

export const value = (input: unknown): string =>
  typeof input === "string" || typeof input === "number" ? String(input).trim() : "";

const languages = new Intl.DisplayNames(["en"], { type: "language" });
export function subtitleLanguages(codes: unknown[]): string | undefined {
  const names = new Set<string>();
  for (const language of codes) {
    if (typeof language !== "string") continue;
    const code = language.trim().replace(/_/g, "-").toLowerCase();
    if (code === "und" || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(code)) continue;
    try { names.add(languages.of(code) || code); } catch { /* Ignore malformed language tags. */ }
  }
  return names.size > 1 ? "Multiple" : [...names][0];
}

export function normalized(input: string): string {
  return input.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, "");
}

const movies = /^(电影|电影片|动作片|喜剧片|爱情片|科幻片|恐怖片|剧情片|战争片|悬疑片|惊悚片|犯罪片|奇幻片|冒险片|武侠片|古装片|灾难片|纪录片|记录片)$/;
const dramas = /^(国产剧|大陆剧|内地剧|香港剧|港澳剧|台湾剧|港台剧)$/;
const variety = /^(大陆综艺|港台综艺|国产综艺|综艺|综艺片)$/;
const chineseRegion = /中国|大陆|内地|香港|台湾|台灣|澳门|澳門|中华|中華|china|hong\s*kong|taiwan|maca[ou]/i;

export function categoryKind(name: string): Kind | undefined {
  if (movies.test(name)) return "movie";
  if (dramas.test(name)) return "drama";
  if (variety.test(name)) return "variety";
}

export function chineseKind(vod: Vod): Kind | undefined {
  const category = value(vod.type_name);
  const kind = categoryKind(category);
  if (!kind) return;
  if (kind === "movie") {
    const numbered = [...value(vod.vod_play_url).matchAll(/(?:^|#|\$\$\$)第(\d+)集\$/g)];
    if (new Set(numbered.map(match => Number(match[1]))).size > 1) return;
  }
  const area = value(vod.vod_area);
  if (area) return chineseRegion.test(area) ? kind : undefined;
  // A Chinese category is sufficient; a Chinese dub of a foreign movie is not.
  if (kind === "drama" || /^(大陆|港台|国产)综艺$/.test(category)) return kind;
}

export function webUrl(input: unknown): string | undefined {
  try {
    const url = new URL(value(input));
    if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* Invalid upstream URL. */ }
}
