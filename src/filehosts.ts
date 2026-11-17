import { load } from "cheerio";

export const MKVDRAMA_HOSTS = [
  { id: "pixeldrain", name: "PixelDrain" },
  { id: "send", name: "Send" }
];

export function fileHost(hostname: string): string | undefined {
  if (hostname === "pixeldrain.com") return "pixeldrain";
  if (hostname === "fileditchvids.st" || hostname.endsWith(".fileditchvids.st")) return "fileditchvids";
  if (hostname === "send.now" || hostname.endsWith(".send.now") || hostname.endsWith(".sendcdn.com") || hostname.endsWith(".datatransfer.to") || hostname.endsWith(".usercdn.com")) return "send";
}

export function hostLabel(url: string): string {
  const hostname = new URL(url).hostname;
  return MKVDRAMA_HOSTS.find(host => host.id === fileHost(hostname))?.name || hostname;
}

type PageReader = (url: string, options?: RequestInit) => Promise<{ text: string; redirect?: string }>;

function sendPlayerConfig(payload: string): { sources?: { src?: string }[] } {
  if (payload.startsWith("{")) return JSON.parse(payload);
  const bytes = Buffer.from(payload, "base64");
  // Send's public /player/video/p/3601de288bae.js uses RC4 with an eight-byte salt.
  const key = Buffer.concat([Buffer.from("439f83a0914b3e7b85b858b745f51437"), bytes.subarray(0, 8)]);
  const state = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + state[i] + key[i % key.length]) & 255;
    [state[i], state[j]] = [state[j], state[i]];
  }
  const data = Buffer.from(bytes.subarray(8));
  let i = 0; j = 0;
  for (let n = 0; n < data.length; n++) {
    i = (i + 1) & 255; j = (j + state[i]) & 255;
    [state[i], state[j]] = [state[j], state[i]];
    data[n] ^= state[(state[i] + state[j]) & 255];
  }
  return JSON.parse(data.toString("utf8"));
}

export async function resolveSend(url: string, read: PageReader): Promise<{ url: string; filename: string; subtitles?: string; headers: Record<string, string> }> {
  const page = await read(url);
  const $ = load(page.text);
  const filename = $("#fv[data-name]").attr("data-name");
  const payload = $("#xvp-config").text().trim();
  if (!filename || !payload) throw new Error("Send player configuration missing");
  const source = sendPlayerConfig(payload)?.sources?.[0]?.src;
  const target = typeof source === "string" ? new URL(source) : undefined;
  if (!target || target.protocol !== "https:" || target.username || target.password || target.port ||
    fileHost(target.hostname) !== "send" || !/^\/d\//.test(target.pathname) || !/\.(mkv|mp4)$/i.test(target.pathname)) {
    throw new Error("Send player did not return a direct file URL");
  }
  const languages = [...new Set($("video track[kind='captions'], video track[kind='subtitles']").toArray()
    .map(track => $(track).attr("label") || $(track).attr("srclang")).filter(Boolean))];
  return { url: target.href, filename, subtitles: languages.length > 1 ? "Multiple" : languages[0], headers: { Referer: url } };
}
