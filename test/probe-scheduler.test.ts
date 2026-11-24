import test from "node:test";
import assert from "node:assert/strict";
import { ProbeError, ProbeScheduler, probeConfig } from "../src/probe-scheduler.js";
import { takeProbeMetrics } from "../src/loading.js";
import { ResultCache, SharedJobs, urlLifetime } from "../src/shared-jobs.js";

const command = (ms: number, output: string) => ["-e", `setTimeout(() => console.log(${JSON.stringify(output)}), ${ms})`];

test("FFprobe scheduler bounds running and queued jobs, prioritizes playback and gives enrichment a turn", async () => {
  takeProbeMetrics();
  const scheduler = new ProbeScheduler(1, 5, process.execPath);
  const order: string[] = [];
  const run = (name: string, priority?: "playback", ms = 0) =>
    scheduler.run(command(ms, name), { timeoutMs: 2000, priority }).then(value => { order.push(value.trim()); });
  const pending = [run("running", undefined, 80), run("enrichment"), ...Array.from({ length: 4 }, (_, i) => run(`playback-${i}`, "playback"))];
  await assert.rejects(run("overflow", "playback"), { reason: "queue-full" });
  await Promise.all(pending);
  assert.deepEqual(order, ["running", "playback-0", "playback-1", "playback-2", "enrichment", "playback-3"]);
  const metrics = takeProbeMetrics();
  assert.equal(metrics.peaks["ffprobe.running"], 1);
  assert.equal(metrics.peaks["ffprobe.queued"], 5);
  assert.equal(metrics.depths["ffprobe.running"], 0);
  assert.equal(metrics.counters["ffprobe.calls"], 6);
});

test("expired and cancelled queued probes never spawn, and killed children release their slots", async () => {
  takeProbeMetrics();
  const scheduler = new ProbeScheduler(1, 2, process.execPath, 50);
  const controller = new AbortController(), running = new AbortController();
  const occupied = scheduler.run(command(2000, "stall"), { timeoutMs: 3000, signal: running.signal });
  const cancelled = scheduler.run(command(0, "cancelled"), { timeoutMs: 2000, signal: controller.signal });
  const expired = scheduler.run(command(0, "expired"), { timeoutMs: 2000 });
  controller.abort();
  await assert.rejects(cancelled, { reason: "cancelled" });
  await assert.rejects(expired, { reason: "queue-timeout" });
  running.abort();
  await assert.rejects(occupied, { reason: "cancelled" });
  await assert.rejects(scheduler.run(command(2000, "stall"), { timeoutMs: 40 }),
    (error: ProbeError) => error.reason === "timeout" && error.killed);
  await assert.rejects(scheduler.run(command(0, "long output"), { timeoutMs: 2000, maxOutput: 3 }), { reason: "output-limit" });
  assert.equal((await scheduler.run(command(0, "done"), { timeoutMs: 2000 })).trim(), "done");
  const metrics = takeProbeMetrics();
  assert.equal(metrics.counters["ffprobe.calls"], 4);
  assert.equal(metrics.depths["ffprobe.queued"], 0);
  assert.equal(metrics.depths["ffprobe.running"], 0);
});

test("parallel FFprobe slots never exceed the configured shared limit", async () => {
  takeProbeMetrics();
  const scheduler = new ProbeScheduler(2, 4, process.execPath);
  await Promise.all(Array.from({ length: 6 }, (_, i) => scheduler.run(command(25, String(i)), { timeoutMs: 2000 })));
  assert.equal(takeProbeMetrics().peaks["ffprobe.running"], 2);
});

test("caller cancellation and TTL cache eviction are independent of running jobs", async () => {
  let calls = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const cache = new ResultCache<string>(2, 1024);
  const jobs = new SharedJobs<number>("test", 1);
  const load = async (signal: AbortSignal) => {
    calls++;
    await gate;
    signal.throwIfAborted();
    return 7;
  };
  const first = new AbortController();
  const cancelled = jobs.run("same", 1000, load, first.signal);
  cache.set("one", "small", 1000);
  cache.set("two", "small", 1000);
  cache.set("three", "small", 1000);
  cache.set("oversize", "x".repeat(1024), 1000);
  assert.equal(cache.get("one"), undefined);
  assert.equal(cache.get("oversize"), undefined);
  const remaining = jobs.run("same", 1000, load);
  await assert.rejects(jobs.run("other", 1000, load), /capacity/);
  first.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  release();
  assert.equal(await remaining, 7);
  assert.equal(calls, 1);
  assert.equal(await jobs.run("other", 1000, load), 7);
});

test("configuration rejects invalid limits and known URL expiry has a five-second margin", t => {
  t.mock.method(Date, "now", () => Date.parse("2026-01-01T00:00:00Z"));
  assert.deepEqual(probeConfig({}), { processes: 2, queued: 32, analysisTtlMs: 30000, cacheBytes: 64 * 1024 ** 2 });
  for (const env of [{ MIST_FFPROBE_PROCESSES: "0" }, { MIST_FFPROBE_QUEUE: "-1" }, { MIST_HLS_ANALYSIS_TTL_MS: "31000" },
    { MIST_MEDIA_CACHE_MIB: "64.5" }, { MIST_FFPROBE_PROCESSES: "" }]) assert.throws(() => probeConfig(env), /MIST_/);
  assert.equal(urlLifetime("https://test.example/?X-Amz-Date=20260101T000000Z&X-Amz-Expires=10", 30000), 5000);
  assert.equal(urlLifetime("https://test.example/?expires=invalid", 30000), 0);
});

test("the last waiting caller cancels work and the same key can be retried after cleanup", async () => {
  const jobs = new SharedJobs<number>("test", 1);
  const caller = new AbortController();
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const pending = jobs.run("key", 1000, signal => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => { reject(signal.reason); finish(); }, { once: true });
  }), caller.signal);
  await Promise.resolve();
  caller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  await finished;
  assert.equal(await jobs.run("key", 1000, async () => 1), 1);
});

test("a fresh caller can retry after a cancelled job without duplicating its cleanup", async () => {
  const jobs = new SharedJobs<number>("test", 1);
  const caller = new AbortController();
  let release!: () => void;
  const cleanup = new Promise<void>(resolve => { release = resolve; });
  const first = jobs.run("key", 1000, async signal => {
    await cleanup;
    signal.throwIfAborted();
    return 0;
  }, caller.signal);
  await Promise.resolve();
  caller.abort();
  await assert.rejects(first, { name: "AbortError" });
  let started = false;
  const fresh = jobs.run("key", 1000, async () => { started = true; return 1; });
  assert.equal(started, false);
  release();
  assert.equal(await fresh, 1);
});
