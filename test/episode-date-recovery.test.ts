import test from "node:test";
import assert from "node:assert/strict";
import { AddonService } from "../src/service.js";
import { MediaInspector } from "../src/media.js";
import { MetadataResolver } from "../src/metadata.js";
import type { Vod } from "../src/model.js";
import { createProviders, loadSources } from "../src/providers.js";
import { drama, fixtures } from "./fixtures.js";

const catalog = [
  { episode_number: 1, name: "初次见面", air_date: "2026-11-21" },
  { episode_number: 2, name: "再次出发", air_date: "2026-11-28" }
];
const entry = (label: string, path: string) => `${label}$https://video.example/${path}.m3u8`;
const listing = (entries: string[], overrides: Vod = {}) => drama(1, { vod_name: "冬日之旅", vod_year: "2026",
  type_name: "大陆综艺", vod_play_from: "m3u8", vod_play_url: entries.join("#"), ...overrides });

function recovery(records: Vod[][], options: { catalog?: typeof catalog; expected?: number; missingSeason?: boolean;
  extras?: boolean; resolutionFirst?: boolean; pageSize?: number } = {}) {
  const episodes = options.catalog || catalog, fixture = fixtures([]);
  const sources = ["feifan", "hongniu"].slice(0, records.length).map(id => loadSources().find(source => source.id === id)!);
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "api.themoviedb.org") {
      if (url.pathname.endsWith("/season/1")) return options.missingSeason ? new Response(null, { status: 404 }) :
        Response.json({ season_number: 1, air_date: "2026-11-21", episodes });
      if (url.pathname.includes("/episode/")) return Response.json(episodes.find(episode =>
        episode.episode_number === Number(url.pathname.split("/").at(-1))));
      return Response.json({ id: 210757, original_name: "冬日之旅", first_air_date: "2026-11-21", origin_country: ["CN"],
        seasons: [{ season_number: 1, name: "第1季", air_date: "2026-11-21", episode_count: options.expected ?? episodes.length }] });
    }
    const source = sources.findIndex(source => new URL(source.url).hostname === url.hostname);
    if (source < 0) return fixture.fetcher(input, init);
    const ids = url.searchParams.get("ids")?.split(","), query = url.searchParams.get("wd");
    const items = records[source].filter(vod => ids ? ids.includes(String(vod.vod_id)) :
      Boolean(query && String(vod.vod_name).includes(query)));
    const size = options.pageSize || 20, page = Number(url.searchParams.get("pg") || 1);
    return Response.json({ code: 1, pagecount: Math.ceil(items.length / size), list: items.slice((page - 1) * size, page * size) });
  };
  const inspector = new MediaInspector(fetcher, async url => ({ ...await fixture.probe(url, 6500),
    height: url.includes("inferred") ? 2160 : 720 }));
  const service = new AddonService(createProviders(sources, fetcher), new MetadataResolver(fetcher, "test-key"), fetcher,
    inspector, undefined, undefined, options.resolutionFirst, undefined, options.extras);
  return (episode = 1) => service.streams("series", `tmdb:210757:1:${episode}`);
}

test("variety recovers a unique next-day broadcast and retains the original provider label", async () => {
  const streams = await recovery([[listing([
    entry("第20261122期", "inferred"), entry("第20261123期", "later"), entry("第20261122期会员版", "extra")
  ])]], { extras: true })();
  assert.equal(streams.length, 1);
  assert.equal(new URL(streams[0].url).pathname, "/inferred.m3u8");
  assert.match(streams[0].description, /Inferred date: 第20261122期/);
});

test("variety also recovers a unique previous-day broadcast", async () => {
  const streams = await recovery([[listing([entry("第20261120期", "inferred")])]])();
  assert.equal(streams.length, 1);
  assert.match(streams[0].description, /Inferred date: 第20261120期/);
});

test("regular sources share resolution and provider ranking regardless of inference, with extras last", async () => {
  for (const resolutionFirst of [false, true]) {
    for (const inferredFirst of [false, true]) {
      const records = [
        [listing([entry("第20261122期", "inferred")])],
        [listing([entry("第20261121期", "exact"), entry("第20261121期会员版", "extra")])]
      ];
      const streams = await recovery(inferredFirst ? records : records.reverse(), { extras: true, resolutionFirst })();
      const regular = resolutionFirst || inferredFirst ? ["/inferred.m3u8", "/exact.m3u8"] : ["/exact.m3u8", "/inferred.m3u8"];
      assert.deepEqual(streams.map(stream => new URL(stream.url).pathname), [...regular, "/extra.m3u8"]);
      assert.match(streams.find(stream => stream.url.endsWith("/inferred.m3u8"))!.description, /Inferred date/);
      assert.ok(streams.filter(stream => !stream.url.endsWith("/inferred.m3u8")).every(stream => !stream.description.includes("Inferred date")));
    }
  }
});

test("a later exact match in the same provider beats an earlier inferred candidate", async () => {
  const streams = await recovery([[
    listing([entry("第20261122期", "inferred")]),
    listing([entry("第20261121期", "exact")], { vod_id: 2 })
  ]], { pageSize: 1 })();
  assert.deepEqual(streams.map(stream => new URL(stream.url).pathname), ["/exact.m3u8"]);
  assert.ok(!streams[0].description.includes("Inferred date"));
});

for (const type_name of ["大陆综艺", "国产剧", "国产动漫"]) {
  test(`${type_name} recovers a unique next-day episode`, async () => {
    const streams = await recovery([[listing([entry("第20261122期", "inferred")], { type_name })]])();
    assert.equal(streams.length, 1);
    assert.match(streams[0].description, /Inferred date: 第20261122期/);
  });

  test(`${type_name} daily dates cannot be reassigned to the preceding episode`, async () => {
    const streams = recovery([[listing([entry("第20261122期", "second")], { type_name })]], {
      catalog: [catalog[0], { ...catalog[1], air_date: "2026-11-22" }]
    });
    assert.deepEqual(await streams(), []);
    const second = await streams(2);
    assert.deepEqual(second.map(stream => new URL(stream.url).pathname), ["/second.m3u8"]);
    assert.ok(!second[0].description.includes("Inferred date"));
  });
}

test("one provider date cannot infer two neighboring catalog episodes", async () => {
  const streams = recovery([[listing([entry("第20261122期", "ambiguous")])]], {
    catalog: [catalog[0], { ...catalog[1], air_date: "2026-11-23" }]
  });
  assert.deepEqual(await streams(), []);
  assert.deepEqual(await streams(2), []);
});

test("competing candidates across dates, playback lines and provider records remain unresolved", async () => {
  for (const records of [
    [listing([entry("第20261120期", "before"), entry("第20261122期", "after")])],
    [listing([], { vod_play_from: "one$$$two", vod_play_url: `${entry("第20261122期", "one")}$$$${entry("第20261122期", "two")}` })],
    [listing([entry("第20261122期", "one")]), listing([entry("第20261122期", "two")], { vod_id: 2 })]
  ]) assert.deepEqual(await recovery([records], { pageSize: 1 })(), []);
});

test("duplicate copies of the same dated URL are one inferred candidate", async () => {
  const same = entry("第20261122期", "inferred");
  const streams = await recovery([[listing([], { vod_play_from: "one$$$two", vod_play_url: `${same}$$$${same}` })]])();
  assert.equal(streams.length, 1);
  assert.match(streams[0].description, /Inferred date/);
});

test("truncated provider search cannot establish a unique inferred candidate", async () => {
  const records = [listing([entry("第20261122期", "inferred")]), ...Array.from({ length: 5 }, (_, index) =>
    listing([], { vod_id: index + 2, vod_year: "2025" }))];
  assert.deepEqual(await recovery([records], { pageSize: 1 })(), []);
});

test("catalog previews and extras are not inferred from regular broadcasts", async () => {
  for (const name of ["先导片", "第1期会员版"]) {
    assert.deepEqual(await recovery([[listing([entry("第20261122期", "wrong")])]], {
      catalog: [{ ...catalog[0], name }, catalog[1]]
    })(), [], name);
  }
});

test("inference never overrides conflicting numbers, seasons, parts, previews or extras", async () => {
  for (const label of ["第20261122期第1期", "第2季第20261122期", "第20261122期上", "第20261122期预告",
    "第20261122期会员版", "第20261122期纯享版", "第20261122期花絮", "第20261122期主题故事"]) {
    assert.deepEqual(await recovery([[listing([entry(label, "wrong")])]], { extras: true })(), [], label);
  }
});

test("date inference still requires verified show identity", async () => {
  for (const overrides of [{ vod_year: "2025" },
    { vod_name: "冬日之旅花絮" }, { vod_name: "冬日之旅第二季" }]) {
    assert.deepEqual(await recovery([[listing([entry("第20261122期", "wrong")], overrides)]])(), [], JSON.stringify(overrides));
  }
});

test("missing, partial, undated or gapped season metadata cannot enable inference", async () => {
  for (const options of [{ missingSeason: true }, { expected: 3 },
    { catalog: [catalog[0], { ...catalog[1], air_date: "" }] },
    { catalog: [catalog[0], { ...catalog[1], episode_number: 3 }] }]) {
    assert.deepEqual(await recovery([[listing([entry("第20261122期", "wrong")])]], options)(), [], JSON.stringify(options));
  }
});

test("yearless labels and dates beyond one day remain unmatched", async () => {
  for (const label of ["11.22期", "1122", "第20261123期"]) {
    assert.deepEqual(await recovery([[listing([entry(label, "wrong")])]])(), [], label);
  }
});

test("a URL already confirmed for another episode cannot also become an inferred episode", async () => {
  assert.deepEqual(await recovery([[listing([
    entry("第20261122期", "shared"), entry("第20261128期", "shared")
  ])]])(), []);
});

test("a confirmed duplicate URL takes precedence over an inferred source", async () => {
  const streams = await recovery([
    [listing([entry("第20261122期", "shared")])], [listing([entry("第20261121期", "shared")])]
  ])();
  assert.equal(streams.length, 1);
  assert.match(streams[0].description, /红牛云播/);
  assert.ok(!streams[0].description.includes("Inferred date"));
});

test("an inferred regular source takes precedence over an extra with the same URL", async () => {
  const streams = await recovery([
    [listing([entry("第20261122期", "shared")])], [listing([entry("第20261121期会员版", "shared")])]
  ], { extras: true })();
  assert.equal(streams.length, 1);
  assert.match(streams[0].description, /Inferred date: 第20261122期/);
  assert.match(streams[0].description, /非凡云播/);
});

test("cached provider mappings retain inferred labels without changing episode identity", async () => {
  const streams = recovery([[listing([entry("第20261122期", "inferred")])]]);
  const first = await streams();
  assert.equal(first.length, 1);
  assert.deepEqual(await streams(), first);
  assert.deepEqual(await streams(2), []);
});
