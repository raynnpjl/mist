import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "../src/cache.js";
import { MetadataResolver } from "../src/metadata.js";
import { Provider } from "../src/providers.js";
import { AddonService } from "../src/service.js";
import { Vod } from "../src/model.js";
import { drama, fixtures, TEST_SOURCES } from "./fixtures.js";

function sourceFixture(records: Vod[], pageSize = 1) {
  const fixture = fixtures([drama(1, { vod_name: "测试剧" })], 1);
  const requests: URL[] = [];
  const fetcher: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.hostname !== "hongniu.example" || url.searchParams.get("ac") !== "detail") return fixture.fetcher(input, options);
    requests.push(url);
    const ids = url.searchParams.get("ids")?.split(","), search = url.searchParams.get("wd");
    const items = records.filter(vod => ids ? ids.includes(String(vod.vod_id)) : String(vod.vod_name).includes(search || ""));
    const page = Number(url.searchParams.get("pg") || 1);
    return Response.json({ code: 1, pagecount: Math.ceil(items.length / pageSize),
      list: ids ? items.reverse() : items.slice((page - 1) * pageSize, page * pageSize) });
  };
  const provider = new Provider(TEST_SOURCES[0], new Pool(6), fetcher);
  const create = () => new AddonService([provider], new MetadataResolver(fetcher, "fixture-key"), fetcher, fixture.inspector);
  return { create, requests };
}

test("VOD mappings reuse warm records across services, then refresh by ID instead of repeating search pages", async t => {
  let now = 10000;
  t.mock.method(Date, "now", () => now);
  const fixture = sourceFixture([drama(2, { vod_name: "测试剧番外" }), drama(1, { vod_name: "测试剧" })]);
  const first = await fixture.create().streams("series", "tmdb:210757:1:1");
  assert.equal(first.length, 1);
  assert.equal(fixture.requests.length, 2);
  assert.deepEqual(await fixture.create().streams("series", "tmdb:210757:1:1"), first);
  const next = await fixture.create().streams("series", "tmdb:210757:1:2");
  assert.equal(next.length, 1);
  assert.ok(next[0].url.endsWith("/1/2.m3u8"));
  assert.equal(fixture.requests.length, 2, "records from search must seed the detail cache");
  now += 2 * 60_000 + 1;
  assert.deepEqual(await fixture.create().streams("series", "tmdb:210757:1:1"), first);
  assert.equal(fixture.requests.length, 3);
  assert.equal(fixture.requests[2].searchParams.get("ids"), "1");
  assert.equal(fixture.requests[2].searchParams.get("wd"), null);
  now += 30 * 60_000;
  assert.deepEqual(await fixture.create().streams("series", "tmdb:210757:1:1"), first);
  assert.equal(fixture.requests.length, 5, "expired mappings must rediscover the full matching record set");
});

test("batched VOD records preserve source ordering even when detail responses reorder IDs", async t => {
  let now = 10000;
  t.mock.method(Date, "now", () => now);
  const fixture = sourceFixture([drama(1, { vod_name: "测试剧" }), drama(2, { vod_name: "测试剧" })], 20);
  const first = await fixture.create().streams("series", "tmdb:210757:1:1");
  assert.equal(first.length, 2);
  now += 2 * 60_000 + 1;
  assert.deepEqual(await fixture.create().streams("series", "tmdb:210757:1:1"), first);
  assert.equal(fixture.requests[1].searchParams.get("ids"), "1,2");
});

test("cached VOD IDs still validate title, year, region and content type before selecting streams", async t => {
  for (const changed of [{ vod_name: "测试剧番外" }, { vod_year: "2023" }, { vod_area: "日本" }, { type_name: "动作片" }]) {
    await t.test(JSON.stringify(changed), async sub => {
      let now = 10000;
      sub.mock.method(Date, "now", () => now);
      const records = [drama(1, { vod_name: "测试剧" })];
      const fixture = sourceFixture(records);
      assert.equal((await fixture.create().streams("series", "tmdb:210757:1:1")).length, 1);
      records[0] = { ...records[0], ...changed };
      records.push(drama(3, { vod_name: "测试剧" }));
      now += 2 * 60_000 + 1;
      const streams = await fixture.create().streams("series", "tmdb:210757:1:1");
      assert.equal(fixture.requests[1].searchParams.get("ids"), "1");
      assert.equal(streams.length, 1);
      assert.ok(streams[0].url.endsWith("/3/1.m3u8"), "invalid IDs must trigger fresh discovery, never wrong playback");
    });
  }
});

test("missing episodes and disappeared records refresh VOD mappings without hiding replacements", async t => {
  for (const disappeared of [false, true]) {
    await t.test(disappeared ? "removed ID" : "new episode", async sub => {
      let now = 10000;
      sub.mock.method(Date, "now", () => now);
      const records = [drama(1, { vod_name: "测试剧", vod_play_url: "第01集$https://video.example/1/1.m3u8" })];
      const fixture = sourceFixture(records);
      assert.equal((await fixture.create().streams("series", "tmdb:210757:1:1")).length, 1);
      if (disappeared) records.splice(0, 1);
      records.push(drama(3, { vod_name: "测试剧" }));
      now += 2 * 60_000 + 1;
      const streams = await fixture.create().streams("series", "tmdb:210757:1:2");
      assert.equal(fixture.requests[1].searchParams.get("ids"), "1");
      assert.equal(streams.length, 1);
      assert.ok(streams[0].url.endsWith("/3/2.m3u8"));
    });
  }
});

test("a partial VOD detail response rediscovers the complete source set", async t => {
  let now = 10000;
  t.mock.method(Date, "now", () => now);
  const records = [drama(1, { vod_name: "测试剧" }), drama(2, { vod_name: "测试剧" })];
  const fixture = sourceFixture(records, 20);
  assert.equal((await fixture.create().streams("series", "tmdb:210757:1:1")).length, 2);
  records[1] = drama(3, { vod_name: "测试剧" });
  now += 2 * 60_000 + 1;
  const streams = await fixture.create().streams("series", "tmdb:210757:1:1");
  assert.equal(fixture.requests[1].searchParams.get("ids"), "1,2");
  assert.equal(streams.length, 2);
  assert.ok(streams.some(stream => stream.url.endsWith("/3/1.m3u8")));
});

test("VOD records without stable IDs keep normal validated searches", async t => {
  let now = 10000;
  t.mock.method(Date, "now", () => now);
  const fixture = sourceFixture([drama(1, { vod_id: undefined, vod_name: "测试剧" })]);
  const first = await fixture.create().streams("series", "tmdb:210757:1:1");
  assert.equal(first.length, 1);
  now += 2 * 60_000 + 1;
  assert.deepEqual(await fixture.create().streams("series", "tmdb:210757:1:1"), first);
  assert.equal(fixture.requests.length, 2);
  assert.ok(fixture.requests.every(url => !url.searchParams.has("ids")));
});
