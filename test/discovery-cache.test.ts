import test from "node:test";
import assert from "node:assert/strict";
import { Cache, Pool } from "../src/cache.js";
import { DiscoveryCache, DiscoveryStore } from "../src/discovery-cache.js";
import { discoveryRedis } from "./discovery-fixtures.js";

const valid = (value: unknown): value is string => typeof value === "string";

test("discovery memory hits use zero commands; shared hits GET once without extending expiry", async t => {
  let now = Date.now(), loads = 0;
  t.mock.method(Date, "now", () => now);
  const redis = discoveryRedis();
  const open = () => new DiscoveryCache("test", 2, valid, redis.open());
  const first = open();
  const load = async () => { loads++; return "compact"; };
  assert.equal(await first.get("key", 10_000, load), "compact");
  assert.deepEqual(redis.commands.map(c => c[0]), ["GET", "SET"]);
  const expiry = [...redis.records.values()][0].expires;
  now += 4000;
  await first.get("key", 10_000, load);
  assert.equal(redis.commands.length, 2);
  const second = open();
  await second.get("key", 10_000, load);
  assert.deepEqual(redis.commands.map(c => c[0]), ["GET", "SET", "GET"]);
  assert.equal([...redis.records.values()][0].expires, expiry);
  now += 6001;
  await second.get("key", 10_000, load);
  assert.equal(loads, 2, "memory must honor the shared record's original expiration");
  assert.deepEqual(redis.commands.slice(-2).map(c => c[0]), ["GET", "SET"]);
});

test("explicit refresh deletes stale data once and skips a redundant Redis GET", async () => {
  const redis = discoveryRedis(), cache = new DiscoveryCache("test", 2, valid, redis.open());
  await cache.get("key", 10_000, async () => "old");
  assert.equal(await cache.get("key", 10_000, async () => "new", undefined, true), "new");
  assert.deepEqual(redis.commands.map(c => c[0]), ["GET", "SET", "DEL", "SET"]);
  await assert.rejects(cache.get("key", 10_000, async () => { throw new Error("discovery failed"); }, undefined, true));
  assert.equal(redis.records.size, 0, "failed refresh must not leave the confirmed stale record in Redis");
});

test("Redis transport, HTTP, protocol and malformed-record failures all permit uncached discovery", async () => {
  for (const fetcher of [
    async () => { throw new Error("offline"); },
    async () => new Response("Unavailable", { status: 503 }),
    async () => Response.json({ error: "quota" }),
    async () => Response.json({ result: "{invalid" }),
    async () => Response.json({ result: JSON.stringify({ expires: Date.now() + 60_000, value: { invalid: true } }) })
  ] as typeof fetch[]) {
    const redis = discoveryRedis();
    const cache = new DiscoveryCache("test", 2, valid, new DiscoveryStore(redis.env, fetcher));
    assert.equal(await cache.get("key", 10_000, async () => "uncached"), "uncached");
    assert.equal(await cache.get("key", 10_000, async () => { assert.fail("memory hit must work during an outage"); }), "uncached");
  }
});

test("discovery cache deduplicates concurrent loads, bounds memory and rejects oversized entries", async () => {
  const redis = discoveryRedis(), cache = new DiscoveryCache("test", 1, valid, redis.open());
  let loads = 0;
  const load = async () => { loads++; return "value"; };
  await Promise.all(Array.from({ length: 10 }, () => cache.get("same", 10_000, load)));
  assert.equal(loads, 1);
  assert.equal(redis.commands.length, 2);
  await cache.get("other", 10_000, load);
  await cache.get("same", 10_000, load);
  assert.equal(loads, 2, "evicted memory values should still be available in Redis");
  assert.equal(redis.commands.at(-1)?.[0], "GET");
  const before = redis.commands.length;
  for (let n = 0; n < 2; n++) assert.equal((await cache.get("large", 10_000, async () => "x".repeat(65_536))).length, 65_536);
  assert.deepEqual(redis.commands.slice(before).map(c => c[0]), ["GET", "GET"], "oversized data must not be kept in either cache");
});

test("in-flight cache loads stay deduplicated past TTL and failed loads can retry", async t => {
  let now = Date.now(), release!: (value: number) => void;
  t.mock.method(Date, "now", () => now);
  const cache = new Cache<number>(2);
  const first = cache.get("key", 1, () => new Promise(resolve => { release = resolve; }));
  await Promise.resolve(); now += 10;
  assert.equal(cache.get("key", 1, async () => 2), first);
  release(1); await first;
  await assert.rejects(cache.get("fail", 10, async () => { throw new Error("failed"); }));
  assert.equal(await cache.get("fail", 10, async () => 3), 3);
});

test("pool cancellation removes queued work; independent failures release slots", async () => {
  const pool = new Pool(2), controller = new AbortController();
  let active = 0, peak = 0;
  const releases: (() => void)[] = [];
  const work = (fail = false) => pool.run(async () => {
    active++; peak = Math.max(peak, active);
    try { await new Promise<void>(resolve => releases.push(resolve)); if (fail) throw new Error("independent failure"); }
    finally { active--; }
  });
  const first = work(true), second = work();
  const canceled = pool.run(async () => { assert.fail("canceled work must never start"); }, controller.signal);
  const settled = Promise.allSettled([first, second, canceled]);
  controller.abort();
  releases.splice(0).forEach(release => release());
  assert.deepEqual((await settled).map(r => r.status), ["rejected", "fulfilled", "rejected"]);
  assert.equal(peak, 2);
  assert.equal(await pool.run(async () => "next"), "next");
});

test("Redis timeouts permit discovery, while an aborted lookup cannot start uncached work", async t => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", () => timeout(5));
  const redis = discoveryRedis();
  const fetcher: typeof fetch = async (_input, options) => new Promise((_, reject) => {
    options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
  });
  const cache = new DiscoveryCache("test", 2, valid, new DiscoveryStore(redis.env, fetcher));
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    assert.equal(await cache.get("key", 10_000, async () => "discovered"), "discovered");
    await assert.rejects(cache.get("aborted", 10_000, async () => { assert.fail("aborted lookup must not start discovery"); }, timeout(1)),
      { name: "TimeoutError" });
  } finally { clearTimeout(keepAlive); }
});
