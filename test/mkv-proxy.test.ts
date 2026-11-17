import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { MkvDrama, pageFetcher } from "../src/mkvdrama.js";

test("MKVDrama rejects invalid proxy configuration without exposing credentials", () => {
  for (const value of ["invalid-private-proxy", "ftp://user:secret@private.example", "https://user:secret@private.example/path",
    "https://user:secret@private.example?token=secret", "https://user:secret@private.example#secret", "socks5://"]) {
    assert.throws(() => pageFetcher({ MKVDRAMA_PROXY_URL: value }), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /MKVDRAMA_PROXY_URL/);
      assert.doesNotMatch(error.message, /secret|private\.example|invalid-private-proxy/);
      return true;
    });
  }
  for (const value of [undefined, "", "  ", "http://127.0.0.1:3128", "https://user:secret@proxy.example:3129",
    "socks5://127.0.0.1:1080", " socks5h://user:secret@proxy.example:1080 "]) {
    assert.equal(typeof pageFetcher({ MKVDRAMA_PROXY_URL: value }), "function");
  }
});

test("MKVDrama uses authenticated CONNECT for every discovery host and reports proxy failures without credentials", async t => {
  const previous = process.env.no_proxy;
  process.env.no_proxy = "*";
  t.after(() => { if (previous === undefined) delete process.env.no_proxy; else process.env.no_proxy = previous; });
  const seen: { url?: string; auth?: string }[] = [];
  const server = createServer();
  server.on("connect", (request, socket) => {
    seen.push({ url: request.url, auth: request.headers["proxy-authorization"] });
    socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"Mist\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const port = (server.address() as AddressInfo).port;
  const fetcher = pageFetcher({ MKVDRAMA_PROXY_URL: `http://mist:private-password@127.0.0.1:${port}` });
  const hosts = ["mkvdrama.net", "ouo.io", "ouo.press", "viewcrate.cc", "filecrypt.cc", "pixeldrain.com", "send.now", "www.google.com"];
  for (const host of hosts) {
    await assert.rejects(fetcher(`https://${host}/`, { signal: AbortSignal.timeout(3000) }), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /proxy request failed/);
      assert.doesNotMatch(error.message, /private-password|127\.0\.0\.1/);
      return true;
    });
  }
  assert.deepEqual(seen.map(request => request.url), hosts.map(host => `${host}:443`), "NO_PROXY must not bypass the configured proxy");
  assert.ok(seen.every(request => request.auth === `Basic ${Buffer.from("mist:private-password").toString("base64")}`));
  const status = await new MkvDrama(fetcher).check();
  assert.equal(status.available, false);
  assert.match(status.error!, /proxy request failed/);
  assert.doesNotMatch(JSON.stringify(status), /private-password|127\.0\.0\.1/);
});

test("proxy transport preserves POST bodies, cookies and manual redirects", async t => {
  const seen: { url?: string; method?: string; cookie?: string; body: string }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    seen.push({ url: request.url, method: request.method, cookie: request.headers.cookie, body: Buffer.concat(chunks).toString() });
    response.writeHead(302, { Location: "https://send.now/episode", "Set-Cookie": "access=scoped; Secure", "Content-Type": "text/html" });
    response.end("redirect body");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const port = (server.address() as AddressInfo).port;
  // HTTP exercises the native proxy transport without an external origin or a test TLS trust override.
  const response = await pageFetcher({ MKVDRAMA_PROXY_URL: `http://127.0.0.1:${port}` })("http://mkvdrama.net/panel", {
    method: "POST", headers: { Cookie: "access=scoped", "Content-Type": "application/json" },
    body: '{"token":"test"}', signal: AbortSignal.timeout(3000), redirect: "manual"
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "https://send.now/episode");
  assert.deepEqual(response.headers.getSetCookie(), ["access=scoped; Secure"]);
  assert.equal(await response.text(), "redirect body");
  assert.deepEqual(seen, [{ url: "http://mkvdrama.net/panel", method: "POST", cookie: "access=scoped", body: '{"token":"test"}' }]);
});
