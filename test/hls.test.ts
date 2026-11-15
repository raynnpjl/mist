import test from "node:test";
import assert from "node:assert/strict";
import { HlsPlaylists, rewritePlaylist } from "../src/hls.js";

const base = "https://video.example/show/2000k/hls/index.m3u8";
const markedBreak = ["# ppvod-ad-injected v1", "#EXT-X-DISCONTINUITY", "#EXTINF:4,", "/ad/00000.ts",
  "#EXTINF:1.76,", "/ad/00001.ts", "#EXT-X-DISCONTINUITY"];
const original = ["#EXTM3U", "#EXT-X-TARGETDURATION:7", "#EXTINF:6.68,", "00074.ts", ...markedBreak,
  "#EXTINF:3.52,", "00075.ts", "#EXTINF:6.6,", "00494.ts", ...markedBreak, "#EXTINF:4,", "00495.ts", "#EXT-X-ENDLIST"].join("\n");
const relay = (url: string) => `https://mist.example/hls/${Buffer.from(url).toString("base64url")}.m3u8`;

test("both explicitly marked injected ads are removed without changing program order or durations", () => {
  const fixed = rewritePlaylist(original, base, relay);
  assert.ok(!/ppvod|DISCONTINUITY|\/ad\//.test(fixed));
  const uris = fixed.split("\n").filter(line => line && !line.startsWith("#"));
  assert.deepEqual(uris, ["00074.ts", "00075.ts", "00494.ts", "00495.ts"].map(uri => new URL(uri, base).href));
  assert.deepEqual([...fixed.matchAll(/#EXTINF:([\d.]+)/g)].map(match => Number(match[1])), [6.68, 3.52, 6.6, 4]);
  assert.match(fixed, /#EXT-X-ENDLIST\n$/);
});

test("explicit adjump media paths identify ad blocks without a ppvod comment", () => {
  const pathBreak = ["#EXT-X-DISCONTINUITY", "#EXTINF:3,", "/video/adjump/time/17932819848870000000.ts",
    "#EXTINF:1.76,", "/video/adjump/time/17932819848870000001.ts", "#EXT-X-DISCONTINUITY"];
  const body = ["#EXTM3U", "#EXT-X-TARGETDURATION:7", "#EXTINF:6.68,", "00074.ts", ...pathBreak,
    "#EXTINF:3.52,", "00075.ts", "#EXTINF:6.6,", "00494.ts", ...pathBreak, "#EXTINF:4,", "00495.ts", "#EXT-X-ENDLIST"].join("\n");
  const fixed = rewritePlaylist(body, base, relay);
  assert.ok(!/adjump|DISCONTINUITY/.test(fixed));
  assert.deepEqual(fixed.split("\n").filter(line => line && !line.startsWith("#")),
    ["00074.ts", "00075.ts", "00494.ts", "00495.ts"].map(uri => new URL(uri, base).href));
  assert.deepEqual([...fixed.matchAll(/#EXTINF:([\d.]+)/g)].map(match => Number(match[1])), [6.68, 3.52, 6.6, 4]);
  const unrelated = body.replaceAll("/video/adjump/time/", "/video/scene/time/");
  assert.equal((rewritePlaylist(unrelated, base, relay).match(/#EXT-X-DISCONTINUITY/g) || []).length, 4);
  const incomplete = body.replace("#EXT-X-DISCONTINUITY\n#EXTINF:3.52", "#EXTINF:3.52")
    .replace("#EXTINF:6.6,\n00494.ts", "#EXT-X-DISCONTINUITY\n#EXTINF:6.6,\n00494.ts");
  for (const program of ["00074.ts", "00075.ts", "00494.ts", "00495.ts"]) {
    assert.ok(rewritePlaylist(incomplete, base, relay).includes(new URL(program, base).href));
  }
});

test("unmarked discontinuities, live playlists, incomplete ads and stateful media remain intact", () => {
  const unmarked = original.replaceAll("# ppvod-ad-injected v1\n", "");
  assert.equal((rewritePlaylist(unmarked, base, relay).match(/#EXT-X-DISCONTINUITY/g) || []).length, 4);
  const mixed = original.replace("#EXTINF:4,\n00495.ts", "#EXT-X-DISCONTINUITY\n#EXTINF:4,\n00495.ts");
  assert.equal((rewritePlaylist(mixed, base, relay).match(/#EXT-X-DISCONTINUITY/g) || []).length, 1);
  const incompleteFirst = original.replace("#EXT-X-DISCONTINUITY\n#EXTINF:3.52", "#EXTINF:3.52");
  const partial = rewritePlaylist(incompleteFirst, base, relay);
  assert.equal((partial.match(/https:\/\/video.example\/ad\/00000.ts/g) || []).length, 1, "The incomplete first block stays while the complete second block is removed");
  const unsafe = [original.replace("#EXT-X-ENDLIST", ""),
    incompleteFirst.replace("#EXT-X-DISCONTINUITY\n#EXTINF:4,\n00495.ts", "#EXTINF:4,\n00495.ts"),
    original.replaceAll("#EXTINF:1.76,\n/ad/00001.ts", "#EXTINF:0,\n/ad/00001.ts"),
    original.replaceAll("# ppvod-ad-injected v1", "# unverified-ad-marker"),
    original.replaceAll("/ad/00000.ts", "ad-00000.ts").replaceAll("/ad/00001.ts", "ad-00001.ts"),
    ...["#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"", "#EXT-X-MAP:URI=\"init.mp4\"", "#EXT-X-BYTERANGE:100@0",
      "#EXT-X-PROGRAM-DATE-TIME:2026-11-15T00:00:00Z", "#EXT-X-DATERANGE:ID=\"ad\",START-DATE=\"2026-11-15T00:00:00Z\"",
      "#EXT-X-DISCONTINUITY-SEQUENCE:3", "#EXT-X-I-FRAMES-ONLY"].map(tag => original.replace("#EXTM3U", `#EXTM3U\n${tag}`))];
  for (const body of unsafe) {
    const fixed = rewritePlaylist(body, base, relay);
    const expected = body.split("\n").filter(line => line && !line.startsWith("#")).map(uri => new URL(uri, base).href);
    assert.deepEqual(fixed.split("\n").filter(line => line && !line.startsWith("#")), expected);
    assert.equal((fixed.match(/#EXT-X-DISCONTINUITY\n/g) || []).length, (body.match(/#EXT-X-DISCONTINUITY\n/g) || []).length);
  }
});

test("master variants and alternate playlists use Mist; segments, keys and maps stay on the CDN", () => {
  const master = ["#EXTM3U", "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",URI=\"../audio.m3u8\"",
    "#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=500000,URI=\"iframe.m3u8\"",
    "#EXT-X-STREAM-INF:BANDWIDTH=2000000", "video.m3u8?token=abc"].join("\n");
  const fixed = rewritePlaylist(master, base, relay);
  for (const name of ["../audio.m3u8", "iframe.m3u8", "video.m3u8?token=abc"]) {
    assert.ok(fixed.includes(relay(new URL(name, base).href)));
  }
  const encrypted = rewritePlaylist("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:4,\nsegment.ts\n#EXT-X-ENDLIST", base, relay);
  for (const name of ["key.bin", "init.mp4", "segment.ts"]) assert.ok(encrypted.includes(new URL(name, base).href));
});

test("a missing ad closing tag cannot consume program segments up to a later scene discontinuity", () => {
  const malformed = original.replace("#EXT-X-DISCONTINUITY\n#EXTINF:3.52", "#EXTINF:3.52")
    .replace("#EXTINF:6.6,\n00494.ts", "#EXT-X-DISCONTINUITY\n#EXTINF:6.6,\n00494.ts");
  const fixed = rewritePlaylist(malformed, base, relay);
  for (const program of ["00074.ts", "00075.ts", "00494.ts", "00495.ts"]) {
    assert.ok(fixed.includes(new URL(program, base).href), `Program segment ${program} must survive an incomplete ad block`);
  }
});

test("playlist links survive another instance but reject tampering and another installation", () => {
  const key = "01".repeat(32), id = "a".repeat(48);
  const first = new HlsPlaylists(key), replica = new HlsPlaylists(key);
  const url = first.url(base, id, "https://mist.example");
  const token = new URL(url).pathname.split("/").at(-1)!.slice(0, -5);
  assert.equal(replica.source(token, id), base);
  assert.equal(replica.source(token, "b".repeat(48)), undefined);
  assert.equal(replica.source(`x${token}`, id), undefined);
  assert.equal(replica.source(token.slice(0, -1), id), undefined);
  assert.equal(new HlsPlaylists("02".repeat(32)).source(token, id), undefined);
  assert.throws(() => first.url("file:///etc/passwd", id, "https://mist.example"), /Invalid/);
});

test("unlabelled inserted clips are detected from their independent clock and continuous program join", async () => {
  const body = ["#EXTM3U", "#EXT-X-TARGETDURATION:7", "#EXTINF:4,", "before.ts", "#EXT-X-DISCONTINUITY",
    "#EXTINF:5.566667,", "clip-a.ts", "#EXTINF:2.933333,", "clip-b.ts", "#EXT-X-DISCONTINUITY",
    "#EXTINF:4,", "after.ts", "#EXT-X-ENDLIST"].join("\n");
  const clocks: Record<string, { start: number; end: number }> = {
    "before.ts": { start: 294.64, end: 298.64 }, "clip-a.ts": { start: 1.4, end: 6.966667 },
    "clip-b.ts": { start: 6.966667, end: 9.9 }, "after.ts": { start: 298.64, end: 302.64 }
  };
  const probed: string[] = [];
  const playlists = new HlsPlaylists("01".repeat(32), async () => new Response(body), async url => {
    probed.push(url);
    return clocks[new URL(url).pathname.split("/").at(-1)!];
  });
  const fixed = await playlists.read(base, "a".repeat(48), "https://mist.example");
  assert.deepEqual(fixed.split("\n").filter(line => line && !line.startsWith("#")),
    ["before.ts", "after.ts"].map(uri => new URL(uri, base).href), "Clock detection must remove unlabelled inserted clips");
  assert.ok(!fixed.includes("DISCONTINUITY"));
  assert.equal(new Set(probed).size, 4);
  for (const change of [
    { "after.ts": { start: 999, end: 1003 } },
    { "clip-a.ts": { start: 298.64, end: 304.206667 } },
    { "clip-b.ts": { start: 6.966667, end: 50 } }
  ]) {
    const unchanged = new HlsPlaylists("01".repeat(32), async () => new Response(body), async url => {
      const name = new URL(url).pathname.split("/").at(-1)!;
      return { ...clocks, ...change }[name];
    });
    assert.match(await unchanged.read(base, "a".repeat(48), "https://mist.example"), /clip-a\.ts/);
  }
  const unavailable = new HlsPlaylists("01".repeat(32), async () => new Response(body), async () => { throw new Error("probe unavailable"); });
  assert.match(await unavailable.read(base, "a".repeat(48), "https://mist.example"), /clip-a\.ts/);
});

test("clock detection shares repeated segment probes and bounds concurrent work", async () => {
  const clocks: Record<string, { start: number; end: number }> = {
    "00074.ts": { start: 294.64, end: 301.32 }, "00075.ts": { start: 301.32, end: 304.84 },
    "00494.ts": { start: 1980, end: 1986.6 }, "00495.ts": { start: 1986.6, end: 1990.6 },
    "00000.ts": { start: 1.4, end: 5.4 }, "00001.ts": { start: 5.4, end: 7.16 }
  };
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let active = 0, peak = 0;
  const probes: string[] = [];
  const playlists = new HlsPlaylists("01".repeat(32), async () => new Response(original.replaceAll("# ppvod-ad-injected v1\n", "")), async url => {
    probes.push(url); active++; peak = Math.max(peak, active);
    try { await gate; return clocks[new URL(url).pathname.split("/").at(-1)!]; }
    finally { active--; }
  });
  const pending = playlists.read(base, "a".repeat(48), "https://mist.example");
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(active, 4);
  } finally { release(); }
  assert.ok(!/\/ad\//.test(await pending));
  assert.equal(peak, 4);
  assert.equal(probes.length, 6, "Each shared program/ad segment is probed once per playlist read");
  assert.equal(new Set(probes).size, probes.length);
});

test("protected playlists and an exhausted playback deadline never start segment probes", async t => {
  let probes = 0;
  for (const body of [original.replace("#EXT-X-ENDLIST", ""), original.replace("#EXTM3U", "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"")]) {
    const playlists = new HlsPlaylists("01".repeat(32), async () => new Response(body), async () => { probes++; throw new Error("Unexpected probe"); });
    assert.match(await playlists.read(base, "a".repeat(48), "https://mist.example"), /\/ad\/00000\.ts/);
  }
  let now = 10000;
  t.mock.method(Date, "now", () => now);
  const slow = new HlsPlaylists("01".repeat(32), async () => {
    now += 9000;
    return new Response(original.replaceAll("# ppvod-ad-injected v1\n", ""));
  }, async () => { probes++; throw new Error("Unexpected probe"); });
  assert.match(await slow.read(base, "a".repeat(48), "https://mist.example"), /\/ad\/00000\.ts/);
  assert.equal(probes, 0);
});

test("every playlist read fetches fresh content, honors redirect bases and can recover after upstream failures", async () => {
  let requests = 0;
  const playlists = new HlsPlaylists("01".repeat(32), async (_input, options) => {
    requests++;
    assert.equal((options?.headers as Record<string, string>)["User-Agent"], "Mozilla/5.0");
    assert.ok(options?.signal instanceof AbortSignal);
    if (requests === 1) return new Response("offline", { status: 503 });
    if (requests === 2) return new Response("not HLS");
    const response = new Response(requests === 3 ? original : original.replace("00075.ts", "updated.ts"));
    Object.defineProperty(response, "url", { value: "https://cdn.example/redirected/index.m3u8" });
    return response;
  });
  const read = () => playlists.read(base, "a".repeat(48), "https://mist.example");
  await assert.rejects(read(), /HTTP 503/);
  await assert.rejects(read(), /HLS playlist/);
  assert.match(await read(), /https:\/\/cdn.example\/redirected\/00075\.ts/);
  assert.match(await read(), /https:\/\/cdn.example\/redirected\/updated\.ts/);
  assert.equal(requests, 4);
});
