import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import { Installations } from "../src/installations.js";
import { MetadataResolver } from "../src/metadata.js";
import { AddonService } from "../src/service.js";
import { drama, fixtures } from "./fixtures.js";

test("website validates and encrypts keys, serves private addon routes, and updates active installations", async t => {
  const dir = await mkdtemp(join(tmpdir(), "mist-configure-"));
  const store = await Installations.open(dir);
  const fixture = fixtures([drama()]);
  const keys: string[] = [];
  const fetcher: typeof fetch = (input, options) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/authentication") && url.searchParams.get("api_key") === "f".repeat(32)) {
      return Promise.resolve(new Response("Unauthorized", { status: 401 }));
    }
    return fixture.fetcher(input, options);
  };
  const factory = (key: string) => {
    keys.push(key);
    return new AddonService(fixture.providers, new MetadataResolver(fetcher, key), fetcher, fixture.inspector);
  };
  const server = createApp(store, factory, fixture.providers).listen(0, "127.0.0.1");
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (data: unknown, headers = {}) => fetch(`${base}/api/configure`, { method: "POST",
    headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(data) });
  const html = await (await fetch(`${base}/configure`)).text();
  assert.match(html, /type="password"/);
  assert.match(html, /DMCA Notice/);
  assert.match(html, /Continue/);
  assert.equal((await post({ apiKey: "invalid" })).status, 400);
  assert.equal((await post({ apiKey: "f".repeat(32) })).status, 400);
  assert.deepEqual(await readdir(dir), ["master.key"], "invalid keys must not be saved");
  const apiKey = "0123456789abcdef0123456789abcdef";
  assert.equal((await post({ apiKey }, { Origin: "https://unrelated.example" })).status, 403);
  const response = await post({ apiKey }, { Origin: base });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const raw = await response.text();
  assert.ok(!raw.includes(apiKey));
  const { installation, manifestPath } = JSON.parse(raw);
  assert.equal(await store.get(installation), apiKey);
  const configured = await fetch(base + manifestPath);
  assert.equal(configured.headers.get("access-control-allow-origin"), "*");
  const manifest = await configured.text();
  assert.ok(!manifest.includes(apiKey));
  assert.equal(JSON.parse(manifest).behaviorHints.configurationRequired, undefined);
  const streamUrl = `${base}/${installation}/stream/series/tt26235088:1:1.json`;
  assert.equal((await (await fetch(streamUrl)).json()).streams.length, 2);
  const replacement = "11111111111111111111111111111111";
  assert.equal((await post({ apiKey: replacement, installation })).status, 200);
  assert.equal(await store.get(installation), replacement);
  keys.length = 0;
  assert.equal((await (await fetch(streamUrl)).json()).streams.length, 2);
  assert.deepEqual(keys, [replacement], "a key update must evict the old cached service");
  assert.equal((await fetch(`${base}/${"a".repeat(48)}/manifest.json`)).status, 404);
  assert.equal((await fetch(`${base}/stream/series/tt26235088:1:1.json`)).status, 404);
  assert.equal((await fetch(`${base}/data/master.key`)).status, 404);
});
