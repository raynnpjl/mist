import test from "node:test";
import assert from "node:assert/strict";
import { MetadataResolver } from "../src/metadata.js";
import { AddonService } from "../src/service.js";
import { drama, fixtures, TEST_SOURCES } from "./fixtures.js";
import { createProviders } from "../src/providers.js";

for (const [episode, date] of [[1, "2026-04-24"], [2, "2026-05-01"]] as const)
test(`Keep Running catalog season 14 episode ${episode} finds the renamed season 10 across all five VOD providers`, async () => {
  // Live provider labels; catalog numbering includes the four pre-rename seasons.
  const stamp = date.replaceAll("-", "");
  const records = [
    ["奔跑吧第十季", "2026", `第${episode}期`],
    ["奔跑吧第十季", "2026", stamp],
    ["奔跑吧 第十季", "2026", `${stamp}第${episode}期`],
    ["奔跑吧第十季", "2026(中国大陆)", stamp],
    ["奔跑吧 第十季", "2026", `第${stamp}期`]
  ];
  const fixture = fixtures([], 5);
  const fetcher: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.hostname === "api.themoviedb.org") {
      if (url.pathname.includes("/episode/")) return Response.json({ name: `Episode ${episode}`, air_date: date });
      return Response.json({ id: 98031, original_name: "奔跑吧", name: "奔跑吧", first_air_date: "2014-10-10",
        origin_country: ["CN"], alternative_titles: { results: [{ iso_3166_1: "CN", title: "奔跑吧兄弟" }] } });
    }
    const source = TEST_SOURCES.findIndex(source => new URL(source.url).hostname === url.hostname);
    if (source >= 0 && url.searchParams.has("wd")) {
      const [vod_name, vod_year, label] = records[source];
      const vod = drama(source + 1, { vod_name, vod_year, type_name: "大陆综艺", vod_play_from: "m3u8",
        vod_play_url: `${label}$https://${url.hostname}/correct.m3u8#${label}加更$https://${url.hostname}/bonus.m3u8#${label}会员版$https://${url.hostname}/member.m3u8` });
      return Response.json({ code: 1, pagecount: 1,
        list: vod_name.includes(url.searchParams.get("wd")!) ? [vod] : [] });
    }
    return fixture.fetcher(input, options);
  };
  const service = new AddonService(createProviders(TEST_SOURCES, fetcher), new MetadataResolver(fetcher, "test-key"), fetcher, fixture.inspector);
  const streams = await service.streams("series", `tmdb:98031:14:${episode}`);
  assert.equal(streams.length, 5, "All five providers have this broadcast but catalog and provider seasons differ");
  assert.deepEqual(new Set(streams.map(stream => new URL(stream.url).hostname)),
    new Set(TEST_SOURCES.map(source => new URL(source.url).hostname)));
  assert.ok(streams.every(stream => new URL(stream.url).pathname === "/correct.m3u8"));
});

test("Keep Running retains original seasons and maps renamed listings without accepting wrong seasons or extras", async () => {
  for (const [season, vod_name, year] of [
    [1, "奔跑吧兄弟 第一季", 2014], [3, "奔跑吧兄弟第三季", 2015],
    [5, "奔跑吧第一季", 2017], [13, "奔跑吧第九季", 2025]
  ] as const) {
    const fixture = fixtures([
      drama(1, { vod_name, vod_year: String(year), type_name: "大陆综艺", vod_play_from: "m3u8",
        vod_play_url: "第2期$https://video.example/correct.m3u8#第2期加更$https://video.example/bonus.m3u8" }),
      drama(2, { vod_name: "奔跑吧兄弟第二季", vod_year: String(year), type_name: "大陆综艺" }),
      drama(3, { vod_name, vod_year: String(year - 1), type_name: "大陆综艺" }),
      drama(4, { vod_name: "奔跑吧·黄河篇", vod_year: String(year), type_name: "大陆综艺" })
    ]);
    const fetcher: typeof fetch = async (input, options) => {
      const url = new URL(String(input));
      if (url.hostname !== "api.themoviedb.org") return fixture.fetcher(input, options);
      if (url.pathname.includes("/find/")) return Response.json({ tv_results: [{ id: 98031 }] });
      if (url.pathname.includes("/episode/")) return Response.json({ name: "Episode 2", air_date: `${year}-05-01` });
      return Response.json({ id: 98031, original_name: "奔跑吧", name: "奔跑吧", first_air_date: "2014-10-10", origin_country: ["CN"] });
    };
    const service = new AddonService(fixture.providers, new MetadataResolver(fetcher, "test-key"), fetcher, fixture.inspector);
    for (const id of [`tmdb:98031:${season}:2`, `tt9999999:${season}:2`]) {
      const streams = await service.streams("series", id);
      assert.equal(streams.length, 2, id);
      assert.ok(streams.every(stream => stream.url.endsWith("/correct.m3u8")), id);
      assert.ok(streams.every(stream => stream.description.startsWith(`奔跑吧 S${String(season).padStart(2, "0")}E02`)), id);
    }
  }
});

test("Keep Running all-season collections select catalog season numbers", async () => {
  const fixture = fixtures([drama(1, { vod_name: "奔跑吧", vod_year: "2014", type_name: "大陆综艺", vod_play_from: "m3u8",
    vod_play_url: "S14E02$https://video.example/correct.m3u8#S10E02$https://video.example/wrong.m3u8" })]);
  const fetcher: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.hostname === "api.themoviedb.org") {
      if (url.pathname.includes("/episode/")) return Response.json({ name: "Episode 2", air_date: "2026-05-01" });
      return Response.json({ id: 98031, original_name: "奔跑吧", name: "奔跑吧", first_air_date: "2014-10-10", origin_country: ["CN"] });
    }
    return fixture.fetcher(input, options);
  };
  const service = new AddonService(fixture.providers, new MetadataResolver(fetcher, "test-key"), fetcher, fixture.inspector);
  const streams = await service.streams("series", "tmdb:98031:14:2");
  assert.equal(streams.length, 2);
  assert.ok(streams.every(stream => stream.url.endsWith("/correct.m3u8")));
});

test("SHErlock catalog episodes align by explicit upper/lower labels and accept first-season listing names", async () => {
  const show = { vod_name: "女子推理社", vod_year: "2023", type_name: "大陆综艺", vod_play_from: "m3u8" };
  const fixture = fixtures([
    drama(1, { ...show, vod_play_url: "第1集：解救三班岛（上）$https://video.example/1-upper.m3u8#第1集：解救三班岛（下）$https://video.example/1-lower.m3u8#第2集$https://video.example/wrong-2.m3u8#第2集超前彩蛋$https://video.example/bonus.m3u8#第2集：三连罪（上）$https://video.example/2-upper.m3u8" }),
    drama(2, { ...show, vod_name: "女子推理社第一季", vod_play_url: "20230418上$https://video.example/dated-upper.m3u8#20230418下$https://video.example/dated-lower.m3u8" }),
    drama(3, { ...show, vod_play_url: "第01集上$https://video.example/numbered-upper.m3u8#第01集下$https://video.example/numbered-lower.m3u8#第01集便利店$https://video.example/store.m3u8" })
  ]);
  const episodes = ["第1集：解救三班岛（上）", "第1集：解救三班岛（下）", "第2集：三连罪（上）"];
  const fetcher: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.hostname === "api.themoviedb.org" && url.pathname.includes("/episode/")) {
      const episode = Number(url.pathname.split("/").at(-1));
      return Response.json({ name: episodes[episode-1], air_date: episode < 3 ? "2023-04-18" : "2023-04-25" });
    }
    return fixture.fetcher(input, options);
  };
  const service = new AddonService(fixture.providers, new MetadataResolver(fetcher, "fixture-key"), fetcher, fixture.inspector);
  for (const [episode, part, count] of [[1,"upper",6],[2,"lower",6],[3,"upper",2]] as const) {
    const streams = await service.streams("series", `tmdb:210757:1:${episode}`);
    assert.equal(streams.length, count);
    assert.ok(streams.every(s => s.url.endsWith(`${part}.m3u8`)));
    assert.ok(streams.every(s => !/wrong|bonus|store/.test(s.url)));
  }
});

test("treasure-hunt split parts use the broadcast-period number rather than the catalog episode index", async () => {
  const fixture = fixtures([drama(1, { vod_name: "忙忙碌碌寻宝藏", vod_year: "2024", type_name: "大陆综艺", vod_play_from: "m3u8",
    vod_play_url: "第1期$https://video.example/first.m3u8#第2期上$https://video.example/second-upper.m3u8#第2期下$https://video.example/second-lower.m3u8#第3期$https://video.example/wrong-third.m3u8#第2期加更$https://video.example/bonus.m3u8" })]);
  const episodes = ["第1期：田曦薇王安宇开启寻宝", "第2期上：寻宝团解谜困境", "第2期下：揭秘环节全员飚演技"];
  const fetcher: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.hostname === "api.themoviedb.org" && url.pathname.includes("/episode/")) {
      const episode = Number(url.pathname.split("/").at(-1));
      return Response.json({ name: episodes[episode-1], air_date: ["2024-07-28", "2024-08-04", "2024-08-05"][episode-1] });
    }
    return fixture.fetcher(input, options);
  };
  const service = new AddonService(fixture.providers, new MetadataResolver(fetcher, "fixture-key"), fetcher, fixture.inspector);
  for (const [episode, path] of [[1,"first"],[2,"second-upper"],[3,"second-lower"]] as const) {
    const streams = await service.streams("series", `tmdb:210757:1:${episode}`);
    assert.equal(streams.length, 2);
    assert.ok(streams.every(s => s.url.endsWith(`/${path}.m3u8`)));
  }
});
