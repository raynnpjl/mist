import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, manifest } from "../src/app.js";
import { MetadataResolver, parseVideo } from "../src/metadata.js";
import { AddonService } from "../src/service.js";
import { Provider } from "../src/providers.js";
import { Pool } from "../src/cache.js";
import { MediaInspector } from "../src/media.js";
import { drama, fixtures, TEST_SOURCES } from "./fixtures.js";
import { Installations } from "../src/installations.js";

test("Mist is stream-only and eligible for IMDb and TMDB episodes from existing catalogs", () => {
  assert.deepEqual(manifest.catalogs, []);
  const resource = manifest.resources.find(r => typeof r !== "string" && r.name === "stream");
  assert.ok(resource && typeof resource !== "string");
  for (const id of ["tt26235088:1:1", "tmdb:210757:1:1"]) {
    assert.ok(resource.idPrefixes?.some(prefix => id.startsWith(prefix)), `Mist not eligible for ${id}`);
  }
  assert.equal(manifest.resources.length, 1);
  assert.equal(parseVideo("movie", "tt26235088:1:1"), undefined);
  assert.equal(parseVideo("series", "tt26235088"), undefined);
  assert.equal(parseVideo("series", "cnvod:00000000-0000-0000-0000-000000000000:1:1"), undefined);
});

test("IMDb and TMDB episodes return Mist sources without any catalog or metadata request", async () => {
  const fixture = fixtures([drama(1, { vod_name: "狂飙", vod_year: "2023" })]);
  const service = new AddonService(fixture.providers, new MetadataResolver(fixture.fetcher, "fixture-key"), fixture.fetcher, fixture.inspector);
  for (const id of ["tt26235088:1:1", "tmdb:210757:1:1"]) {
    const streams = await service.streams("series", id);
    assert.equal(streams.length, 2, `No Mist sources for ${id}`);
    assert.ok(streams.every(s => s.url.endsWith("/1.m3u8")));
    assert.ok(streams.every(s => s.name === "1080P"));
    assert.ok(streams.every(s => {
      const lines = s.description.split("\n");
      return lines.length === 4 && lines[0] === "狂飙 S01E01" && /^Bitrate: [\d.]+ Mbps$/.test(lines[1]) &&
        lines[2] === "Language: Chinese" && /^(红牛|天堂)云播$/.test(lines[3]);
    }));
    assert.ok(streams.every(s => /1080p 1920x1080 H\.264 AAC 2\.0 Chinese/.test(s.behaviorHints.filename)));
  }
  const second = await service.streams("series", "tt26235088:1:2");
  assert.ok(second.length && second.every(s => s.url.endsWith("/2.m3u8")));
});

test("a failed source does not block healthy providers", async () => {
  const fixture = fixtures([drama()]);
  const broken = new Provider(TEST_SOURCES[2], new Pool(1), async () => new Response("Blocked", { status: 403 }));
  const service = new AddonService([broken, ...fixture.providers], new MetadataResolver(fixture.fetcher, "fixture-key"), fixture.fetcher, fixture.inspector);
  const streams = await service.streams("series", "tt26235088:1:1");
  assert.equal(streams.length, 2);
  assert.ok(fixture.requests.some(url => url.searchParams.get("wd") === "测试剧1"));
});

test("release type stays in badge metadata without a Quality line in the description", async () => {
  const fixture = fixtures([drama(1, { vod_name: "狂飙", vod_version: "1080p WEB-DL", vod_year: "2023" })]);
  const service = new AddonService(fixture.providers, new MetadataResolver(fixture.fetcher, "fixture-key"), fixture.fetcher, fixture.inspector);
  const streams = await service.streams("series", "tt26235088:1:1");
  assert.equal(streams[0].name, "1080P");
  assert.equal(streams[0].description, "狂飙 S01E01\nBitrate: 2.5 Mbps\nLanguage: Chinese\n红牛云播");
  assert.match(streams[0].behaviorHints.filename, /1080p 1920x1080 WEB-DL H\.264 AAC 2\.0 Chinese/);
});

test("unavailable quality and bitrate stay explicit without invented badge tokens", async () => {
  const fixture = fixtures([drama(1, { vod_name: "狂飙", vod_year: "2023" })]);
  const inspector = new MediaInspector(async () => { throw new Error("offline"); }, async () => { throw new Error("offline"); });
  const service = new AddonService(fixture.providers, new MetadataResolver(fixture.fetcher, "fixture-key"), fixture.fetcher, inspector);
  const streams = await service.streams("series", "tt26235088:1:1");
  assert.equal(streams[0].name, "Unknown");
  assert.equal(streams[0].description, "狂飙 S01E01\nBitrate: Unavailable\nLanguage: Chinese\n红牛云播");
  assert.ok(!/1080p|WEB-DL|HDR|Atmos/.test(streams[0].behaviorHints.filename));
});

test("all providers failing surfaces an error rather than silently claiming no matches", async () => {
  const fixture = fixtures([drama()]);
  const broken = new Provider(TEST_SOURCES[0], new Pool(1), async () => { throw new Error("offline"); });
  const service = new AddonService([broken], new MetadataResolver(fixture.fetcher, "fixture-key"), fixture.fetcher, fixture.inspector);
  await assert.rejects(service.streams("series", "tt26235088:1:1"), /unavailable/);
});

test("matching rejects remakes, unrelated search hits and episode previews", async () => {
  const original = drama();
  const fixture = fixtures([original, drama(2, { vod_name: original.vod_name, vod_year: "2023" }),
    drama(3, { vod_name: `${original.vod_name}番外` })]);
  const service = new AddonService(fixture.providers, new MetadataResolver(fixture.fetcher, "fixture-key"), fixture.fetcher, fixture.inspector);
  const streams = await service.streams("series", "tt26235088:1:1");
  assert.equal(streams.length, 2);
  assert.ok(streams.every(s => s.url.endsWith("/1/1.m3u8")));
});

test("movie IMDb requests return full-film choices with Chinese names and labeled details", async () => {
  const vod = drama(1, { type_id: 6, type_name: "动作片", vod_name: "测试电影", vod_play_from: "m3u8",
    vod_play_url: "HD国语$https://video.example/movie/index.m3u8" });
  const fixture = fixtures([vod]);
  const service = new AddonService(fixture.providers, new MetadataResolver(fixture.fetcher, "fixture-key"), fixture.fetcher, fixture.inspector);
  const streams = await service.streams("movie", "tt26235088");
  assert.equal(streams.length, 2);
  assert.ok(streams.every(s => s.description.startsWith("测试电影 Movie\n") && /\nLanguage: Chinese\n(红牛|天堂)云播$/.test(s.description)));
});

test("reachable source choices rank first while client alternatives remain available", async () => {
  const fixture = fixtures([drama()]);
  const fetcher = async (input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) =>
    String(input).includes("hongniu.example") ? new Response("offline", { status: 503 }) : fixture.fetcher(input, options);
  const service = new AddonService(fixture.providers, new MetadataResolver(fixture.fetcher, "fixture-key"), fetcher, new MediaInspector(fetcher, fixture.probe));
  const streams = await service.streams("series", "tt26235088:1:1");
  assert.equal(streams.length, 2);
  assert.equal(streams[0].description.split("\n").at(-1), "天堂云播");
  assert.equal(streams[1].description.split("\n").at(-1), "红牛云播");
});

test("date-labelled variety uses the catalog episode's air date and excludes bonus cuts", async () => {
  const vod = drama(1, { type_id: 25, type_name: "大陆综艺", vod_name: "测试综艺", vod_year: "2026", vod_play_from: "m3u8",
    vod_play_url: "20261113$https://video.example/main.m3u8#20261113加更$https://video.example/bonus.m3u8#20261114$https://video.example/next.m3u8" });
  const fixture = fixtures([vod]);
  const service = new AddonService(fixture.providers, new MetadataResolver(fixture.fetcher, "fixture-key"), fixture.fetcher, fixture.inspector);
  const streams = await service.streams("series", "tt26235088:1:1");
  assert.equal(streams.length, 2);
  assert.ok(streams.every(s => s.url.endsWith("/main.m3u8")));
});

test("metadata for a different external ID cannot map a request to the wrong show", async () => {
  const fixture = fixtures([drama()]);
  const service = new AddonService(fixture.providers, new MetadataResolver(fixture.fetcher, "fixture-key"), fixture.fetcher, fixture.inspector);
  assert.deepEqual(await service.streams("series", "tt9999999:1:1"), []);
});

test("HTTP direct episode requests return streams and CORS; catalogs and metadata are absent", async () => {
  const fixture = fixtures([drama()]);
  const service = new AddonService(fixture.providers, new MetadataResolver(fixture.fetcher, "fixture-key"), fixture.fetcher, fixture.inspector);
  const directory = await mkdtemp(join(tmpdir(), "mist-http-"));
  const installations = await Installations.open(directory);
  const id = await installations.save("0123456789abcdef0123456789abcdef");
  const server = createApp(installations, () => service, fixture.providers).listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const unconfigured = await (await fetch(`${base}/manifest.json`)).json();
    assert.equal(unconfigured.behaviorHints.configurationRequired, true);
    assert.deepEqual(unconfigured.resources, []);
    const response = await fetch(`${base}/${id}/manifest.json`);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.deepEqual((await response.json()).catalogs, []);
    const streams = await fetch(`${base}/${id}/stream/series/tt26235088:1:1.json`);
    assert.equal(streams.status, 200);
    assert.equal(streams.headers.get("access-control-allow-origin"), "*");
    assert.equal((await streams.json()).streams.length, 2);
    assert.equal((await fetch(`${base}/catalog/series/chinese-dramas.json`)).status, 404);
    assert.equal((await fetch(`${base}/meta/series/tt26235088.json`)).status, 404);
    const html = await (await fetch(base)).text();
    const withoutProviderNames = html.replace(/红牛|天堂|暴风|量子|优酷/g, "");
    assert.ok(!/\p{Script=Han}/u.test(withoutProviderNames));
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
