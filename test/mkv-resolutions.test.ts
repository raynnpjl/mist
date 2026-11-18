import test from "node:test";
import assert from "node:assert/strict";
import { MkvDrama } from "../src/mkvdrama.js";
import { MkvHeaderInspector } from "../src/mkv-metadata.js";
import { AddonService } from "../src/service.js";
import { MetadataResolver } from "../src/metadata.js";
import { RESOLUTIONS, Resolution } from "../src/settings.js";
import { drama, fixtures } from "./fixtures.js";
import { cachedSite, discoveryRedis, mkvFilename, mkvRequest, mkvTitle } from "./discovery-fixtures.js";

function bundleSite(labels = ["1080p", "720p"], filenames: Record<string, string> = {}) {
  const site = cachedSite(), seen: { url: URL; range: boolean }[] = [];
  const fetcher: typeof fetch = async (input, options) => {
    const url = new URL(String(input)), range = new Headers(options?.headers).has("Range");
    seen.push({ url, range });
    if (url.hostname === "mkvdrama.net" && url.pathname.startsWith("/bundle/")) return new Response(null, { status: 302,
      headers: { Location: `https://filecrypt.cc${url.pathname}` } });
    if (url.hostname === "filecrypt.cc") {
      const [, , height, host] = url.pathname.split("/");
      return new Response(`<a id="download" href="${host === "pixel" ? "https://pixeldrain.com/u/" : "https://send.now/"}file${height}E2">Download</a>`);
    }
    const response = await site.fetcher(input, options);
    if (url.pathname === "/drama") return new Response((await response.text())
      .replace("<strong>1080p</strong>", `<strong>${labels[0]}</strong>`)
      .replace("<strong>720p</strong>", `<strong>${labels[1]}</strong>`)
      .replace(/https:\/\/pixeldrain.com\/u\/file(\d+)E2/g, "https://mkvdrama.net/bundle/$1/pixel")
      .replace(/https:\/\/send.now\/file(\d+)E2/g, "https://mkvdrama.net/bundle/$1/send"));
    const id = url.pathname.match(/^\/api\/file\/(\w+)\/info$/)?.[1];
    if (id && filenames[id]) return Response.json({ ...await response.json(), name: filenames[id] });
    return response;
  };
  return { ...site, fetcher, seen };
}

function services(site: ReturnType<typeof bundleSite>) {
  const redis = discoveryRedis(), vod = fixtures([drama(1, { vod_name: "测试剧" })], 0);
  const fetcher: typeof fetch = (input, options) => {
    const url = new URL(String(input));
    if (url.hostname === "api.themoviedb.org") return url.searchParams.get("language") === "en-US" ?
      Promise.resolve(Response.json({ name: "Test Drama" })) : vod.fetcher(input, options);
    return site.fetcher(input, options);
  };
  const source = new MkvDrama(fetcher, 30_000, redis.open());
  const inspector = new MkvHeaderInspector(fetcher, async () => ({ format: { duration: "4" }, streams: [
    { codec_type: "subtitle", tags: { language: "eng" } }, { codec_type: "subtitle", tags: { language: "chi" } }
  ] }), 3000, redis.open());
  const create = (resolutions = [...RESOLUTIONS]) => new AddonService([source], new MetadataResolver(fetcher, "key"), fetcher,
    vod.inspector, resolutions, inspector);
  return { source, create, redis };
}

test("4K MKVDrama files are enabled by default, selectable separately, and keep their original filenames", async () => {
  const filename = mkvFilename(2160);
  for (const [selection, names] of [[RESOLUTIONS, ["4K", "720P"]], [[2160], ["4K"]], [[1080], []], [[720], ["720P"]]] as [Resolution[], string[]][]) {
    const site = bundleSite(["2160p", "720p"], { file1080E2: filename }); site.state.send = false;
    const cards = await services(site).create(selection).streams("series", "tmdb:210757:1:2");
    assert.deepEqual(cards.map(card => card.name), names);
    assert.equal(site.seen.some(({ url }) => url.pathname === "/bundle/1080/pixel"), selection.includes(2160),
      "disabled 2160p bundles must be skipped before redirects and host metadata requests");
    const fourK = cards.find(card => card.name === "4K");
    if (fourK) assert.equal(fourK.behaviorHints.filename, filename);
  }
});

test("disabled-only bundles cause no redirect, container or host requests and enabled cards stay complete", async () => {
  const baselineSite = bundleSite(), baseline = services(baselineSite);
  const all = await baseline.create().streams("series", "tmdb:210757:1:2");
  const site = bundleSite(), fixture = services(site);
  const selected = await fixture.create([1080]).streams("series", "tmdb:210757:1:2");
  assert.equal(selected.length, 2);
  const normalize = (cards: typeof all) => cards.map(card => ({ ...card, url: card.url.replace(/\/sign\d+\//, "/signature/") }));
  assert.deepEqual(normalize(selected), normalize(all.filter(card => card.name === "1080P")));
  assert.ok(site.seen.every(({ url }) => !/720/.test(url.href)), "disabled bundles must be skipped before their first redirect");
  assert.equal(site.seen.filter(item => item.range).length, 2);
  assert.equal(selected[0].behaviorHints.videoSize, 1_000_000);
  assert.equal(selected[0].behaviorHints.filename, mkvFilename());
  assert.match(selected[0].description, /Bitrate: 2 Mbps\nLanguage: Chinese\nSubtitle: Multiple\nMKVDrama · PixelDrain$/);
  assert.deepEqual(selected[1].behaviorHints.proxyHeaders, { request: { Referer: "https://send.now/file1080E2" } });
  assert.equal(baselineSite.seen.filter(({ range }) => !range).length - site.seen.filter(({ range }) => !range).length, 6);
});

test("an entirely disabled listing returns empty without treating filtering as a stale episode lookup", async () => {
  const site = bundleSite(), fixture = services(site);
  assert.deepEqual(await fixture.create([360]).streams("series", "tmdb:210757:1:2"), []);
  assert.deepEqual(site.seen.map(({ url }) => url.pathname), ["/search", "/drama", "/search"]);
  assert.deepEqual(site.seen.filter(({ url }) => url.pathname === "/search").map(({ url }) => url.searchParams.get("q")), ["Test Drama", "测试剧"],
    "other aliases may still find enabled sources, without refreshing the filtered page");
  const before = site.seen.length;
  assert.deepEqual(await fixture.create([360]).streams("series", "tmdb:210757:1:2"), []);
  assert.deepEqual(site.seen.slice(before).map(({ url }) => url.pathname), ["/drama"]);
  assert.ok(fixture.redis.commands.every(command => command[0] !== "DEL"), "intentional exclusion must not invalidate a shared show mapping");
});

test("mixed, ambiguous and unlabelled bundles still resolve and retain the final file filter", async () => {
  for (const label of ["720p / 1080p", "720p + original", "720p / 4K", "Mixed 720p", "HD", "", "WEB-DL", "720p 1080p"]) {
    const site = bundleSite(["1080p", label]), fixture = services(site);
    const cards = await fixture.create([1080]).streams("series", "tmdb:210757:1:2");
    assert.equal(cards.length, 2, label);
    assert.ok(site.seen.some(({ url }) => url.pathname === "/bundle/720/pixel"), label);
    assert.ok(site.seen.some(({ url }) => url.hostname === "send.now" && url.pathname.includes("720")), label);
    assert.equal(site.seen.filter(item => item.range).length, 2, "the existing file-level filter still excludes disabled header reads");
  }
});

test("a mixed bundle can supply an enabled filename despite the first resolution in its label", async () => {
  const site = bundleSite(["720p / 1080p", "720p"]), fixture = services(site);
  const cards = await fixture.create([1080]).streams("series", "tmdb:210757:1:2");
  assert.equal(cards.length, 2);
  assert.ok(cards.every(card => card.name === "1080P"));
  assert.ok(site.seen.some(({ url }) => url.pathname === "/bundle/1080/pixel"));
});

test("conflicting anchor or filename hints keep a disabled-labelled bundle discoverable", async () => {
  for (const conflict of ["anchor", "filename"]) {
    const site = bundleSite(["720p", "720p"]), fixtureSite = { ...site };
    const fetcher: typeof fetch = async (input, options) => {
      const response = await site.fetcher(input, options);
      if (new URL(String(input)).pathname !== "/drama") return response;
      const html = await response.text();
      return new Response(conflict === "anchor" ? html.replace(
        'href="https://mkvdrama.net/bundle/1080/pixel">PixelDrain',
        'href="https://mkvdrama.net/bundle/1080/pixel">720p / 1080p') : html.replace(
        'https://mkvdrama.net/bundle/1080/pixel', `https://cdn.example/${mkvFilename()}`));
    };
    fixtureSite.fetcher = fetcher;
    const cards = await services(fixtureSite).create([1080]).streams("series", "tmdb:210757:1:2");
    assert.equal(cards.length, 1, conflict);
    assert.equal(cards[0].behaviorHints.filename, mkvFilename());
    if (conflict === "anchor") assert.ok(site.seen.some(({ url }) => url.hostname === "pixeldrain.com"));
  }
});

test("filtering one listing does not hide enabled bundles found through another alias", async () => {
  const site = bundleSite(["720p", "720p"]);
  const fetcher: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.pathname === "/search" && url.searchParams.get("q") === "测试剧") return new Response(
      '<article class="bs"><a itemprop="url" title="Test Drama" href="/other-drama">Test Drama</a></article>');
    if (url.pathname === "/other-drama") return new Response(
      `<div class="infox"><h1>Test Drama</h1><div class="spe"><span>Aired: 2024</span><span>Type: Drama</span></div></div>
      <div class="soraddlx"><div class="soraurlx"><strong>1080p</strong><a href="https://pixeldrain.com/u/file1080E2">PixelDrain</a></div></div>`);
    return site.fetcher(input, options);
  };
  const cards = await services({ ...site, fetcher }).create([1080]).streams("series", "tmdb:210757:1:2");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].behaviorHints.filename, mkvFilename());
  assert.ok(site.seen.every(({ url }) => !url.pathname.startsWith("/bundle/")));
});

test("disabled bundles do not consume the existing link cap ahead of enabled qualities", async () => {
  const site = bundleSite();
  const fetcher: typeof fetch = async (input, options) => {
    const response = await site.fetcher(input, options);
    if (new URL(String(input)).pathname !== "/drama") return response;
    return new Response((await response.text()).replace(
      '<a href="https://mkvdrama.net/bundle/1080/pixel">PixelDrain</a>', link => link.repeat(12)));
  };
  const cards = await services({ ...site, fetcher }).create([720]).streams("series", "tmdb:210757:1:2");
  assert.equal(cards.length, 2);
  assert.ok(cards.every(card => card.name === "720P"));
  assert.ok(site.seen.every(({ url }) => !url.pathname.includes("1080")));
});

test("early filtering uses existing height parsing and resolution buckets", async () => {
  for (const [label, filename, selection, expected] of [
    ["720pHD", mkvFilename(720), [1080], 0],
    ["1080pHD", mkvFilename(), [1080], 1],
    ["540p", mkvFilename(540), [720], 1],
    ["540p", mkvFilename(540), [480], 0],
    ["360p", mkvFilename(360), [360], 1],
    ["480p", mkvFilename(480), [480], 1],
    ["1440p", mkvFilename(1440), ["unknown"], 0]
  ] as [string, string, Resolution[], number][]) {
    const site = bundleSite([label, "720p"], { file1080E2: filename }); site.state.send = false;
    const cards = await services(site).create(selection).streams("series", "tmdb:210757:1:2");
    assert.equal(cards.filter(card => card.url.endsWith("file1080E2")).length, expected, `${label} with ${selection}`);
    assert.equal(site.seen.some(({ url }) => url.pathname === "/bundle/1080/pixel"), Boolean(expected), label);
  }
});

test("unknown file resolutions remain governed by the installation's unknown preference", async () => {
  for (const [selection, unknownCount] of [[["unknown"], 1], [[1080], 0]] as [Resolution[], number][]) {
    const site = bundleSite(["1080p", ""], { file720E2: "Test.Drama.S01E02.mkv" }); site.state.send = false;
    const cards = await services(site).create(selection).streams("series", "tmdb:210757:1:2");
    assert.equal(cards.filter(card => card.name === "Unknown").length, unknownCount);
    assert.ok(site.seen.some(({ url }) => url.pathname === "/bundle/720/pixel"), "missing labels always require discovery");
  }
});

test("selection changes cannot poison shared stream or episode caches, including fresh instances", async () => {
  const site = bundleSite(), redis = discoveryRedis(); site.state.send = false;
  const source = new MkvDrama(site.fetcher, 30_000, redis.open());
  const lookup = (provider: MkvDrama, resolutions: Resolution[]) => provider.streams(mkvTitle, mkvRequest, undefined, undefined, resolutions);
  const high = await lookup(source, [1080]), saved = structuredClone(high);
  assert.deepEqual(high.map(file => file.height), [1080]);
  assert.deepEqual((await lookup(source, [720])).map(file => file.height), [720]);
  assert.deepEqual((await lookup(source, [720, 1080])).map(file => file.height), [1080, 720]);
  assert.deepEqual(high, saved, "filtering another selection must not mutate a cached result");
  assert.equal(await lookup(source, [1080]), high);
  const replica = new MkvDrama(site.fetcher, 30_000, redis.open());
  const before = site.seen.length;
  assert.deepEqual((await lookup(replica, [720])).map(file => file.height), [720]);
  assert.ok(site.seen.slice(before).every(({ url }) => url.hostname === "pixeldrain.com"), "replica must use the matching episode shard");
  const episodes = [...redis.records].filter(([key]) => key.includes(":episodes:"));
  assert.equal(episodes.length, 3);
  assert.equal([...redis.records].filter(([key]) => key.includes(":shows:")).length, 1, "show mappings remain selection independent");
});

test("a restrictive Redis cache cannot hide a different installation's enabled quality", async () => {
  const site = bundleSite(), redis = discoveryRedis(); site.state.send = false;
  const open = () => new MkvDrama(site.fetcher, 30_000, redis.open());
  await open().streams(mkvTitle, mkvRequest, undefined, undefined, [1080]);
  const before = site.seen.length;
  const lower = await open().streams(mkvTitle, mkvRequest, undefined, undefined, [720]);
  assert.deepEqual(lower.map(file => file.height), [720]);
  assert.ok(site.seen.slice(before).some(({ url }) => url.pathname === "/drama"));
  assert.ok(site.seen.slice(before).every(({ url }) => !url.pathname.includes("1080")));
});

test("normalized selections share in-flight work while different selections remain isolated", async () => {
  const site = bundleSite(), redis = discoveryRedis(); site.state.send = false;
  const source = new MkvDrama(site.fetcher, 30_000, redis.open());
  const reversed: Resolution[] = [1080, 720];
  const [both, duplicate, high] = await Promise.all([
    source.streams(mkvTitle, mkvRequest, undefined, undefined, reversed),
    source.streams(mkvTitle, mkvRequest, undefined, undefined, [720, 1080]),
    source.streams(mkvTitle, mkvRequest, undefined, undefined, [1080])
  ]);
  assert.equal(duplicate, both);
  assert.deepEqual(both.map(file => file.height), [1080, 720]);
  assert.deepEqual(high.map(file => file.height), [1080]);
  assert.deepEqual(reversed, [1080, 720], "normalization must not sort the caller's settings array");
  assert.equal(site.seen.filter(({ url }) => url.pathname === "/drama").length, 2);
  const before = site.seen.length;
  assert.equal(await source.streams(mkvTitle, mkvRequest, undefined, undefined, [720, 1080]), both);
  assert.equal(site.seen.length, before);
});

test("all-enabled discovery retains every existing request and explicit/default selections deduplicate", async () => {
  const site = bundleSite(["2160p", "720p"]), redis = discoveryRedis(); site.state.send = false;
  const source = new MkvDrama(site.fetcher, 30_000, redis.open());
  const all = await source.streams(mkvTitle, mkvRequest);
  assert.deepEqual(all.map(file => file.height), [1080, 720], "all-enabled discovery must preserve filename precedence over page hints");
  assert.ok(site.seen.some(({ url }) => url.pathname === "/bundle/1080/pixel"));
  const before = site.seen.length;
  assert.equal(await source.streams(mkvTitle, mkvRequest, undefined, undefined, [...RESOLUTIONS].reverse()), all);
  assert.equal(site.seen.length, before);
});
