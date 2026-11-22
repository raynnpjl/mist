import test from "node:test";
import assert from "node:assert/strict";
import { AddonService } from "../src/service.js";
import { MetadataResolver } from "../src/metadata.js";
import { createProviders } from "../src/providers.js";
import { drama, fixtures, TEST_SOURCES } from "./fixtures.js";

for (const [name, year, tmdbId] of [["斗罗大陆", 2018, 76572], ["吞噬星空", 2020, 101172]] as const) {
  test(`${name} returns exact numbered episodes across Chinese animation provider categories`, async () => {
    const record = drama(1, { vod_name: name, vod_year: String(year), type_name: "国产动漫", vod_play_from: "m3u8",
      vod_play_url: [1, 2, 250].map(episode => `第${episode}集$https://video.example/1/${episode}.m3u8`).join("#") });
    const fixture = fixtures([record,
      drama(2, { vod_name: name, vod_year: String(year + 1), type_name: "国产动漫" }),
      drama(3, { vod_name: name, vod_year: String(year), type_name: "国产动漫", vod_area: "日本", vod_lang: "国语" }),
      drama(4, { vod_name: `${name}番外`, vod_year: String(year), type_name: "国产动漫" }),
      drama(5, { vod_name: name, vod_year: String(year + 3), type_name: "国产剧" }),
      drama(6, { vod_name: `${name}2`, vod_year: String(year), type_name: "国产动漫" }),
      drama(7, { vod_name: `${name}11`, vod_year: String(year), type_name: "国产动漫" })], 5);
    const categories = ["中国动漫", "国产动漫", "动漫", "大陆动漫", "港台动漫"];
    const fetcher: typeof fetch = async (input, options) => {
      const url = new URL(String(input));
      if (url.hostname === "api.themoviedb.org" && url.pathname === `/3/tv/${tmdbId}`) url.pathname = "/3/tv/210757";
      const response = await fixture.fetcher(url, options);
      const index = TEST_SOURCES.findIndex(source => new URL(source.url).hostname === url.hostname);
      if (index < 0 || url.searchParams.get("ac") !== "detail") return response;
      const data = await response.json();
      return Response.json({ ...data, list: data.list.map(vod => ({ ...vod,
        type_name: vod.type_name === "国产动漫" ? categories[index] : vod.type_name,
        vod_name: index === 0 && vod.vod_id === 1 ? `${name}1` : vod.vod_name,
        vod_area: index === 3 && vod.vod_id === 1 ? "国产" : vod.vod_area })) });
    };
    const providers = createProviders(TEST_SOURCES, fetcher);
    const service = new AddonService(providers, new MetadataResolver(fetcher, "fixture-key"), fetcher, fixture.inspector);
    for (const episode of [1, 2, 250]) {
      const streams = await service.streams("series", `tmdb:${tmdbId}:1:${episode}`);
      assert.equal(streams.length, 5, "each provider must return only the matching Chinese animated series");
      assert.ok(streams.every(stream => stream.url.endsWith(`/1/${episode}.m3u8`)));
    }
  });
}

test("animated movie categories return movie sources and stay separate from series requests", async () => {
  const fixture = fixtures([drama(1, { vod_name: "吞噬星空剧场版 血洛大陆", vod_year: "2024", type_name: "动画片",
    vod_play_from: "m3u8", vod_play_url: "HD$https://video.example/movie.m3u8" })], 1);
  const service = new AddonService(fixture.providers, new MetadataResolver(fixture.fetcher, "fixture-key"), fixture.fetcher, fixture.inspector);
  assert.equal((await service.streams("movie", "tmdb:210757")).length, 1);
  assert.deepEqual(await service.streams("series", "tmdb:210757:1:1"), []);
});
