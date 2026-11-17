import test from "node:test";
import assert from "node:assert/strict";
import { MkvHeaderInspector, parseMkvMetadata } from "../src/mkv-metadata.js";

const limit = 128 * 1024;
const bytes = Buffer.concat([Buffer.from("1a45dfa3", "hex"), Buffer.alloc(limit - 4)]);
const file = { url: "https://pixeldrain.com/api/file/episode2", filename: "Test.S01E02.mkv" };
const probeResult = { format: { duration: "3600", bit_rate: "123" }, streams: [
  { codec_type: "video" }, { codec_type: "subtitle", tags: { language: "eng" } },
  { codec_type: "subtitle", tags: { language: "chi" } }
] };
const response = () => new Response(bytes, { status: 206, headers: { "Content-Range": `bytes 0-${limit - 1}/900000000` } });

test("MKV metadata reads one capped prefix, shares concurrent work and caches only parsed results", async () => {
  let reads = 0, probes = 0;
  const inspector = new MkvHeaderInspector(async (url, options) => {
    reads++;
    assert.equal(String(url), file.url);
    assert.equal(options?.redirect, "manual");
    assert.equal(new Headers(options?.headers).get("Range"), `bytes=0-${limit - 1}`);
    assert.equal(new Headers(options?.headers).get("Accept-Encoding"), "identity");
    return response();
  }, async (prefix, timeout) => {
    probes++;
    assert.equal(prefix.length, limit);
    assert.ok(timeout > 0);
    return probeResult;
  });
  const [first, duplicate] = await Promise.all([inspector.inspect(file), inspector.inspect(file)]);
  assert.deepEqual(first, { subtitles: "Multiple", averageBitrate: 2_000_000 });
  assert.equal(duplicate, first);
  assert.equal(await inspector.inspect(file), first);
  assert.equal(reads, 1);
  assert.equal(probes, 1);
  assert.ok(Object.values(first).every(value => !Buffer.isBuffer(value)));
});

test("MKV metadata forwards playback headers and keeps results separate when those headers change", async () => {
  let reads = 0;
  const inspector = new MkvHeaderInspector(async (_url, options) => {
    reads++;
    assert.match(new Headers(options?.headers).get("Referer")!, /^https:\/\/send.now\/(first|second)$/);
    return response();
  }, async () => probeResult);
  const send = { ...file, url: "https://d1.datatransfer.to/d/signed/file.mkv", headers: { Referer: "https://send.now/first" } };
  await inspector.inspect(send);
  await inspector.inspect({ ...send, headers: { Referer: "https://send.now/second" } });
  assert.equal(reads, 2);
});

test("ignored ranges, invalid ranges, redirects and compressed responses are canceled before parsing", async () => {
  for (const [status, headers] of [
    [200, {}], [302, { Location: "http://127.0.0.1/private" }],
    [206, {}], [206, { "Content-Range": "bytes 1-8/1000" }],
    [206, { "Content-Range": `bytes 0-${limit}/900000000` }],
    [206, { "Content-Range": "bytes 0-3/3" }],
    [206, { "Content-Range": "bytes 0-3/*" }],
    [206, { "Content-Range": "bytes 0-3/1000", "Content-Length": "1000000" }],
    [206, { "Content-Range": "bytes 0-3/1000", "Content-Encoding": "gzip" }]
  ] as [number, Record<string, string>][]) {
    let canceled = false, reads = 0;
    const inspector = new MkvHeaderInspector(async () => {
      reads++;
      return new Response(new ReadableStream({ cancel() { canceled = true; } }), { status, headers });
    }, async () => { assert.fail("Invalid responses must never reach FFprobe"); });
    assert.deepEqual(await inspector.inspect(file), {});
    assert.equal(reads, 1);
    assert.equal(canceled, true);
  }
});

test("oversized, truncated and non-Matroska prefixes never reach the parser", async () => {
  for (const data of [Buffer.concat([bytes, Buffer.alloc(1)]), bytes.subarray(0, 8), Buffer.alloc(limit)]) {
    let canceled = false;
    const inspector = new MkvHeaderInspector(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(data); if (data.length <= limit) controller.close(); }, cancel() { canceled = true; }
    }), { status: 206, headers: { "Content-Range": `bytes 0-${limit - 1}/900000000` } }),
    async () => { assert.fail("Invalid prefixes must not be parsed"); });
    assert.deepEqual(await inspector.inspect(file), {});
    if (data.length > limit) assert.equal(canceled, true);
  }
});

test("metadata failures remain optional and do not poison the parsed metadata cache", async () => {
  let reads = 0;
  const inspector = new MkvHeaderInspector(async () => { if (++reads === 1) throw new Error("temporary outage"); return response(); },
    async () => probeResult);
  assert.deepEqual(await inspector.inspect(file), {});
  assert.equal((await inspector.inspect(file)).subtitles, "Multiple");
  assert.equal(reads, 2);
});

test("unsupported hosts, unsafe URLs and non-MKV files do not trigger file reads", async () => {
  const inspector = new MkvHeaderInspector(async () => { assert.fail("Unsupported URL must not be fetched"); });
  for (const url of ["http://pixeldrain.com/api/file/id", "https://user:secret@pixeldrain.com/api/file/id",
    "https://pixeldrain.com:8443/api/file/id", "https://pixeldrain.com.evil.example/api/file/id",
    "https://pixeldrain.com/api/user", "https://fileditchvids.st/file.mkv", "https://127.0.0.1/file.mkv"]) {
    assert.deepEqual(await inspector.inspect({ ...file, url }), {});
  }
  assert.deepEqual(await inspector.inspect({ ...file, filename: "episode.mp4" }), {});
});

test("one deadline cancels stalled header reads and a failed parser preserves source metadata", async () => {
  const inspector = new MkvHeaderInspector(async (_url, options) => new Promise((_, reject) => {
    options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
  }), async () => probeResult, 20);
  const keepAlive = setTimeout(() => {}, 1000);
  try { assert.deepEqual(await inspector.inspect(file), {}); }
  finally { clearTimeout(keepAlive); }
  const unavailable = new MkvHeaderInspector(async () => response(), async () => { throw new Error("ffprobe unavailable"); });
  assert.deepEqual(await unavailable.inspect(file), {});
});

test("subtitle labels use embedded languages and bitrate uses the whole-file size and duration", () => {
  assert.deepEqual(parseMkvMetadata(probeResult, 900000000), { subtitles: "Multiple", averageBitrate: 2_000_000 });
  assert.deepEqual(parseMkvMetadata({ streams: [{ codec_type: "subtitle", tags: { language: "eng" } }] }, 900000000), { subtitles: "English" });
  assert.deepEqual(parseMkvMetadata({ streams: [{ codec_type: "subtitle", tags: { language: "chi" } }] }, 900000000), { subtitles: "Chinese" });
  assert.deepEqual(parseMkvMetadata({ streams: [{ codec_type: "subtitle", tags: { language: "und" } }], format: { duration: "NaN" } }, 900000000), {});
  assert.deepEqual(parseMkvMetadata({ streams: [{ codec_type: "subtitle", tags: { language: "en-abc" } }], format: { duration: "3600" } }, 900000000),
    { averageBitrate: 2_000_000 });
  assert.deepEqual(parseMkvMetadata({ format: { duration: "3600", bit_rate: "999999" } }, 0), {});
});
