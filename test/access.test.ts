import test, { TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Accounts } from "../src/accounts.js";
import { accessGate } from "../src/access.js";
import { createApp } from "../src/app.js";
import { HlsPlaylists } from "../src/hls.js";
import { AddonService } from "../src/service.js";
import { MetadataResolver } from "../src/metadata.js";
import { defaultSettings } from "../src/settings.js";
import { accessCookie, configuredInstallation, drama, fixtures, installationFixture, TEST_ACCESS_KEY } from "./fixtures.js";

async function serve(t: TestContext, db = installationFixture(), encryptionKey = db.env.MIST_ENCRYPTION_KEY, store?: Accounts) {
  store ||= await db.open();
  const fixture = fixtures([drama()]);
  const server = createApp(store, apiKey => new AddonService(fixture.providers,
    new MetadataResolver(fixture.fetcher, apiKey), fixture.fetcher, fixture.inspector), fixture.providers,
    new HlsPlaylists(encryptionKey, fixture.fetcher), encryptionKey).listen(0, "127.0.0.1");
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = (accessKey: unknown, headers = {}) => fetch(`${base}/api/access`, { method: "POST",
    headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ accessKey }) });
  const request = (path: string, cookie: string, method = "GET", body?: unknown) => fetch(base + path, { method,
    headers: { Cookie: cookie, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { base, login, request, db, store, fixture };
}

test("sessions require a valid server signing secret", async () => {
  const store = await installationFixture().open();
  for (const secret of ["", "short", "x".repeat(64)]) assert.throws(() => accessGate(store, secret), /MIST_ENCRYPTION_KEY/);
});

test("a fresh key needs TMDB setup; a returning key restores its installation and saved preferences on another replica", async t => {
  const db = installationFixture(), first = await serve(t, db), replica = await serve(t, db);
  const login = await first.login(TEST_ACCESS_KEY);
  assert.deepEqual(await login.json(), { authenticated: true });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const configured = await first.request("/api/configure", cookie, "POST", { apiKey: "a".repeat(32) });
  assert.equal(configured.status, 200);
  const { installation } = await configured.json();
  assert.equal(installation, db.installation);
  const settings = { ...defaultSettings(), sources: ["hongniu"], inspectionTimeoutMs: 2500 };
  assert.equal((await first.request(`/api/installations/${installation}/settings`, cookie, "PUT", settings)).status, 200);
  const returning = await replica.login(TEST_ACCESS_KEY);
  const restored = await returning.json();
  assert.deepEqual(restored, { authenticated: true, installation });
  assert.ok(!JSON.stringify(restored).includes("a".repeat(32)), "TMDB credentials never leave the server");
  const nextCookie = returning.headers.get("set-cookie")!.split(";")[0];
  assert.deepEqual((await (await replica.request(`/api/installations/${installation}`, nextCookie)).json()).settings, settings);
  assert.deepEqual(await (await replica.request("/api/access", nextCookie)).json(), restored);
  assert.equal(db.records.size, 1, "repeated login and TMDB updates must reuse the same account");
  const logout = await replica.request("/api/access", nextCookie, "DELETE");
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie")!, /mist_access=;/);
});

test("workspace opens after configured providers are removed without losing credentials or other preferences", async t => {
  const { db, store, login, request } = await serve(t);
  const id = await configuredInstallation(store, "a".repeat(32));
  const current = defaultSettings();
  const saved = { ...current, sources: ["shandian", "hongniu", "yinghua"],
    sourceOrder: ["shandian", "liangzi", "yinghua", ...current.sourceOrder.filter(id => id !== "liangzi")],
    inspectionTimeoutMs: 2500, resolutions: [720], resolutionFirst: true };
  db.records.get(id)!.preferences = saved;
  const credential = JSON.stringify(db.records.get(id)!.credential);
  const response = await login(TEST_ACCESS_KEY);
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  assert.deepEqual(await response.json(), { authenticated: true, installation: id });
  const workspace = await request(`/api/installations/${id}`, cookie);
  assert.equal(workspace.status, 200, "valid access key must open a workspace with stale provider references");
  const config = await workspace.json();
  const expected = { ...saved, sources: ["hongniu"], sourceOrder: saved.sourceOrder.filter(id => current.sourceOrder.includes(id)) };
  assert.deepEqual(config.settings, expected);
  assert.ok(config.providers.every(source => !["shandian", "yinghua"].includes(source.id)));
  assert.ok(!JSON.stringify(config).includes("a".repeat(32)));
  assert.equal(JSON.stringify(db.records.get(id)!.credential), credential);
  assert.equal((await store.get(id))?.apiKey, "a".repeat(32));
  assert.equal((await request(`/api/installations/${id}/settings`, cookie, "PUT", { ...expected, sources: ["yinghua"] })).status, 400,
    "new preference submissions must still reject unknown providers");
  assert.equal((await request(`/api/installations/${id}/settings`, cookie, "PUT", expected)).status, 200);
  assert.deepEqual(db.records.get(id)!.preferences, expected, "saving replaces retired references with the current layout");
});

test("workspace opens with no sources enabled when every saved selection was removed", async t => {
  const { db, store, login, request } = await serve(t);
  const id = await configuredInstallation(store, "a".repeat(32));
  db.records.get(id)!.preferences = { ...defaultSettings(), sources: ["shandian", "yinghua"], sourceOrder: ["yinghua", "shandian"] };
  const response = await login(TEST_ACCESS_KEY), cookie = response.headers.get("set-cookie")!.split(";")[0];
  const workspace = await request(`/api/installations/${id}`, cookie);
  assert.equal(workspace.status, 200);
  const config = await workspace.json();
  assert.deepEqual(config.settings.sources, [], "do not silently enable providers the account never selected");
  assert.deepEqual(config.settings.sourceOrder, defaultSettings().sourceOrder);
  const selected = { ...config.settings, sources: ["hongniu"] };
  assert.equal((await request(`/api/installations/${id}/settings`, cookie, "PUT", selected)).status, 200);
  assert.deepEqual((await store.get(id))?.settings, selected);
});

test("accounts cannot read, modify or replace another account's installation", async t => {
  const { store, db, login, request } = await serve(t);
  await configuredInstallation(store, "a".repeat(32));
  const second = await store.createAccessKey();
  const response = await login(second.accessKey), cookie = response.headers.get("set-cookie")!.split(";")[0];
  assert.deepEqual(await response.json(), { authenticated: true });
  for (const path of [`/api/installations/${db.installation}`, `/api/installations/${db.installation}/status`]) {
    assert.equal((await request(path, cookie)).status, 404);
  }
  assert.equal((await request(`/api/installations/${db.installation}/settings`, cookie, "PUT", defaultSettings())).status, 404);
  assert.equal((await request("/api/configure", cookie, "POST", { installation: db.installation, apiKey: "b".repeat(32) })).status, 404);
  const own = await request("/api/configure", cookie, "POST", { apiKey: "b".repeat(32) });
  assert.equal(own.status, 200);
  assert.notEqual((await own.json()).installation, db.installation);
  assert.equal((await store.get(db.installation))?.apiKey, "a".repeat(32));
});

test("unauthenticated APIs do no storage or provider work; player requests need no browser session", async t => {
  const { base, login, db, store, fixture } = await serve(t);
  const id = await configuredInstallation(store, "a".repeat(32));
  const before = db.requests.length;
  for (const [path, method] of [["/api/configure", "POST"], [`/api/installations/${id}`, "GET"],
    [`/api/installations/${id}/settings`, "PUT"], [`/api/installations/${id}/status`, "GET"]]) {
    const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json" },
      ...(method === "GET" ? {} : { body: JSON.stringify({ apiKey: "b".repeat(32) }) }) });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal(db.requests.length, before);
  assert.equal(fixture.requests.length, 0);
  const html = await (await fetch(`${base}/configure`)).text();
  assert.match(html, /Access Key Required/);
  assert.ok(!html.includes(TEST_ACCESS_KEY));
  assert.equal((await fetch(`${base}/health`)).status, 200);
  const manifest = await fetch(`${base}/${id}/manifest.json`);
  assert.equal(manifest.status, 200);
  assert.equal(manifest.headers.get("cache-control"), "private, no-store");
  assert.ok((await (await fetch(`${base}/${id}/stream/series/tt26235088:1:1.json`)).json()).streams.length);
  for (const key of [undefined, 1, "incorrect", "ff".repeat(32)]) {
    const denied = await login(key);
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get("set-cookie"), null);
  }
  assert.equal((await login(TEST_ACCESS_KEY, { Origin: "https://unrelated.example" })).status, 403);
});

test("sessions reject tampering, expiry and signing-key changes; account revocation works immediately on every replica", async t => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const db = installationFixture(), first = await serve(t, db), replica = await serve(t, db);
  const rotated = await serve(t, db, "02".repeat(32));
  const id = await configuredInstallation(first.store, "a".repeat(32));
  const second = await first.store.createAccessKey();
  const secondResponse = await first.login(second.accessKey), secondCookie = secondResponse.headers.get("set-cookie")!.split(";")[0];
  const response = await first.login(TEST_ACCESS_KEY, { "X-Forwarded-Proto": "https" });
  const setCookie = response.headers.get("set-cookie")!;
  for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/api", "Max-Age=28800"]) assert.ok(setCookie.includes(flag));
  const cookie = setCookie.split(";")[0];
  for (const app of [first, replica]) assert.equal((await app.request(`/api/installations/${id}`, cookie)).status, 200);
  assert.deepEqual(await (await rotated.request("/api/access", cookie)).json(), { authenticated: false });
  for (const invalid of [cookie.replace(/\.\d+\./, ".9999999999999."), cookie + "x", "mist_access=broken", "mist_access=%invalid"]) {
    assert.equal((await first.request(`/api/installations/${id}`, invalid)).status, 401);
  }
  await first.store.revokeAccessKey(db.id);
  for (const app of [first, replica]) {
    assert.equal((await app.request(`/api/installations/${id}`, cookie)).status, 401);
    assert.equal((await fetch(`${app.base}/${id}/manifest.json`)).status, 404);
    assert.equal((await app.login(TEST_ACCESS_KEY)).status, 401);
    assert.deepEqual(await (await app.request("/api/access", secondCookie)).json(), { authenticated: true });
  }
  now += 8 * 60 * 60_000;
  assert.equal((await first.request("/api/configure", secondCookie, "POST", { apiKey: "a".repeat(32) })).status, 401);
});

test("a database outage never bypasses access checks or exposes database credentials", async t => {
  const db = installationFixture(), healthy = await serve(t, db), cookie = await accessCookie(healthy.base);
  const unavailable = new Accounts(async () => { throw new Error(db.env.DATABASE_URL); }, db.env.MIST_ENCRYPTION_KEY);
  const app = await serve(t, db, db.env.MIST_ENCRYPTION_KEY, unavailable);
  for (const response of [await app.login(TEST_ACCESS_KEY), await app.request("/api/access", cookie),
    await app.request(`/api/installations/${db.installation}`, cookie)]) {
    assert.equal(response.status, 500);
    assert.ok(!(await response.text()).includes(db.env.DATABASE_URL));
  }
});

test("repeated invalid access keys are throttled until the attempt window expires", async t => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const { login } = await serve(t);
  for (let i = 0; i < 10; i++) assert.equal((await login("ff".repeat(32))).status, 401);
  const limited = await login(TEST_ACCESS_KEY);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "900");
  now += 15 * 60_000;
  assert.equal((await login(TEST_ACCESS_KEY)).status, 200);
});
