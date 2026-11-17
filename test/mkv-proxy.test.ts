import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { MkvDrama, pageFetcher } from "../src/mkvdrama.js";

// Public ECHConfigList fixture; not a credential or a production pin.
const ECH = "AEX+DQBB7AAgACAoljvazIcCUAEZEJyw/FlphlioFGAu6n6sizGCzaYrMQAEAAEAAQASY2xvdWRmbGFyZS1lY2guY29tAAA=";
const dnsAnswer = () => Response.json({ Status: 0, Answer: [{ name: "viewcrate.cc.", type: 65, TTL: 300, data: `1 . alpn=h2 ech=${ECH}` }] });

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
  t.mock.method(globalThis, "fetch", async () => dnsAnswer());
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

test("proxied ViewCrate supplies cached ECH configuration to complete the TLS request", async t => {
  const { Session, CurlOpt, Response: NativeResponse } = await import("impers");
  let dnsRequests = 0, requests = 0;
  t.mock.method(globalThis, "fetch", async (input, options) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://dns.google");
    assert.equal(url.searchParams.get("name"), "viewcrate.cc");
    assert.equal(url.searchParams.get("type"), "HTTPS");
    assert.ok(options?.signal);
    dnsRequests++;
    return dnsAnswer();
  });
  t.mock.method(Session.prototype, "request", async (_method, input, options) => {
    requests++;
    if (new URL(input).hostname === "viewcrate.cc" && options?.curlOptions?.[CurlOpt.ECH] !== `ecl:${ECH}`) {
      throw new Error("ViewCrate TLS handshake failed without ECH");
    }
    options?.contentCallback?.(Buffer.from("download links"));
    return new NativeResponse({ statusCode: 200 });
  });
  const fetcher = pageFetcher({ MKVDRAMA_PROXY_URL: "https://mist:private-password@proxy.example:3129" });
  await fetcher("https://mkvdrama.net/search?q=drama", { signal: AbortSignal.timeout(1000) });
  assert.equal(dnsRequests, 0, "other discovery hosts need no extra DNS request");
  for (const path of ["/c/first", "/c/second"]) {
    const response = await fetcher(`https://viewcrate.cc${path}`, { signal: AbortSignal.timeout(1000) });
    assert.equal(await response.text(), "download links");
  }
  assert.equal(dnsRequests, 1, "public TLS configuration is shared across proxied ViewCrate requests");
  assert.equal(requests, 3);
});

test("missing ViewCrate ECH configuration fails before attempting an unprotected connection", async t => {
  const { Session, Response: NativeResponse } = await import("impers");
  let requests = 0;
  const dns = t.mock.method(globalThis, "fetch", async () => Response.json({ Status: 0, Answer: [] }));
  t.mock.method(Session.prototype, "request", async () => { requests++; return new NativeResponse({ statusCode: 200 }); });
  const fetcher = pageFetcher({ MKVDRAMA_PROXY_URL: "https://mist:private-password@proxy.example:3129" });
  await assert.rejects(fetcher("https://viewcrate.cc/c/first", { signal: AbortSignal.timeout(1000) }), /proxy request failed/);
  assert.equal(requests, 0);
  dns.mock.mockImplementation(async () => dnsAnswer());
  assert.equal((await fetcher("https://viewcrate.cc/c/first", { signal: AbortSignal.timeout(1000) })).status, 200);
  assert.equal(requests, 1, "a failed DNS load must not poison later lookups");
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
