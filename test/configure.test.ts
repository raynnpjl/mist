import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.js";
import { MetadataResolver } from "../src/metadata.js";
import { AddonService } from "../src/service.js";
import { drama, fixtures, installationFixture } from "./fixtures.js";

test("website validates and encrypts keys, serves private addon routes, and updates active installations", async t => {
  const redis = installationFixture();
  const store = await redis.open();
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
  const replicaStore = await redis.open();
  const server = createApp(store, factory, fixture.providers).listen(0, "127.0.0.1");
  const replica = createApp(replicaStore, factory, fixture.providers).listen(0, "127.0.0.1");
  t.after(async () => {
    await Promise.all([server, replica].map(instance => new Promise<void>((resolve, reject) => instance.close(error => error ? reject(error) : resolve()))));
  });
  await Promise.all([once(server, "listening"), once(replica, "listening")]);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const replicaBase = `http://127.0.0.1:${(replica.address() as AddressInfo).port}`;
  const post = (data: unknown, headers = {}) => fetch(`${base}/api/configure`, { method: "POST",
    headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(data) });
  const html = await (await fetch(`${base}/configure`)).text();
  assert.match(html, /type="password"/);
  assert.match(html, /DMCA Notice/);
  assert.match(html, /Continue/);
  assert.equal((await post({ apiKey: "invalid" })).status, 400);
  assert.equal((await post({ apiKey: "f".repeat(32) })).status, 400);
  assert.equal(redis.records.size, 0, "invalid keys must not be saved");
  const apiKey = "0123456789abcdef0123456789abcdef";
  assert.equal((await post({ apiKey }, { Origin: "https://unrelated.example" })).status, 403);
  const response = await post({ apiKey }, { Origin: base });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const raw = await response.text();
  assert.ok(!raw.includes(apiKey));
  const { installation, manifestPath } = JSON.parse(raw);
  assert.equal((await store.get(installation))?.apiKey, apiKey);
  const configured = await fetch(base + manifestPath);
  assert.equal(configured.headers.get("access-control-allow-origin"), "*");
  const manifest = await configured.text();
  assert.ok(!manifest.includes(apiKey));
  assert.equal(JSON.parse(manifest).behaviorHints.configurationRequired, undefined);
  const streamUrl = `${base}/${installation}/stream/series/tt26235088:1:1.json`;
  const replicaStreamUrl = `${replicaBase}/${installation}/stream/series/tt26235088:1:1.json`;
  assert.equal((await (await fetch(streamUrl)).json()).streams.length, 2);
  assert.equal((await (await fetch(replicaStreamUrl)).json()).streams.length, 2);
  const replacement = "11111111111111111111111111111111";
  assert.equal((await post({ apiKey: replacement, installation })).status, 200);
  assert.equal((await store.get(installation))?.apiKey, replacement);
  keys.length = 0;
  assert.equal((await (await fetch(streamUrl)).json()).streams.length, 2);
  assert.deepEqual(keys, [replacement], "a key update must evict the old cached service");
  keys.length = 0;
  assert.equal((await (await fetch(replicaStreamUrl)).json()).streams.length, 2);
  assert.deepEqual(keys, [replacement], "another instance must see the key update despite its warm cache");
  assert.equal((await fetch(`${base}/${"a".repeat(48)}/manifest.json`)).status, 404);
  assert.equal((await fetch(`${base}/stream/series/tt26235088:1:1.json`)).status, 404);
  assert.equal((await fetch(`${base}/data/master.key`)).status, 404);
});
