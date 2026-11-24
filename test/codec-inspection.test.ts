import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { haveMediaTools, makeMediaFixtures } from "../scripts/media-fixtures.js";
import { tsCodecHeader, mp4InitCodecHeader } from "../src/codec-header.js";
import { MediaInspector, probeSegmentClock, tsSampleProbe } from "../src/media.js";
import { takeProbeMetrics } from "../src/loading.js";

const available = haveMediaTools();
const mediaPlaylist = (uri: string, extra = "") =>
  `#EXTM3U\n#EXT-X-TARGETDURATION:1\n${extra}#EXTINF:1,\n${uri}\n#EXT-X-ENDLIST\n`;
const responseURL = (response: Response, url: string) => Object.defineProperty(response, "url", { value: url });

function rangeResponse(bytes: Buffer, range: string | null): Response {
  const match = range?.match(/^bytes=(\d+)-(\d+)$/);
  assert.ok(match);
  const start = Number(match[1]), end = Math.min(Number(match[2]), bytes.length - 1);
  return new Response(new Uint8Array(bytes.subarray(start, end + 1)), { status: 206,
    headers: { "Content-Range": `bytes ${start}-${end}/${bytes.length}` } });
}

test("codec headers verify cropped MPEG-TS dimensions, handle AVC init and refuse malformed or arbitrary data", { skip: !available }, t => {
  const directory = mkdtempSync(join(tmpdir(), "mist-codec-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = makeMediaFixtures(directory);
  const ts = file("cropped.ts"), init = file("init.mp4"), invalid = Buffer.from(ts);
  assert.deepEqual(tsCodecHeader(ts), { width: 318, height: 238, videoCodec: "h264", audioCodec: "aac", channelLayout: "stereo", complete: true });
  assert.deepEqual(mp4InitCodecHeader(init), { width: 318, height: 238, videoCodec: "h264", complete: false });
  assert.equal(tsCodecHeader(ts.subarray(0, 3 * 188)), undefined);
  const sps = invalid.indexOf(Buffer.from([0, 0, 0, 1, 0x67]));
  assert.ok(sps >= 0);
  invalid[sps + 6] |= 3;
  assert.equal(tsCodecHeader(invalid), undefined);
  assert.equal(tsCodecHeader(Buffer.concat([Buffer.alloc(188), ts])), undefined);
  assert.equal(tsCodecHeader(file("direct.mp4")), undefined);
  assert.equal(mp4InitCodecHeader(init.subarray(0, init.length - 10)), undefined);
  assert.equal(mp4InitCodecHeader(Buffer.concat([Buffer.from("an arbitrary header"), init])), undefined);
});

test("exact HLS variant and sample dimensions win over declarations without renewing availability", { skip: !available }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "mist-exact-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = makeMediaFixtures(directory), ts = file("cropped.ts"), other = file("other.ts");
  let now = 10_000, healthy = true, different = false, ranges: string[] = [];
  t.mock.method(Date, "now", () => now);
  const inspector = new MediaInspector(async (input, options) => {
    const url = new URL(String(input)), range = new Headers(options?.headers).get("Range");
    if (url.pathname.endsWith("/entry")) {
      const text = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=230000,RESOLUTION=800x600\nvariant?sig=selected\n";
      return responseURL(new Response(text), "https://cdn.example/redirect/entry.m3u8");
    }
    if (url.pathname.endsWith("/variant")) {
      assert.equal(url.search, "?sig=selected");
      return new Response(mediaPlaylist("segment.ts?sig=sample"));
    }
    assert.equal(url.pathname, "/redirect/segment.ts");
    ranges.push(range!);
    if (!healthy) return new Response("gone", { status: 410 });
    return responseURL(rangeResponse(different ? other : ts, range), `https://cdn.example/frame-${different ? "b" : "a"}.ts`);
  }, async () => assert.fail("a complete exact header should avoid FFprobe"), 6500, { lightweight: true });
  const first = await inspector.inspect("https://fixture.example/entry?sig=original");
  assert.equal(first.height, 238);
  assert.equal(first.reachable, true);
  assert.equal(first.audioCodec, "aac");
  assert.equal(first.channelLayout, "stereo");
  assert.equal(first.bitrate, 230000);
  assert.equal(first.resolutionEvidence?.source, "codec-header");
  assert.equal(first.resolutionEvidence?.verified, true);
  assert.ok(first.resolutionEvidence?.variantIdentity && first.resolutionEvidence.sampleIdentity);
  assert.deepEqual(ranges, ["bytes=0-65535"]);
  now += 30001;
  healthy = false;
  const failed = await inspector.inspect("https://fixture.example/entry?sig=original");
  assert.equal(failed.reachable, false);
  assert.equal(failed.height, 238);
  assert.equal(failed.resolutionEvidence, first.resolutionEvidence);
  now += 5001;
  healthy = true;
  different = true;
  const changed = await inspector.inspect("https://fixture.example/entry?sig=original");
  assert.equal(changed.reachable, true);
  assert.equal(changed.height, 298);
  assert.notEqual(changed.resolutionEvidence?.sampleIdentity, first.resolutionEvidence?.sampleIdentity);
});

test("TS ranges are validated, a complete mono sample supplies rich fallback without an extra download, and encrypted media uses URL fallback",
  { skip: !available }, async t => {
    const directory = mkdtempSync(join(tmpdir(), "mist-codec-fallback-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const file = makeMediaFixtures(directory), mono = file("mono.ts"), init = file("init.mp4");
    const asset = Buffer.concat([Buffer.alloc(500), mono]);
    const mapAsset = Buffer.concat([Buffer.alloc(800), init, Buffer.alloc(50)]);
    const ranges: string[] = [], urlProbes: string[] = [];
    takeProbeMetrics();
    const inspector = new MediaInspector(async (input, options) => {
      const url = String(input), path = new URL(url).pathname, range = new Headers(options?.headers).get("Range");
      switch (path) {
        case "/mono.m3u8": return new Response(mediaPlaylist(`#EXT-X-BYTERANGE:${mono.length}@500\nmono.ts`));
        case "/wrong.m3u8": return new Response(mediaPlaylist(`#EXT-X-BYTERANGE:${mono.length}@500\nwrong.ts`));
        case "/encrypted.m3u8": return new Response(mediaPlaylist("encrypted.ts", '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n'));
        case "/frag-complete.m3u8":
        case "/frag.m3u8": return new Response(mediaPlaylist("fragment.m4s", `#EXT-X-MAP:URI="init.bin",BYTERANGE="${init.length}@800"\n`));
        case "/mono.ts": ranges.push(range!); return rangeResponse(asset, range);
        case "/wrong.ts": ranges.push(range!); return new Response(new Uint8Array(asset));
        case "/init.bin": ranges.push(range!); return rangeResponse(mapAsset, range);
        default: assert.fail(`unexpected request ${url}`);
      }
    }, async url => {
      const path = new URL(url).pathname;
      urlProbes.push(path);
      return { reachable: true, height: path === "/frag.m3u8" ? undefined : 480, videoCodec: "h264", audioCodec: "ac3",
        channelLayout: "5.1(side)", subtitles: "English" };
    }, 6500, { lightweight: true, sampleProbe: tsSampleProbe() });
    const inspect = (file: string) => inspector.inspect(`https://fixture.example/${file}.m3u8`);
    const sampled = await inspect("mono");
    assert.equal(sampled.height, 238);
    assert.equal(sampled.audioCodec, "aac");
    assert.equal(sampled.channelLayout, "mono");
    assert.equal(sampled.resolutionEvidence?.source, "codec-header");
    assert.equal((await inspect("wrong")).resolutionEvidence?.source, "ffprobe");
    assert.equal((await inspect("encrypted")).height, 480);
    const fragment = await inspect("frag");
    assert.equal(fragment.height, 238);
    assert.equal(fragment.subtitles, "English");
    assert.equal(fragment.audioCodec, "ac3");
    assert.equal(fragment.channelLayout, "5.1(side)");
    assert.equal(fragment.resolutionEvidence?.source, "codec-header");
    assert.equal((await inspect("frag-complete")).resolutionEvidence?.source, "ffprobe");
    assert.deepEqual(urlProbes, ["/wrong.m3u8", "/encrypted.m3u8", "/frag.m3u8", "/frag-complete.m3u8"]);
    assert.deepEqual(ranges, [`bytes=500-${500 + mono.length - 1}`, `bytes=500-${500 + mono.length - 1}`, `bytes=800-${800 + init.length - 1}`]);
    const { counters } = takeProbeMetrics();
    assert.equal(counters["media.sampleReused"], 1);
    assert.equal(counters["ffprobe.calls"], 1);
    assert.equal(counters["media.header.success"], 2);
  });

test("a new range in the same signed HLS resource invalidates the old dimensions", { skip: !available }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "mist-codec-range-change-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = makeMediaFixtures(directory);
  const first = file("cropped.ts"), second = file("other.ts"), pad = Buffer.alloc(188);
  const bytes = Buffer.concat([pad, first, second]);
  let now = 10_000, update = false;
  t.mock.method(Date, "now", () => now);
  const ranges: string[] = [];
  const inspector = new MediaInspector(async (input, options) => {
    if (String(input).endsWith("entry.m3u8?sig=same")) {
      const offset = update ? pad.length + first.length : pad.length, length = update ? second.length : first.length;
      return new Response(mediaPlaylist(`#EXT-X-BYTERANGE:${length}@${offset}\nsegments.ts?token=reused`));
    }
    const range = new Headers(options?.headers).get("Range");
    ranges.push(range!);
    return rangeResponse(bytes, range);
  }, async () => assert.fail("both ranges contain complete verified headers"), 6500, { lightweight: true });
  const entry = "https://fixture.example/entry.m3u8?sig=same";
  assert.equal((await inspector.inspect(entry)).height, 238);
  now += 30_001;
  update = true;
  assert.equal((await inspector.inspect(entry)).height, 298);
  assert.deepEqual(ranges, [`bytes=188-${188 + first.length - 1}`, `bytes=${188 + first.length}-${bytes.length - 1}`]);
});

test("clock evidence carries expiry from the final media response URL", { skip: !available }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "mist-clock-expiry-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = makeMediaFixtures(directory);
  t.mock.method(Date, "now", () => 10_000);
  const clock = await probeSegmentClock("https://fixture.example/clip.ts", 1000,
    async () => responseURL(new Response(new Uint8Array(file("clip.ts"))), "https://cdn.example/clip.ts?Expires=19"));
  assert.equal(clock.reuseUntil, 14_000);
  assert.ok(clock.end > clock.start);
});
