import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { MetadataResolver } from "../src/metadata.js";
import { MediaInspector } from "../src/media.js";
import { AddonService } from "../src/service.js";
import { createProviders } from "../src/providers.js";
import { drama, fixtures, TEST_SOURCES } from "./fixtures.js";

test("provider searches start while episode metadata is still loading", async () => {
  const fixture = fixtures([drama()]);
  let release!: (response: Response) => void, began!: () => void;
  const gate = new Promise<Response>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { began = resolve; });
  let providerStarted = false;
  const fetcher: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.hostname === "api.themoviedb.org" && url.pathname.includes("/episode/")) {
      began(); return gate;
    }
    if (url.searchParams.get("ac") === "detail") providerStarted = true;
    return fixture.fetcher(input, options);
  };
  const providers = createProviders(TEST_SOURCES, fetcher).slice(0, 2);
  const service = new AddonService(providers, new MetadataResolver(fetcher, "fixture-key"), fetcher, fixture.inspector);
  const pending = service.streams("series", "tmdb:210757:1:1");
  try {
    await started;
    await setImmediate();
    assert.ok(providerStarted, "provider discovery must overlap episode metadata");
  } finally {
    release(Response.json({ name: "Episode 1", air_date: "2024-11-13" }));
    assert.equal((await pending).length, 2);
  }
});

test("a ready provider starts media inspection before a slower search finishes without changing duplicate priority", async () => {
  const fixture = fixtures([drama(1, { vod_play_from: "m3u8",
    vod_play_url: "第01集$https://cdn.example/shared.m3u8" })]);
  let release!: () => void, began!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { began = resolve; });
  let probes = 0;
  const fetcher: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.hostname === "hongniu.example" && url.searchParams.get("ac") === "detail") {
      began(); await gate;
    }
    return fixture.fetcher(input, options);
  };
  const inspector = new MediaInspector(fetcher, async (...args) => { probes++; return fixture.probe(...args); });
  const providers = createProviders(TEST_SOURCES, fetcher).slice(0, 2);
  const service = new AddonService(providers, new MetadataResolver(fetcher, "fixture-key"), fetcher, inspector);
  const pending = service.streams("series", "tmdb:210757:1:1");
  try {
    await started;
    await setImmediate();
    assert.equal(probes, 1, "inspect the ready provider while the other search is pending");
  } finally {
    release();
    const streams = await pending;
    assert.equal(streams.length, 1);
    assert.equal(streams[0].description.split("\n").at(-1), "红牛云播");
    assert.equal(probes, 1, "shared URLs must reuse one inspection");
  }
});

test("installations share verified VOD probes while keeping their own filters, order and detail budgets", async () => {
  const fixture = fixtures([drama()]);
  const budgets: number[] = [];
  const inspector = new MediaInspector(fixture.fetcher, async (...args) => {
    budgets.push(args[1]);
    return fixture.probe(...args);
  });
  const first = new AddonService(fixture.providers, new MetadataResolver(fixture.fetcher, "first-key"), fixture.fetcher,
    inspector, [1080], undefined, false, 1000);
  const reversed = new AddonService([...fixture.providers].reverse(), new MetadataResolver(fixture.fetcher, "second-key"), fixture.fetcher,
    inspector, [1080], undefined, false, 10000);
  const filtered = new AddonService(fixture.providers, new MetadataResolver(fixture.fetcher, "third-key"), fixture.fetcher,
    inspector, [720], undefined, false, 6500);
  const streams = await first.streams("series", "tmdb:210757:1:1");
  assert.equal(streams.length, 2);
  assert.deepEqual(await reversed.streams("series", "tmdb:210757:1:1"), [...streams].reverse());
  assert.deepEqual(await filtered.streams("series", "tmdb:210757:1:1"), []);
  assert.deepEqual(budgets, [1000, 1000], "other accounts must reuse verified facts without inheriting source preferences");
});
