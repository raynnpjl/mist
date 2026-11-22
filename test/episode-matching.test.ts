import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import { AddonService } from "../src/service.js";
import { MetadataResolver } from "../src/metadata.js";
import { createProviders } from "../src/providers.js";
import { HlsPlaylists } from "../src/hls.js";
import { defaultSettings, parseSettings } from "../src/settings.js";
import { accessCookie, configuredInstallation, drama, fixtures, installationFixture, TEST_ENCRYPTION_KEY, TEST_SOURCES } from "./fixtures.js";

const episodes = [
  { episode_number: 1, name: "初次见面", air_date: "2023-12-22" },
  { episode_number: 2, name: "冬日挑战", air_date: "2023-12-29" },
  { episode_number: 3, name: "新年旅行", air_date: "2024-01-05" },
  { episode_number: 4, name: "再次出发", air_date: "2024-01-12" },
  { episode_number: 5, name: "最后一站", air_date: "2024-01-19" }
];

function seasonFixture(lines: string[][], name = "冬日之旅", aliases: string[] = [], catalog = episodes, seriesName = "冬日之旅") {
  const vod = drama(1, { vod_name: name, vod_year: "2023", type_name: "大陆综艺", vod_play_from: lines.map(() => "m3u8").join("$$$"),
    vod_play_url: lines.map(line => line.join("#")).join("$$$") });
  const fixture = fixtures([vod], 1);
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.hostname !== "api.themoviedb.org") return fixture.fetcher(input, options);
    requests.push(url.pathname);
    if (url.pathname.endsWith("/season/1")) return Response.json({ season_number: 1, air_date: "2023-12-22", episodes: catalog });
    if (url.pathname.includes("/episode/")) return Response.json(catalog[Number(url.pathname.split("/").at(-1)) - 1]);
    return Response.json({ id: 210757, original_name: seriesName, first_air_date: "2023-12-22", origin_country: ["CN"],
      alternative_titles: { results: aliases.map(title => ({ iso_3166_1: "US", title })) } });
  };
  const providers = createProviders(TEST_SOURCES.slice(0, 1), fetcher);
  const metadata = new MetadataResolver(fetcher, "test-key");
  return { fetcher, requests, providers, inspector: fixture.inspector, providerRequests: fixture.requests, create: (extras = false) =>
    new AddonService(providers, metadata, fetcher, fixture.inspector, undefined, undefined, false, undefined, extras) };
}

test("season evidence resolves January MMDD, missing episodes and an anchored finale without counting extras", async () => {
  const fixture = seasonFixture([[
    "冬日之旅 ２０２３／１２／２２$https://video.example/one.m3u8",
    "第1期会员加更$https://video.example/extra.m3u8",
    "0105$https://video.example/three.m3u8",
    "0112$https://video.example/four.m3u8",
    "收官之夜$https://video.example/five.m3u8"
  ]]);
  const service = fixture.create();
  for (const [episode, expected] of [[1, ["/one.m3u8"]], [2, []], [3, ["/three.m3u8"]], [4, ["/four.m3u8"]], [5, ["/five.m3u8"]]] as const) {
    const streams = await service.streams("series", `tmdb:210757:1:${episode}`);
    assert.deepEqual(streams.map(stream => new URL(stream.url).pathname), expected);
  }
  assert.equal(fixture.requests.filter(path => path.endsWith("/season/1")).length, 1);
  assert.ok(fixture.requests.every(path => !path.includes("/episode/")));
});

test("a verified running order disambiguates reused month-day labels within its own playback line", async () => {
  const catalog = [
    { episode_number: 1, name: "初次见面", air_date: "2023-12-22" },
    { episode_number: 2, name: "第一次旅行", air_date: "2024-01-05" },
    { episode_number: 3, name: "中场", air_date: "2024-12-20" },
    { episode_number: 4, name: "第二次旅行", air_date: "2025-01-05" },
    { episode_number: 5, name: "收官", air_date: "2025-01-19" }
  ];
  const service = seasonFixture([[
    "20241220$https://video.example/three.m3u8",
    "01-05$https://video.example/four.m3u8",
    "01-05会员加更$https://video.example/ambiguous-extra.m3u8",
    "20250119$https://video.example/five.m3u8"
  ], ["01-05$https://video.example/ambiguous-line.m3u8"]], undefined, [], catalog).create(true);
  assert.deepEqual(await service.streams("series", "tmdb:210757:1:2"), []);
  assert.deepEqual((await service.streams("series", "tmdb:210757:1:4")).map(stream => new URL(stream.url).pathname), ["/four.m3u8"]);
});

test("a compact date sequence corroborates itself against distinct catalog broadcasts", async () => {
  const service = seasonFixture([[
    "1229$https://video.example/two.m3u8",
    "0105$https://video.example/three.m3u8",
    "0112$https://video.example/four.m3u8"
  ], ["0105$https://video.example/isolated.m3u8"]]).create();
  assert.deepEqual((await service.streams("series", "tmdb:210757:1:3")).map(stream => new URL(stream.url).pathname), ["/three.m3u8"]);
});

test("contradictory number/date claims, out-of-order broadcasts and duplicate identities cannot shift a line", async () => {
  const service = seasonFixture([[
    "第4期$https://video.example/four.m3u8",
    "20231222 第2期$https://video.example/conflict.m3u8",
    "第1期$https://video.example/one.m3u8",
    "第3期$https://video.example/copied.m3u8",
    "第5期$https://video.example/copied.m3u8",
    "收官之夜$https://video.example/unverified.m3u8"
  ]]).create();
  for (const [episode, paths] of [[1, ["/one.m3u8"]], [2, []], [3, []], [4, ["/four.m3u8"]], [5, []]] as const) {
    assert.deepEqual((await service.streams("series", `tmdb:210757:1:${episode}`)).map(stream => new URL(stream.url).pathname), paths);
  }
});

test("a dated extra can use verified regular evidence on the same line when the catalog omits the date", async () => {
  const service = seasonFixture([[
    "第3期 2024-01-05$https://video.example/three.m3u8",
    "2024-01-05 纯享版$https://video.example/performance.m3u8"
  ], ["2024-01-05 纯享版$https://video.example/independent.m3u8"]], undefined, [],
  episodes.map(episode => episode.episode_number === 3 ? { ...episode, air_date: "" } : episode)).create(true);
  assert.deepEqual((await service.streams("series", "tmdb:210757:1:3")).map(stream => new URL(stream.url).pathname),
    ["/three.m3u8", "/performance.m3u8"]);
});

test("API show discovery accepts catalog international aliases and script variants with the correct season identity", async () => {
  for (const providerName of ["夢想劇場", "Dream Theatre"]) {
    const service = seasonFixture([["EP1$https://video.example/one.m3u8"]], providerName, ["Dream Theatre"], episodes, "梦想剧场").create();
    assert.deepEqual((await service.streams("series", "tmdb:210757:1:1")).map(stream => new URL(stream.url).pathname), ["/one.m3u8"]);
  }
});

test("search records without a playlist load provider details and reuse the resulting episode list", async () => {
  const fixture = seasonFixture([[]]);
  const calls: string[] = [];
  const record = drama(12, { vod_name: "冬日之旅", vod_year: "2023", type_name: "大陆综艺", vod_play_from: "m3u8" });
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.searchParams.has("wd")) {
      calls.push("search");
      return Response.json({ code: 1, pagecount: 1, list: [{ ...record, vod_play_url: undefined }] });
    }
    if (url.searchParams.get("ids") === "12") {
      calls.push("detail");
      return Response.json({ code: 1, list: [{ ...record,
        vod_play_url: "第1期$https://video.example/one.m3u8#第2期$https://video.example/two.m3u8" }] });
    }
    return fixture.fetcher(input, init);
  };
  const service = new AddonService(createProviders(TEST_SOURCES.slice(0, 1), fetcher), new MetadataResolver(fetcher, "test-key"), fetcher, fixture.inspector);
  for (const [episode, path] of [[1, "/one.m3u8"], [2, "/two.m3u8"]] as const) {
    const streams = await service.streams("series", `tmdb:210757:1:${episode}`);
    assert.deepEqual(streams.map(stream => new URL(stream.url).pathname), [path]);
  }
  assert.deepEqual(calls, ["search", "detail"]);
});

test("installation settings expose only confirmed extras on the existing signed HTTP stream path", async t => {
  const fixture = seasonFixture([[
    "第1期$https://video.example/one.m3u8",
    "会员福利$https://video.example/unrelated.m3u8",
    "第1期会员加更$https://video.example/member.m3u8",
    "第1期纯享版$https://video.example/performance.m3u8",
    "第1期未删减版$https://video.example/one.m3u8",
    "第1期下期预告$https://video.example/preview.m3u8",
    "2023年12月22日 加长版$https://video.example/extended.m3u8",
    "冬日挑战 花絮$https://video.example/behind.m3u8",
    "第2期正片$https://video.example/two.m3u8",
    "第3期会员加更$https://video.example/extra-only.m3u8"
  ]]);
  const accounts = await installationFixture().open();
  const enabledId = await configuredInstallation(accounts, "a".repeat(32));
  const disabledId = await configuredInstallation(accounts, "b".repeat(32));
  const hls = new HlsPlaylists(TEST_ENCRYPTION_KEY, fixture.fetcher);
  const server = createApp(accounts, (_key, settings) => fixture.create(settings.includeEpisodeExtras),
    fixture.providers, hls, TEST_ENCRYPTION_KEY).listen(0, "127.0.0.1");
  t.after(() => { server.close(); });
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cookie = await accessCookie(base);
  const update = (includeEpisodeExtras: unknown) => fetch(`${base}/api/installations/${enabledId}/settings`, {
    method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ ...defaultSettings(), includeEpisodeExtras })
  });
  const streams = async (id: string, episode = 1) => {
    const response = await fetch(`${base}/${id}/stream/series/tmdb:210757:1:${episode}.json`);
    assert.equal(response.status, 200);
    const body = await response.json();
    return body.streams.map((stream: { url: string; description: string; behaviorHints: { bingeGroup: string } }) => {
      const token = new URL(stream.url).pathname.split("/").at(-1)!.replace(/\.m3u8$/, "");
      const url = hls.source(token, id);
      assert.ok(url, "all playlist choices must use the installation's signed HLS route");
      return { path: new URL(url).pathname, description: stream.description, group: stream.behaviorHints.bingeGroup };
    });
  };
  assert.equal(parseSettings({ ...defaultSettings(), includeEpisodeExtras: undefined })?.includeEpisodeExtras, false);
  assert.equal((await update("true")).status, 400);
  assert.deepEqual((await streams(enabledId)).map((stream: { path: string }) => stream.path), ["/one.m3u8"]);
  assert.ok(fixture.providerRequests.every(url => !/^\/(member|extended|performance)\.m3u8$/.test(url.pathname)));
  const saved = await update(true);
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).settings.includeEpisodeExtras, true);
  const [withExtras, withoutExtras] = await Promise.all([streams(enabledId), streams(disabledId)]);
  assert.deepEqual(withExtras.map((stream: { path: string }) => stream.path), ["/one.m3u8", "/member.m3u8", "/performance.m3u8", "/extended.m3u8"]);
  assert.deepEqual(withoutExtras, [withExtras[0]]);
  for (const [index, label] of [[1, "会员加更"], [2, "纯享版"], [3, "加长版"]] as const) {
    const lines = withExtras[index].description.split("\n");
    assert.equal(lines[0], `冬日之旅 S01E01 ${label}`);
    assert.equal(lines.at(-1), "红牛云播");
    assert.notEqual(withExtras[index].group, withExtras[0].group);
  }
  assert.deepEqual((await streams(enabledId, 2)).map((stream: { path: string }) => stream.path), ["/two.m3u8", "/behind.m3u8"]);
  assert.deepEqual(await streams(disabledId, 3), []);
  const extraOnly = await streams(enabledId, 3);
  assert.equal(extraOnly.length, 1);
  assert.equal(extraOnly[0].path, "/extra-only.m3u8");
  assert.equal(extraOnly[0].description.split("\n")[0], "冬日之旅 S01E03 会员加更");
  assert.equal((await update(false)).status, 200);
  assert.deepEqual(await streams(enabledId), withoutExtras);
});
