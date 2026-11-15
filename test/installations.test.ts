import test from "node:test";
import assert from "node:assert/strict";
import { Installations } from "../src/installations.js";
import { defaultSettings } from "../src/settings.js";
import { installationFixture } from "./fixtures.js";

test("Redis credentials stay encrypted and usable from a fresh instance", async () => {
  const redis = installationFixture();
  const store = await redis.open();
  const key = "0123456789abcdef0123456789abcdef";
  const id = await store.save(key);
  assert.match(id, /^[a-f0-9]{48}$/);
  const record = redis.records.get(`mist:installation:${id}`)!;
  const raw = record.get("credential")!;
  assert.ok(!raw.includes(key));
  assert.equal((await (await redis.open()).get(id))?.apiKey, key);
  assert.deepEqual((await store.get(id))?.settings, defaultSettings());
  const revision = (await store.get(id))!.revision;
  await store.save(key, id);
  assert.notEqual(record.get("credential"), raw, "updating must use a fresh IV");
  assert.notEqual((await store.get(id))!.revision, revision);
  assert.equal(await store.get("../master.key"), undefined);
  await assert.rejects(store.save(key, "../escape"), /Invalid installation ID/);
});

test("GCM rejects tampering, moved records and a different deployment encryption key", async () => {
  const redis = installationFixture();
  const store = await redis.open();
  const id = await store.save("0123456789abcdef0123456789abcdef");
  const record = redis.records.get(`mist:installation:${id}`)!;
  const raw = record.get("credential")!;
  const other = await store.save("11111111111111111111111111111111");
  redis.records.get(`mist:installation:${other}`)!.set("credential", raw);
  await assert.rejects(store.get(other));
  const wrongKey = await Installations.open({ ...redis.env, MIST_ENCRYPTION_KEY: "02".repeat(32) }, redis.fetcher);
  await assert.rejects(wrongKey.get(id));
  const data = JSON.parse(raw);
  data.ciphertext = (data.ciphertext[0] === "0" ? "1" : "0") + data.ciphertext.slice(1);
  record.set("credential", JSON.stringify(data));
  await assert.rejects(store.get(id));
});

test("missing or invalid Redis configuration fails without generating a replacement key", async () => {
  const redis = installationFixture();
  for (const key of Object.keys(redis.env)) {
    await assert.rejects(Installations.open({ ...redis.env, [key]: "" }, redis.fetcher), new RegExp(key));
  }
  await assert.rejects(Installations.open({ ...redis.env, UPSTASH_REDIS_REST_URL: "http://redis.example" }, redis.fetcher), /HTTPS/);
  await assert.rejects(Installations.open({ ...redis.env, MIST_ENCRYPTION_KEY: "not-a-key" }, redis.fetcher), /MIST_ENCRYPTION_KEY/);
  assert.equal(redis.records.size, 0);
});

test("Redis errors fail the request without exposing credentials or treating failures as missing data", async () => {
  const redis = installationFixture();
  const id = "a".repeat(48);
  for (const response of [new Response("fixture-token", { status: 401 }), Response.json({ error: "fixture-token" })]) {
    const store = await Installations.open(redis.env, async () => response);
    await assert.rejects(store.get(id), error => error instanceof Error && /Redis/.test(error.message) && !error.message.includes("fixture-token"));
  }
  const store = await Installations.open(redis.env, async () => { throw new Error("offline"); });
  await assert.rejects(store.get(id), /offline/);
});
