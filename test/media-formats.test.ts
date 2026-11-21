import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { MediaInspector } from "../src/media.js";

const hasMediaTools = ["ffmpeg", "ffprobe"].every(command => spawnSync(command, ["-version"], { stdio: "ignore", timeout: 2000 }).status === 0);

test("real MP4, TS, encrypted, fragmented and byte-range HLS retain verified media details without duplicate cold media reads", { skip: !hasMediaTools }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "mist-media-formats-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const server = createServer((req, res) => {
    let data: Buffer;
    try { data = readFileSync(join(directory, basename(new URL(req.url!, "http://fixture").pathname))); }
    catch { res.writeHead(404).end(); return; }
    const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    if (range) {
      const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
      if (start >= data.length) { res.writeHead(416).end(); return; }
      res.setHeader("Content-Range", `bytes ${start}-${end}/${data.length}`);
      res.statusCode = 206;
      data = data.subarray(start, end + 1);
    }
    res.setHeader("Content-Length", data.length);
    res.end(data);
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  writeFileSync(join(directory, "key.bin"), Buffer.alloc(16, 7));
  writeFileSync(join(directory, "key-info.txt"), `${origin}/key.bin\n${join(directory, "key.bin")}\n`);
  const formats: [string, string[]][] = [
    ["direct.mp4", ["-movflags", "+faststart"]],
    ["plain.m3u8", ["-f", "hls", "-hls_time", "1"]],
    ["encrypted.m3u8", ["-f", "hls", "-hls_time", "1", "-hls_key_info_file", join(directory, "key-info.txt")]],
    ["fragmented.m3u8", ["-f", "hls", "-hls_time", "1", "-hls_segment_type", "fmp4"]],
    ["byte-range.m3u8", ["-f", "hls", "-hls_time", "1", "-hls_flags", "single_file"]]
  ];
  for (const [filename, options] of formats) {
    await t.test(filename, async () => {
      const generated = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=10",
        "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", "1", "-c:v", "libx264", "-preset", "ultrafast",
        "-g", "10", "-c:a", "aac", "-threads", "1", ...options, filename], { cwd: directory, encoding: "utf8", timeout: 5000 });
      assert.equal(generated.status, 0, generated.stderr);
      const reads: URL[] = [];
      const inspector = new MediaInspector(async (input, options) => {
        reads.push(new URL(String(input)));
        return fetch(input, options);
      });
      const cold = await inspector.inspect(`${origin}/${filename}`);
      assert.equal(cold.height, 64);
      assert.equal(cold.videoCodec, "h264");
      assert.equal(cold.audioCodec, "aac");
      assert.equal(cold.reachable, true);
      assert.ok(reads.every(url => url.pathname.endsWith(".m3u8")), "cold media requests must belong exclusively to FFprobe");
      now += 30001;
      assert.deepEqual(await inspector.inspect(`${origin}/${filename}`), cold);
      assert.ok(reads.some(url => !url.pathname.endsWith(".m3u8")), "warm availability checks must read only a small prefix");
    });
  }
});
