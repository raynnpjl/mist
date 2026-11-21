import test from "node:test";
import assert from "node:assert/strict";
import { createProviders, loadSources, SOURCES } from "../src/providers.js";
import { sourceConfig } from "../src/config.js";

test("JSON endpoints drive API requests while the public provider catalog omits URLs", async t => {
  const previous = process.env.HONGNIU_API_URL;
  process.env.HONGNIU_API_URL = "https://ignored.example/api";
  t.after(() => { if (previous === undefined) delete process.env.HONGNIU_API_URL; else process.env.HONGNIU_API_URL = previous; });
  const sources = loadSources();
  assert.deepEqual(sources, sourceConfig.apis);
  assert.ok(SOURCES.every(source => !("url" in source)), "public source catalog must not expose endpoints");
  const seen: URL[] = [];
  const fetcher: typeof fetch = async input => {
    seen.push(new URL(String(input)));
    return Response.json({ code: 1, list: [] });
  };
  const result = await Promise.all(createProviders(sources, fetcher).map(provider => provider.check()));
  assert.ok(result.every(row => row.available));
  assert.deepEqual(seen.map(url => url.origin + url.pathname), sources.map(source => source.url));
  assert.ok(seen.every(url => url.searchParams.get("ac") === "list"));
});
