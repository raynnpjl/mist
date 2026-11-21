import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { Cache, readLimited } from "../src/cache.js";
import { count, observeLoading, timed } from "../src/loading.js";
import { AddonService } from "../src/service.js";
import { MetadataResolver } from "../src/metadata.js";
import { drama, fixtures } from "./fixtures.js";

test("concurrent loading reports isolate counters and attribute shared upstream work once", async t => {
  const logs: any[] = [];
  t.mock.method(console, "info", (line: string) => logs.push(JSON.parse(line)));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const cache = new Cache<string>(1);
  const load = () => cache.get("shared", 1000, () => timed("upstream", async () => {
    count("upstreamCalls");
    await gate;
    return readLimited(new Response("private-payload"), 1024);
  }));
  const first = observeLoading(async () => { count("first"); return load(); });
  const second = observeLoading(async () => { count("second"); return load(); });
  await setImmediate();
  release();
  assert.deepEqual(await Promise.all([first, second]), ["private-payload", "private-payload"]);
  const owner = logs.find(log => log.counters.first), waiter = logs.find(log => log.counters.second);
  assert.equal(owner.counters.upstreamCalls, 1);
  assert.equal(owner.counters.bodyBytesRead, Buffer.byteLength("private-payload"));
  assert.equal(waiter.counters.upstreamCalls, undefined);
  assert.equal(waiter.counters.bodyBytesRead, undefined);
  assert.equal(owner.counters.second, undefined);
  assert.equal(waiter.counters.first, undefined);
  assert.doesNotMatch(JSON.stringify(logs), /private-payload|shared/);
});

test("loading errors report durations and counts without logging exception messages", async t => {
  const logs: any[] = [];
  t.mock.method(console, "info", (line: string) => logs.push(JSON.parse(line)));
  await assert.rejects(observeLoading(() => timed("upstream", async () => {
    throw new Error("https://private.example/installation?api_key=secret");
  })), /private/);
  assert.equal(logs[0].outcome, "error");
  assert.equal(logs[0].stages.upstream.calls, 1);
  assert.equal(logs[0].stages.upstream.errors, 1);
  assert.ok(logs[0].stages.upstream.ms >= 0);
  assert.doesNotMatch(JSON.stringify(logs), /private|installation|secret|api_key/);
});

test("cold and warm source reports count real Node calls, probes, cache reuse and metadata completeness", async t => {
  const logs: any[] = [];
  t.mock.method(console, "info", (line: string) => logs.push(JSON.parse(line)));
  const fixture = fixtures([drama()], 1);
  const service = new AddonService(fixture.providers, new MetadataResolver(fixture.fetcher, "private-tmdb-key"), fixture.fetcher, fixture.inspector);
  const first = await observeLoading(() => service.streams("series", "tmdb:210757:1:1"));
  assert.deepEqual(await observeLoading(() => service.streams("series", "tmdb:210757:1:1")), first);
  assert.equal(logs[0].stages["vod.http"].calls, 1);
  assert.equal(logs[0].stages["tmdb.http"].calls, 2);
  assert.equal(logs[0].stages["media.http"].calls, 1);
  assert.equal(logs[0].stages["media.probe"].calls, 1);
  assert.equal(logs[0].counters.streams, 1);
  assert.equal(logs[0].counters["missing.subtitles"], undefined);
  assert.equal(logs[1].stages["vod.http"], undefined);
  assert.equal(logs[1].stages["tmdb.http"], undefined);
  assert.equal(logs[1].stages["media.probe"], undefined);
  assert.equal(logs[1].counters["media.resultHits"], 1);
  assert.equal(logs[1].counters["vod.mappingHits"], 1);
  assert.doesNotMatch(JSON.stringify(logs), /private-tmdb-key|tmdb:210757|测试剧|\.example|https?:/);
});

test("resolver latency percentiles retain at most 256 samples", async t => {
  let last: any;
  t.mock.method(console, "info", (line: string) => { last = JSON.parse(line); });
  for (let i = 0; i < 260; i++) await observeLoading(async () => []);
  assert.equal(last.window.samples, 256);
  assert.ok(last.window.p50Ms >= 0);
  assert.ok(last.window.p95Ms >= last.window.p50Ms);
});
