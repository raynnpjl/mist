import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { DiscoveryStore } from "../src/discovery-cache.js";

export function discoveryRedis() {
  const env = { UPSTASH_REDIS_REST_URL: "https://redis.example", UPSTASH_REDIS_REST_TOKEN: "fixture-token" };
  const records = new Map<string, { value: string; expires: number }>();
  const commands: string[][] = [];
  const fetcher: typeof fetch = async (input, options) => {
    assert.equal(String(input), env.UPSTASH_REDIS_REST_URL + "/");
    assert.equal(new Headers(options?.headers).get("Authorization"), "Bearer fixture-token");
    const command = JSON.parse(String(options?.body)) as string[];
    commands.push(command);
    const [op, key, value, ex, seconds] = command;
    if (op === "GET") {
      const record = records.get(key);
      return Response.json({ result: record && record.expires > Date.now() ? record.value : null });
    }
    if (op === "SET") {
      assert.equal(ex, "EX");
      assert.ok(Number(seconds) > 0);
      records.set(key, { value, expires: Date.now() + Number(seconds) * 1000 });
      return Response.json({ result: "OK" });
    }
    if (op === "DEL") return Response.json({ result: Number(records.delete(key)) });
    assert.fail(`Unexpected Redis operation: ${op}`);
  };
  return { env, records, commands, fetcher, open: () => new DiscoveryStore(env, fetcher) };
}

export const mkvTitle = { names: ["Test Drama"], displayName: "测试剧", year: 2024, tmdbId: "210757" };
export const mkvRequest = { type: "series" as const, id: "tmdb:210757", season: 1, episode: 2 };
export const mkvFilename = (height = 1080, episode = 2) => `Test.Drama.S01E${String(episode).padStart(2, "0")}.${height}p.mkv`;

export function cachedSite(latency = 0) {
  const seen: string[] = [];
  let active = 0, peak = 0, signed = 0, headers = 0;
  const state = { completed: false, status: "", missing: false, badPixel: false, badSend: false, size: 1_000_000,
    version: "", replacement: false, episodes: new Set([2]), send: true };
  const fetcher: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    seen.push(url.href);
    active++; peak = Math.max(peak, active);
    try {
      if (latency) await delay(latency, undefined, { signal: options?.signal ?? undefined });
      options?.signal?.throwIfAborted();
      if (new Headers(options?.headers).has("Range")) {
        headers++;
        return new Response(Buffer.from("1a45dfa300000000", "hex"), { status: 206,
          headers: { "Content-Range": `bytes 0-7/${state.size}` } });
      }
      if (url.pathname === "/search") return new Response(state.missing ? '<div class="listupd"></div>' :
        `<article class="bs"><a itemprop="url" title="Test Drama" href="/${state.replacement ? "replacement" : "drama"}">Test Drama</a></article>`);
      if (["/drama", "/replacement"].includes(url.pathname)) return new Response(
        `<div class="infox"><h1>Test Drama</h1><div class="spe"><span>Aired: 2024</span><span>Type: Drama</span>
        <span>Status: ${state.completed ? "Completed" : state.status}</span><span>Subtitles: English</span></div></div>
        <div class="soraddlx">${[1080, 720].map(height => `<div class="soraurlx"><strong>${height}p</strong>${[...state.episodes].map(episode =>
          `<a href="https://pixeldrain.com/u/${state.replacement ? "new" : "file"}${height}E${episode}">PixelDrain</a>` +
          (state.send ? `<a href="https://send.now/file${height}E${episode}">Send</a>` : "")).join("")}</div>`).join("")}</div>`);
      if (url.hostname === "pixeldrain.com") {
        if (state.badPixel && !url.pathname.includes("new")) return new Response("Gone", { status: 410 });
        const [, height, episode] = url.pathname.match(/(?:file|new)(\d+)E(\d+)/) || [];
        return Response.json({ success: true, name: mkvFilename(Number(height), Number(episode)), size: state.size,
          ...(state.version ? { hash_sha256: state.version } : {}) });
      }
      if (url.hostname === "send.now") {
        if (state.badSend) throw new Error("Send unavailable");
        const [, height, episode] = url.pathname.match(/file(\d+)E(\d+)/) || [];
        const filename = mkvFilename(Number(height), Number(episode));
        return new Response(`<main id="fv" data-name="${filename}"></main><script id="xvp-config">${JSON.stringify({ sources: [
          { src: `https://d1.datatransfer.to/d/sign${++signed}/${filename}` }
        ] })}</script><video><track kind="subtitles" label="Chinese"></video>`);
      }
      assert.fail(`Unexpected network request: ${url}`);
    } finally { active--; }
  };
  return { state, seen, fetcher, metrics: () => ({ peak, headers, signed }) };
}
