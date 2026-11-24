import test from "node:test";
import assert from "node:assert/strict";
import { AddonService } from "../src/service.js";
import { MetadataResolver } from "../src/metadata.js";
import { createProviders, loadSources } from "../src/providers.js";
import { drama, fixtures } from "./fixtures.js";

// TMDB 239870 season names/start dates and public provider labels captured together.
const seasons = [
  { season_number: 1, name: "黄河篇 第 1 季", air_date: "2020-12-04", title: "奔跑吧·黄河篇" },
  { season_number: 2, name: "黄河篇 第 2 季", air_date: "2021-10-22", title: "奔跑吧·黄河篇第二季" },
  { season_number: 3, name: "共同富裕篇", air_date: "2022-11-04", title: "奔跑吧·共同富裕篇" },
  { season_number: 4, name: "生态篇", air_date: "2023-11-18", title: "奔跑吧·生态篇" },
  { season_number: 5, name: "茶马古道篇", air_date: "2024-11-23", title: "奔跑吧·茶马古道篇" },
  { season_number: 6, name: "天路篇", air_date: "2025-11-22", title: "奔跑吧·天路篇" },
  { season_number: 7, name: "大湾区篇", air_date: "2026-11-21", title: "奔跑吧大湾区篇" }
];
const sources = loadSources();

function special(season: number, episode = 1, date = seasons[season - 1].air_date, name = "主题故事", missingSeason = false,
  raw?: { label?: string; title?: string; episodes?: { episode_number: number; name: string; air_date: string }[] }) {
  const theme = seasons[season - 1], fixture = fixtures([]);
  const searches: string[] = [];
  const fetcher: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.hostname === "api.themoviedb.org") {
      if (url.pathname.endsWith(`/season/${season}`) && raw?.episodes) return Response.json({ season_number: season,
        name: theme.name, air_date: theme.air_date, episodes: raw.episodes });
      if (url.pathname.includes("/episode/")) return Response.json({ name, air_date: date });
      return Response.json({ id: 239870, name: "奔跑吧·特别篇", original_name: "奔跑吧·特别篇", first_air_date: "2020-12-04",
        origin_country: ["CN"], seasons: missingSeason ? [] : seasons, alternative_titles: { results: seasons
          .filter(season => season.season_number < 7).map(season => ({ iso_3166_1: "CN", title: season.title })) } });
    }
    const source = sources.find(source => new URL(source.url).hostname === url.hostname);
    if (!source || url.searchParams.get("ac") !== "detail") return fixture.fetcher(input, options);
    const stamp = date.replaceAll("-", "");
    const dated = !["hongniu", "guangsu"].includes(source.id);
    const label = raw?.label || (season === 7 && source.id === "feifan" ? "第20261122期" :
      !dated ? `第${episode}期` : source.id === "baofeng" ? `${stamp}第${episode}期` : `第${stamp}期`);
    const vod = drama(1, { vod_name: raw?.title || theme.title, vod_year: theme.air_date.slice(0, 4), type_name: "大陆综艺", vod_play_from: "m3u8",
      vod_play_url: `${label}$https://video.example/${source.id}/correct.m3u8#${label}会员版$https://video.example/${source.id}/bonus.m3u8#第99期$https://video.example/wrong.m3u8` });
    const wrong = (id: number, values: Record<string, unknown>) => ({ ...vod, ...values, vod_id: id,
      vod_play_url: `${label}$https://video.example/wrong-${id}.m3u8` });
    const records = [vod, wrong(2, { vod_name: "奔跑吧第七季", vod_year: "2026" }),
      wrong(3, { vod_year: String(Number(vod.vod_year) - 1) }),
      wrong(4, { vod_name: theme.title + " 跑男来了" }),
      wrong(5, { vod_name: season === 2 ? "奔跑吧·黄河篇" : "奔跑吧·黄河篇第二季" })];
    const query = url.searchParams.get("wd"), ids = url.searchParams.get("ids")?.split(",");
    if (query) searches.push(query);
    const list = records.filter(record => ids ? ids.includes(String(record.vod_id)) : Boolean(query && String(record.vod_name).includes(query)));
    return Response.json({ code: 1, pagecount: 1, list });
  };
  const providers = createProviders(sources, fetcher);
  return { searches,
    service: new AddonService(providers, new MetadataResolver(fetcher, "fixture-key"), fetcher, fixture.inspector) };
}

for (const season of seasons)
test(`Keep Running Special season ${season.season_number} uses its themed provider title and local episode numbering`, async () => {
  const fixture = special(season.season_number);
  const streams = await fixture.service.streams("series", `tmdb:239870:${season.season_number}:1`);
  const expected = sources.filter(source => season.season_number !== 7 || source.id !== "feifan").map(source => source.id);
  assert.deepEqual(new Set(streams.map(stream => stream.behaviorHints.bingeGroup.split(":")[1])), new Set(expected));
  assert.equal(streams.length, expected.length);
  assert.ok(streams.every(stream => stream.url.endsWith("/correct.m3u8")));
  assert.ok(streams.every(stream => stream.description.split("\n")[0].endsWith(` S${String(season.season_number).padStart(2, "0")}E01`)));
});

test("Keep Running 大湾区篇 recovers Feifan's next-day label when the full dated season is available", async () => {
  const fixture = special(7, 1, undefined, undefined, false, { episodes: [
    { episode_number: 1, name: "主题故事", air_date: "2026-11-21" },
    { episode_number: 2, name: "再次出发", air_date: "2026-11-28" }
  ] });
  const streams = await fixture.service.streams("series", "tmdb:239870:7:1");
  assert.equal(streams.length, sources.length);
  assert.ok(streams.every(stream => stream.url.endsWith("/correct.m3u8")));
  assert.deepEqual(streams.map(stream => stream.behaviorHints.bingeGroup.split(":")[1]), sources.map(source => source.id));
  const feifan = streams.find(stream => stream.behaviorHints.bingeGroup.startsWith("mist:feifan:"))!;
  assert.match(feifan.description, /Inferred date: 第20261122期/);
  assert.match(feifan.description, /非凡云播/);
});

for (const [season, episode, date, name] of [
  [1, 5, "2021-01-01", "村民生活"], [3, 3, "2022-11-18", "唱首新歌给你听（上）"],
  [5, 7, "2025-01-04", "星光不问赶路人（上）"], [5, 8, "2025-01-11", "星光不问赶路人（下）"],
  [6, 8, "2026-01-10", "同路人"]
] as const)
test(`Keep Running Special ${season}:${episode} retains the season start year and matches a complete broadcast`, async () => {
  const streams = await special(season, episode, date, name).service.streams("series", `tmdb:239870:${season}:${episode}`);
  assert.equal(streams.length, sources.length);
  assert.ok(streams.every(stream => stream.url.endsWith("/correct.m3u8")));
});

test("Keep Running Special fails closed when the requested season has no authoritative theme", async () => {
  assert.deepEqual(await special(7, 1, undefined, undefined, true).service.streams("series", "tmdb:239870:7:1"), []);
});

for (const [season, episode, date, name, label, title] of [
  [1, 1, "2020-12-04", "龙羊峡探秘", "奔跑吧黄河篇第一季2020.12.04期", "奔跑吧·黄河篇"],
  [2, 1, "2021-10-22", "种子争夺战", "奔跑吧黄河篇第二季10.22期", "奔跑吧·黄河篇第二季"],
  [3, 1, "2022-11-04", "新安江好汉图鉴", "第1期", "奔跑吧•共同富裕篇"],
  [4, 7, "2023-12-30", "收官特辑", "收官特辑", "奔跑吧·生态篇"],
  [4, 7, "2023-12-30", "收官特辑", "第20231230期收官特辑", "奔跑吧·生态篇"]
] as const)
test(`Keep Running Special handles captured provider label ${label}`, async () => {
  const streams = await special(season, episode, date, name, false, { label, title }).service.streams("series", `tmdb:239870:${season}:${episode}`);
  assert.equal(streams.length, sources.length);
  assert.ok(streams.every(stream => stream.url.endsWith("/correct.m3u8")));
});

test("yearless date labels must match the requested broadcast exactly", async () => {
  for (const label of ["奔跑吧黄河篇第二季10.24期", "奔跑吧黄河篇第二季02.30期"]) {
    const fixture = special(2, 1, "2021-10-22", "种子争夺战", false, { label });
    assert.deepEqual(await fixture.service.streams("series", "tmdb:239870:2:1"), []);
  }
});

test("themed provider mappings remain usable on a cached lookup", async () => {
  const fixture = special(6);
  const first = await fixture.service.streams("series", "tmdb:239870:6:1");
  const searches = fixture.searches.length;
  assert.deepEqual(await fixture.service.streams("series", "tmdb:239870:6:1"), first);
  assert.equal(fixture.searches.length, searches, "valid themed mappings must not repeat title searches");
});
