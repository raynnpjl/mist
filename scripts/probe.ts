import "../src/env.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readLimited } from "../src/cache.js";
import { extractPlayback } from "../src/episodes.js";
import { Kind, chineseKind, value } from "../src/model.js";
import { Provider, UPSTREAM_HEADERS, createProviders, loadSources } from "../src/providers.js";

async function request(url: string, range?: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10000), headers: {
    "User-Agent": UPSTREAM_HEADERS["User-Agent"], ...(range ? { Range: range } : {})
  } });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Media HTTP ${response.status}`); }
  return response;
}

export async function probeHls(url: string) {
  for (let depth = 0; depth < 4; depth++) {
    const response = await request(url);
    const text = await readLimited(response, 1024 * 1024);
    if (!text.trimStart().startsWith("#EXTM3U")) throw new Error("URL returned a webpage instead of HLS");
    const first = text.split(/\r?\n/).map(l => l.trim()).find(l => l && !l.startsWith("#"));
    if (!first) throw new Error("Playlist has no media entries");
    const next = new URL(first, response.url).href;
    if (text.includes("#EXT-X-STREAM-INF")) { url = next; continue; }
    const key = text.match(/#EXT-X-KEY:[^\n]*METHOD=AES-128[^\n]*URI="([^"]+)"/);
    if (key) {
      const keyResponse = await request(new URL(key[1], response.url).href);
      const keyBytes = await keyResponse.arrayBuffer();
      if (keyBytes.byteLength !== 16) throw new Error("Invalid AES-128 key response");
    }
    const segment = await request(next, "bytes=0-1023");
    const reader = segment.body!.getReader();
    let bytes: Uint8Array | undefined;
    try { bytes = (await reader.read()).value; } finally { await reader.cancel(); }
    if (!bytes?.length || /^\s*<(!doctype|html)/i.test(Buffer.from(bytes).toString("utf8", 0, 80))) {
      throw new Error("Segment returned empty data or HTML");
    }
    return { playlist: response.url, segmentStatus: segment.status, sampledBytes: bytes.length,
      encrypted: Boolean(key), contentType: segment.headers.get("content-type") };
  }
  throw new Error("Too many nested HLS playlists");
}

async function probe(provider: Provider, kind: Kind) {
  let sample: { title: string; episode: string; url: string } | undefined;
  try {
    const categories = await provider.categories(kind);
    for (const category of categories) {
      const data = await provider.page(1, category.id);
      for (const vod of data.items) {
        if (chineseKind(vod) !== kind) continue;
        const stream = extractPlayback(vod, provider.source.id).find(p => p.url && new URL(p.url).pathname.endsWith(".m3u8"));
        if (stream?.url) { sample = { title: value(vod.vod_name), episode: stream.label, url: stream.url }; break; }
      }
      if (sample) break;
    }
    if (!sample) throw new Error("No Chinese HLS sample found");
    const media = await probeHls(sample.url);
    return { source: provider.source.id, kind, ok: true, ...sample, ...media };
  } catch (error) {
    return { source: provider.source.id, kind, ok: false, ...sample,
      error: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  const results = [];
  for (const provider of createProviders(loadSources())) {
    const batch = await Promise.all((["drama", "movie", "variety"] as Kind[]).map(kind => probe(provider, kind)));
    for (const result of batch) { results.push(result); console.log(JSON.stringify(result)); }
  }
  const path = process.env.REPORT_PATH || "reports/live-probe.json";
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2) + "\n");
  if (results.some(r => !r.ok)) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
