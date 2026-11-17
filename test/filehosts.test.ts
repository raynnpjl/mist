import test from "node:test";
import assert from "node:assert/strict";
import { resolveSend } from "../src/filehosts.js";

const filename = "Test.Drama.S01E02.1080p.mkv";
const page = `<form id="F1" method="POST"><input name="op" value="download2"><input name="id" value="second">
  <input name="rand" value="fresh&amp;token"><input name="method_free" value=""></form>
  <main id="fv" data-name="${filename}"></main>`;
const playerConfig = (src?: string) => `<script id="xvp-config" type="application/json">${JSON.stringify({ sources: [{ src }] })}</script>`;

test("Send uses the player-signed URL instead of the download URL that rejects concurrent range requests", async () => {
  const player = `https://d1.datatransfer.to/d/player-signed/${filename}`;
  const payload = "Zml4dHVyZTEsIPVMmji8XhHyQZ0P2DO0Uae2cOjlHnTj97etmned2sk+DSrdF8oMNVe5dBOo5leV13ahZFedJ9qXlagDX52+EevE7WE0t0m2wTVC69dX2PGw84GYqmW8wIgLDEanUjxHRyrQZV4i8QB6BMi6SP+5xQ==";
  const methods: string[] = [];
  const file = await resolveSend("https://send.now/second", async (_url, options) => {
    methods.push(options?.method || "GET");
    return options?.method === "POST" ? { text: "", redirect: `https://d1.datatransfer.to/d/download-signed/${filename}` }
      : { text: page + `<script id="xvp-config" type="application/json">${payload}</script>` };
  });
  assert.equal(file.url, player);
  assert.deepEqual(methods, ["GET"], "download form must not be submitted for playback");
});

test("Send reads player metadata without requesting media and labels available subtitles", async () => {
  const seen: { url: string; options?: RequestInit }[] = [];
  const direct = `https://d1.datatransfer.to/d/signed/${filename}`;
  const file = await resolveSend("https://send.now/second", async (url, options) => {
    seen.push({ url, options });
    assert.equal(url, "https://send.now/second", "the resolver must never fetch the generated video URL");
    return { text: page + playerConfig(direct) + '<video><track kind="captions" label="English"><track kind="captions" label="Japanese"></video>' };
  });
  assert.deepEqual(file, { url: direct, filename, subtitles: "Multiple", headers: { Referer: "https://send.now/second" } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].options?.method, undefined);
});

test("Send subtitle metadata stays unknown when absent and names a single listed language", async () => {
  for (const [track, subtitles] of [["", undefined], ['<video><track kind="subtitles" label="English"></video>', "English"]]) {
    const file = await resolveSend("https://send.now/second", async () =>
      ({ text: page + playerConfig(`https://d1.sendcdn.com/d/signed/${filename}`) + track }));
    assert.equal(file.subtitles, subtitles);
  }
});

test("Send rejects missing player metadata and filenames without submitting download forms", async () => {
  for (const text of ["<h1>Login required</h1>", page,
    playerConfig(`https://d1.sendcdn.com/d/signed/${filename}`)]) {
    let reads = 0;
    await assert.rejects(resolveSend("https://send.now/second", async () => { reads++; return { text }; }),
      /player configuration missing/);
    assert.equal(reads, 1);
  }
});

test("Send rejects unsafe, unrelated and non-file destinations without following them", async () => {
  for (const source of [undefined, "http://d1.sendcdn.com/d/file.mkv", "https://user:secret@d1.sendcdn.com/d/file.mkv",
    "https://d1.sendcdn.com:8443/d/file.mkv", "https://d1.sendcdn.com.evil.example/d/file.mkv", "https://send.now/login"]) {
    let reads = 0;
    await assert.rejects(resolveSend("https://send.now/second", async () => {
      reads++;
      return { text: page + playerConfig(source) };
    }), /did not return a direct file URL/);
    assert.equal(reads, 1);
  }
});
