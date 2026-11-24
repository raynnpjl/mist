import test from "node:test";
import assert from "node:assert/strict";
import { HlsPlaylists } from "../src/hls.js";
import { PlaylistFetcher } from "../src/playlist-fetch.js";
import { observeLoading, takeProbeMetrics } from "../src/loading.js";

const root = "https://fixture.example/index.m3u8?sig=one";
const origin = "https://mist.example";
const a = "a".repeat(48), b = "b".repeat(48);
const key = "01".repeat(32);
const VOD = "#EXTM3U\n#EXTINF:4,\nbefore.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:4,\nad.ts\n" +
  "#EXT-X-DISCONTINUITY\n#EXTINF:4,\nafter.ts\n#EXT-X-ENDLIST\n";
const clocks = { "before.ts": { start: 100, end: 104 }, "ad.ts": { start: 1, end: 5 }, "after.ts": { start: 104, end: 108 } };
const clock = (url: string) => clocks[new URL(url).pathname.split("/").at(-1)! as keyof typeof clocks];

test("simultaneous installations share one fetch and receive their own signed child links", async () => {
  let fetches = 0;
  const master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=600000\nchild.m3u8?sig=child\n";
  const hls = new HlsPlaylists(key, async () => { fetches++; return new Response(master); });
  const [first, second] = await Promise.all([hls.read(root, a, origin), hls.read(root, b, origin)]);
  assert.equal(fetches, 1);
  const link = (result: string) => result.trimEnd().split("\n").at(-1)!;
  const token = (result: string) => link(result).split("/").at(-1)!.slice(0, -5);
  assert.notEqual(link(first), link(second));
  assert.equal(hls.source(token(first), a), "https://fixture.example/child.m3u8?sig=child");
  assert.equal(hls.source(token(second), b), "https://fixture.example/child.m3u8?sig=child");
  assert.equal(hls.source(token(first), b), undefined);
  await hls.read(root, a, origin);
  assert.equal(fetches, 2);
});

test("analysis reuse requires matching body, redirect base, signature and unexpired TTL", async t => {
  let now = 10_000, fetches = 0, probes = 0, body = VOD, base = "https://cdn.example/a/index.m3u8";
  t.mock.method(Date, "now", () => now);
  const hls = new HlsPlaylists(key, async () => {
    fetches++;
    const response = new Response(body);
    Object.defineProperty(response, "url", { value: base });
    return response;
  }, async url => { probes++; return clock(url); });
  const get = (url = root) => hls.read(url, a, origin);
  const [first, second] = await Promise.all([get(), get()]);
  assert.equal(first, second);
  assert.doesNotMatch(first, /ad\.ts|DISCONTINUITY/);
  assert.equal(fetches, 1);
  assert.equal(probes, 3);
  await get();
  assert.equal(fetches, 2);
  assert.equal(probes, 3);
  body += "#changed\n";
  await get();
  assert.equal(probes, 6);
  base = base.replace("/a/", "/b/");
  assert.match(await get(), /cdn\.example\/b\/before\.ts/);
  assert.equal(probes, 9);
  await get(root.replace("one", "two"));
  assert.equal(probes, 12);
  now += 30_001;
  await get();
  assert.equal(probes, 15);
  const expiring = root + "&exp=48";
  await get(expiring);
  await get(expiring);
  assert.equal(probes, 18);
  now += 3000;
  await get(expiring);
  assert.equal(probes, 21);
});

test("failed and partial clock analysis can never cache a clean decision", async () => {
  let stage = 0, probes = 0;
  const hls = new HlsPlaylists(key, async () => new Response(VOD), async url => {
    probes++;
    if (stage === 0 || stage === 1 && url.endsWith("after.ts")) throw new DOMException("Timed out", "TimeoutError");
    return clock(url);
  });
  assert.match(await hls.read(root, a, origin), /ad\.ts/);
  stage++;
  assert.match(await hls.read(root, a, origin), /ad\.ts/);
  stage++;
  assert.doesNotMatch(await hls.read(root, a, origin), /ad\.ts/);
  assert.equal(probes, 7);
  await hls.read(root, a, origin);
  assert.equal(probes, 7);
});

test("distinct snapshots can join compatible segment clocks but cannot share signed playlist fetches", async () => {
  let probes = 0, fetches = 0;
  let unblock!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  const hls = new HlsPlaylists(key, async url => { fetches++; return new Response(VOD + `#${url}\n`); },
    async url => { probes++; await gate; return clock(url); });
  const first = hls.read(root, a, origin);
  const second = hls.read(root.replace("one", "two"), b, origin);
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fetches, 2);
    assert.equal(probes, 1);
  } finally { unblock(); }
  assert.ok((await Promise.all([first, second])).every(body => !body.includes("ad.ts")));
  assert.equal(probes, 3);
});

test("fetch keys include signed URLs, headers, ranges and context, with independent caller cancellation", async () => {
  let calls = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const fetcher = async (_input: RequestInfo | URL, options?: RequestInit) => {
    calls++;
    await gate;
    options?.signal?.throwIfAborted();
    return new Response(VOD);
  };
  const pool = new PlaylistFetcher(fetcher, "direct");
  const proxied = new PlaylistFetcher(fetcher, "proxy");
  const caller = new AbortController(), other = new AbortController();
  const read = (header: string, range: string, signal = other.signal) => pool.read(root, signal, "fixture",
    { Referer: header, Range: range });
  const cancelled = read("a", "bytes=0-3", caller.signal);
  const kept = [read("a", "bytes=0-3"), read("b", "bytes=0-3"), read("a", "bytes=3-6"),
    proxied.read(root, other.signal, "fixture", { Referer: "a", Range: "bytes=0-3" })];
  caller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  release();
  assert.equal((await Promise.all(kept)).length, 4);
  assert.equal(calls, 4);
});

test("playlist metrics distinguish one execution from each caller and omit request identifiers", async t => {
  const logs: any[] = [];
  t.mock.method(console, "info", (line: string) => logs.push(JSON.parse(line)));
  takeProbeMetrics();
  const hls = new HlsPlaylists(key, async () => new Response(VOD), async url => clock(url));
  await Promise.all([a, b].map(id => observeLoading(() => hls.read(root, id, origin), "playback-playlist")));
  assert.equal(logs.length, 2);
  assert.equal(logs[0].event, "mist.playback-playlist");
  assert.ok(logs[1].window.p95Ms >= logs[1].window.p50Ms);
  const metrics = takeProbeMetrics();
  assert.equal(metrics.counters["playlist.fetch.started"], 1);
  assert.equal(metrics.counters["playlist.fetch.joins"], 1);
  assert.equal(metrics.stages["playlist.fetch.callerWait"].calls, 2);
  assert.equal(metrics.counters["hls.analysis.started"], 1);
  assert.doesNotMatch(JSON.stringify([metrics, logs]), /sig=|\.example|aaaaaa|bbbbbb/);
});

test("live reads always fetch the latest window and skip clock analysis", async () => {
  let fetches = 0;
  const hls = new HlsPlaylists(key, async () => new Response(VOD.replace("#EXT-X-ENDLIST", "")
    .replace("after.ts", `window-${++fetches}.ts`)), async () => assert.fail("live media should not be clock-probed"));
  assert.match(await hls.read(root, a, origin), /window-1\.ts/);
  assert.match(await hls.read(root, a, origin), /window-2\.ts/);
});

test("a signed segment redirect can shorten completed analysis reuse", async t => {
  let now = 10_000, probes = 0;
  t.mock.method(Date, "now", () => now);
  const hls = new HlsPlaylists(key, async () => new Response(VOD), async url => {
    probes++;
    return { ...clock(url), ...(url.endsWith("/ad.ts") ? { reuseUntil: 12_000 } : {}) };
  });
  await hls.read(root, a, origin);
  await hls.read(root, b, origin);
  assert.equal(probes, 3);
  now = 12_001;
  await hls.read(root, a, origin);
  assert.equal(probes, 6);
});

test("failed executions and both callers' failed waits appear separately in metrics", async () => {
  takeProbeMetrics();
  const fetcher = new PlaylistFetcher(async () => new Response("Forbidden", { status: 403 }));
  const signal = AbortSignal.timeout(1000);
  await Promise.all([1, 2].map(() => assert.rejects(fetcher.read(root, signal, "fixture"), /403/)));
  const { stages } = takeProbeMetrics();
  assert.equal(stages["playlist.fetch.execution"].calls, 1);
  assert.equal(stages["playlist.fetch.execution"].errors, 1);
  assert.equal(stages["playlist.fetch.callerWait"].calls, 2);
  assert.equal(stages["playlist.fetch.callerWait"].errors, 2);
});

test("a playback deadline preserves already verified removals without caching partial work", async t => {
  const originalTimeout = AbortSignal.timeout;
  const budgets: AbortController[] = [];
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    if (ms !== 8000) return originalTimeout(ms);
    const deadline = new AbortController();
    budgets.push(deadline);
    return deadline.signal;
  });
  const body = VOD.replace("#EXT-X-ENDLIST", "#EXT-X-DISCONTINUITY\n#EXTINF:4,\nslow.ts\n" +
    "#EXT-X-DISCONTINUITY\n#EXTINF:4,\nlast.ts\n#EXT-X-ENDLIST");
  let stalled = true, firstAdReads = 0, slowReads = 0;
  const hls = new HlsPlaylists(key, async () => new Response(body), async (url, _timeout, signal) => {
    if (url.endsWith("/ad.ts")) firstAdReads++;
    if (url.endsWith("/slow.ts")) {
      slowReads++;
      if (stalled) return new Promise((_, reject) =>
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
      return { start: 200, end: 204 };
    }
    return clock(url);
  });
  const pending = hls.read(root, a, origin);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(slowReads, 1);
  budgets[0].abort(new DOMException("Playback deadline", "TimeoutError"));
  const partial = await pending;
  assert.doesNotMatch(partial, /ad\.ts/);
  assert.match(partial, /slow\.ts/);
  stalled = false;
  await hls.read(root, b, origin);
  assert.equal(firstAdReads, 2);
  assert.equal(slowReads, 2);
});
