import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createApp, manifest } from "../src/app.js";
import { MetadataResolver, parseVideo } from "../src/metadata.js";
import { AddonService } from "../src/service.js";
import { Provider } from "../src/providers.js";
import { Pool } from "../src/cache.js";
import { MediaInspector } from "../src/media.js";
import { HlsPlaylists } from "../src/hls.js";
import type { Resolution } from "../src/settings.js";
import { drama, fixtures, installationFixture, TEST_SOURCES } from "./fixtures.js";

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
      return lines.length === 5 && lines[0] === "狂飙 S01E01" && /^Bitrate: [\d.]+ Mbps$/.test(lines[1]) &&
        lines[2] === "Language: Chinese" && lines[3] === "Subtitle: Chinese" && /^(红牛|天堂)云播$/.test(lines[4]);
    }));
    assert.ok(streams.every(s => /1080p 1920x1080 H\.264 AAC 2\.0 Chinese/.test(s.behaviorHints.filename)));
  }
  const second = await service.streams("series", "tt26235088:1:2");
  assert.ok(second.length && second.every(s => s.url.endsWith("/2.m3u8")));
});

test("source titles label HD as 1080P and the 2160 tier as 4K while preserving actual dimensions", async () => {
  for (const height of [360, 480, 606, 720, 721, 768, 800, 900, 1080, 1081, 1440, 1600, 2160]) {
    const fixture = fixtures([drama()], 1);
    const width = height > 1080 ? 3840 : 1920;
    const inspector = new MediaInspector(fixture.fetcher, async () => ({ width, height }));
    const service = new AddonService(fixture.providers, new MetadataResolver(fixture.fetcher, "fixture-key"), fixture.fetcher, inspector);
    const streams = await service.streams("series", "tt26235088:1:1");
    assert.equal(streams.length, 1);
    assert.equal(streams[0].name, height > 1080 ? "4K" : height > 720 ? "1080P" : `${height}P`, `height ${height}`);
    assert.ok(streams[0].behaviorHints.filename.includes(`${height}p ${width}x${height}`));
  }
});

test("resolution preferences filter detected streams, group cropped heights, and select unknown separately", async () => {
  for (const [height, resolutions, count] of [
    [360, [360], 1], [480, [360], 0], [480, [480], 1], [606, [720], 1],
    [720, [1080], 0], [800, [1080], 1], [1080, [720, 1080], 1],
    [1440, [360, 480, 720, 1080, "unknown"], 0], [1440, [2160], 1],
    [2160, [2160], 1], [2160, [1080], 0], [2160, ["unknown"], 0],
    [2161, [360, 480, 720, 1080, 2160, "unknown"], 0], [undefined, [2160], 0], [undefined, [720], 0],
    [undefined, ["unknown"], 1], [720, ["unknown"], 0]
  ] as [number | undefined, Resolution[], number][]) {
    const fixture = fixtures([drama()], 1);
    const inspector = new MediaInspector(fixture.fetcher, async () => ({ height }));
    const service = new AddonService(fixture.providers, new MetadataResolver(fixture.fetcher, "fixture-key"), fixture.fetcher, inspector, resolutions);
    assert.equal((await service.streams("series", "tt26235088:1:1")).length, count, `height ${height}, selections ${resolutions}`);
  }
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
  assert.equal(streams[0].description, "狂飙 S01E01\nBitrate: 2.5 Mbps\nLanguage: Chinese\nSubtitle: Chinese\n红牛云播");
  assert.match(streams[0].behaviorHints.filename, /1080p 1920x1080 WEB-DL H\.264 AAC 2\.0 Chinese/);
});

test("unavailable quality and bitrate stay explicit without invented badge tokens", async () => {
  const fixture = fixtures([drama(1, { vod_name: "狂飙", vod_year: "2023" })]);
  const inspector = new MediaInspector(async () => { throw new Error("offline"); }, async () => { throw new Error("offline"); });
  const service = new AddonService(fixture.providers, new MetadataResolver(fixture.fetcher, "fixture-key"), fixture.fetcher, inspector);
  const streams = await service.streams("series", "tt26235088:1:1");
  assert.equal(streams[0].name, "Unknown");
  assert.equal(streams[0].description, "狂飙 S01E01\nBitrate: Unavailable\nLanguage: Chinese\nSubtitle: Chinese\n红牛云播");
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
  assert.ok(streams.every(s => s.description.startsWith("测试电影 Movie\n") && /\nLanguage: Chinese\nSubtitle: Chinese\n(红牛|天堂)云播$/.test(s.description)));
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
  const installations = await installationFixture().open();
  const id = await installations.save("0123456789abcdef0123456789abcdef");
  const server = createApp(installations, () => service, fixture.providers, new HlsPlaylists("01".repeat(32), fixture.fetcher)).listen(0, "127.0.0.1");
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
    const payload = await streams.json();
    assert.equal(payload.streams.length, 2);
    for (const stream of payload.streams) {
      assert.equal(typeof stream.description, "string");
      assert.equal(Object.hasOwn(stream, "title"), false, "Stremio treats title as a duplicate description field");
    }
    assert.equal((await fetch(`${base}/catalog/series/chinese-dramas.json`)).status, 404);
    assert.equal((await fetch(`${base}/meta/series/tt26235088.json`)).status, 404);
    const html = await (await fetch(base)).text();
    const withoutProviderNames = html.replace(/红牛|天堂|暴风|量子|优酷/g, "");
    assert.ok(!/\p{Script=Han}/u.test(withoutProviderNames));
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("all providers recover a transient playlist failure before redirecting to the CDN", async () => {
  const fixture = fixtures([drama()], 5);
  const service = new AddonService(fixture.providers, new MetadataResolver(fixture.fetcher, "fixture-key"), fixture.fetcher, fixture.inspector);
  const attempts = new Map<string, number>();
  const fetcher: typeof fetch = async input => {
    const url = String(input), count = (attempts.get(url) || 0) + 1;
    attempts.set(url, count);
    if (count === 1) return new Response("Temporary CDN failure", { status: 503 });
    return new Response(["#EXTM3U", "#EXT-X-TARGETDURATION:7", "#EXTINF:4,", "before.ts",
      "# ppvod-ad-injected v1", "#EXT-X-DISCONTINUITY", "#EXTINF:4,", "/ad/clip.ts",
      "#EXT-X-DISCONTINUITY", "#EXTINF:4,", "after.ts", "#EXT-X-ENDLIST"].join("\n"));
  };
  const installations = await installationFixture().open();
  const id = await installations.save("0123456789abcdef0123456789abcdef");
  const server = createApp(installations, () => service, fixture.providers, new HlsPlaylists("01".repeat(32), fetcher)).listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const { streams } = await (await fetch(`${base}/${id}/stream/series/tt26235088:1:1.json`)).json();
    assert.equal(streams.length, 5);
    for (const stream of streams) {
      const response = await fetch(stream.url, { redirect: "manual" });
      assert.equal(response.status, 200, "A recovered CDN request must stay on repaired playback");
      assert.equal(response.headers.get("x-mist-hls-repair"), null);
      const body = await response.text();
      assert.ok(!body.includes("/ad/clip.ts"));
      assert.ok(body.includes("before.ts") && body.includes("after.ts"));
    }
    assert.equal(attempts.size, 5);
    assert.ok([...attempts.values()].every(count => count === 2));
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("all providers report why repair was bypassed when redirecting playback to a rejecting CDN", async t => {
  const warnings: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args); });
  const fixture = fixtures([drama()], 5);
  let blocked = 0;
  const fetcher: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    if (TEST_SOURCES.some(source => new URL(source.url).hostname === url.hostname) && url.pathname.endsWith(".m3u8")) {
      blocked++;
      return new Response("CDN rejects the server", { status: 403 });
    }
    return fixture.fetcher(input, options);
  };
  const inspector = new MediaInspector(fetcher, async () => ({}));
  const service = new AddonService(fixture.providers, new MetadataResolver(fetcher, "fixture-key"), fetcher, inspector);
  const installations = await installationFixture().open();
  const id = await installations.save("0123456789abcdef0123456789abcdef");
  const server = createApp(installations, () => service, fixture.providers, new HlsPlaylists("01".repeat(32), fetcher)).listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const { streams } = await (await fetch(`${base}/${id}/stream/series/tt26235088:1:1.json`)).json();
    assert.equal(streams.length, 5);
    for (const source of TEST_SOURCES) {
      const stream = streams.find((stream: any) => stream.behaviorHints.bingeGroup.startsWith(`mist:${source.id}:`));
      assert.ok(stream.url.startsWith(`${base}/${id}/hls/`), `${source.name} must use playback-time inspection`);
      const response = await fetch(stream.url, { redirect: "manual" });
      assert.equal(response.status, 307, "A blocked inspection must leave the original CDN stream playable");
      assert.equal(response.headers.get("location"), `https://${source.id}.example/1/1.m3u8`);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.equal(response.headers.get("access-control-allow-origin"), "*");
      assert.equal(response.headers.get("x-mist-hls-repair"), "bypassed");
      assert.equal(response.headers.get("x-mist-hls-error"), "upstream-http-403");
      assert.equal(stream.name, "Unknown");
    }
    assert.ok(blocked > 0, "The test must exercise a failed server-side inspection");
    assert.equal(warnings.length, 5);
    assert.ok(warnings.every(args => args[0] === "[Mist HLS] Repair bypassed"));
    assert.ok(warnings.every(args => JSON.stringify(args).includes("upstream-http-403")));
    assert.ok(warnings.every(args => !JSON.stringify(args).includes(id)), "Diagnostics must not log private installation links");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("all five providers repair episodes at playback, including new episodes and changed playlists", async () => {
  const fixture = fixtures([drama()]);
  const service = new AddonService(fixture.providers, new MetadataResolver(fixture.fetcher, "fixture-key"), fixture.fetcher, fixture.inspector);
  const sources = [
    { provider: "liangzi", url: "https://v.lzcdn27.com/20261115/22075_2c9a8bdc/index.m3u8" },
    { provider: "liangzi", url: "https://v.lzcdn27.com/20261115/22074_9bc7a87a/index.m3u8" },
    ...TEST_SOURCES.map(source => ({ provider: source.id, url: `https://${source.id}.example/future-episode/index.m3u8` }))
  ];
  const direct = TEST_SOURCES.map(source => ({ provider: source.id, url: `https://${source.id}.example/movie.mp4` }));
  service.streams = async () => [...sources, ...direct].map(({ provider, url }) => ({ name: "1080P", description: "Chinese episode", url,
    behaviorHints: { notWebReady: true, bingeGroup: `mist:${provider}:m3u8`, filename: "episode.m3u8" } }));
  let updated = false, requests = 0;
  const fetcher: typeof fetch = async input => {
    requests++;
    if (String(input).endsWith("/index.m3u8")) return new Response("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n2000k/hls/media.m3u8\n");
    return new Response(["#EXTM3U", "#EXT-X-TARGETDURATION:7", "#EXTINF:6.68,", "00074.ts",
      "# ppvod-ad-injected v1", "#EXT-X-DISCONTINUITY", "#EXTINF:4,", "/ad/first.ts", "#EXT-X-DISCONTINUITY",
      "#EXTINF:3.52,", updated ? "updated-00075.ts" : "00075.ts", "#EXTINF:6.6,", "00494.ts",
      "# ppvod-ad-injected v1", "#EXT-X-DISCONTINUITY", "#EXTINF:4,", "/ad/second.ts", "#EXT-X-DISCONTINUITY",
      "#EXTINF:4,", "00495.ts", "#EXT-X-ENDLIST"].join("\n"));
  };
  const installations = await installationFixture().open();
  const id = await installations.save("0123456789abcdef0123456789abcdef");
  const server = createApp(installations, () => service, fixture.providers, new HlsPlaylists("01".repeat(32), fetcher)).listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const { streams } = await (await fetch(`${base}/${id}/stream/series/tt36982492:1:19.json`)).json();
    assert.equal(requests, 0, "Repair inspection belongs to playback, not stream listing");
    let mediaUrl = "";
    for (let i = 0; i < sources.length; i++) {
      assert.ok(streams[i].url.startsWith(`${base}/${id}/hls/`), `${sources[i].provider} HLS episodes must be checked at playback`);
      const master = await (await fetch(streams[i].url)).text();
      mediaUrl = master.split("\n").find(line => line && !line.startsWith("#"))!;
      assert.ok(mediaUrl.startsWith(`${base}/${id}/hls/`), "Child playlists must also be inspected");
      const response = await fetch(mediaUrl);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("access-control-allow-origin"), "*");
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.match(response.headers.get("content-type")!, /application\/vnd.apple.mpegurl/);
      const playlist = await response.text();
      const segments = playlist.split("\n").filter(line => line && !line.startsWith("#"));
      const mediaBase = new URL("2000k/hls/", sources[i].url).href;
      assert.deepEqual(segments, ["00074.ts", "00075.ts", "00494.ts", "00495.ts"].map(segment => mediaBase + segment));
      assert.ok(!/ppvod|DISCONTINUITY|\/ad\//.test(playlist));
      assert.match(playlist, /#EXT-X-ENDLIST\n$/);
    }
    assert.deepEqual(streams.slice(sources.length).map((stream: any) => stream.url), direct.map(stream => stream.url), "MP4 stays direct for every provider");
    assert.equal(requests, sources.length * 2, "Only playlists are fetched by Mist");
    updated = true;
    assert.match(await (await fetch(mediaUrl)).text(), /updated-00075\.ts/);
    assert.equal(requests, sources.length * 2 + 1, "A new playback request must use the current upstream playlist");
    assert.equal((await fetch(mediaUrl.replace(id, "a".repeat(48)))).status, 404);
    const otherId = await installations.save("0123456789abcdef0123456789abcdef");
    assert.equal((await fetch(mediaUrl.replace(id, otherId))).status, 400, "Playlist signatures are installation-bound");
    assert.equal((await fetch(mediaUrl.replace("/hls/", "/hls/x"))).status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
