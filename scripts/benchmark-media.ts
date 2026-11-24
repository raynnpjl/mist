import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { cpus, platform, release, tmpdir, totalmem } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { makeMediaFixtures } from "./media-fixtures.js";
import { HlsPlaylists } from "../src/hls.js";
import { takeProbeMetrics } from "../src/loading.js";
import { MediaInspector, type MediaInfo } from "../src/media.js";
import { createMediaNetwork } from "../src/media-network.js";
import { ProbeScheduler } from "../src/probe-scheduler.js";

const installation = "a".repeat(48);
const secret = "01".repeat(32);
const modeNames = ["legacy", "new-2", "new-4"] as const;
const args = process.argv.slice(2);

function flag(name: string, fallback: string) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}

const round = (n: number) => Math.round(n * 100) / 100;

async function main() {
  const root = mkdtempSync(join(tmpdir(), "mist-media-bench-"));
  const iterations = Number(flag("--iterations", "5"));
  const baselineRef = flag("--baseline-ref", "a4ec000");
  const selectedMode = flag("--mode", "all");
  assert.ok(Number.isInteger(iterations) && iterations >= 1 && iterations <= 100);
  assert.ok(selectedMode === "all" || modeNames.some(name => name === selectedMode));
  const env = { PATH: process.env.PATH, MIST_BENCH_FFPROBE: process.env.MIST_BENCH_FFPROBE, MIST_BENCH_PROBE_LOG: process.env.MIST_BENCH_PROBE_LOG };
  try {
    const ffprobe = execFileSync("which", ["ffprobe"], { encoding: "utf8" }).trim();
    const ffprobeVersion = execFileSync(ffprobe, ["-version"], { encoding: "utf8" }).split("\n")[0];
    const tools = join(root, "bin"), probeLog = join(root, "probe.log");
    mkdirSync(tools);
    const launcher = join(tools, "ffprobe");
    writeFileSync(launcher, '#!/bin/sh\nprintf "%s\\n" "$$" >> "$MIST_BENCH_PROBE_LOG"\nexec "$MIST_BENCH_FFPROBE" "$@"\n');
    chmodSync(launcher, 0o755);
    writeFileSync(probeLog, "");
    process.env.PATH = `${tools}:${env.PATH}`;
    process.env.MIST_BENCH_FFPROBE = ffprobe;
    process.env.MIST_BENCH_PROBE_LOG = probeLog;

    const fixtureDir = join(root, "media");
    mkdirSync(fixtureDir);
    const fixture = makeMediaFixtures(fixtureDir);
    let legacy: { MediaInspector: typeof MediaInspector; HlsPlaylists: typeof HlsPlaylists } | undefined;
    if (selectedMode === "all" || selectedMode === "legacy") {
      const baseline = join(root, "legacy"), archive = join(root, "legacy.tar");
      mkdirSync(baseline);
      execFileSync("git", ["archive", "--format=tar", "-o", archive, baselineRef, "src"]);
      execFileSync("tar", ["-xf", archive, "-C", baseline]);
      symlinkSync(resolve("node_modules"), join(baseline, "node_modules"), "dir");
      writeFileSync(join(baseline, "config.json"), JSON.stringify({
        api_site: { fixture: { name: "Fixture", api: "https://provider.invalid/api" } },
        web_site: { mkvdrama: { name: "Fixture", url: "https://mkv.invalid" } }
      }));
      legacy = {
        MediaInspector: (await import(pathToFileURL(join(baseline, "src/media.ts")).href)).MediaInspector,
        HlsPlaylists: (await import(pathToFileURL(join(baseline, "src/hls.ts")).href)).HlsPlaylists
      };
    }

    let requests = 0, bytes = 0, revision = 0;
    const actualNow = Date.now;
    const server = createServer((req, res) => {
      requests++;
      const request = new URL(req.url!, "http://fixture");
      const expiry = Number(request.searchParams.get("exp"));
      if (expiry && expiry * 1000 <= Date.now()) { res.writeHead(403).end(); return; }
      let body: Buffer;
      if (request.pathname.endsWith("/clock.m3u8")) {
        body = Buffer.from(`#EXTM3U\n#EXT-X-TARGETDURATION:1\n#rev-${revision}\n#EXTINF:1,\n/before.ts\n` +
          "#EXT-X-DISCONTINUITY\n#EXTINF:1,\n/clip.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:1,\n/after.ts\n#EXT-X-ENDLIST\n");
      } else if (request.pathname.startsWith("/episode/")) {
        const [, , number, name] = request.pathname.split("/");
        const file = name === "mono.m3u8" ? "mono.ts" : Number(number) % 2 ? "other.ts" : "cropped.ts";
        body = Buffer.from(`#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n/${file}\n#EXT-X-ENDLIST\n`);
      } else {
        try { body = fixture(basename(request.pathname)); }
        catch { res.writeHead(404).end(); return; }
      }
      const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      if (range) {
        const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
        if (start >= body.length || start > end) { res.writeHead(416).end(); return; }
        res.statusCode = 206;
        res.setHeader("Content-Range", `bytes ${start}-${end}/${body.length}`);
        body = body.subarray(start, end + 1);
      }
      bytes += body.length;
      res.setHeader("Content-Length", body.length);
      res.end(body);
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const modes = modeNames.filter(name => selectedMode === "all" || selectedMode === name);
    const output: object[] = [];
    const countProbes = () => readFileSync(probeLog, "utf8").split("\n").length - 1;

    try {
      for (const mode of modes) {
        const scheduler = new ProbeScheduler(mode === "new-4" ? 4 : 2);
        const network = createMediaNetwork({}, scheduler);
        const createInspector = () => mode === "legacy" ? new legacy!.MediaInspector() : new MediaInspector(network.fetcher, network.probe,
          6500, { playlists: network.playlists, lightweight: true, sampleProbe: network.sampleProbe });
        const createPlaylists = () => mode === "legacy" ? new legacy!.HlsPlaylists(secret) :
          new HlsPlaylists(secret, network.fetcher, network.segmentProbe, { playlists: network.playlists });
        const inspect = (inspector: MediaInspector, path: string) => inspector.inspect(origin + path);
        const episode = (id: number) => `/episode/${id}/index.m3u8`;
        const mono = (id: number) => `/episode/${id}/mono.m3u8`;
        const direct = (id: number) => `/direct.mp4?episode=${id}`;

        type Outcome = MediaInfo | string | "expected-expiry";
        type Measure = (action: () => Promise<Outcome>) => Promise<Outcome>;
        const measure = async (name: string, run: (call: Measure) => Promise<void>) => {
          requests = 0; bytes = 0;
          const before = countProbes(), cpu = process.cpuUsage();
          takeProbeMetrics();
          const latencies: number[] = [];
          const completeness = { available: 0, dimensions: 0, video: 0, audio: 0, channels: 0, subtitles: 0, bitrate: 0, adsRemoved: 0, expired: 0 };
          let maxRss = process.memoryUsage.rss();
          const sampleRss = setInterval(() => { maxRss = Math.max(maxRss, process.memoryUsage.rss()); }, 5);
          const began = performance.now();
          try {
            await run(async action => {
              const started = performance.now();
              const info = await action();
              latencies.push(performance.now() - started);
              if (info === "expected-expiry") completeness.expired++;
              else if (typeof info === "string") {
                assert.ok(!info.includes("/clip.ts"), "verified fixture ad must be removed");
                completeness.adsRemoved++;
              } else {
                completeness.available += Number(info.reachable);
                completeness.dimensions += Number(Boolean(info.width && info.height));
                completeness.video += Number(Boolean(info.videoCodec));
                completeness.audio += Number(Boolean(info.audioCodec));
                completeness.channels += Number(Boolean(info.channelLayout));
                completeness.subtitles += Number(Boolean(info.subtitles));
                completeness.bitrate += Number(Boolean(info.bitrate));
              }
              return info;
            });
          } finally { clearInterval(sampleRss); }
          const wallMs = performance.now() - began, nodeCpu = process.cpuUsage(cpu);
          const metrics = takeProbeMetrics();
          latencies.sort((a, b) => a - b);
          const percentile = (p: number) => round(latencies[Math.ceil(latencies.length * p) - 1]);
          output.push({ mode, scenario: name, calls: latencies.length, wallMs: round(wallMs), p50Ms: percentile(0.5), p95Ms: percentile(0.95),
            ffprobeCalls: countProbes() - before, requests, fixturePayloadBytes: bytes, estimatedNodeRssMiB: round(maxRss / 1024 ** 2),
            nodeCpuMs: round((nodeCpu.user + nodeCpu.system) / 1000), completeness, metrics });
        };

        async function expectMedia(call: Measure, inspector: MediaInspector, path: string, height: number, channel = "stereo") {
          const info = await call(() => inspect(inspector, path)) as MediaInfo;
          assert.equal(info.height, height);
          assert.equal(info.audioCodec, "aac");
          assert.equal(info.channelLayout, channel);
          assert.equal(info.reachable, true);
        }

        await measure("cold-unique-h264", async call => {
          const inspector = createInspector();
          for (let i = 0; i < iterations * 2; i++) await expectMedia(call, inspector, episode(i), i % 2 ? 298 : 238);
        });
        const warm = createInspector();
        await inspect(warm, episode(0));
        await measure("warm-repeated-h264", async call => {
          for (let i = 0; i < iterations * 8; i++) await expectMedia(call, warm, episode(0), 238);
        });
        await measure("concurrent-same-h264", async call => {
          const inspector = createInspector();
          for (let i = 0; i < iterations; i++) await Promise.all(Array.from({ length: 8 }, () =>
            expectMedia(call, inspector, episode(i), i % 2 ? 298 : 238)));
        });
        await measure("concurrent-different-mixed", async call => {
          const inspector = createInspector();
          for (let i = 0; i < iterations; i++) await Promise.all(Array.from({ length: 8 }, (_, j) =>
            expectMedia(call, inspector, j % 2 ? episode(i * 8 + j) : direct(i * 8 + j), j % 2 ? 298 : 238)));
        });
        await measure("concurrent-different-unsupported-mp4", async call => {
          const inspector = createInspector();
          for (let i = 0; i < iterations; i++) await Promise.all(Array.from({ length: 8 }, (_, j) =>
            expectMedia(call, inspector, direct(i * 8 + j), 238)));
        });
        await measure("cold-dense-h264", async call => {
          const inspector = createInspector();
          for (let i = 0; i < iterations; i++) await expectMedia(call, inspector, `/dense.m3u8?episode=${i}`, 720);
        });
        await measure("missing-details-mono-ts", async call => {
          const inspector = createInspector();
          for (let i = 0; i < iterations; i++) await expectMedia(call, inspector, mono(i), 238, "mono");
        });
        await measure("missing-details-fmp4", async call => {
          const inspector = createInspector();
          for (let i = 0; i < iterations; i++) await expectMedia(call, inspector, `/fragmented.m3u8?episode=${i}`, 238);
        });
        await measure("alternate-subtitle-rendition", async call => {
          const inspector = createInspector();
          for (let i = 0; i < iterations; i++) {
            const info = await call(() => inspect(inspector, `/caption-master.m3u8?episode=${i}`)) as MediaInfo;
            assert.equal(info.height, 238);
            assert.equal(info.audioCodec, "aac");
            assert.equal(info.channelLayout, "stereo");
            assert.equal(info.subtitles, "English");
            assert.equal(info.bitrate, 260000);
          }
        });
        await measure("playback-shared-warm-updated-expiring", async call => {
          const playback = createPlaylists();
          const read = (path: string) => call(() => playback.read(origin + path, installation, origin));
          const plain = "/clock.m3u8?sig=constant";
          for (let i = 0; i < iterations; i++) {
            revision = i;
            await Promise.all(Array.from({ length: 4 }, () => read(plain)));
            await read(plain);
          }
          const observed = actualNow();
          let now = observed;
          Date.now = () => now;
          try {
            const expires = `${plain}&exp=${Math.floor(observed / 1000) + 8}`;
            await read(expires);
            await read(expires);
            now += 4500; // Signature is valid, but reuse margin requires new analysis.
            await read(expires);
            now += 4500;
            await call(async () => {
              await assert.rejects(playback.read(origin + expires, installation, origin), /403/);
              return "expected-expiry";
            });
            await read(`/clock.m3u8?sig=refreshed&exp=${Math.floor(now / 1000) + 20}`);
          } finally { Date.now = actualNow; }
        });
        await network.close();
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>(done => server.close(() => done()));
    }
    console.log(JSON.stringify({ environment: { node: process.version, ffprobeVersion, platform: platform(), release: release(),
      cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryMiB: Math.round(totalmem() / 1024 ** 2) },
      baselineRef, iterations, results: output }, null, 2));
  } finally {
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
