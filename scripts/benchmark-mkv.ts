// Mocked network benchmark; optional first argument is a checkout of the pre-change source.
// node --import tsx scripts/benchmark-mkv.ts /tmp/mist-before
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { drama, fixtures } from "../test/fixtures.js";
import { cachedSite, discoveryRedis } from "../test/discovery-fixtures.js";
import { DiscoveryStore } from "../src/discovery-cache.js";
import type { DirectStream } from "../src/protocol.js";

const normalize = (cards: DirectStream[]) => cards.map(card => ({ ...card, url: card.url.replace(/\/sign\d+\//, "/signature/") }));
const median = (values: number[]) => Math.round(values.sort((a, b) => a - b)[Math.floor(values.length / 2)] * 100) / 100;

async function measure(root: string, send: boolean) {
  const module = (name: string) => import(pathToFileURL(resolve(root, `src/${name}.ts`)).href);
  const [{ AddonService }, { MetadataResolver }, { MkvDrama }, { MkvHeaderInspector }] = await Promise.all(
    ["service", "metadata", "mkvdrama", "mkv-metadata"].map(module));
  const times = { cold: [] as number[], memory: [] as number[], replica: [] as number[] };
  let example: DirectStream[] = [], commands: number[] = [], peak = 0;
  for (let run = 0; run < 5; run++) {
    const site = cachedSite(20), redis = discoveryRedis(); site.state.send = send;
    const vod = fixtures([drama(1, { vod_name: "测试剧" })], 5);
    // Both implementations get the same 20 ms MKV/host/header latency and 5 ms Redis latency.
    redis.open = () => new DiscoveryStore(redis.env, async (...args: Parameters<typeof fetch>) => {
      await delay(5); return redis.fetcher(...args);
    });
    const fetcher: typeof fetch = async (input, options) => {
      const url = new URL(String(input));
      if (url.hostname === "api.themoviedb.org") return url.searchParams.get("language") === "en-US" ?
        Response.json({ name: "Test Drama" }) : vod.fetcher(input, options);
      return site.fetcher(input, options);
    };
    const create = () => new AddonService([...vod.providers, new MkvDrama(fetcher, 30_000, redis.open())],
      new MetadataResolver(fetcher, "mock-key"), fetcher, vod.inspector, [720, 1080],
      new MkvHeaderInspector(fetcher, async () => ({ format: { duration: "4" }, streams: [
        { codec_type: "subtitle", tags: { language: "chi" } }
      ] }), 3000, redis.open()));
    const service = create(); commands = [];
    for (const [phase, instance] of [["cold", service], ["memory", service], ["replica", create()]] as const) {
      const before = redis.commands.length, start = performance.now();
      const cards = await instance.streams("series", "tmdb:210757:1:2");
      times[phase].push(performance.now() - start);
      assert.equal(cards.length, send ? 9 : 7);
      if (phase === "cold") example = normalize(cards);
      else assert.deepEqual(normalize(cards), example);
      commands.push(redis.commands.length - before);
    }
    peak = Math.max(peak, site.metrics().peak);
  }
  return { medianMs: Object.fromEntries(Object.entries(times).map(([key, values]) => [key, median(values)])),
    redisCommands: { cold: commands[0], memory: commands[1], replica: commands[2] }, peakMkvTasks: peak, cards: example };
}

async function main() {
  for (const send of [false, true]) {
    const after = await measure(process.cwd(), send);
    const before = process.argv[2] ? await measure(process.argv[2], send) : undefined;
    if (before) assert.deepEqual(after.cards, before.cards, "source cards must be identical to the pre-change implementation");
    const compact = (result: typeof after) => ({ ...result, cards: result.cards.length });
    console.log(JSON.stringify({ mocked: true, samples: 5, mkvLatencyMs: 20, redisLatencyMs: 5,
      hosts: send ? "PixelDrain + Send" : "PixelDrain", before: before && compact(before), after: compact(after) }));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
