import test from "node:test";
import assert from "node:assert/strict";
import { HlsPlaylists, rewritePlaylist } from "../src/hls.js";

const base = "https://video.example/show/2000k/hls/index.m3u8";
const markedBreak = ["# ppvod-ad-injected v1", "#EXT-X-DISCONTINUITY", "#EXTINF:4,", "/ad/00000.ts",
  "#EXTINF:1.76,", "/ad/00001.ts", "#EXT-X-DISCONTINUITY"];
const original = ["#EXTM3U", "#EXT-X-TARGETDURATION:7", "#EXTINF:6.68,", "00074.ts", ...markedBreak,
  "#EXTINF:3.52,", "00075.ts", "#EXTINF:6.6,", "00494.ts", ...markedBreak, "#EXTINF:4,", "00495.ts", "#EXT-X-ENDLIST"].join("\n");
const relay = (url: string) => `https://mist.example/hls/${Buffer.from(url).toString("base64url")}.m3u8`;

test("both explicitly marked injected ads are removed without removing program segments", () => {
  const fixed = rewritePlaylist(original, base, relay);
  assert.ok(!/ppvod|DISCONTINUITY|\/ad\//.test(fixed));
  const uris = fixed.split("\n").filter(line => line && !line.startsWith("#"));
  assert.deepEqual(uris, ["00074.ts", "00075.ts", "00494.ts", "00495.ts"].map(uri => new URL(uri, base).href));
  assert.deepEqual([...fixed.matchAll(/#EXTINF:([\d.]+)/g)].map(match => Number(match[1])), [6.68, 3.52, 6.6, 4]);
  assert.match(fixed, /#EXT-X-ENDLIST\n$/);
});

test("unmarked discontinuities, live playlists, incomplete ads and stateful media remain intact", () => {
  const unmarked = original.replaceAll("# ppvod-ad-injected v1\n", "");
  assert.equal((rewritePlaylist(unmarked, base, relay).match(/#EXT-X-DISCONTINUITY/g) || []).length, 4);
  const mixed = original.replace("#EXTINF:4,\n00495.ts", "#EXT-X-DISCONTINUITY\n#EXTINF:4,\n00495.ts");
  assert.equal((rewritePlaylist(mixed, base, relay).match(/#EXT-X-DISCONTINUITY/g) || []).length, 1);
  for (const body of [original.replace("#EXT-X-ENDLIST", ""), original.replaceAll("#EXT-X-DISCONTINUITY\n#EXTINF:3.52", "#EXTINF:3.52"),
    ...["#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"", "#EXT-X-MAP:URI=\"init.mp4\"", "#EXT-X-BYTERANGE:100@0",
      "#EXT-X-PROGRAM-DATE-TIME:2026-11-15T00:00:00Z"].map(tag => original.replace("#EXTM3U", `#EXTM3U\n${tag}`))]) {
    assert.match(rewritePlaylist(body, base, relay), /https:\/\/video.example\/ad\/00000.ts/);
  }
});

test("master variants and alternate playlists use the relay; segments, keys and maps stay on the CDN", () => {
  const master = ["#EXTM3U", "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",URI=\"../audio.m3u8\"",
    "#EXT-X-STREAM-INF:BANDWIDTH=2000000", "video.m3u8"].join("\n");
  const fixed = rewritePlaylist(master, base, relay);
  assert.ok(fixed.includes(relay(new URL("../audio.m3u8", base).href)));
  assert.ok(fixed.includes(relay(new URL("video.m3u8", base).href)));
  const encrypted = rewritePlaylist("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:4,\nsegment.ts\n#EXT-X-ENDLIST", base, relay);
  for (const name of ["key.bin", "init.mp4", "segment.ts"]) assert.ok(encrypted.includes(new URL(name, base).href));
});

test("playlist links survive another instance but reject tampering and another installation", async () => {
  const key = "01".repeat(32), id = "a".repeat(48);
  let requests = 0;
  const fetcher: typeof fetch = async () => { requests++; return new Response(original); };
  const first = new HlsPlaylists(key, fetcher), replica = new HlsPlaylists(key, fetcher);
  const url = first.url(base, id, "https://mist.example");
  const token = new URL(url).pathname.split("/").at(-1)!.slice(0, -5);
  assert.equal(replica.source(token, id), base);
  assert.equal(replica.source(token, "b".repeat(48)), undefined);
  assert.equal(replica.source(`x${token}`, id), undefined);
  assert.equal(replica.source(token.slice(0, -1), id), undefined);
  assert.equal(new HlsPlaylists("02".repeat(32)).source(token, id), undefined);
  assert.throws(() => first.url("file:///etc/passwd", id, "https://mist.example"), /Invalid/);
  const fixed = await replica.read(base, id, "https://mist.example");
  assert.ok(!fixed.includes("/ad/"));
  assert.equal(requests, 1);
});

test("upstream HTTP errors and non-HLS responses fail; a later valid response can recover", async () => {
  let requests = 0;
  const playlists = new HlsPlaylists("01".repeat(32), async () => {
    requests++;
    return requests === 1 ? new Response("offline", { status: 503 }) : new Response(requests === 2 ? "not HLS" : original);
  });
  await assert.rejects(playlists.read(base, "a".repeat(48), "https://mist.example"), /HTTP 503/);
  await assert.rejects(playlists.read(base, "a".repeat(48), "https://mist.example"), /HLS playlist/);
  assert.ok((await playlists.read(base, "a".repeat(48), "https://mist.example")).includes("00074.ts"));
  assert.equal(requests, 3);
});
