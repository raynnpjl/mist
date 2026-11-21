import test from "node:test";
import assert from "node:assert/strict";
import { MetadataResolver } from "../src/metadata.js";
import { AddonService } from "../src/service.js";
import { drama, fixtures } from "./fixtures.js";
import { MediaInspector } from "../src/media.js";

test("missing TMDB titles and episodes retry after five seconds instead of persisting for six hours", async t => {
  let now = 10000, available = false, calls = 0;
  t.mock.method(Date, "now", () => now);
  const resolver = new MetadataResolver(async input => {
    calls++;
    if (!available) return new Response("Not found", { status: 404 });
    return String(input).includes("/episode/") ? Response.json({ name: "Episode 1", air_date: "2024-01-02" }) :
      Response.json({ id: 210757, original_name: "测试剧", first_air_date: "2024-01-01", origin_country: ["CN"] });
  }, "fixture-key");
  const request = { type: "series" as const, id: "tmdb:210757", season: 1, episode: 1 };
  assert.equal(await resolver.title(request), undefined);
  assert.equal(await resolver.title(request), undefined);
  assert.equal(calls, 1);
  available = true; now += 5001;
  const title = (await resolver.title(request))!;
  assert.equal(title.tmdbId, "210757");
  available = false;
  assert.equal(await resolver.episode(title, request), undefined);
  available = true; now += 5001;
  assert.equal((await resolver.episode(title, request))?.name, "Episode 1");
  assert.equal(calls, 4);
});

test("episode metadata refreshes both cache layers after one hour", async t => {
  let now = 10000, calls = 0;
  t.mock.method(Date, "now", () => now);
  const resolver = new MetadataResolver(async () => {
    calls++;
    return Response.json({ name: `Updated ${calls}`, air_date: "2024-01-02" });
  }, "fixture-key");
  const title = { names: ["测试剧"], displayName: "测试剧", year: 2024, tmdbId: "210757" };
  const request = { type: "series" as const, id: "tmdb:210757", season: 1, episode: 1 };
  assert.equal((await resolver.episode(title, request))?.name, "Updated 1");
  now += 60 * 60_000 + 1;
  assert.equal((await resolver.episode(title, request))?.name, "Updated 2");
  assert.equal(calls, 2);
});

test("empty IMDb mappings retry promptly even when TMDB returns HTTP 200", async t => {
  let now = 10000, available = false, searches = 0;
  t.mock.method(Date, "now", () => now);
  const resolver = new MetadataResolver(async input => {
    if (String(input).includes("/find/")) { searches++; return Response.json({ tv_results: available ? [{ id: 210757 }] : [] }); }
    return Response.json({ id: 210757, original_name: "测试剧", first_air_date: "2024-01-01", origin_country: ["CN"] });
  }, "fixture-key");
  const request = { type: "series" as const, id: "tt26235088", season: 1, episode: 1 };
  assert.equal(await resolver.title(request), undefined);
  available = true; now += 5001;
  assert.equal((await resolver.title(request))?.tmdbId, "210757");
  assert.equal(searches, 2);
});

test("configured TMDB lookup resolves IMDb IDs to native aliases and episode dates", async () => {
  const seen: URL[] = [];
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input)); seen.push(url);
    assert.equal(url.searchParams.get("api_key"), "test-server-key");
    if (url.pathname.includes("/find/")) return Response.json({ tv_results: [{ id: 210757 }] });
    if (url.pathname.includes("/episode/")) return Response.json({ name: "Episode 1", air_date: "2023-01-14" });
    return Response.json({ id: 210757, original_name: "狂飙", name: "狂飙", first_air_date: "2023-01-14",
      origin_country: ["CN"], external_ids: { imdb_id: "tt26235088" }, alternative_titles: { results: [] } });
  };
  const resolver = new MetadataResolver(fetcher, "test-server-key");
  const request = { type: "series" as const, id: "tt26235088", season: 1, episode: 1 };
  const title = await resolver.title(request);
  assert.deepEqual(title?.names, ["狂飙"]);
  assert.equal(title?.year, 2023);
  assert.equal(title?.displayName, "狂飙");
  assert.deepEqual(await resolver.episode(title!, request), { name: "Episode 1", date: "2023-01-14", year: 2023 });
  assert.ok(seen.every(url => url.hostname === "api.themoviedb.org"));
});

test("TMDB original titles are retained separately from localized display names", async () => {
  for (const [type, data, nativeName, localized] of [
    ["series", { original_name: "더 글로리", name: "黑暗荣耀" }, "더 글로리", "黑暗荣耀"],
    ["movie", { original_title: "Original Film", title: "本地化片名" }, "Original Film", "本地化片名"],
    ["series", { name: "只有译名" }, undefined, "只有译名"]
  ] as const) {
    const resolver = new MetadataResolver(async () => Response.json({ ...data, id: 210757,
      first_air_date: "2024-01-01", release_date: "2024-01-01", origin_country: ["CN"] }), "test-key");
    const title = await resolver.title({ type, id: "tmdb:210757" });
    assert.equal(title?.nativeName, nativeName);
    assert.equal(title?.displayName, localized, "other providers keep their existing localized display name");
    assert.ok(title?.names.includes(localized));
  }
});

test("bad configured credentials surface an error without switching metadata providers", async () => {
  const resolver = new MetadataResolver(async () => new Response("Unauthorized", { status: 401 }), "invalid-key");
  await assert.rejects(resolver.title({ type: "movie", id: "tmdb:210757" }), /metadata HTTP 401/);
});

test("later seasons select their own listing and never substitute first-season episodes", async () => {
  const records = [drama(1, { vod_name: "测试剧第二季", vod_year: "2024" }),
    drama(2, { vod_name: "测试剧", vod_year: "2020" })];
  const fixture = fixtures(records);
  const fetcher: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.hostname !== "api.themoviedb.org") return fixture.fetcher(input, options);
    if (url.pathname.includes("/episode/")) return Response.json({ name: "Episode 1", air_date: "2024-01-14" });
    return Response.json({ id: 210757, original_name: "测试剧", name: "测试剧", first_air_date: "2020-01-14", origin_country: ["CN"] });
  };
  const service = new AddonService(fixture.providers, new MetadataResolver(fetcher, "test-key"), fetcher, new MediaInspector(fetcher, fixture.probe));
  const streams = await service.streams("series", "tmdb:210757:2:1");
  assert.equal(streams.length, 2);
  assert.ok(streams.every(s => s.url.endsWith("/1/1.m3u8")));
  assert.ok(streams.every(s => s.description.split("\n")[0].endsWith(" S02E01")));
});

test("all-season listings retain the series release year and require explicit season labels", async () => {
  const fixture = fixtures([drama(1, { vod_name: "测试剧", vod_year: "2020", vod_play_from: "m3u8",
    vod_play_url: "S01E01$https://video.example/season1.m3u8#S02E01$https://video.example/season2.m3u8" })]);
  const fetcher: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.hostname !== "api.themoviedb.org") return fixture.fetcher(input, options);
    if (url.pathname.includes("/episode/")) return Response.json({ name: "Episode 1", air_date: "2024-01-14" });
    return Response.json({ id: 210757, original_name: "测试剧", name: "测试剧", first_air_date: "2020-01-14", origin_country: ["CN"] });
  };
  const service = new AddonService(fixture.providers, new MetadataResolver(fetcher, "test-key"), fetcher, new MediaInspector(fetcher, fixture.probe));
  const streams = await service.streams("series", "tmdb:210757:2:1");
  assert.equal(streams.length, 2);
  assert.ok(streams.every(s => s.url.endsWith("/season2.m3u8")));
});
