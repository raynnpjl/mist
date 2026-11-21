import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { MediaInspector, codecTags, parsePlaylist, parseProbe } from "../src/media.js";

test("eight inspections run together with full detail budgets while excess work stays queued", async t => {
  let now = 10000;
  t.mock.method(Date, "now", () => now);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let active = 0, peak = 0, calls = 0;
  const budgets: number[] = [];
  const inspector = new MediaInspector(async () => new Response("#EXTM3U\n"), async (_url, timeout) => {
    calls++; active++; peak = Math.max(peak, active); budgets.push(timeout);
    try {
      await gate;
      return { width: 1920, height: 1080, videoCodec: "h264", audioCodec: "aac", channelLayout: "stereo" };
    } finally { active--; }
  });
  const urls = Array.from({ length: 10 }, (_, i) => `https://video.example/${i}.m3u8`);
  const pending = urls.map(url => inspector.inspect(url));
  const completed = Promise.all(pending);
  assert.equal(inspector.inspect(urls[0]), pending[0], "duplicate URLs must share their queued inspection");
  try {
    await setImmediate();
    assert.equal(active, 8, "all eight slots must be usable before any inspection finishes");
    assert.equal(calls, 8, "excess inspections must remain queued");
  } finally {
    now += 6501;
    release();
    await completed;
  }
  assert.ok((await completed).every(info => info.height === 1080 && info.videoCodec === "h264" && info.audioCodec === "aac"));
  assert.equal(calls, 10);
  assert.equal(peak, 8);
  assert.deepEqual(budgets, Array(10).fill(6500));
});

test("successful inspections share verified facts across budgets and expire without normalizing signed URLs", async t => {
  let now = 10000, calls = 0;
  t.mock.method(Date, "now", () => now);
  const inspector = new MediaInspector(async input => new Response(String(input).includes(".m3u8") ? "#EXTM3U\n#EXTINF:5,\nsegment.ts\n" : "media"), async () => {
    calls++;
    return { reachable: true, width: 1920, height: 1080, videoCodec: "h264" };
  });
  const url = "https://video.example/master.m3u8";
  const first = await inspector.inspect(url, 1000);
  assert.equal(await inspector.inspect(url, 10000), first);
  assert.equal(calls, 1, "changing an account's detail budget must reuse successful metadata");
  await inspector.inspect(url + "?token=two", 10000);
  assert.equal(calls, 2, "different playback signatures must remain distinct");
  now += 5 * 60_000 + 1;
  await inspector.inspect(url, 10000);
  assert.equal(calls, 3, "expired availability and media details must be refreshed");
});

test("short failed inspections cannot poison thorough inspections, and failures retry after five seconds", async t => {
  let now = 10000;
  t.mock.method(Date, "now", () => now);
  const budgets: number[] = [];
  const inspector = new MediaInspector(async () => new Response("#EXTM3U\n"), async (_url, timeout) => {
    budgets.push(timeout);
    if (timeout < 6500) throw new Error("Probe timed out");
    return { reachable: true, height: 1080, videoCodec: "h264" };
  });
  const url = "https://video.example/master.m3u8";
  assert.equal((await inspector.inspect(url, 1000)).height, undefined);
  await inspector.inspect(url, 1000);
  assert.deepEqual(budgets, [1000], "identical failures should have a short cooldown");
  now += 5001;
  await inspector.inspect(url, 1000);
  assert.deepEqual(budgets, [1000, 1000]);
  assert.equal((await inspector.inspect(url, 6500)).height, 1080);
  assert.deepEqual(budgets, [1000, 1000, 6500]);
  assert.equal((await inspector.inspect(url, 1000)).height, 1080);
  assert.deepEqual(budgets, [1000, 1000, 6500]);
});

test("pending inspections with different budgets keep independent probes", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const budgets: number[] = [];
  const inspector = new MediaInspector(async () => new Response("#EXTM3U\n"), async (_url, timeout) => {
    budgets.push(timeout);
    await gate;
    if (timeout === 1000) throw new Error("Probe timed out");
    return { reachable: true, height: 1080, videoCodec: "h264" };
  });
  const short = inspector.inspect("https://video.example/master.m3u8", 1000);
  const thorough = inspector.inspect("https://video.example/master.m3u8", 10000);
  try {
    await setImmediate();
    assert.deepEqual(budgets, [1000, 10000]);
  } finally { release(); }
  assert.equal((await short).height, undefined);
  assert.equal((await thorough).height, 1080);
});

test("playlist-only dimensions retry verification instead of entering the successful metadata cache", async t => {
  let now = 10000, calls = 0;
  t.mock.method(Date, "now", () => now);
  const inspector = new MediaInspector(async input => String(input).endsWith(".m3u8") ?
    new Response("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\nmedia.m3u8\n") : new Response("sample"),
  async () => {
    if (++calls === 1) throw new Error("Probe timed out");
    return { reachable: true, height: 1080, videoCodec: "h264" };
  });
  const url = "https://video.example/master.m3u8";
  assert.equal((await inspector.inspect(url)).height, 720);
  now += 5001;
  assert.equal((await inspector.inspect(url)).height, 1080);
  assert.equal(calls, 2);
});

test("FFprobe HLS playlist-size bitrate is excluded while real file bitrate is retained", () => {
  const data = { streams: [{ codec_type: "video", width: 1920, height: 1080, codec_name: "h264" }],
    format: { format_name: "hls", bit_rate: "122" } };
  const hls = parseProbe(data, "https://video.example/index.m3u8");
  assert.equal(hls.height, 1080);
  assert.equal(hls.bitrate, undefined);
  const mp4 = parseProbe({ ...data, format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", bit_rate: "2500000" } },
    "https://video.example/movie.mp4");
  assert.equal(mp4.bitrate, 2500000);
});

test("HLS master inspection chooses the highest declared resolution and resolves relative URLs", () => {
  const playlist = parsePlaylist(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720
720/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,AVERAGE-BANDWIDTH=4000000,RESOLUTION=1920x1080
1080/index.m3u8?token=abc
`, "https://video.example/master.m3u8");
  assert.deepEqual(playlist, { next: "https://video.example/1080/index.m3u8?token=abc", width: 1920, height: 1080, bitrate: 4000000 });
});

test("cold inspection reads only playlists; availability refresh reads a bounded range without repeating FFprobe", async t => {
  let now = 10000;
  t.mock.method(Date, "now", () => now);
  const requests: string[] = [];
  let canceled = false, probes = 0;
  const fetcher: typeof fetch = async (input, options) => {
    const url = String(input); requests.push(url);
    if (url.endsWith("master.m3u8")) return new Response("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1080x608\nmedia.m3u8\n");
    if (url.endsWith("media.m3u8")) return new Response("#EXTM3U\n#EXTINF:10,\nsegment.ts\n");
    assert.equal((options?.headers as Record<string, string>).Range, "bytes=0-1023");
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(512 * 1024).fill(0x47)); },
      cancel() { canceled = true; }
    }), { status: 206 });
  };
  const inspector = new MediaInspector(fetcher, async () => {
    probes++;
    return { reachable: true, width: 1080, height: 606, videoCodec: "h264", audioCodec: "aac", channelLayout: "stereo" };
  });
  const first = await inspector.inspect("https://video.example/master.m3u8");
  assert.equal(first.height, 606);
  assert.equal(first.bitrate, 800000);
  assert.equal(first.reachable, true);
  assert.equal(canceled, false, "FFprobe already reads the media on a cold lookup");
  assert.equal(await inspector.inspect("https://video.example/master.m3u8"), first);
  assert.equal(requests.length, 2);
  assert.equal(probes, 1);
  now += 30001;
  const refreshed = await inspector.inspect("https://video.example/master.m3u8");
  assert.equal(refreshed.height, 606);
  assert.equal(refreshed.reachable, true);
  assert.equal(canceled, true);
  assert.equal(requests.length, 5);
  assert.equal(probes, 1, "verified dimensions and codecs outlive the availability check");
});

test("missing ffprobe preserves declared quality without fabricating codecs", async () => {
  const fetcher: typeof fetch = async input => String(input).endsWith(".m3u8") ?
    new Response("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\nmedia.m3u8\n") : new Response("small");
  const inspector = new MediaInspector(fetcher, async () => { throw new Error("ENOENT"); });
  const info = await inspector.inspect("https://video.example/master.m3u8");
  assert.equal(info.height, 720);
  assert.equal(info.bitrate, 2000000);
  assert.deepEqual(codecTags(info), []);
});

test("failed inspection remains usable as an unavailable-metadata result", async () => {
  const inspector = new MediaInspector(async () => { throw new Error("offline"); }, async () => { throw new Error("offline"); });
  const info = await inspector.inspect("https://video.example/index.m3u8");
  assert.equal(info.reachable, false);
  assert.equal(info.height, undefined);
  assert.equal(info.bitrate, undefined);
});

test("a single HLS segment is not misrepresented as the full stream bitrate", async () => {
  const fetcher: typeof fetch = async input => String(input).endsWith(".m3u8") ?
    new Response("#EXTM3U\n#EXTINF:8,\nsegment.ts\n") :
    new Response(new Uint8Array(1024).fill(0x47), { status: 206, headers: { "Content-Range": "bytes 0-1023/2500000" } });
  const inspector = new MediaInspector(fetcher, async () => ({}));
  const info = await inspector.inspect("https://video.example/index.m3u8");
  assert.equal(info.bitrate, undefined);
});

test("shared byte-range media files do not produce inflated whole-file bitrate estimates", async () => {
  const fetcher: typeof fetch = async input => String(input).endsWith(".m3u8") ?
    new Response("#EXTM3U\n#EXTINF:8,\n#EXT-X-BYTERANGE:1000000@20000\nshared.mp4\n") :
    new Response(new Uint8Array(1024).fill(0x47), { status: 206, headers: { "Content-Range": "bytes 0-1023/500000000" } });
  const info = await new MediaInspector(fetcher, async () => ({})).inspect("https://video.example/index.m3u8");
  assert.equal(info.bitrate, undefined);
});

test("badge tokens describe detected codecs and channel layouts without guessing surround or HDR", () => {
  assert.deepEqual(codecTags({ reachable: true, videoCodec: "h264", audioCodec: "aac", channelLayout: "stereo" }), ["H.264", "AAC", "2.0"]);
  assert.deepEqual(codecTags({ reachable: true, videoCodec: "hevc", audioCodec: "eac3", channelLayout: "5.1(side)" }), ["HEVC", "EAC3", "5.1"]);
  assert.deepEqual(codecTags({ reachable: true }), []);
});
