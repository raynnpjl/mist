import "./env.js";
import { createApp } from "./app.js";
import { createProviders, loadSources } from "./providers.js";
import { AddonService } from "./service.js";
import { MetadataResolver } from "./metadata.js";
import { Accounts } from "./accounts.js";
import { HlsPlaylists } from "./hls.js";
import { MediaInspector } from "./media.js";
import { createMediaNetwork } from "./media-network.js";
import { MkvDrama } from "./mkvdrama.js";
import { MkvHeaderInspector } from "./mkv-metadata.js";
import { DiscoveryStore } from "./discovery-cache.js";

const port = Number(process.env.PORT || 7000);
const timeout = Number(process.env.UPSTREAM_TIMEOUT_MS || 8000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be between 1 and 65535");
if (!Number.isInteger(timeout) || timeout < 100 || timeout > 30000) throw new Error("UPSTREAM_TIMEOUT_MS must be between 100 and 30000");
async function main() {
  const media = createMediaNetwork();
  const installations = await Accounts.open();
  await installations.check();
  const discovery = new DiscoveryStore();
  const providers = [...createProviders(loadSources(), fetch, timeout), new MkvDrama(undefined, undefined, discovery)];
  const mkvHeaders = new MkvHeaderInspector(undefined, undefined, undefined, discovery);
  const inspector = new MediaInspector(media.fetcher, media.probe);
  const server = createApp(installations, (key, settings) => new AddonService(
    settings.sourceOrder.filter(id => settings.sources.includes(id)).flatMap(id => providers.filter(provider => provider.source.id === id)),
    new MetadataResolver(fetch, key, timeout), fetch,
    inspector, settings.resolutions, mkvHeaders, settings.resolutionFirst, settings.inspectionTimeoutMs, settings.includeEpisodeExtras), providers,
    new HlsPlaylists(process.env.MIST_ENCRYPTION_KEY!, media.fetcher, media.segmentProbe), process.env.MIST_ENCRYPTION_KEY!)
    .listen(port, process.env.HOST || "0.0.0.0", () => console.log(`Mist setup: http://localhost:${port}/configure`));
  server.requestTimeout = 60_000;
  function shutdown() {
    server.close(() => { media.close().then(() => process.exit(0), () => process.exit(1)); });
    setTimeout(() => process.exit(1), 10_000).unref();
  }
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
