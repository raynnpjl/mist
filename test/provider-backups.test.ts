import test from "node:test";
import assert from "node:assert/strict";
import { Provider } from "../src/providers.js";
import { Pool } from "../src/cache.js";

const source = { id: "test", name: "Test", url: "https://primary.example/api", backups: ["https://backup.example/mirror", "https://last.example/api"] };

test("failed API endpoints try ordered backups, reuse healthy results and skip cooling endpoints", async () => {
  const requests: URL[] = [];
  const provider = new Provider(source, new Pool(1), async input => {
    const url = new URL(String(input)); requests.push(url);
    if (url.hostname === "primary.example") throw new TypeError("fetch failed");
    return Response.json({ code: 1, pagecount: 1, list: [{ vod_id: 1 }] });
  });
  await provider.page(1, undefined, "title");
  await provider.page(1, undefined, "title");
  await provider.page(1, undefined, "different title");
  assert.deepEqual(requests.map(url => url.hostname), ["primary.example", "backup.example", "backup.example"]);
  assert.equal(requests[1].pathname, "/mirror");
  assert.equal(requests[1].searchParams.get("ac"), "detail");
  assert.equal(requests[1].searchParams.get("wd"), "title");
});

test("valid empty results do not query backup catalogues", async () => {
  let calls = 0;
  const provider = new Provider(source, new Pool(1), async () => { calls++; return Response.json({ code: 1, pagecount: 0, list: [] }); });
  assert.deepEqual((await provider.page(1, undefined, "missing")).items, []);
  assert.equal(calls, 1);
});

test("invalid JSON and bad pagination can use the next endpoint", async () => {
  const calls: string[] = [];
  const provider = new Provider(source, new Pool(1), async input => {
    const host = new URL(String(input)).hostname; calls.push(host);
    if (host === "primary.example") return new Response("not-json");
    if (host === "backup.example") return Response.json({ code: 1, pagecount: "invalid", list: [] });
    return Response.json({ code: 1, pagecount: 1, list: [{ vod_id: 9 }] });
  });
  assert.equal((await provider.page(1)).items[0].vod_id, 9);
  assert.deepEqual(calls, ["primary.example", "backup.example", "last.example"]);
});

test("API errors use backups and the primary is retried after its cooldown", async t => {
  let now = 10000, healthy = false;
  t.mock.method(Date, "now", () => now);
  const calls: string[] = [];
  const provider = new Provider(source, new Pool(1), async input => {
    const host = new URL(String(input)).hostname; calls.push(host);
    return Response.json({ code: host === "primary.example" && !healthy ? 0 : 1, pagecount: 1, list: [] });
  });
  await provider.page(1);
  healthy = true; now += 20001;
  await provider.page(1, undefined, "another query");
  assert.deepEqual(calls, ["primary.example", "backup.example", "primary.example"]);
});

test("hanging endpoints share one timeout budget rather than multiplying it", async () => {
  const budgets: number[] = [];
  // AbortSignal.timeout timers are unreferenced; keep the test alive while they fire.
  const keepAlive = setTimeout(() => {}, 2000);
  const start = performance.now();
  const provider = new Provider(source, new Pool(1), async (_input, init) => {
    const signal = init!.signal!;
    return new Promise<Response>((_resolve, reject) => {
      const attempt = performance.now();
      signal.addEventListener("abort", () => { budgets.push(performance.now() - attempt); reject(signal.reason); }, { once: true });
    });
  }, 120);
  try {
    await assert.rejects(provider.page(1));
    assert.equal(budgets.length, 3, "reserve an attempt for each backup");
    assert.ok(performance.now() - start < 260, "all attempts must fit within one 120ms budget plus scheduling overhead");
  } finally { clearTimeout(keepAlive); }
});

test("status uses backups without putting stream searches in a provider cooldown", async () => {
  const provider = new Provider(source, new Pool(1), async input => new URL(String(input)).hostname === "primary.example" ?
    new Response("unavailable", { status: 503 }) : Response.json({ code: 1, pagecount: 1, list: [] }));
  assert.equal((await provider.check()).available, true);
  await assert.doesNotReject(provider.page(1));
});

test("cached provider IDs are invalidated when backup failover changes their catalogue namespace", async t => {
  let now = 10000, useBackup = false;
  t.mock.method(Date, "now", () => now);
  const provider = new Provider(source, new Pool(1), async input => {
    const url = new URL(String(input));
    if (useBackup && url.hostname === "primary.example") throw new TypeError("fetch failed");
    return Response.json({ code: 1, pagecount: 1, list: [{ vod_id: 1, vod_name: url.hostname }] });
  });
  const page = await provider.page(1, undefined, "title");
  provider.rememberMatch("title", page.items, page.endpoint);
  now += 120001; useBackup = true;
  assert.deepEqual((await provider.cachedMatch("title"))?.items, [], "same numeric ID on another endpoint must not be reused");
});
