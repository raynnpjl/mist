import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import type { AddressInfo, Socket } from "node:net";
import { createMediaNetwork } from "../src/media-network.js";

async function proxyFixture(t: TestContext) {
  const requests: string[] = [];
  const sockets = new Set<Socket>();
  let deny = false, stall = false;
  const origin = createServer((req, res) => {
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.end(req.url === "/control" ? "direct" : "#EXTM3U\n#EXTINF:5,\nsegment.ts\n");
  });
  origin.listen(0, "127.0.0.1");
  await once(origin, "listening");
  const proxy = createServer((_req, res) => { res.writeHead(502).end(); });
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    return socket;
  };
  proxy.on("connection", track);
  proxy.on("connect", (req, client, head) => {
    requests.push(req.url!);
    if (stall) return;
    if (deny) {
      client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = track(connect((origin.address() as AddressInfo).port, "127.0.0.1"));
    upstream.on("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    client.on("close", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    origin.closeAllConnections();
    await Promise.all([origin, proxy].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  });
  return { requests, url: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
    origin: `http://127.0.0.1:${(origin.address() as AddressInfo).port}`,
    deny: () => { deny = true; }, stall: () => { stall = true; } };
}

test("media proxy configuration rejects unsupported or credential-bearing URLs without exposing them", () => {
  for (const value of ["private-secret", "socks5://private.example:40000", "https://private.example:8118",
    "http://user:private-secret@private.example:8118", "http://private.example/path",
    "http://private.example?token=private-secret", "http://private.example#private-secret"]) {
    assert.throws(() => createMediaNetwork({ MEDIA_PROXY_URL: value }), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /MEDIA_PROXY_URL/);
      assert.doesNotMatch(error.message, /private-secret|private\.example/);
      return true;
    });
  }
});

test("media requests use the configured proxy while unrelated global fetch calls stay direct", async t => {
  const proxy = await proxyFixture(t);
  const network = createMediaNetwork({ MEDIA_PROXY_URL: proxy.url });
  t.after(() => network.close());
  const response = await network.fetcher("http://media.invalid/master.m3u8", { signal: AbortSignal.timeout(2000) });
  assert.match(await response.text(), /^#EXTM3U/);
  assert.deepEqual(proxy.requests, ["media.invalid:80"]);
  assert.equal(await (await fetch(`${proxy.origin}/control`)).text(), "direct");
  assert.equal(proxy.requests.length, 1, "media routing must not change the global dispatcher");
});

test("a failed media proxy request is not retried on the direct route", async t => {
  const proxy = await proxyFixture(t);
  proxy.deny();
  const network = createMediaNetwork({ MEDIA_PROXY_URL: proxy.url });
  t.after(() => network.close());
  await assert.rejects(network.fetcher(`${proxy.origin}/control`, { signal: AbortSignal.timeout(1000) }));
  assert.equal(proxy.requests.length, 1, "the healthy direct origin must not bypass a configured proxy failure");
});

test("an unset media proxy retains direct fetch", async () => {
  const network = createMediaNetwork({});
  assert.equal(network.fetcher, fetch);
  await network.close();
});

const hasFfprobe = spawnSync("ffprobe", ["-version"], { stdio: "ignore", timeout: 2000 }).status === 0;
test("FFprobe uses the same HTTP proxy even when the environment bypasses proxies", { skip: !hasFfprobe }, async t => {
  const proxy = await proxyFixture(t);
  proxy.deny();
  const network = createMediaNetwork({ MEDIA_PROXY_URL: proxy.url });
  t.after(() => network.close());
  const previous = { no_proxy: process.env.no_proxy, NO_PROXY: process.env.NO_PROXY };
  process.env.no_proxy = process.env.NO_PROXY = "*";
  t.after(() => {
    for (const key of ["no_proxy", "NO_PROXY"] as const) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  await assert.rejects(network.probe("https://media.invalid/index.m3u8", 2000));
  assert.deepEqual(proxy.requests, ["media.invalid:443"]);
});

test("segment clock inspection fetches its media through the configured proxy", async t => {
  const proxy = await proxyFixture(t);
  const network = createMediaNetwork({ MEDIA_PROXY_URL: proxy.url });
  t.after(() => network.close());
  await assert.rejects(network.segmentProbe("http://media.invalid/segment.ts", 2000));
  assert.deepEqual(proxy.requests, ["media.invalid:80"]);
});

test("the selected deadline still kills FFprobe when a proxy connection stalls", { skip: !hasFfprobe }, async t => {
  const proxy = await proxyFixture(t);
  proxy.stall();
  const network = createMediaNetwork({ MEDIA_PROXY_URL: proxy.url });
  t.after(() => network.close());
  await assert.rejects(network.probe("https://media.invalid/index.m3u8", 150), error => {
    assert.equal((error as NodeJS.ErrnoException & { killed: boolean }).killed, true);
    return true;
  });
});
