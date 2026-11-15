import express from "express";
import { resolve } from "node:path";
import { addonBuilder, getRouter, Manifest } from "stremio-addon-sdk";
import { Cache } from "./cache.js";
import { installationId, Installations } from "./installations.js";
import { Provider, SOURCES } from "./providers.js";
import { AddonService } from "./service.js";
import { HlsPlaylists } from "./hls.js";
import { defaultSettings, parseSettings, Settings } from "./settings.js";

export const manifest: Manifest & { stremioAddonsConfig: { issuer: string; signature: string } } = {
  id: "org.mist.chinese", version: "1.2.0", name: "Mist",
  description: "HTTP Addon for chinese content",
  stremioAddonsConfig: {
    issuer: "https://stremio-addons.net",
    signature: "eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..DR7JuNucW3enoPVljnZzog.En6KpQ_KuEr3RJnxcdTaGzjHLATNm5GGnlqDNQwH5shzRQbxO-HDwkHntvXKW07vowSEL9jjSczmZ_cFMh7-oPuLreMtb2gPFY2gvxPxmP4jocVaz6f0VF2_LEfE_w-R.g0ERoiqMTnqK-txFWOZNsg"
  },
  types: ["movie", "series"],
  resources: [{ name: "stream", types: ["movie", "series"], idPrefixes: ["tt", "tmdb:"] }],
  catalogs: [], behaviorHints: { configurable: true }
};

function manifestFor(req: express.Request): Manifest {
  return { ...manifest, logo: `${req.protocol}://${req.get("host")}/assets/icon.png` };
}

export function createApp(installations: Installations, createService: (key: string, settings: Settings) => AddonService, providers: Provider[], playlists: HlsPlaylists) {
  const routers = new Cache<ReturnType<typeof getRouter>>(512);
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use((_req, res, next) => { res.set("Referrer-Policy", "no-referrer"); next(); });
  app.use("/assets", express.static(resolve(__dirname, "../public"), { index: false }));
  app.get(["/", "/configure", "/:installation/configure"], (_req, res) => res.set("Cache-Control", "no-store")
    .sendFile(resolve(__dirname, "../public/index.html")));
  app.get("/health", (_req, res) => res.set("Cache-Control", "no-store").json({ status: "ok",
    providers: providers.map(p => p.status()) }));
  app.get("/manifest.json", (req, res) => res.set("Access-Control-Allow-Origin", "*").json({ ...manifestFor(req),
    resources: [], behaviorHints: { configurable: true, configurationRequired: true } }));

  app.use("/api", express.json({ limit: "2kb" }), (req, res, next) => {
    res.set("Cache-Control", "no-store");
    const origin = req.method === "GET" ? undefined : req.get("Origin");
    try { if (origin && new URL(origin).host !== req.get("host")) { res.status(403).json({ error: "Use the Mist configuration page" }); return; } }
    catch { res.status(403).json({ error: "Invalid origin" }); return; }
    next();
  });

  app.post("/api/configure", async (req, res, next) => {
    const key = typeof req.body?.apiKey === "string" ? req.body.apiKey.trim() : "";
    if (!/^[a-f0-9]{32}$/i.test(key)) { res.status(400).json({ error: "Enter a valid TMDB v3 API key (32 hexadecimal characters)" }); return; }
    const id = req.body.installation;
    try {
      if (id !== undefined && (typeof id !== "string" || !await installations.get(id))) {
        res.status(404).json({ error: "Installation not found" }); return;
      }
      try { await createService(key, defaultSettings()).authenticate(); }
      catch (error) {
        const invalid = error instanceof Error && /HTTP 401/.test(error.message);
        res.status(invalid ? 400 : 502).json({ error: invalid ? "TMDB rejected this API key" : "Could not verify the key with TMDB. Try again." });
        return;
      }
      const installation = await installations.save(key, id);
      res.json({ installation, manifestPath: `/${installation}/manifest.json` });
    } catch (error) { next(error); }
  });

  app.get("/api/installations/:installation", async (req, res, next) => {
    try {
      const id = req.params.installation;
      const installation = await installations.get(id);
      if (!installation) { res.status(404).json({ error: "Installation not found" }); return; }
      res.json({ installation: id, manifestPath: `/${id}/manifest.json`, settings: installation.settings,
        providers: SOURCES.map(source => ({ id: source.id, name: source.name })) });
    } catch (error) { next(error); }
  });

  app.put("/api/installations/:installation/settings", async (req, res, next) => {
    try {
      const id = req.params.installation;
      if (!await installations.get(id)) { res.status(404).json({ error: "Installation not found" }); return; }
      const settings = parseSettings(req.body);
      if (!settings) { res.status(400).json({ error: "Select at least one valid source and a lookup time from 1 to 10 seconds" }); return; }
      await installations.saveSettings(id, settings);
      res.json({ settings });
    } catch (error) { next(error); }
  });

  app.get("/api/installations/:installation/status", async (req, res, next) => {
    try {
      if (!await installations.get(req.params.installation)) { res.status(404).json({ error: "Installation not found" }); return; }
      res.json({ providers: await Promise.all(providers.map(async provider => ({ id: provider.source.id,
        name: provider.source.name, ...await provider.check() }))) });
    } catch (error) { next(error); }
  });

  app.get("/:installation/hls/:token.m3u8", async (req, res, next) => {
    try {
      const id = req.params.installation;
      if (!await installations.get(id)) { next(); return; }
      const source = playlists.source(req.params.token, id);
      if (!source) { res.status(400).json({ error: "Invalid playlist link" }); return; }
      res.set({ "Access-Control-Allow-Origin": "*", "Cache-Control": "private, no-store" });
      try {
        const body = await playlists.read(source, id, `${req.protocol}://${req.get("host")}`);
        res.type("application/vnd.apple.mpegurl").send(body);
      } catch {
        // A CDN can reject server requests while still allowing native players.
        res.redirect(307, source);
      }
    } catch (error) { next(error); }
  });

  app.use("/:installation", async (req, res, next) => {
    const id = req.params.installation;
    if (!installationId.test(id)) { next(); return; }
    try {
      const installation = await installations.get(id);
      if (!installation) { next(); return; }
      const installedManifest = manifestFor(req);
      const router = await routers.get(`${id}:${installation.revision}:${installedManifest.logo}`, 6 * 60 * 60_000, async () => {
        const service = createService(installation.apiKey, installation.settings);
        const builder = new addonBuilder(installedManifest);
        builder.defineStreamHandler(async args => ({ streams: (await service.streams(args.type, args.id)).map(stream =>
          /\.m3u8$/i.test(new URL(stream.url).pathname)
            ? { ...stream, url: playlists.url(stream.url, id, new URL(installedManifest.logo!).origin) } : stream), cacheMaxAge: 30 }));
        return getRouter(builder.getInterface());
      });
      router(req, res, next);
    } catch (error) { next(error); }
  });
  app.use((_req, res) => res.status(404).json({ error: "Not found. Configure Mist at /configure." }));
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.type === "entity.too.large" ? 413 : error.type === "entity.parse.failed" ? 400 : 500)
      .json({ error: "Request failed" });
  });
  return app;
}
