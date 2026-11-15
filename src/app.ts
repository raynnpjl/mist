import express from "express";
import { resolve } from "node:path";
import { addonBuilder, getRouter, Manifest } from "stremio-addon-sdk";
import { Cache } from "./cache.js";
import { installationId, Installations } from "./installations.js";
import { Provider, SOURCES } from "./providers.js";
import { AddonService } from "./service.js";
import { defaultSettings, parseSettings, Settings } from "./settings.js";

export const manifest: Manifest = {
  id: "org.mist.chinese", version: "1.0.0", name: "Mist",
  description: "HTTP Addon for chinese content\nProviders: 红牛, 天堂, 暴风, 量子, 优酷",
  types: ["movie", "series"],
  resources: [{ name: "stream", types: ["movie", "series"], idPrefixes: ["tt", "tmdb:"] }],
  catalogs: [], behaviorHints: { configurable: true }
};

export function createApp(installations: Installations, createService: (key: string, settings: Settings) => AddonService, providers: Provider[]) {
  const routers = new Cache<ReturnType<typeof getRouter> | undefined>(512);
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => { res.set("Referrer-Policy", "no-referrer"); next(); });
  app.use("/assets", express.static(resolve(__dirname, "../public"), { index: false }));
  app.get(["/", "/configure", "/:installation/configure"], (_req, res) => res.set("Cache-Control", "no-store")
    .sendFile(resolve(__dirname, "../public/index.html")));
  app.get("/health", (_req, res) => res.set("Cache-Control", "no-store").json({ status: "ok",
    providers: providers.map(p => p.status()) }));
  app.get("/manifest.json", (_req, res) => res.set("Access-Control-Allow-Origin", "*").json({ ...manifest,
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
      routers.delete(installation);
      res.json({ installation, manifestPath: `/${installation}/manifest.json` });
    } catch (error) { next(error); }
  });

  app.get("/api/installations/:installation", async (req, res, next) => {
    try {
      const id = req.params.installation;
      if (!await installations.get(id)) { res.status(404).json({ error: "Installation not found" }); return; }
      res.json({ installation: id, manifestPath: `/${id}/manifest.json`, settings: await installations.settings(id),
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
      routers.delete(id);
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

  app.use("/:installation", async (req, res, next) => {
    const id = req.params.installation;
    if (!installationId.test(id)) { next(); return; }
    try {
      const router = await routers.get(id, 6 * 60 * 60_000, async () => {
        const key = await installations.get(id);
        if (!key) return;
        const service = createService(key, await installations.settings(id));
        const builder = new addonBuilder(manifest);
        builder.defineStreamHandler(async args => ({ streams: await service.streams(args.type, args.id), cacheMaxAge: 30 }));
        return getRouter(builder.getInterface());
      });
      if (router) router(req, res, next);
      else next();
    } catch (error) { next(error); }
  });
  app.use((_req, res) => res.status(404).json({ error: "Not found. Configure Mist at /configure." }));
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.type === "entity.too.large" ? 413 : error.type === "entity.parse.failed" ? 400 : 500)
      .json({ error: "Request failed" });
  });
  return app;
}
