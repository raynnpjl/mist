import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseConfig } from "../src/config.js";

const document = () => ({ api_site: {
  first: { name: "First", api: "https://first.example/api", backup_apis: ["https://second.example/api", "https://third.example/api"] },
  custom: { name: "Custom", api: "http://custom.example/api" }
}, web_site: { mkvdrama: { name: "MKVDrama", url: "https://site.example" } } });

test("JSON defines ordered API providers, backup endpoints and a separate website", () => {
  const config = parseConfig(document());
  assert.deepEqual(config.apis, [
    { id: "first", name: "First", url: "https://first.example/api", backups: ["https://second.example/api", "https://third.example/api"] },
    { id: "custom", name: "Custom", url: "http://custom.example/api", backups: [] }
  ]);
  assert.deepEqual(config.mkvdrama, { id: "mkvdrama", name: "MKVDrama", url: "https://site.example" });
});

test("invalid provider configuration fails without exposing endpoint values", () => {
  for (const api of ["invalid-private-endpoint", "ftp://private.example/api", "https://user:secret@private.example/api", "https://private.example/api#secret"]) {
    const input = document(); input.api_site.first.api = api;
    assert.throws(() => parseConfig(input), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /config.json.*first/);
      assert.doesNotMatch(error.message, /private|secret/);
      return true;
    });
  }
  for (const input of [null, {}, { ...document(), api_site: {} },
    { ...document(), web_site: {} }, { ...document(), web_site: { unsupported: { name: "Other", url: "https://site.example" } } },
    { ...document(), api_site: { bad: { name: "", api: "https://first.example" } } },
    { ...document(), api_site: { bad: { name: "Bad", api: "https://first.example", backup_apis: "https://second.example" } } },
    { ...document(), api_site: { bad: { name: "Bad", api: "https://first.example", backup_apis: ["https://first.example"] } } },
    { ...document(), web_site: { mkvdrama: { name: "MKVDrama", url: "https://site.example/path" } } }]) {
    assert.throws(() => parseConfig(input), /config.json/);
  }
});

test("missing and malformed JSON fail clearly without consulting environment endpoints", t => {
  const directory = mkdtempSync(join(tmpdir(), "mist-config-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "config.json");
  assert.throws(() => loadConfig(file), /config.json/);
  writeFileSync(file, "{private-invalid-json");
  assert.throws(() => loadConfig(file), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /config.json/);
    assert.doesNotMatch(error.message, /private-invalid-json/);
    return true;
  });
  writeFileSync(file, JSON.stringify(document()));
  assert.equal(loadConfig(file).apis[1].id, "custom");
});
