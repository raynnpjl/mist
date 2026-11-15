import test from "node:test";
import assert from "node:assert/strict";
import { manifest } from "../src/app.js";
import { MetadataResolver } from "../src/metadata.js";
import { AddonService } from "../src/service.js";
import { drama, fixtures } from "./fixtures.js";

// cNative's mapMetadata keeps its own metadata ID but mapEpisode uses the external ID.
// https://github.com/raynnpjl/cNative/blob/main/addon/src/metadata/metadata.mapper.ts
test("cNative IMDb and unmapped-TMDB episode IDs discover and resolve Mist streams", async () => {
  const fixture = fixtures([drama(1, { vod_name: "狂飙", vod_year: "2023" })]);
  const service = new AddonService(fixture.providers, new MetadataResolver(fixture.fetcher, "fixture-key"), fixture.fetcher, fixture.inspector);
  const streamResource = manifest.resources.find(r => typeof r !== "string" && r.name === "stream");
  assert.ok(streamResource && typeof streamResource !== "string");
  const cnativeMetas = [
    { id: "cnative:en-en-en:tt26235088", videos: [{ id: "tt26235088:1:1" }] },
    { id: "cnative:zh-en-en:tmdb:210757", videos: [{ id: "tmdb:210757:1:1" }] }
  ];
  for (const meta of cnativeMetas) {
    const videoId = meta.videos[0].id;
    assert.ok(streamResource.idPrefixes?.some(prefix => videoId.startsWith(prefix)));
    const streams = await service.streams("series", videoId);
    assert.ok(streams.length > 0, `No Mist sources for cNative episode ${videoId}`);
    assert.ok(streams.every(s => s.name === "1080P"));
  }
});
