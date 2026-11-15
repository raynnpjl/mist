import test from "node:test";
import assert from "node:assert/strict";
import { createProviders, loadSources, SOURCES } from "../src/providers.js";
import { TEST_SOURCES } from "./fixtures.js";

const environment = Object.fromEntries(TEST_SOURCES.map(source => [`${source.id.toUpperCase()}_API_URL`, source.url]));

test("provider endpoints come only from the supplied environment and drive API requests", async () => {
  const sources = loadSources(environment);
  assert.deepEqual(sources, TEST_SOURCES);
  assert.ok(SOURCES.every(source => !("url" in source)), "source catalog must not embed endpoints");
  const seen: URL[] = [];
  const fetcher: typeof fetch = async input => {
    seen.push(new URL(String(input)));
    return Response.json({ code: 1, list: [] });
  };
  const result = await Promise.all(createProviders(sources, fetcher).map(provider => provider.check()));
  assert.ok(result.every(row => row.available));
  assert.deepEqual(seen.map(url => url.origin + url.pathname), TEST_SOURCES.map(source => source.url));
  assert.ok(seen.every(url => url.searchParams.get("ac") === "list"));
});

test("missing or invalid endpoint configuration fails without built-in URLs or leaking its value", () => {
  for (const source of SOURCES) {
    const key = `${source.id.toUpperCase()}_API_URL`;
    for (const value of [undefined, "", "invalid-private-endpoint", "http://private.example/api", "https://user:secret@private.example/api"]) {
      assert.throws(() => loadSources({ ...environment, [key]: value }), error => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(key));
        assert.ok(!error.message.includes("private.example") && !error.message.includes("secret") && !error.message.includes("invalid-private-endpoint"));
        return true;
      });
    }
  }
});
