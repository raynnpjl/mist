import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import { defaultSettings, parseSettings, Settings } from "../src/settings.js";
import { createApp } from "../src/app.js";
import { HlsPlaylists } from "../src/hls.js";
import { createProviders, STREAM_SOURCES } from "../src/providers.js";
import { MetadataResolver } from "../src/metadata.js";
import { MediaInspector } from "../src/media.js";
import { AddonService } from "../src/service.js";
import { drama, fixtures, installationFixture, TEST_SOURCES } from "./fixtures.js";

test("preferences default to all sources and persist independently of concurrent encrypted key updates", async () => {
  const redis = installationFixture();
  const store = await redis.open();
  const id = await store.save("0123456789abcdef0123456789abcdef");
  assert.deepEqual((await store.get(id))?.settings, defaultSettings());
  const settings: Settings = { ...defaultSettings(), sources: ["liangzi", "hongniu"], inspectionTimeoutMs: 2500, resolutions: [720, 1080, 2160] };
  await Promise.all([store.saveSettings(id, settings), store.save("11111111111111111111111111111111", id)]);
  const reopened = await redis.open();
  assert.deepEqual((await reopened.get(id))?.settings, settings);
  assert.equal((await reopened.get(id))?.apiKey, "11111111111111111111111111111111");
  assert.ok(!JSON.stringify([...redis.records.get(`mist:installation:${id}`)!.values()]).includes("11111111111111111111111111111111"));
});

test("provider layout persists independently of enabled providers", async () => {
  const redis = installationFixture(), store = await redis.open();
  const id = await store.save("0123456789abcdef0123456789abcdef");
  const sourceOrder = ["youku", "hongniu", "mkvdrama", "tiantang", "liangzi", "baofeng"];
  for (const sources of [["youku", "hongniu"], ["youku"], ["youku", "hongniu"]]) {
    await store.saveSettings(id, { ...defaultSettings(), sources, sourceOrder });
    const reopened = await redis.open();
    const settings = (await reopened.get(id))!.settings;
    assert.deepEqual(settings.sources, sources);
    assert.deepEqual(settings.sourceOrder, sourceOrder, "disabling and re-enabling a provider must retain its saved position");
  }
});

test("provider layout rejects incomplete, duplicate or unknown provider orders", () => {
  const settings = defaultSettings(), ids = STREAM_SOURCES.map(source => source.id);
  for (const sourceOrder of [[], ids.slice(1), [...ids, ids[0]], ids.map(() => ids[0]), [...ids.slice(1), "unknown"], null, "hongniu"]) {
    assert.equal(parseSettings({ ...settings, sourceOrder }), undefined);
  }
});

test("an unset provider layout retains the configured provider priority", () => {
  const parsed = parseSettings({ sources: ["mkvdrama", "hongniu"], inspectionTimeoutMs: 6500 });
  assert.deepEqual(parsed?.sourceOrder, ["mkvdrama", "hongniu", "tiantang", "baofeng", "liangzi", "youku"]);
});

test("preferences reject empty, duplicate or unknown sources and invalid time windows", () => {
  for (const input of [null, {}, { sources: [], inspectionTimeoutMs: 6500 },
    { sources: ["hongniu", "hongniu"], inspectionTimeoutMs: 6500 }, { sources: ["other"], inspectionTimeoutMs: 6500 },
    { sources: ["hongniu"], inspectionTimeoutMs: 999 }, { sources: ["hongniu"], inspectionTimeoutMs: 10001 },
    { sources: ["hongniu"], inspectionTimeoutMs: 1501 },
    { sources: ["hongniu"], inspectionTimeoutMs: "2000" }]) assert.equal(parseSettings(input), undefined);
  assert.deepEqual(parseSettings({ sources: ["hongniu"], inspectionTimeoutMs: 1000 }),
    { ...defaultSettings(), sources: ["hongniu"], inspectionTimeoutMs: 1000 });
});

test("resolution preferences default to all choices and reject empty, duplicate or unsupported choices", () => {
  const settings = { ...defaultSettings(), sources: ["mkvdrama"] };
  assert.deepEqual(settings.resolutions, [360, 480, 720, 1080, 2160, "unknown"]);
  for (const resolutions of [[], [720, 720], [1440], [4320], ["2160"], ["4K"], ["720"], "720", null]) {
    assert.equal(parseSettings({ ...settings, resolutions }), undefined);
  }
  assert.deepEqual(parseSettings({ ...settings, resolutions: [720] }), { ...settings, resolutions: [720] });
  assert.deepEqual(parseSettings({ ...settings, resolutions: [2160] }), { ...settings, resolutions: [2160] });
  assert.deepEqual(parseSettings({ ...settings, resolutions: ["unknown"] }), { ...settings, resolutions: ["unknown"] });
});

test("pending status checks do not consume stream-search slots", async () => {
  const fixture = fixtures([drama()], 5);
  let release!: () => void, searches = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetcher: typeof fetch = async (input, options) => {
    const action = new URL(String(input)).searchParams.get("ac");
    if (action === "detail") searches++;
    await gate;
    return fixture.fetcher(input, options);
  };
  const providers = createProviders(TEST_SOURCES, fetcher);
  const pending = providers.flatMap(provider => [provider.check(), provider.page(1, undefined, "测试")]);
  try {
    await setImmediate();
    assert.equal(searches, 5);
  } finally { release(); await Promise.all(pending); }
});

test("dashboard preferences affect streams and inspection budgets, while status reports real provider checks", async t => {
  const redis = installationFixture();
  const store = await redis.open();
  const fixture = fixtures([drama()], 5);
  const budgets: number[] = [];
  const used: Settings[] = [];
  const fetcher: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.hostname === "baofeng.example" && url.searchParams.get("ac") === "list") return new Response("Blocked", { status: 403 });
    return fixture.fetcher(input, options);
  };
  const providers = createProviders(TEST_SOURCES, fetcher);
  const factory = (key: string, settings: Settings) => {
    used.push(settings);
    return new AddonService(settings.sourceOrder.filter(id => settings.sources.includes(id)).flatMap(id => providers.filter(p => p.source.id === id)),
      new MetadataResolver(fetcher, key), fetcher,
      new MediaInspector(fetcher, async (url, timeout) => { budgets.push(timeout); return fixture.probe(url, timeout); }, settings.inspectionTimeoutMs), settings.resolutions);
  };
  const replicaStore = await redis.open();
  const server = createApp(store, factory, providers, new HlsPlaylists(redis.env.MIST_ENCRYPTION_KEY, fetcher)).listen(0, "127.0.0.1");
  const replica = createApp(replicaStore, factory, providers, new HlsPlaylists(redis.env.MIST_ENCRYPTION_KEY, fetcher)).listen(0, "127.0.0.1");
  t.after(async () => {
    await Promise.all([server, replica].map(instance => new Promise<void>((resolve, reject) => instance.close(error => error ? reject(error) : resolve()))));
  });
  await Promise.all([once(server, "listening"), once(replica, "listening")]);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const replicaBase = `http://127.0.0.1:${(replica.address() as AddressInfo).port}`;
  const key = "0123456789abcdef0123456789abcdef";
  const response = await fetch(`${base}/api/configure`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: key }) });
  const { installation: id } = await response.json();
  const endpoint = `${base}/api/installations/${id}`;
  const initial = await (await fetch(endpoint)).text();
  assert.ok(!initial.includes(key));
  assert.deepEqual(JSON.parse(initial).providers, STREAM_SOURCES.map(({ id, name }) => ({ id, name })),
    "configuration must not expose provider endpoints or hostnames");
  assert.deepEqual(JSON.parse(initial).settings, defaultSettings());
  assert.deepEqual(JSON.parse(initial).resolutions, [360, 480, 720, 1080, 2160, "unknown"]);
  assert.equal(Object.hasOwn(JSON.parse(initial), "mkvdramaHosts"), false);
  const streamUrl = `${base}/${id}/stream/series/tt26235088:1:1.json`;
  const replicaStreamUrl = `${replicaBase}/${id}/stream/series/tt26235088:1:1.json`;
  assert.equal((await (await fetch(streamUrl)).json()).streams.length, 5);
  assert.equal((await (await fetch(replicaStreamUrl)).json()).streams.length, 5);
  const update = (settings: unknown, origin = base) => fetch(`${endpoint}/settings`, { method: "PUT",
    headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(settings) });
  const ordered = { ...defaultSettings(), sourceOrder: ["youku", "liangzi", "baofeng", "tiantang", "hongniu", "mkvdrama"] };
  assert.equal((await update(ordered)).status, 200);
  assert.deepEqual((await (await fetch(endpoint)).json()).settings.sourceOrder, ordered.sourceOrder, "saved priority must round-trip in order");
  for (const url of [streamUrl, replicaStreamUrl]) {
    assert.deepEqual((await (await fetch(url)).json()).streams.map(stream => stream.description.split("\n").at(-1)),
      ["优酷云播", "量子云播", "暴风云播", "天堂云播", "红牛云播"], "reordering replaces warm services on every instance");
  }
  const disabled = { ...ordered, sources: ordered.sources.filter(id => id !== "baofeng") };
  assert.equal((await update(disabled)).status, 200);
  assert.deepEqual((await (await fetch(endpoint)).json()).settings.sourceOrder, ordered.sourceOrder, "disabling a provider preserves its position");
  for (const url of [streamUrl, replicaStreamUrl]) {
    assert.deepEqual((await (await fetch(url)).json()).streams.map(stream => stream.description.split("\n").at(-1)),
      ["优酷云播", "量子云播", "天堂云播", "红牛云播"], "disabled providers must be ignored in the saved priority order");
  }
  const settings = { ...defaultSettings(), sources: ["hongniu"], inspectionTimeoutMs: 2000 };
  assert.equal((await update(settings, "https://unrelated.example")).status, 403);
  assert.equal((await update({ ...settings, sources: [] })).status, 400);
  assert.equal((await update({ ...settings, resolutions: [] })).status, 400);
  assert.equal((await update(settings)).status, 200);
  assert.deepEqual((await store.get(id))?.settings, settings);
  budgets.length = 0; used.length = 0;
  const streams = (await (await fetch(streamUrl)).json()).streams;
  assert.equal(streams.length, 1);
  assert.ok(streams[0].description.endsWith("红牛云播"));
  assert.deepEqual(used, [settings], "saving preferences must replace the cached service");
  assert.equal(budgets.length, 1);
  assert.ok(budgets[0] > 0 && budgets[0] <= 2000);
  used.length = 0;
  assert.equal((await (await fetch(replicaStreamUrl)).json()).streams.length, 1);
  assert.deepEqual(used, [settings], "another instance must see saved preferences despite its warm cache");
  assert.equal((await update({ ...settings, resolutions: [720] })).status, 200);
  assert.deepEqual((await (await fetch(streamUrl)).json()).streams, [], "resolution changes must replace cached stream results");
  assert.deepEqual((await (await fetch(replicaStreamUrl)).json()).streams, [], "saved resolutions apply on other instances");
  const status = await (await fetch(`${endpoint}/status`)).json();
  assert.equal(status.providers.length, 5);
  assert.equal(status.providers.find(p => p.id === "baofeng").available, false);
  assert.equal(status.providers.filter(p => p.available).length, 4);
  assert.ok(status.providers.some(p => p.id === "tiantang" && p.available), "unselected sources must still be checked");
  assert.ok(status.providers.filter(p => p.available).every(p => Number.isFinite(p.responseMs) && p.checkedAt));
  await assert.doesNotReject(providers.find(p => p.source.id === "baofeng")!.page(1, undefined, "new-search"),
    "a failed status probe must not place working stream searches in cooldown");
  const checks = fixture.requests.filter(url => url.searchParams.get("ac") === "list").length;
  await fetch(`${endpoint}/status`);
  assert.equal(fixture.requests.filter(url => url.searchParams.get("ac") === "list").length, checks);
  assert.equal((await fetch(`${base}/api/installations/${"a".repeat(48)}`)).status, 404);
  assert.equal((await fetch(`${base}/assets/styles.css`)).status, 200);
  assert.equal((await fetch(`${base}/assets/app.js`)).status, 200);
});
