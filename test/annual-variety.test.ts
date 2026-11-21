import test from "node:test";
import assert from "node:assert/strict";
import { AddonService } from "../src/service.js";
import { MetadataResolver } from "../src/metadata.js";
import { createProviders } from "../src/providers.js";
import { normalized } from "../src/model.js";
import { drama, fixtures, TEST_SOURCES } from "./fixtures.js";

const broadcasts: Record<number, string> = { 1: "2026-01-03", 2: "2026-01-10", 44: "2026-11-14", 45: "2026-11-21" };

function saturday(plainAlias = false, missingDate = false) {
  const fixture = fixtures([drama()], 5);
  const searches: { source: string; query: string }[] = [];
  // Live provider naming and labels, with playback URLs replaced by fixture URLs.
  const records = TEST_SOURCES.map((source, index) => {
    const dates = Object.values(broadcasts).filter(date => source.id !== "youku" || date !== "2026-11-21");
    const entries = dates.flatMap(date => {
      const stamp = date.replaceAll("-", "");
      const label = ["hongniu", "youku"].includes(source.id) ? `第${stamp}期` : stamp;
      return [`${label}$https://video.example/${source.id}/${stamp}.m3u8`,
        `${label}加更$https://video.example/${source.id}/bonus-${stamp}.m3u8`];
    });
    entries.push("第20261120期好六街抢先逛$https://video.example/preview.m3u8");
    return drama(index + 1, { vod_name: source.id === "hongniu" ? "你好，星期六 2022" :
      source.id === "youku" ? "你好，星期六 2026" : source.id === "tiantang" ? "你好星期六" : "你好，星期六",
      vod_year: source.id === "youku" ? "2026" : "2022", type_name: source.id === "youku" ? "综艺" : "大陆综艺",
      vod_play_from: "m3u8", vod_play_url: entries.join("#") });
  });
  const fetcher: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.hostname === "api.themoviedb.org") {
      if (url.pathname.includes("/episode/")) {
        const episode = Number(url.pathname.split("/").at(-1));
        return Response.json({ name: `Episode ${episode}`, air_date: missingDate ? undefined : broadcasts[episode] });
      }
      return Response.json({ id: 154770, original_name: "你好，星期六", name: "你好，星期六", first_air_date: "2022-01-01",
        origin_country: ["CN"], alternative_titles: { results: plainAlias ? [{ iso_3166_1: "CN", title: "你好星期六" }] : [] } });
    }
    const source = TEST_SOURCES.findIndex(source => new URL(source.url).hostname === url.hostname);
    if (source >= 0 && url.searchParams.get("ac") === "detail") {
      const query = url.searchParams.get("wd"), ids = url.searchParams.get("ids")?.split(",");
      if (query) searches.push({ source: TEST_SOURCES[source].id, query });
      const preferred = TEST_SOURCES[source].id === "tiantang" ? "你好星期六" : "你好，星期六";
      const accepted = ["hongniu", "tiantang", "youku"].includes(TEST_SOURCES[source].id) ? query === preferred :
        Boolean(query && normalized(query) === normalized(preferred));
      const list = ids ? records.filter(vod => ids.includes(String(vod.vod_id))) : accepted ? [records[source]] : [];
      return Response.json({ code: 1, pagecount: list.length ? 1 : 0, list });
    }
    return fixture.fetcher(input, options);
  };
  const providers = createProviders(TEST_SOURCES, fetcher);
  const create = () => new AddonService(providers, new MetadataResolver(fetcher, "fixture-key"), fetcher, fixture.inspector);
  return { records, searches, create };
}

for (const episode of [1, 2, 44, 45])
test(`Hello Saturday season 5 episode ${episode} matches year-labelled and unpunctuated provider listings`, async () => {
  const fixture = saturday();
  const streams = await fixture.create().streams("series", `tmdb:154770:5:${episode}`);
  const expected = TEST_SOURCES.filter(source => episode !== 45 || source.id !== "youku").map(source => source.id);
  assert.deepEqual(new Set(streams.map(stream => stream.behaviorHints.bingeGroup.split(":")[1])), new Set(expected));
  assert.equal(streams.length, expected.length);
  assert.ok(streams.every(stream => stream.url.endsWith(`/${broadcasts[episode].replaceAll("-", "")}.m3u8`)));
  assert.ok(streams.every(stream => !/bonus|preview/.test(stream.url)));
});

test("native punctuation remains searchable when a normalized catalog alias drops the comma", async () => {
  const fixture = saturday(true);
  const streams = await fixture.create().streams("series", "tmdb:154770:5:44");
  assert.equal(streams.length, 5);
  assert.ok(fixture.searches.some(search => search.source === "hongniu" && search.query === "你好，星期六"));
  assert.ok(fixture.searches.some(search => search.source === "tiantang" && search.query === "你好星期六"));
});

test("cached annual variety mappings preserve exact dates across episodes and installations", async () => {
  const fixture = saturday();
  assert.equal((await fixture.create().streams("series", "tmdb:154770:5:1")).length, 5);
  const searched = fixture.searches.length;
  const next = await fixture.create().streams("series", "tmdb:154770:5:44");
  assert.equal(next.length, 5);
  assert.ok(next.every(stream => stream.url.endsWith("/20261114.m3u8")));
  assert.equal(fixture.searches.length, searched, "valid mapped records must skip repeated discovery");
});

test("annual variety matching rejects wrong years, inconsistent year labels, spin-offs and missing broadcast dates", async () => {
  for (const changed of [
    { vod_name: "你好，星期六 2025", vod_year: "2025" },
    { vod_name: "你好，星期六 2026", vod_year: "2025" },
    { vod_name: "你好，星期六 纳凉企划", vod_year: "2022" }
  ]) {
    const fixture = saturday();
    for (const record of fixture.records) Object.assign(record, changed);
    assert.deepEqual(await fixture.create().streams("series", "tmdb:154770:5:44"), [], JSON.stringify(changed));
  }
  assert.deepEqual(await saturday(false, true).create().streams("series", "tmdb:154770:5:44"), []);
});

test("year suffixes do not relax movie or drama title matching", async () => {
  for (const [type, type_name] of [["movie", "动作片"], ["series", "国产剧"]] as const) {
    const fixture = fixtures([drama(1, { vod_name: "测试 2026", vod_year: "2026", type_name,
      vod_play_url: "第1集$https://video.example/wrong.m3u8" })], 1);
    const fetcher: typeof fetch = async (input, options) => new URL(String(input)).hostname === "api.themoviedb.org" ?
      Response.json({ id: 210757, original_name: "测试", original_title: "测试", name: "测试", title: "测试",
        first_air_date: "2026-01-01", release_date: "2026-01-01", origin_country: ["CN"] }) : fixture.fetcher(input, options);
    const service = new AddonService(createProviders(TEST_SOURCES.slice(0, 1), fetcher), new MetadataResolver(fetcher, "fixture-key"), fetcher, fixture.inspector);
    assert.deepEqual(await service.streams(type, type === "movie" ? "tmdb:210757" : "tmdb:210757:1:1"), []);
  }
});
