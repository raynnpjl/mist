import { Pool, readBytes } from "./cache.js";
import { createHash } from "node:crypto";
import { timed } from "./loading.js";
import { UPSTREAM_HEADERS, type Fetcher } from "./providers.js";
import { identity, requestHeaders, SharedJobs } from "./shared-jobs.js";

export const playlistHeaders = Object.freeze({ "User-Agent": UPSTREAM_HEADERS["User-Agent"] });
export class NotPlaylist extends Error {
  constructor() { super("Upstream did not return an HLS playlist"); }
}

export interface PlaylistSnapshot { body: string; base: string; hash: string }

export class PlaylistFetcher {
  private jobs = new SharedJobs<PlaylistSnapshot>("playlist.fetch", 48);
  private network = new Pool(8);

  constructor(private fetcher: Fetcher = fetch, readonly context = "direct") {}

  read(url: string, signal: AbortSignal, stage: string, headers: HeadersInit = playlistHeaders): Promise<PlaylistSnapshot> {
    const key = identity(url, requestHeaders(headers), this.context);
    return this.jobs.run(key, 10_000, job => this.network.run(async () => {
      const retryUntil = Date.now() + 8000;
      for (let attempt = 0; ; attempt++) {
        try {
          const response = await timed(stage, () => this.fetcher(url, { headers, signal: job }));
          if (!response.ok) { await response.body?.cancel(); throw new Error(`Playlist HTTP ${response.status}`); }
          const bytes = await readBytes(response, 1024 * 1024, prefix => {
            if (!/^\s*#EXTM3U[ \t]*(?:[\r\n]|$)/.test(prefix.toString("utf8"))) throw new NotPlaylist();
          });
          return { body: bytes.toString("utf8"), base: response.url || url,
            hash: createHash("sha256").update(bytes).digest("hex") };
        } catch (error) {
          const transient = error instanceof TypeError && ["fetch failed", "terminated"].includes(error.message) ||
            error instanceof Error && /^Playlist HTTP 5\d{2}$/.test(error.message);
          if (attempt || !transient || job.aborted || Date.now() >= retryUntil) throw error;
        }
      }
    }, job), signal);
  }
}
