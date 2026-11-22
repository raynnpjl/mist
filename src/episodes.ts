import { Episode, Kind, Playable, Vod, normalized, value, webUrl } from "./model.js";

function chineseNumber(input: string): number {
  if (/^\d+$/.test(input)) return Number(input);
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
  let total = 0, digit = 0;
  for (const char of input) {
    if (char in digits) digit = digits[char];
    else { total += (digit || 1) * units[char]; digit = 0; }
  }
  return total + digit;
}

function part(input: string): string {
  return input.replace(/(?:1080p|720p|2160p|4k|高清|超清|完整版|正片)/g, "")
    .replace(/^[第期集日]+|[期集日]+$/g, "");
}

export function episodeFor(label: string, show: string, kind: Kind, year?: number): Episode {
  const title = label.trim();
  if (kind === "movie") return { key: "movie", title };
  const body = normalized(title).replace(normalized(show), "");
  const short = kind === "variety" && year ? title.match(/(?<!\d)(\d{1,2})[.\-/月](\d{1,2})日?(?=期|$)/) : undefined;
  const date = title.match(/(20\d{2})[.\-/年](\d{1,2})[.\-/月](\d{1,2})日?/) ||
    title.match(/(20\d{2})(\d{2})(\d{2})/) || short && [short[0], String(year), short[1], short[2]];
  if (date) {
    const [, year, month, day] = date;
    const stamp = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    const parsed = new Date(`${stamp}T00:00:00.000Z`);
    if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(stamp)) {
      const suffix = part(body.replace(normalized(date[0]), "")
        .replace(/^第(?:1|一)季/, "")
        .replace(/^第(?:\d+|[零〇一二两三四五六七八九十百千]+)[集期话回]/, ""));
      return { key: `date:${stamp}:${suffix || "main"}`, title, released: parsed.toISOString() };
    }
  }
  const explicit = body.match(/^s(\d+)e(\d+)(.*)$/i);
  const numbered = body.match(/^(?:第)?(\d+|[零〇一二两三四五六七八九十百千]+)(?:集|期|话|回)?(.*)$/);
  if (explicit || numbered) {
    const season = explicit ? Number(explicit[1]) : 1;
    const number = explicit ? Number(explicit[2]) : chineseNumber(numbered![1]);
    const suffix = part(explicit ? explicit[3] : numbered![2]);
    if (number > 0 && number < 100000 && season < 1000) {
      return { key: `episode:${season}:${number}:${suffix || "main"}`, title };
    }
  }
  return { key: `label:${body || normalized(title)}`, title };
}

export function playables(vod: Vod, kind: Kind, year?: number): Playable[] {
  const groups = value(vod.vod_play_from).split("$$$");
  const result: Playable[] = [];
  for (const [index, playlist] of value(vod.vod_play_url).split("$$$").entries()) {
    for (const entry of playlist.split("#")) {
      const split = entry.indexOf("$");
      if (split < 0) continue;
      const url = webUrl(entry.slice(split + 1));
      if (!url || !/\.(m3u8|mp4)$/i.test(new URL(url).pathname)) continue;
      const label = entry.slice(0, split).trim();
      if (!label) continue;
      result.push({ episode: episodeFor(label, value(vod.vod_name), kind, year), url, group: groups[index] || "HLS" });
    }
  }
  return result;
}

