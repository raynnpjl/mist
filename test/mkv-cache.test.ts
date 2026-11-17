import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { MkvDrama } from "../src/mkvdrama.js";
import { MkvHeaderInspector } from "../src/mkv-metadata.js";
import { AddonService } from "../src/service.js";
import { MetadataResolver } from "../src/metadata.js";
import { DiscoveryStore } from "../src/discovery-cache.js";
import { drama, fixtures } from "./fixtures.js";
import { cachedSite, discoveryRedis, mkvFilename, mkvRequest, mkvTitle } from "./discovery-fixtures.js";

const probe = async () => ({ format: { duration: "4" }, streams: [{ codec_type: "subtitle", tags: { language: "chi" } }] });

test("shared show and episode mappings keep every host/quality, regenerating playback URLs without storing secrets", async () => {
  const site = cachedSite(), redis = discoveryRedis();
  const open = () => new MkvDrama(site.fetcher, 30_000, redis.open());
  const cold = await open().streams(mkvTitle, mkvRequest);
  const before = site.seen.length;
  const warm = await open().streams(mkvTitle, mkvRequest);
  assert.equal(cold.length, 4); assert.equal(warm.length, 4);
  assert.deepEqual(warm.map(({ url, ...file }) => file), cold.map(({ url, ...file }) => file));
  assert.deepEqual(site.seen.slice(before).map(url => new URL(url).hostname), ["pixeldrain.com", "send.now", "pixeldrain.com", "send.now"]);
  assert.deepEqual(redis.commands.map(c => c[0]), ["GET", "SET", "GET", "SET", "GET", "GET"]);
  assert.notEqual(cold[1].url, warm[1].url, "Send signatures must be regenerated from a stable public page");
  const stored = [...redis.records.values()].map(record => record.value).join("");
  for (const secret of ["sign1", "datatransfer.to", "Cookie", "Authorization", "Referer", "_akx", "proxy"]) assert.ok(!stored.includes(secret));
});

test("show mappings expire at six hours; episode shards use 30 minutes unless status confirms completion", async t => {
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  for (const status of ["", "Ongoing", "Not Completed", "Completed"]) {
    const site = cachedSite(), redis = discoveryRedis();
    site.state.status = status; site.state.send = false;
    const open = () => new MkvDrama(site.fetcher, 30_000, redis.open());
    await open().streams(mkvTitle, mkvRequest);
    const writes = redis.commands.filter(c => c[0] === "SET");
    assert.equal(Number(writes[0][4]), 6 * 60 * 60);
    assert.equal(Number(writes[1][4]), status === "Completed" ? 24 * 60 * 60 : 30 * 60);
    const count = site.seen.filter(url => url.endsWith("/drama")).length;
    now += 31 * 60_000;
    await open().streams(mkvTitle, mkvRequest);
    assert.equal(site.seen.filter(url => url.endsWith("/drama")).length, count + Number(status !== "Completed"));
    now += 25 * 60 * 60_000;
    await open().streams(mkvTitle, mkvRequest);
    assert.equal(site.seen.filter(url => new URL(url).pathname === "/search").length, 2);
  }
});

test("confirmed invalid cached host links refresh their episode mapping once, preserving healthy hosts", async () => {
  const site = cachedSite(), redis = discoveryRedis();
  await new MkvDrama(site.fetcher, 30_000, redis.open()).streams(mkvTitle, mkvRequest);
  site.state.badPixel = true; site.state.replacement = true;
  const before = site.seen.length;
  const files = await new MkvDrama(site.fetcher, 30_000, redis.open()).streams(mkvTitle, mkvRequest);
  assert.equal(files.length, 4);
  assert.ok(files[0].url.includes("new1080"));
  assert.equal(site.seen.slice(before).filter(url => url.endsWith("/drama")).length, 1);
  assert.equal(redis.commands.filter(c => c[0] === "DEL").length, 1);
});

test("a missing episode refreshes a cached show locator once and does not revisit a failed page", async () => {
  const site = cachedSite(), redis = discoveryRedis();
  const fetcher: typeof fetch = (input, options) => site.state.replacement && new URL(String(input)).pathname === "/drama" ?
    Promise.resolve(new Response('<div class="infox"><h1>Test Drama</h1><div class="spe"><span>Aired: 2024</span><span>Type: Drama</span></div></div><div class="soraddlx"></div>')) :
    site.fetcher(input, options);
  const source = new MkvDrama(fetcher, 30_000, redis.open());
  await source.streams(mkvTitle, mkvRequest);
  site.state.replacement = true; site.state.episodes = new Set([3]);
  const files = await source.streams(mkvTitle, { ...mkvRequest, episode: 3 });
  assert.equal(files.length, 4);
  assert.equal(site.seen.filter(url => new URL(url).pathname === "/search").length, 2);
  assert.equal(site.seen.filter(url => url.endsWith("/replacement")).length, 1);
  const missing = await source.streams(mkvTitle, { ...mkvRequest, episode: 99 });
  assert.deepEqual(missing, []);
  assert.equal(site.seen.filter(url => new URL(url).pathname === "/search").length, 3, "one refresh per failed request");
});

test("Redis outages allow normal discovery, and concurrent requests share discovery plus header work", async () => {
  const site = cachedSite(5), redis = discoveryRedis();
  const source = new MkvDrama(site.fetcher, 30_000, new DiscoveryStore(redis.env, async () => { throw new Error("offline"); }));
  const inspector = new MkvHeaderInspector(site.fetcher, probe, 3000, redis.open());
  const inspect = (file: Parameters<typeof inspector.inspect>[0]) => { inspector.inspect(file); };
  const results = await Promise.all(Array.from({ length: 8 }, () => source.streams(mkvTitle, mkvRequest, undefined, inspect)));
  assert.ok(results.every(files => files.length === 4));
  await Promise.all(results[0].map(file => inspector.inspect(file)));
  assert.equal(site.seen.filter(url => new URL(url).pathname === "/search").length, 1);
  assert.equal(site.metrics().headers, 4);
  assert.equal(site.metrics().peak, 2);
});

test("stable metadata reuses regenerated URLs while size, filename, version and host identity prevent stale reuse", async t => {
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  const site = cachedSite(), redis = discoveryRedis();
  const open = () => new MkvHeaderInspector(site.fetcher, probe, 3000, redis.open());
  const file = { url: "https://d1.datatransfer.to/d/sign1/file.mkv", filename: mkvFilename(), size: site.state.size,
    headers: { Referer: "https://send.now/file1080E2" } };
  const first = await open().inspect(file);
  assert.deepEqual(first, { subtitles: "Chinese", averageBitrate: 2_000_000 });
  await open().inspect({ ...file, url: file.url.replace("sign1", "sign2") });
  assert.equal(site.metrics().headers, 1);
  assert.deepEqual(redis.commands.map(c => c[0]), ["GET", "SET", "GET"]);
  assert.equal(Number(redis.commands[1][4]), 86400);
  await open().inspect({ ...file, filename: "different.mkv" });
  await open().inspect({ ...file, version: "new-version" });
  await open().inspect({ ...file, headers: { Referer: "https://send.now/another" } });
  site.state.size *= 2;
  assert.equal((await open().inspect({ ...file, size: site.state.size })).averageBitrate, 4_000_000);
  assert.equal(site.metrics().headers, 5);
  now += 24 * 60 * 60_000 + 1;
  await open().inspect({ ...file, size: site.state.size });
  assert.equal(site.metrics().headers, 6);
  const before = redis.commands.length;
  assert.deepEqual(await open().inspect(file), {}, "Content-Range size mismatch must not cache metadata for the wrong file");
  assert.deepEqual(redis.commands.slice(before).map(c => c[0]), ["GET"]);
});

test("host failures stay isolated and partial source mappings are not persisted", async () => {
  const site = cachedSite(), redis = discoveryRedis(); site.state.badSend = true;
  const source = new MkvDrama(site.fetcher, 30_000, redis.open());
  const files = await source.streams(mkvTitle, mkvRequest);
  assert.deepEqual(files.map(file => file.height), [1080, 720]);
  assert.ok(files.every(file => file.host === "PixelDrain"));
  assert.equal(redis.commands.filter(c => c[0] === "SET" && c[1].includes(":episodes:")).length, 0);
});

test("a confirmed invalid cached playback URL refreshes once within the original request budget", async () => {
  const site = cachedSite(), redis = discoveryRedis(); site.state.send = false;
  const source = new MkvDrama(site.fetcher, 30_000, redis.open());
  await source.streams(mkvTitle, mkvRequest);
  site.state.replacement = true;
  let failedReads = 0;
  const inspector = new MkvHeaderInspector(async (input, options) => {
    if (String(input).includes("/api/file/file")) { failedReads++; return new Response("Gone", { status: 404 }); }
    return site.fetcher(input, options);
  }, probe, 3000, redis.open());
  const files = await source.streams(mkvTitle, mkvRequest, undefined, async file => {
    let invalid = false; await inspector.inspect(file, () => { invalid = true; }); return invalid;
  });
  assert.equal(files.length, 2);
  assert.ok(files.every(file => file.url.includes("/new")));
  assert.equal(failedReads, 2);
  assert.equal(redis.commands.filter(c => c[0] === "DEL").length, 1);
});

test("playback memory caching honors explicit expiry and avoids caching unknown signature lifetimes", async t => {
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  for (const query of [`expires=${Math.floor(now / 1000) + 10}`, "token=unknown-lifetime"]) {
    const site = cachedSite(), redis = discoveryRedis();
    let pages = 0;
    const fetcher: typeof fetch = (input, options) => {
      if (new URL(String(input)).pathname === "/drama") {
        pages++;
        return Promise.resolve(new Response(`<div class="infox"><h1>Test Drama</h1><div class="spe"><span>Aired: 2024</span><span>Type: Drama</span></div></div>
          <div class="soraddlx"><div class="soraurlx"><a href="https://cdn.example/${mkvFilename()}?${query}">File</a></div></div>`));
      }
      return site.fetcher(input, options);
    };
    const source = new MkvDrama(fetcher, 30_000, redis.open());
    await source.streams(mkvTitle, mkvRequest);
    await source.streams(mkvTitle, mkvRequest);
    assert.equal(pages, query.startsWith("expires") ? 1 : 2);
    now += 6000;
    await source.streams(mkvTitle, mkvRequest);
    assert.equal(pages, query.startsWith("expires") ? 2 : 3);
    assert.equal(redis.commands.filter(c => c[0] === "SET" && c[1].includes(":episodes:")).length, 0);
  }
});

test("independent OUO branches preserve their own cookies and ordered form steps", async () => {
  const site = cachedSite(), submitted: string[] = [];
  const fetcher: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.pathname === "/drama") return new Response(`<div class="infox"><h1>Test Drama</h1><div class="spe"><span>Aired: 2024</span><span>Type: Drama</span></div></div>
      <div class="soraddlx"><div class="soraurlx">${["first", "second"].map(id => `<a href="https://ouo.io/${id}">Link</a>`).join("")}</div></div>`);
    if (url.hostname === "ouo.io") {
      const id = url.pathname.split("/").at(-1)!;
      if (options?.method !== "POST") {
        await delay(id === "first" ? 1 : 5);
        return new Response(`<form id="form-go" method="post" action="/go/${id}"><input name="_token" value="${id}"></form>`,
          { headers: { "Set-Cookie": `session=${id}; Secure` } });
      }
      assert.equal(new Headers(options.headers).get("Cookie"), `session=${id}`);
      assert.equal(String(options.body), `_token=${id}`);
      submitted.push(id);
      return new Response(null, { status: 302, headers: { Location: `https://pixeldrain.com/u/file${id === "first" ? 1080 : 720}E2` } });
    }
    return site.fetcher(input, options);
  };
  assert.equal((await new MkvDrama(fetcher).streams(mkvTitle, mkvRequest)).length, 2);
  assert.deepEqual(submitted.sort(), ["first", "second"]);
});

test("all resolver instances share two slots, and a deadline cancels active plus queued branches", async () => {
  const site = cachedSite(5); site.state.send = false;
  await Promise.all([new MkvDrama(site.fetcher).streams(mkvTitle, mkvRequest), new MkvDrama(site.fetcher).streams(mkvTitle, mkvRequest)]);
  assert.equal(site.metrics().peak, 2);
  site.state.send = true;
  let started = 0, canceled = 0, sends = 0;
  const stalled = new MkvDrama(async (input, options) => {
    if (new URL(String(input)).hostname === "pixeldrain.com") {
      started++;
      return new Promise((_, reject) => options!.signal!.addEventListener("abort", () => { canceled++; reject(options!.signal!.reason); }, { once: true }));
    }
    if (new URL(String(input)).hostname === "send.now") sends++;
    return site.fetcher(input, options);
  }, 60);
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const healthy = await stalled.streams(mkvTitle, mkvRequest);
    assert.equal(healthy.length, 1, "an independently completed host must survive other branches timing out");
    assert.equal(healthy[0].host, "Send");
  }
  finally { clearTimeout(keepAlive); }
  assert.equal(started, 2); assert.equal(canceled, 2);
  assert.equal(sends, 1, "the other Send branch must cancel while queued, before its fetch starts");
  site.state.send = false;
  assert.equal((await new MkvDrama(site.fetcher).streams(mkvTitle, mkvRequest)).length, 2, "cancellation must release global slots");
});

test("failed metadata extraction never persists and can retry successfully", async () => {
  const site = cachedSite(), redis = discoveryRedis(); let probes = 0;
  const inspector = new MkvHeaderInspector(site.fetcher, async () => {
    if (++probes === 1) throw new Error("ffprobe failed");
    return probe();
  }, 3000, redis.open());
  const file = { url: "https://pixeldrain.com/api/file/file1080E2", filename: mkvFilename(), size: site.state.size };
  assert.deepEqual(await inspector.inspect(file), {});
  assert.deepEqual(redis.commands.map(c => c[0]), ["GET"]);
  assert.equal((await inspector.inspect(file)).averageBitrate, 2_000_000);
  assert.deepEqual(redis.commands.map(c => c[0]), ["GET", "GET", "SET"]);
});

test("nested independent links retain one shared 32-page budget", async () => {
  const site = cachedSite(); let requests = 0;
  const fetcher: typeof fetch = async (input, options) => {
    requests++;
    const url = new URL(String(input));
    if (url.pathname === "/drama") return new Response(`<div class="infox"><h1>Test Drama</h1><div class="spe"><span>Aired: 2024</span><span>Type: Drama</span></div></div>
      <div class="soraddlx"><div class="soraurlx"><a href="https://filecrypt.cc/one">One</a><a href="https://filecrypt.cc/two">Two</a></div></div>`);
    if (url.hostname === "filecrypt.cc") return new Response(`<ul class="link-list">${Array.from({ length: 16 }, (_, n) =>
      `<li><a href="https://pixeldrain.com/u/file${n + 1}E2">File</a></li>`).join("")}</ul>`);
    return site.fetcher(input, options);
  };
  const files = await new MkvDrama(fetcher).streams(mkvTitle, mkvRequest);
  assert.ok(files.length > 0);
  assert.equal(requests, 32, "nested branches must not receive fresh budgets");
});

test("a wide listing completes host chains before spending the shared budget on pending siblings", async () => {
  const site = cachedSite(); let requests = 0;
  const fetcher: typeof fetch = async (input, options) => {
    requests++;
    const url = new URL(String(input));
    if (url.pathname === "/drama") return new Response(`<div class="infox"><h1>Test Drama</h1><div class="spe"><span>Aired: 2024</span><span>Type: Drama</span></div></div>
      <div class="soraddlx"><div class="soraurlx">${Array.from({ length: 8 }, (_, n) =>
      `<a href="https://mkvdrama.net/chain/${n}/0">Bundle</a>`).join("")}</div></div>`);
    if (url.pathname.startsWith("/chain/")) {
      const [, , id, step] = url.pathname.split("/");
      return new Response(null, { status: 302, headers: { Location: Number(step) < 5 ?
        `https://mkvdrama.net/chain/${id}/${Number(step) + 1}` : `https://pixeldrain.com/u/bundle${id}` } });
    }
    if (url.hostname === "pixeldrain.com") return Response.json({ success: true, name: mkvFilename(), size: 1_000_000 });
    return site.fetcher(input, options);
  };
  const files = await new MkvDrama(fetcher, 30_000, new DiscoveryStore({})).streams(mkvTitle, mkvRequest);
  assert.equal(files.length, 4, "completed files must survive the same budget that the sequential resolver used");
  assert.equal(requests, 32, "pending branches must not receive extra requests");
});

test("long gated bundles finish before another bundle consumes their shared host-verification budget", async () => {
  const site = cachedSite(); let requests = 0;
  const fetcher: typeof fetch = async (input, options) => {
    requests++;
    const url = new URL(String(input));
    if (url.pathname === "/drama") return new Response(`<div class="infox"><h1>Test Drama</h1><div class="spe"><span>Aired: 2024</span><span>Type: Drama</span></div></div>
      <div class="soraddlx"><div class="soraurlx"><a href="https://mkvdrama.net/bundle/first">First</a><a href="https://mkvdrama.net/bundle/second">Second</a></div></div>`);
    if (url.pathname.startsWith("/bundle/")) return new Response(null, { status: 302,
      headers: { Location: `https://ouo.io/start/${url.pathname.split("/").at(-1)}` } });
    if (url.hostname === "www.google.com") return new Response(url.pathname.endsWith("anchor") ?
      '<input id="recaptcha-token" value="bootstrap">' : JSON.stringify(["rresp", "verification", null]));
    if (url.hostname === "ouo.io") {
      const [, stage, id] = url.pathname.split("/");
      if (stage === "start" || /^[12]$/.test(stage)) return new Response(null, { status: 302,
        headers: { Location: `https://ouo.io/${stage === "start" ? 1 : Number(stage) + 1}/${id}` } });
      if (stage === "3" || stage === "go") return new Response(`<form id="form-go" method="post" action="/${stage === "3" ? "go" : "finish"}/${id}"><input name="x-token"></form>`);
      return new Response(null, { status: 302, headers: { Location: `https://filecrypt.cc/chain/${id}/0` } });
    }
    if (url.hostname === "filecrypt.cc") {
      const [, , id, step] = url.pathname.split("/");
      return new Response(null, { status: 302, headers: { Location: Number(step) < 3 ?
        `https://filecrypt.cc/chain/${id}/${Number(step) + 1}` : `https://pixeldrain.com/u/${id}` } });
    }
    if (url.hostname === "pixeldrain.com") return Response.json({ success: true, name: mkvFilename(), size: 1_000_000 });
    return site.fetcher(input, options);
  };
  const files = await new MkvDrama(fetcher, 30_000, new DiscoveryStore({})).streams(mkvTitle, mkvRequest);
  assert.equal(files.length, 1, "the first completed bundle must survive budget exhaustion in the next bundle");
  assert.equal(requests, 32);
});

test("all five VOD providers and MKV hosts/qualities keep deterministic, identical cold/warm source cards", async () => {
  const site = cachedSite(5), redis = discoveryRedis(), vod = fixtures([drama(1, { vod_name: "测试剧" })], 5);
  let headerStarted = false, lateHostFinished = false, overlap = false;
  const fetcher: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    if (new Headers(options?.headers).has("Range")) { headerStarted = true; if (!lateHostFinished) overlap = true; }
    if (url.hostname === "send.now") { await delay(20); lateHostFinished = true; }
    if (url.hostname === "api.themoviedb.org") return url.searchParams.get("language") === "en-US" ? Response.json({ name: "Test Drama" }) : vod.fetcher(input, options);
    return site.fetcher(input, options);
  };
  const service = new AddonService([...vod.providers, new MkvDrama(fetcher, 30_000, redis.open())],
    new MetadataResolver(fetcher, "key"), fetcher, vod.inspector, [720, 1080], new MkvHeaderInspector(fetcher, probe, 3000, redis.open()));
  const cold = await service.streams("series", "tmdb:210757:1:2");
  assert.equal(cold.length, 9);
  const mkv = cold.filter(card => card.description.includes("MKVDrama ·"));
  assert.deepEqual(mkv.map(card => card.name), ["1080P", "1080P", "720P", "720P"]);
  assert.deepEqual(mkv.map(card => card.behaviorHints.filename), [mkvFilename(), mkvFilename(), mkvFilename(720), mkvFilename(720)]);
  assert.equal(mkv[0].behaviorHints.videoSize, 1_000_000);
  assert.ok(mkv.every(card => card.description.includes("Bitrate: 2 Mbps\nLanguage: Chinese\nSubtitle: Chinese\n")));
  assert.deepEqual(mkv[1].behaviorHints.proxyHeaders, { request: { Referer: "https://send.now/file1080E2" } });
  assert.ok(headerStarted && overlap, "a discovered header must start before all other host resolutions finish");
  const warm = await service.streams("series", "tmdb:210757:1:2");
  const normalize = (cards: typeof cold) => cards.map(card => ({ ...card, url: card.url.replace(/\/sign\d+\//, "/signature/") }));
  assert.deepEqual(normalize(warm), normalize(cold));
  assert.ok(site.metrics().peak <= 2, "discovery and headers must share one two-task limit");
});
