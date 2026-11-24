import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { MediaInspector, parsePlaylist, parseProbe } from "../src/media.js";

const facts = { reachable: true, width: 1920, height: 1080, videoCodec: "h264", audioCodec: "aac" };

test("MP4 cold inspections use only FFprobe; warm availability refresh does not re-probe cached facts", async t => {
  let now = 10000, calls = 0, probes = 0;
  t.mock.method(Date, "now", () => now);
  const inspector = new MediaInspector(async (_input, options) => {
    calls++;
    assert.equal(new Headers(options?.headers).get("Range"), "bytes=0-1023");
    return new Response(new Uint8Array(1024).fill(1));
  }, async () => { probes++; return facts; });
  const url = "https://video.example/episode.mp4";
  assert.equal((await inspector.inspect(url)).reachable, true);
  assert.equal(calls, 0);
  now += 30001;
  assert.equal((await inspector.inspect(url)).height, 1080);
  assert.equal(calls, 1);
  assert.equal(probes, 1);
  now += 5 * 60_000;
  assert.equal((await inspector.inspect(url)).height, 1080);
  assert.equal(probes, 2);
  assert.equal(calls, 1, "a cold re-probe must not also download a redundant sample");
});

test("a failed availability check cannot reuse an old reachable flag or cache its failure for five minutes", async t => {
  let now = 10000, healthy = false, checks = 0, probes = 0;
  t.mock.method(Date, "now", () => now);
  const inspector = new MediaInspector(async () => {
    checks++;
    return healthy ? new Response(new Uint8Array(1024).fill(1)) : new Response("gone", { status: 404 });
  }, async () => { probes++; return facts; });
  const url = "https://video.example/episode.mp4";
  assert.equal((await inspector.inspect(url)).reachable, true);
  now += 30001;
  const failed = await inspector.inspect(url);
  assert.equal(failed.reachable, false);
  assert.equal(failed.height, 1080);
  healthy = true;
  now += 5001;
  assert.equal((await inspector.inspect(url)).reachable, true);
  assert.equal(checks, 2);
  assert.equal(probes, 1);
});

test("recent metadata for an identical signed URL is reused while known expiry still caps caching", async t => {
  let now = 10000, checks = 0, probes = 0, healthy = true;
  t.mock.method(Date, "now", () => now);
  const inspector = new MediaInspector(async () => {
    checks++;
    return healthy ? new Response(new Uint8Array(1024).fill(1)) : new Response("expired", { status: 403 });
  }, async () => { probes++; return facts; });
  const unknown = "https://video.example/episode.mp4?signature=unknown";
  await inspector.inspect(unknown);
  assert.equal((await inspector.inspect(unknown)).reachable, true);
  assert.equal(checks, 0, "metadata caching must not be confused with caching a generated playback URL");
  assert.equal(probes, 1);
  const expiring = "https://video.example/episode.mp4?exp=20";
  await inspector.inspect(expiring);
  healthy = false;
  now += 6000;
  assert.equal((await inspector.inspect(expiring)).reachable, false);
  assert.equal(checks, 1, "the five-second safety margin must invalidate the previous successful result");
  assert.equal(probes, 2);
  healthy = true; now += 30001;
  assert.equal((await inspector.inspect(unknown)).reachable, true);
  assert.equal(checks, 2, "availability still refreshes after 30 seconds");
  assert.equal(probes, 2);
});

test("queued inspections expire after 30 seconds without running a probe or shrinking active budgets", async t => {
  const original = AbortSignal.timeout;
  const queues: AbortController[] = [];
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    if (ms !== 30000) return original(ms);
    const controller = new AbortController(); queues.push(controller); return controller.signal;
  });
  let release!: () => void, probes = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const inspector = new MediaInspector(async () => new Response("#EXTM3U\n"), async (_url, timeout) => {
    probes++;
    assert.equal(timeout, 6500);
    await gate;
    return facts;
  });
  const pending = Array.from({ length: 9 }, (_, i) => inspector.inspect(`https://video.example/${i}.m3u8`));
  try {
    await setImmediate();
    assert.equal(probes, 8);
    queues[8].abort(new DOMException("Queue deadline", "TimeoutError"));
    assert.deepEqual(await pending[8], { reachable: false });
    assert.equal(probes, 8);
  } finally { release(); await Promise.all(pending); }
});

test("subtitle labels require declared or detected tracks and respect the selected HLS subtitle group", () => {
  assert.equal(parseProbe({ streams: [{ codec_type: "video", width: 1920, height: 1080 }] }, "https://video.example/a.mp4").subtitles, undefined);
  assert.equal(parseProbe({ streams: [{ codec_type: "subtitle", tags: { language: "zho" } }] }, "https://video.example/a.mp4").subtitles, "Chinese");
  assert.equal(parseProbe({ streams: [{ codec_type: "subtitle", tags: { language: "eng" } },
    { codec_type: "subtitle", tags: { language: "chi" } }] }, "https://video.example/a.mp4").subtitles, "Multiple");
  const playlist = parsePlaylist(`#EXTM3U
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="low",LANGUAGE="zh",URI="zh.vtt"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="high",LANGUAGE="en",URI="en.vtt"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,SUBTITLES="low"
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1920x1080,SUBTITLES="high"
high.m3u8
`, "https://video.example/master.m3u8");
  assert.equal(playlist.subtitles, "English");
});

test("HLS bandwidth refreshes before codecs expire, including extensionless variants", async t => {
  let now = 10000, bitrate = 2_000_000, probes = 0;
  t.mock.method(Date, "now", () => now);
  const inspector = new MediaInspector(async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("master.m3u8")) return new Response(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=${bitrate},RESOLUTION=1920x1080\nvariant\n`);
    if (url.pathname.endsWith("variant")) return new Response("#EXTM3U\n#EXTINF:10,\nsegment.ts\n");
    assert.ok(url.pathname.endsWith("segment.ts"));
    return new Response(new Uint8Array(1024).fill(0x47));
  }, async () => { probes++; return { reachable: true, height: 1080, videoCodec: "h264" }; });
  const url = "https://video.example/master.m3u8";
  assert.equal((await inspector.inspect(url)).bitrate, 2_000_000);
  bitrate = 4_000_000; now += 30001;
  const refreshed = await inspector.inspect(url);
  assert.equal(refreshed.bitrate, 4_000_000);
  assert.equal(refreshed.reachable, true);
  assert.equal(refreshed.height, 1080);
  assert.equal(probes, 1);
});

test("failed availability checks cannot inherit old reachability, and result caching cannot extend codec expiry", async t => {
  let now = 10000, healthy = true, probes = 0;
  t.mock.method(Date, "now", () => now);
  const inspector = new MediaInspector(async () => healthy ? new Response(new Uint8Array(1024).fill(1)) : new Response("Gone", { status: 410 }),
    async () => { probes++; return { reachable: true, height: 1080, videoCodec: "h264" }; });
  const url = "https://video.example/file.mp4";
  await inspector.inspect(url);
  now += 30001; healthy = false;
  const failed = await inspector.inspect(url);
  assert.equal(failed.reachable, false);
  assert.equal(failed.height, 1080);
  assert.equal(probes, 1);
  now = 10000 + 5 * 60_000 - 1000; healthy = true;
  assert.equal((await inspector.inspect(url)).reachable, true);
  now += 1001;
  await inspector.inspect(url);
  assert.equal(probes, 2);
});

test("warm HLS checks honor the selected segment's byte range", async t => {
  let now = 10000, probes = 0;
  t.mock.method(Date, "now", () => now);
  const ranges: string[] = [];
  const inspector = new MediaInspector(async (input, options) => {
    if (String(input).endsWith(".m3u8")) return new Response("#EXTM3U\n#EXTINF:5,\n#EXT-X-BYTERANGE:500@20000\nshared.mp4\n");
    ranges.push(new Headers(options?.headers).get("Range")!);
    return new Response(new Uint8Array(500).fill(1));
  }, async () => { probes++; return { reachable: true, height: 1080, videoCodec: "h264" }; });
  await inspector.inspect("https://video.example/episode.m3u8");
  assert.equal(ranges.length, 0);
  now += 30001;
  assert.equal((await inspector.inspect("https://video.example/episode.m3u8")).reachable, true);
  assert.deepEqual(ranges, ["bytes=20000-20499"]);
  assert.equal(probes, 1);
});

test("a fresh direct redirect or strong ETag invalidates old FFprobe facts", async t => {
  let now = 10_000, target = "episode-a.mp4", tag = '"a"', probes = 0, height = 360;
  t.mock.method(Date, "now", () => now);
  const inspector = new MediaInspector(async () => {
    const response = new Response(new Uint8Array(1024).fill(1), { headers: { ETag: tag } });
    return Object.defineProperty(response, "url", { value: `https://cdn.example/${target}` });
  }, async () => { probes++; return { ...facts, height }; });
  const url = "https://video.example/episode.mp4";
  assert.equal((await inspector.inspect(url)).height, 360);
  now += 30001;
  target = "episode-b.mp4"; tag = '"b"'; height = 720;
  assert.equal((await inspector.inspect(url)).height, 720);
  now += 30001;
  assert.equal((await inspector.inspect(url)).height, 720);
  assert.equal(probes, 2, "the validated redirect and ETag can reuse the new facts");
  now += 30001;
  tag = '"c"'; height = 1080;
  assert.equal((await inspector.inspect(url)).height, 1080);
  assert.equal(probes, 3);
});

test("a changed master rendition invalidates facts from the same leaf URL", async t => {
  let now = 10_000, switched = false, probes = 0;
  t.mock.method(Date, "now", () => now);
  const inspector = new MediaInspector(async input => String(input).endsWith("master.m3u8")
    ? new Response(`#EXTM3U\n${switched ? '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="alt",NAME="Audio",URI="alt.m3u8"\n' : ""}#EXT-X-STREAM-INF:BANDWIDTH=400000${switched ? ',AUDIO="alt"' : ""}\nvideo.m3u8\n`)
    : new Response("#EXTM3U\n#EXTINF:10,\nvideo.ts\n#EXT-X-ENDLIST\n"),
  async () => { probes++; return { ...facts, audioCodec: switched ? "ac3" : "aac", channelLayout: "stereo" }; });
  const url = "https://video.example/master.m3u8";
  assert.equal((await inspector.inspect(url)).audioCodec, "aac");
  switched = true;
  now += 30001;
  assert.equal((await inspector.inspect(url)).audioCodec, "ac3");
  assert.equal(probes, 2);
});

test("a required init fetch can invalidate availability while retaining verified fMP4 facts", async t => {
  let now = 10_000, initAvailable = true;
  t.mock.method(Date, "now", () => now);
  const reads: string[] = [];
  const inspector = new MediaInspector(async input => {
    const path = new URL(String(input)).pathname;
    reads.push(path);
    if (path === "/episode.m3u8") return new Response('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:10,\nvideo.m4s\n#EXT-X-ENDLIST\n');
    return path === "/init.mp4" && !initAvailable ? new Response("expired", { status: 403 }) :
      new Response(new Uint8Array(1024).fill(1));
  }, async () => ({ ...facts, channelLayout: "stereo" }), 6500, { lightweight: true });
  const url = "https://video.example/episode.m3u8";
  assert.equal((await inspector.inspect(url)).reachable, true);
  assert.deepEqual(reads, ["/episode.m3u8"], "FFprobe supplied all cold details");
  initAvailable = false;
  now += 30001;
  const unavailable = await inspector.inspect(url);
  assert.equal(unavailable.reachable, false);
  assert.equal(unavailable.resolutionEvidence?.height, 1080);
  assert.deepEqual(reads.slice(-2), ["/video.m4s", "/init.mp4"]);
});

test("incomplete short verification retains dimensions and allows a longer probe to fill details", async () => {
  const budgets: number[] = [];
  const inspector = new MediaInspector(async () => new Response(null), async (_url, timeoutMs) => {
    budgets.push(timeoutMs);
    return { ...facts, audioCodec: timeoutMs > 1000 ? "aac" : undefined, channelLayout: timeoutMs > 1000 ? "stereo" : undefined };
  });
  const url = "https://fixture.example/episode.mp4";
  assert.equal((await inspector.inspect(url, 1000)).resolutionEvidence?.verified, true);
  assert.equal((await inspector.inspect(url, 1000)).audioCodec, undefined);
  assert.equal((await inspector.inspect(url, 6500)).channelLayout, "stereo");
  assert.deepEqual(budgets, [1000, 6500]);
});

test("verified height cannot inherit a width from declared playlist dimensions", async () => {
  const inspector = new MediaInspector(async input => new Response(String(input).endsWith("/master.m3u8")
    ? "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=1920x1080\nmedia.m3u8\n"
    : "#EXTM3U\n#EXTINF:10,\nvideo.ts\n"), async () => ({ reachable: true, videoCodec: "h264", height: 720 }));
  const result = await inspector.inspect("https://fixture.example/master.m3u8");
  assert.equal(result.height, 720);
  assert.equal(result.width, undefined);
  assert.equal(result.resolutionEvidence?.width, undefined);
});
