import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Installations } from "../src/installations.js";

test("installation credentials are encrypted, private and usable after restart", async t => {
  const dir = await mkdtemp(join(tmpdir(), "mist-crypto-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await Installations.open(dir);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  const key = "0123456789abcdef0123456789abcdef";
  const id = await store.save(key);
  assert.match(id, /^[a-f0-9]{48}$/);
  const path = join(dir, `${id}.json`);
  const raw = await readFile(path, "utf8");
  assert.ok(!raw.includes(key));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(dir, "master.key"))).mode & 0o777, 0o600);
  assert.equal(await (await Installations.open(dir)).get(id), key);
  await store.save(key, id);
  assert.notEqual(await readFile(path, "utf8"), raw, "updating must use a fresh IV");
  assert.equal(await store.get("../master.key"), undefined);
  await assert.rejects(store.save(key, "../escape"), /Invalid installation ID/);
});

test("GCM rejects tampering and moving encrypted credentials to a different installation", async t => {
  const dir = await mkdtemp(join(tmpdir(), "mist-crypto-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await Installations.open(dir);
  const id = await store.save("0123456789abcdef0123456789abcdef");
  const path = join(dir, `${id}.json`);
  const raw = await readFile(path, "utf8");
  const other = await store.save("11111111111111111111111111111111");
  await writeFile(join(dir, `${other}.json`), raw);
  await assert.rejects(store.get(other));
  const data = JSON.parse(raw);
  data.ciphertext = (data.ciphertext[0] === "0" ? "1" : "0") + data.ciphertext.slice(1);
  await writeFile(path, JSON.stringify(data));
  await assert.rejects(store.get(id));
});

test("a missing master key fails instead of silently replacing the key for saved installations", async t => {
  const dir = await mkdtemp(join(tmpdir(), "mist-crypto-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = await Installations.open(dir);
  await store.save("0123456789abcdef0123456789abcdef");
  await rm(join(dir, "master.key"));
  await assert.rejects(Installations.open(dir), /encryption key is missing/);
});
