import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { MkvDrama } from "../src/mkvdrama.js";
import { AddonService } from "../src/service.js";
import { MetadataResolver } from "../src/metadata.js";
import { MediaInspector } from "../src/media.js";
import { createApp } from "../src/app.js";
import { HlsPlaylists } from "../src/hls.js";
import { defaultSettings, parseSettings } from "../src/settings.js";
import { MkvHeaderInspector } from "../src/mkv-metadata.js";
import { drama, fixtures, installationFixture } from "./fixtures.js";

const origin = "https://mkvdrama.net";
const title = { names: ["Test Drama", "测试剧"], displayName: "测试剧", year: 2024, tmdbId: "210757" };
const request = { type: "series" as const, id: "tmdb:210757", season: 1, episode: 2 };
const filename = "Test.Drama.S01E02.1080p.WEB-DL.H264[MkvDrama.net].mkv";
const card = (name = "Test Drama", path = "/123-test-drama") =>
  `<article class="bs"><a itemprop="url" class="tip" href="${path}" title="${name}"><b>${name}</b></a></article>`;
const detail = (links: string, name = "Test Drama", year = 2024, type = "Drama") =>
  `<div class="infox"><h1 class="entry-title">${name}</h1><div class="spe"><span><b>Aired:</b> Jan 1, ${year}</span>
  <span><b>Type:</b> ${type}</span></div></div><div class="soraddlx"><h3>Episode 01 - 12</h3>
  <div class="soraurlx"><strong>1080pHD</strong>${links}</div></div>`;
const anchor = (url: string) => `<a href="${url}">Link 1</a>`;

function encrypted(text: string, key: Buffer) {
  const iv = Buffer.from("03".repeat(12), "hex"), cipher = createCipheriv("aes-256-gcm", key, iv);
  const bytes = Buffer.concat([cipher.update(text), cipher.final(), cipher.getAuthTag()]);
  return { d: bytes.toString("base64"), s: iv.toString("hex") };
}

function site(pages: Record<string, string | Response>, files: Record<string, { name: string; size?: number }> = {}) {
  const seen: { url: string; options?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, options) => {
    const url = String(input); seen.push({ url, options });
    assert.equal(options?.redirect, "manual", "each redirect must be checked before following it");
    const id = new URL(url).pathname.match(/^\/api\/file\/([^/]+)\/info$/)?.[1];
    if (new URL(url).hostname === "pixeldrain.com" && id) {
      return files[id] ? Response.json({ success: true, ...files[id] }) : new Response("Missing", { status: 404 });
    }
    const page = pages[`${options?.method || "GET"} ${url}`] || pages[url] || pages[new URL(url).origin + new URL(url).pathname];
    assert.ok(page, `Unexpected request (including any video download): ${url}`);
    return typeof page === "string" ? new Response(page, { headers: { "Content-Type": "text/html" } }) : page.clone();
  };
  return { seen, fetcher, source: new MkvDrama(fetcher) };
}

test("MKVDrama resolves episode/quality bundles with metadata requests only, preserving filename and size", async () => {
  const encoded = Buffer.from("https://pixeldrain.com/u/episode2").toString("base64");
  const fixture = site({
    [`${origin}/search?q=Test+Drama`]: `<div class="listupd">${card("Other Drama", "/other")}${card()}</div>`,
    [`${origin}/123-test-drama`]: detail(anchor("https://pixeldrain.com/u/episode1") + anchor(`/123-test-drama/_c/opaque`)),
    [`${origin}/123-test-drama/_c/opaque`]: new Response(null, { status: 302,
      headers: { Location: `https://ouo.io/qs/anything?s=${encodeURIComponent(encoded)}` } })
  }, { episode1: { name: filename.replace("E02", "E01") }, episode2: { name: filename, size: 1_500_000_000 } });
  const result = await fixture.source.streams(title, request);
  assert.deepEqual(result, [{ url: "https://pixeldrain.com/api/file/episode2", filename, size: 1_500_000_000, height: 1080, host: "PixelDrain" }]);
  assert.ok(!fixture.seen.some(item => new URL(item.url).hostname === "ouo.io"), "quick-share destination avoids an OUO fetch");
  const count = fixture.seen.length;
  await fixture.source.streams(title, request);
  assert.equal(fixture.seen.length, count, "repeat lookups cache URLs and metadata, not video");
});

test("direct MKV URLs remain untouched and wrong seasons, trailers, archives and unsupported hosts are excluded", async () => {
  const correct = `https://cdn.example/${filename}?token=signed`;
  const fixture = site({
    [`${origin}/search?q=Test+Drama`]: card(),
    [`${origin}/123-test-drama`]: detail([
      correct, `https://cdn.example/${filename.replace("S01", "S02")}`, "https://cdn.example/Test.Drama.E02.Preview.mkv",
      "https://cdn.example/season.zip", "https://mega.nz/file/abcdef", "https://fileditchvids.st/abcdef"
    ].map(anchor).join(""))
  });
  assert.equal((await fixture.source.streams(title, request))[0].url, correct);
  assert.equal(fixture.seen.length, 2, "no media requests or unsupported-host requests");
});

test("the current anonymous download panel is loaded with scoped cookies and decrypted without executing site JavaScript", async () => {
  const key = Buffer.from("02".repeat(32), "hex"), gate = "/123-test-drama/gate", pass = "/123-test-drama/pass";
  const access = encrypted(JSON.stringify({ n: "access-token", v: "test-value" }), key);
  const page = detail("").replace('<div class="soraddlx">', '<div id="mlx-root" data-min-age="1">');
  const fixture = site({
    [`${origin}/search?q=Test+Drama`]: card(),
    [`${origin}/123-test-drama`]: new Response(page, { headers: { "Set-Cookie": `_akx=${Buffer.from(JSON.stringify(access)).toString("base64url")}; Secure` } }),
    [`${origin}/123-test-drama/_vb3k_mnxr_w`]: Response.json({ gate_path: gate, pass_path: pass, dec_key: key.toString("hex") }),
    [origin + gate]: new Response(null, { status: 204 }),
    [origin + pass]: Response.json(encrypted(detail(anchor(`https://cdn.example/${filename}`)),
      createHash("sha256").update(`access-payload:${gate}`).digest()))
  });
  assert.equal((await fixture.source.streams(title, request))[0].filename, filename);
  assert.equal(new Headers(fixture.seen[0].options?.headers).get("Accept"), "text/html");
  const prepare = fixture.seen.find(item => item.url.endsWith("/_vb3k_mnxr_w"))!;
  assert.equal(prepare.options?.method, "POST");
  assert.equal(new Headers(prepare.options?.headers).get("Origin"), origin);
  assert.equal(new Headers(prepare.options?.headers).get("Referer"), `${origin}/123-test-drama`);
  const submitted = fixture.seen.find(item => item.url === origin + gate)!;
  assert.deepEqual(JSON.parse(String(submitted.options?.body)), { r: null, i: false, w: false, "access-token": "test-value" });
});

test("OUO follows same-origin forms with scoped cookies and stops at host URLs before reading media", async () => {
  const fixture = site({
    [`${origin}/search?q=Test+Drama`]: card(),
    [`${origin}/123-test-drama`]: detail(anchor("https://ouo.press/example")),
    "https://ouo.io/example": new Response('<form id="form-go" method="POST" action="/go/example"><input name="_token" value="a&amp;b"></form>',
      { headers: { "Set-Cookie": "session=abc; HttpOnly; Secure" } }),
    "https://ouo.io/go/example": new Response(null, { status: 303, headers: { Location: "https://pixeldrain.com/u/episode2" } })
  }, { episode2: { name: filename } });
  assert.equal((await fixture.source.streams(title, request)).length, 1);
  const post = fixture.seen.find(item => item.url.includes("/go/example"))!;
  assert.equal(post.options?.method, "POST");
  assert.equal(String(post.options?.body), "_token=a%26b");
  assert.equal(new Headers(post.options?.headers).get("Cookie"), "session=abc");
  assert.equal(new Headers(fixture.seen.at(-1)?.options?.headers).get("Cookie"), null);
});

test("OUO verification resolves both form stages to a direct host URL without executing page scripts", async () => {
  const fixture = site({
    [`${origin}/search?q=Test+Drama`]: card(),
    [`${origin}/123-test-drama`]: detail(anchor("https://ouo.io/example")),
    "https://ouo.io/example": new Response('<form id="form-captcha" method="POST" action="/go/example"><input name="_token" value="csrf-one"><input name="x-token"><input name="v-token" value="vm"></form><div class="cf-turnstile" data-sitekey="test"></div>',
      { headers: { "Set-Cookie": "ouo_session=first; Secure" } }),
    "https://ouo.io/go/example": new Response('<form id="form-go" method="POST" action="/xreallcygo/example"><input name="_token" value="csrf-two"><input name="x-token"></form>',
      { headers: { "Set-Cookie": "ouo_session=second; Secure" } }),
    "https://ouo.io/xreallcygo/example": new Response(null, { status: 302, headers: { Location: "https://pixeldrain.com/u/episode2" } }),
    "https://www.google.com/recaptcha/api2/anchor": '<input id="recaptcha-token" value="bootstrap-token">',
    "https://www.google.com/recaptcha/api2/reload": ')]}\'\n["rresp","verification-token",null]'
  }, { episode2: { name: filename } });
  const lookupTitle = { ...title, names: ["Test Drama"] };
  assert.equal((await fixture.source.streams(lookupTitle, request))[0].url, "https://pixeldrain.com/api/file/episode2");
  const posts = fixture.seen.filter(item => item.options?.method === "POST" && new URL(item.url).hostname === "ouo.io");
  assert.equal(posts.length, 2);
  assert.deepEqual([...new URLSearchParams(String(posts[0].options?.body))],
    [["_token", "csrf-one"], ["x-token", "verification-token"], ["v-token", "vm"]]);
  assert.equal(new URLSearchParams(String(posts[1].options?.body)).get("_token"), "csrf-two");
  assert.equal(new Headers(posts[1].options?.headers).get("Cookie"), "ouo_session=second");
  const google = fixture.seen.filter(item => new URL(item.url).hostname === "www.google.com");
  assert.equal(google.length, 4, "each form stage receives a fresh verification token");
  assert.ok(google.every(item => !new Headers(item.options?.headers).has("Cookie")), "OUO cookies must stay on OUO");
  assert.deepEqual(await fixture.source.streams(lookupTitle, { ...request, episode: 3 }), []);
  assert.equal(fixture.seen.filter(item => new URL(item.url).hostname === "www.google.com").length, 4,
    "another episode reuses the resolved bundle destination without repeating OUO verification");
});

test("ViewCrate's encrypted file list selects the requested episode before resolving and verifying its host URL", async () => {
  const key = Buffer.from("01".repeat(32), "hex");
  const payload = encrypted(JSON.stringify({ d: [
    { t: "S01E01", l: [{ n: filename.replace("E02", "E01"), h: "pixeldrain.com", u: "first" }] },
    { t: "S01E02", l: [{ n: `${filename} 1.25 GB`, h: "pixeldrain.com", u: "second" },
      { n: filename, h: "fileditchvids.st", u: "unsupported" }] }
  ] }), key);
  const fixture = site({
    [`${origin}/search?q=Test+Drama`]: card(),
    [`${origin}/123-test-drama`]: detail(anchor("https://viewcrate.cc/c/abcdef")),
    "https://viewcrate.cc/c/abcdef": '<main data-bootstrap-url="/c/abcdef/bootstrap">Loading...</main>',
    "https://viewcrate.cc/c/abcdef/bootstrap": Response.json({ k: key.toString("base64"), i: Buffer.from(payload.s, "hex").toString("base64"), c: payload.d }),
    "https://viewcrate.cc/c/abcdef/open/second?privacy=noreferrer": new Response(null, { status: 307, headers: { Location: "/get/ticket" } }),
    "https://viewcrate.cc/get/ticket": new Response(null, { status: 307, headers: { Location: "https://pixeldrain.com/u/episode2" } })
  }, { episode2: { name: filename } });
  const lookupTitle = { ...title, names: ["Test Drama"] };
  assert.equal((await fixture.source.streams(lookupTitle, request))[0].filename, filename);
  assert.ok(!fixture.seen.some(item => item.url.includes("/open/first") || item.url.includes("/open/unsupported")), "only the requested file on a supported host is resolved");
  assert.ok(fixture.seen.some(item => item.url.endsWith("/episode2/info")), "the host filename must confirm the selected episode");
  const wrongEpisode = new MkvDrama((input, options) => String(input).endsWith("/episode2/info")
    ? Promise.resolve(Response.json({ name: filename.replace("E02", "E01") })) : fixture.fetcher(input, options));
  assert.deepEqual(await wrongEpisode.streams(lookupTitle, request), [], "a misleading container label must not return the wrong episode");
});

test("matching rejects remakes and wrong types before following download links", async () => {
  for (const [name, year, type] of [["Test Drama", 2023, "Drama"], ["Test Drama", 2024, "Movie"], ["Test Drama Season 2", 2024, "Drama"]] as const) {
    const fixture = site({ [`${origin}/search?q=Test+Drama`]: card(), [`${origin}/123-test-drama`]: detail(anchor("https://ouo.io/should-not-fetch"), name, year, type),
      [`${origin}/search?q=%E6%B5%8B%E8%AF%95%E5%89%A7`]: '<div class="listupd"></div>' });
    assert.deepEqual(await fixture.source.streams(title, request), []);
    assert.ok(!fixture.seen.some(item => item.url.includes("ouo.io")));
  }
});

test("Chinese aliases and movies resolve with the same title/year checks", async () => {
  const movie = "测试剧.2024.2160p.mkv";
  const fixture = site({
    [`${origin}/search?q=Test+Drama`]: '<div class="listupd"></div>',
    [`${origin}/search?q=%E6%B5%8B%E8%AF%95%E5%89%A7`]: card("测试剧"),
    [`${origin}/123-test-drama`]: detail(anchor(`https://cdn.example/${movie}`), "测试剧", 2024, "Movie")
  });
  assert.equal((await fixture.source.streams(title, { type: "movie", id: request.id }))[0].height, 2160);
});

test("separate later-season listings use that season's year and exact file episode", async () => {
  const fixture = site({
    [`${origin}/search?q=Test+Drama`]: card("Test Drama Season 2"),
    [`${origin}/123-test-drama`]: detail(anchor(`https://cdn.example/${filename.replace("S01", "S02")}`), "Test Drama Season 2", 2025)
  });
  assert.equal((await fixture.source.streams(title, { ...request, season: 2 }, 2025))[0].filename, filename.replace("S01", "S02"));
});

test("Cloudflare and malformed OUO forms produce useful errors without executing webpage scripts", async () => {
  const blocked = new MkvDrama(async () => new Response("Challenge", { status: 403 }));
  assert.equal((await blocked.check()).available, false);
  assert.match((await blocked.check()).error!, /403/);
  await assert.rejects(blocked.streams(title, request), /403/);
  assert.match(blocked.status().lastError!, /403/);
  const fixture = site({
    [`${origin}/search?q=Test+Drama`]: card(),
    [`${origin}/123-test-drama`]: detail(anchor("https://ouo.io/example")),
    "https://ouo.io/example": '<form id="form-captcha"><input name="x-token"></form><script>throw new Error("must not execute")</script>'
  });
  await assert.rejects(fixture.source.streams(title, request), /verification form missing/);
});

test("unsafe redirect targets and loops cannot fetch arbitrary services or consume unbounded requests", async () => {
  for (const target of ["https://pixeldrain.com.evil.example/u/episode2", "http://127.0.0.1/private", `${origin}/loop`]) {
    const fixture = site({
      [`${origin}/search?q=Test+Drama`]: card(),
      [`${origin}/123-test-drama`]: detail(anchor(`${origin}/loop`)),
      [`${origin}/loop`]: new Response(null, { status: 302, headers: { Location: target } })
    });
    await assert.rejects(fixture.source.streams(title, request));
    assert.ok(fixture.seen.length <= 10);
    assert.ok(fixture.seen.every(item => new URL(item.url).hostname === "mkvdrama.net"));
  }
});

test("one shared deadline aborts slow page requests", async () => {
  const source = new MkvDrama(async (_input, options) => new Promise((_, reject) => {
    options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
  }), 20);
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(source.streams(title, request), error => error instanceof Error && error.name === "TimeoutError"); }
  finally { clearTimeout(keepAlive); }
});

test("addon HTTP route returns direct URLs with capped header metadata and preserves playback headers", async t => {
  const fixture = site({ [`${origin}/search?q=Test+Drama`]: card(),
    [`${origin}/123-test-drama`]: '<meta name="description" content="Two school rivals grow closer.">' +
      detail(anchor("https://pixeldrain.com/u/episode2") + anchor("https://send.now/second")),
    "https://send.now/second": `<main id="fv" data-name="${filename}"></main>
      <script id="xvp-config" type="application/json">${JSON.stringify({ sources: [{ src: `https://d1.datatransfer.to/d/player-signed/${filename}` }] })}</script>
      <video><track kind="captions" label="English"><track kind="captions" label="Japanese"></video>`
  }, { episode2: { name: filename, size: 1_000_000 } });
  const vod = fixtures([drama(1, { vod_name: "测试剧" })], 1);
  const headerRequests: { url: string; headers: Headers }[] = [];
  const fetcher: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    const headers = new Headers(options?.headers);
    if (headers.has("Range")) {
      headerRequests.push({ url: url.href, headers });
      assert.equal(headers.get("Range"), "bytes=0-131071");
      assert.equal(options?.redirect, "manual");
      return new Response(Buffer.from("1a45dfa300000000", "hex"), { status: 206, headers: { "Content-Range": "bytes 0-7/1000000" } });
    }
    if (url.hostname === "api.themoviedb.org" && url.searchParams.get("language") === "en-US") return Response.json({ name: "Test Drama" });
    if (url.hostname === "api.themoviedb.org") return vod.fetcher(input, options);
    return fixture.fetcher(input, options);
  };
  const source = new MkvDrama(fetcher), redis = installationFixture(), store = await redis.open();
  const headerInspector = new MkvHeaderInspector(fetcher, async () => ({ format: { duration: "4" }, streams: [
    { codec_type: "subtitle", tags: { language: "eng" } }, { codec_type: "subtitle", tags: { language: "chi" } }
  ] }));
  const id = await store.save("01".repeat(16));
  await store.saveSettings(id, { ...defaultSettings(), sources: ["mkvdrama"] });
  const factory = (key: string, settings: ReturnType<typeof defaultSettings>) => new AddonService(
    settings.sources.includes("mkvdrama") ? [source] : [], new MetadataResolver(fetcher, key), fetcher,
    new MediaInspector(fetcher, async () => { assert.fail("MKVDrama must not invoke an unbounded URL probe"); }), settings.resolutions, headerInspector);
  const server = createApp(store, factory, [source], new HlsPlaylists(redis.env.MIST_ENCRYPTION_KEY, fetcher)).listen(0, "127.0.0.1");
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const response = await fetch(`${base}/${id}/stream/series/tmdb:210757:1:2.json`);
  const { streams } = await response.json();
  assert.equal(streams.length, 2);
  assert.equal(streams[0].url, "https://pixeldrain.com/api/file/episode2");
  assert.deepEqual(streams[0].behaviorHints, { notWebReady: true, filename, videoSize: 1_000_000, bingeGroup: "mist:mkvdrama:direct:PixelDrain:1080" });
  assert.equal(streams[0].name, "1080P");
  assert.equal(streams[0].description, "Test Drama 测试剧 S01E02\nBitrate: 2 Mbps\nLanguage: Chinese\nSubtitle: Multiple\nMKVDrama · PixelDrain");
  assert.equal(headerRequests.length, 2);
  const send = streams.filter((stream: { description: string }) => stream.description.endsWith("MKVDrama · Send"));
  assert.equal(send.length, 1);
  assert.ok(send[0].url.startsWith("https://d1.datatransfer.to/d/"));
  assert.deepEqual(send[0].behaviorHints.proxyHeaders, { request: { Referer: "https://send.now/second" } },
    "the player needs Send's file-page Referer to open the direct CDN URL");
  assert.ok(send[0].description.endsWith("Subtitle: Multiple\nMKVDrama · Send"));
  assert.ok(headerRequests.some(request => request.headers.get("Referer") === "https://send.now/second"));
  const config = await (await fetch(`${base}/api/installations/${id}`)).json();
  assert.ok(config.providers.some(provider => provider.id === "mkvdrama"));
  assert.equal(Object.hasOwn(config, "mkvdramaHosts"), false);
  await store.saveSettings(id, { ...defaultSettings(), sources: ["mkvdrama"], resolutions: [720] });
  assert.deepEqual((await (await fetch(`${base}/${id}/stream/series/tmdb:210757:1:2.json`)).json()).streams, []);
  assert.equal(headerRequests.length, 2, "excluded resolutions must not trigger MKV header reads");
  assert.ok(parseSettings({ ...defaultSettings(), sources: ["mkvdrama"] }));
  assert.ok(defaultSettings().sources.includes("mkvdrama"));
  await store.saveSettings(id, { ...defaultSettings(), sources: ["mkvdrama"] });
  const repeated = (await (await fetch(`${base}/${id}/stream/series/tmdb:210757:1:2.json`)).json()).streams;
  assert.ok(repeated[0].description.includes("Bitrate: 2 Mbps\n"));
  assert.equal(headerRequests.length, 2, "parsed metadata survives service recreation without rereading the file");
  await store.saveSettings(id, { ...defaultSettings(), sources: ["hongniu"] });
  assert.deepEqual((await (await fetch(`${base}/${id}/stream/series/tmdb:210757:1:2.json`)).json()).streams, []);
});

test("MKVDrama failures leave healthy VOD sources available", async () => {
  const fixture = fixtures([drama()]);
  const source = new MkvDrama(async () => new Response("Blocked", { status: 403 }));
  const service = new AddonService([...fixture.providers, source], new MetadataResolver(fixture.fetcher, "fixture-key"), fixture.fetcher, fixture.inspector);
  assert.equal((await service.streams("series", "tmdb:210757:1:1")).length, 2);
});
