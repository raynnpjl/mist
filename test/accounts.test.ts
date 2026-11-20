import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Accounts } from "../src/accounts.js";
import { defaultSettings } from "../src/settings.js";
import { configuredInstallation, installationFixture, TEST_ACCESS_KEY } from "./fixtures.js";

test("generated account keys persist as hashes and each key owns one stable installation", async () => {
  const db = installationFixture(), store = await db.open();
  const first = await store.createAccessKey(), second = await store.createAccessKey();
  assert.match(first.accessKey, /^[a-f0-9]{64}$/);
  assert.notEqual(first.accessKey, second.accessKey);
  assert.ok(!JSON.stringify([...db.records.values()]).includes(first.accessKey));
  assert.ok(!JSON.stringify(db.requests).includes(first.accessKey), "plaintext keys never reach SQL parameters");
  const account = (await store.authenticate(first.accessKey))!;
  assert.equal(account.configured, false);
  assert.equal(await store.get(account.installation), undefined);
  assert.equal(db.records.get(account.installation)!.key_hash, createHash("sha256").update(first.accessKey).digest("hex"));
  assert.deepEqual(await (await db.open()).authenticate(first.accessKey), account);
  assert.notEqual((await store.authenticate(second.accessKey))!.installation, account.installation);
  const listed = await store.listAccessKeys();
  assert.ok(listed.some(row => row.id === first.id));
  assert.ok(listed.every(row => !Object.hasOwn(row, "key_hash") && !Object.hasOwn(row, "credential")));
  assert.equal(await store.revokeAccessKey(first.id), true);
  assert.equal(await store.authenticate(first.accessKey), undefined);
  assert.equal(await store.accountForSession(first.id), undefined);
  assert.ok(await store.authenticate(second.accessKey));
  assert.equal(await store.revokeAccessKey(first.id), false);
});

test("TMDB credentials stay encrypted, survive replicas and retain independent saved preferences", async () => {
  const db = installationFixture(), store = await db.open(), key = "0123456789abcdef0123456789abcdef";
  const id = await configuredInstallation(store, key);
  const record = db.records.get(id)!;
  const raw = JSON.stringify(record.credential);
  assert.ok(!raw.includes(key));
  assert.equal((await (await db.open()).get(id))?.apiKey, key);
  assert.deepEqual((await store.get(id))?.settings, defaultSettings());
  const revision = (await store.get(id))!.revision;
  await store.save(key, id);
  assert.notEqual(JSON.stringify(record.credential), raw);
  assert.notEqual((await store.get(id))!.revision, revision);
  assert.equal((await store.authenticate(TEST_ACCESS_KEY))?.configured, true);
  assert.equal(await store.get("../escape"), undefined);
  await assert.rejects(store.save(key, "../escape"), /Invalid installation ID/);
  await assert.rejects(store.save(key, "a".repeat(48)), /Account unavailable/);
  const owner = (await store.authenticate(TEST_ACCESS_KEY))!;
  await store.revokeAccessKey(owner.id);
  assert.equal(await store.get(id), undefined, "revocation also blocks addon endpoints");
  await assert.rejects(store.save(key, id), /Account unavailable/);
});

test("GCM rejects tampering, credentials moved to another account and a different encryption key", async () => {
  const db = installationFixture(), store = await db.open();
  const id = await configuredInstallation(store, "0123456789abcdef0123456789abcdef");
  const record = db.records.get(id)!, raw = structuredClone(record.credential);
  const other = await configuredInstallation(store, "11111111111111111111111111111111");
  db.records.get(other)!.credential = raw;
  await assert.rejects(store.get(other));
  await assert.rejects(new Accounts(db.query, "02".repeat(32)).get(id));
  const data = record.credential as { ciphertext: string };
  data.ciphertext = (data.ciphertext[0] === "0" ? "1" : "0") + data.ciphertext.slice(1);
  await assert.rejects(store.get(id));
});

test("invalid Neon configuration fails without exposing connection credentials", async () => {
  const db = installationFixture();
  for (const key of Object.keys(db.env)) await assert.rejects(Accounts.open({ ...db.env, [key]: "" }), new RegExp(key));
  await assert.rejects(Accounts.open({ ...db.env, DATABASE_URL: "https://owner:private-password@invalid.example/db" }), error =>
    error instanceof Error && /DATABASE_URL/.test(error.message) && !error.message.includes("private-password"));
  await assert.rejects(Accounts.open({ ...db.env, MIST_ENCRYPTION_KEY: "not-a-key" }), /MIST_ENCRYPTION_KEY/);
});

test("database errors fail closed and never expose credentials or act as missing accounts", async () => {
  const db = installationFixture();
  const store = new Accounts(async () => { throw new Error(db.env.DATABASE_URL); }, db.env.MIST_ENCRYPTION_KEY);
  const safe = (error: unknown) => error instanceof Error && /Neon account storage unavailable/.test(error.message) && !error.message.includes(db.env.DATABASE_URL);
  await assert.rejects(store.get("a".repeat(48)), safe);
  await assert.rejects(store.authenticate(TEST_ACCESS_KEY), safe);
  await assert.rejects(store.check(), safe);
  await assert.rejects(store.initialize(), safe);
});
