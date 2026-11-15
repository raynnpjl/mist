import test from "node:test";
import assert from "node:assert/strict";
import { MetadataResolver } from "../src/metadata.js";
import { AddonService } from "../src/service.js";
import { drama, fixtures } from "./fixtures.js";

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
