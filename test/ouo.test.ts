import test from "node:test";
import assert from "node:assert/strict";
import { resolveOuo } from "../src/ouo.js";

test("OUO redirects stop at the destination without requesting video or verification tokens", async () => {
  const calls: string[] = [];
  const result = await resolveOuo("https://ouo.press/example", async url => {
    calls.push(url);
    return { text: "", redirect: "https://cdn.example/episode.mkv?token=signed" };
  });
  assert.equal(result, "https://cdn.example/episode.mkv?token=signed");
  assert.deepEqual(calls, ["https://ouo.io/example"]);
});

test("OUO rejects foreign form actions before sending cookies or requesting a token", async () => {
  const calls: string[] = [];
  await assert.rejects(resolveOuo("https://ouo.io/example", async url => {
    calls.push(url);
    return { text: '<form id="form-captcha" method="POST" action="https://foreign.example/steal"><input name="_token" value="private"></form>' };
  }), /Invalid OUO form destination/);
  assert.deepEqual(calls, ["https://ouo.io/example"]);
});

test("a missing verification bootstrap or response token never submits the OUO form", async () => {
  for (const anchor of ["<html>No bootstrap</html>", '<input id="recaptcha-token" value="bootstrap">']) {
    const calls: string[] = [];
    await assert.rejects(resolveOuo("https://ouo.io/example", async url => {
      calls.push(url);
      if (new URL(url).hostname === "ouo.io") return { text: '<form id="form-captcha" method="POST" action="/go/example"><input name="_token" value="private"></form>' };
      return { text: url.includes("/anchor?") ? anchor : ')]}\'\n["error","invalid"]' };
    }), /verification (?:bootstrap|token) missing/);
    assert.ok(!calls.some(url => url.includes("/go/example")));
    assert.ok(calls.length <= 3);
  }
});

test("OUO verification allows at most two form submissions", async () => {
  let submissions = 0;
  await assert.rejects(resolveOuo("https://ouo.io/example", async (_url, options) => {
    if (options?.method === "POST") submissions++;
    return { text: '<form id="form-go" method="POST" action="/go/example"><input name="_token" value="fresh"></form>' };
  }), /did not return a destination/);
  assert.equal(submissions, 2);
});

test("OUO follows its cross-domain redirects while keeping form submissions on the current origin", async () => {
  const seen: string[] = [];
  const result = await resolveOuo("https://ouo.io/example", async (url, options) => {
    seen.push(url);
    assert.equal(new Headers(options?.headers).get("authority"), new URL(url).hostname);
    if (url === "https://ouo.io/example") return { text: "", redirect: "https://ouo.press/example" };
    if (url === "https://ouo.press/example") return { text: '<form id="form-go" method="POST" action="/go/example"></form>' };
    assert.equal(options?.method, "POST");
    return { text: "", redirect: "https://pixeldrain.com/u/file" };
  });
  assert.equal(result, "https://pixeldrain.com/u/file");
  assert.deepEqual(seen, ["https://ouo.io/example", "https://ouo.press/example", "https://ouo.press/go/example"]);
  let reads = 0;
  await assert.rejects(resolveOuo("https://ouo.io/example", async () => {
    reads++;
    return { text: "", redirect: "https://ouo.io/example" };
  }), /did not return a destination/);
  assert.ok(reads <= 7, "internal redirects must stay bounded");
});

test("invalid OUO inputs and unsafe destinations are rejected", async () => {
  const read = async () => { assert.fail("Invalid inputs must never make a request"); };
  for (const url of ["https://ouo.io.foreign.example/link", "http://ouo.io/link", "https://user:secret@ouo.io/link", "https://ouo.io:8443/link"]) {
    await assert.rejects(resolveOuo(url, read), /Invalid OUO link/);
  }
  for (const redirect of ["http://cdn.example/episode.mkv", "https://user:secret@cdn.example/episode.mkv"]) {
    await assert.rejects(resolveOuo("https://ouo.io/example", async () => ({ text: "", redirect })), /Invalid OUO destination/);
  }
});
