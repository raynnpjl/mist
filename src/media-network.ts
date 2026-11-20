import { ProxyAgent } from "undici";
import { MediaProbe, probeMedia, probeSegmentClock, SegmentProbe } from "./media.js";
import type { Fetcher } from "./providers.js";

export function createMediaNetwork(env: NodeJS.ProcessEnv = process.env) {
  let proxy: string | undefined;
  const value = env.MEDIA_PROXY_URL?.trim();
  if (value) {
    const message = "MEDIA_PROXY_URL must be an HTTP proxy URL without credentials, path, query or fragment; use a trusted private endpoint";
    let url: URL;
    try { url = new URL(value); } catch { throw new Error(message); }
    if (url.protocol !== "http:" || !url.hostname || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) throw new Error(message);
    proxy = url.href;
  }
  const dispatcher = proxy ? new ProxyAgent(proxy) : undefined;
  const fetcher: Fetcher = dispatcher ? (input, options) => {
    const request = { ...options, dispatcher };
    return fetch(input, request);
  } : fetch;
  const probe: MediaProbe = (url, timeout) => probeMedia(url, timeout, proxy);
  const segmentProbe: SegmentProbe = (url, timeout) => probeSegmentClock(url, timeout, fetcher);
  return { fetcher, probe, segmentProbe, close: async () => { await dispatcher?.close(); } };
}
