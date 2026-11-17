import { load } from "cheerio";

type PageReader = (url: string, options?: RequestInit) => Promise<{ text: string; redirect?: string }>;
const HOSTS = new Set(["ouo.io", "ouo.press"]);
const NAVIGATION_HEADERS = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-GB,en-US;q=0.9,en;q=0.8", "Cache-Control": "max-age=0",
  Referer: "http://www.google.com/ig/adde?moduleurl=", "Upgrade-Insecure-Requests": "1"
};

function ouoHeaders(url: string) {
  return { ...NAVIGATION_HEADERS, authority: new URL(url).hostname,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7" };
}

async function verificationToken(read: PageReader): Promise<string> {
  // Public OUO bootstrap parameters, verified against its live form endpoint.
  const parameters = new URLSearchParams({ ar: "1", k: "6Lcr1ncUAAAAAH3cghg6cOTPGARa8adOf-y9zv2x",
    co: Buffer.from("https://ouo.press:443").toString("base64"), hl: "en", v: "pCoGBhjs9s8EhFOHJFe8cqis", size: "invisible", cb: "mist" });
  const anchor = await read(`https://www.google.com/recaptcha/api2/anchor?${parameters}`, { headers: NAVIGATION_HEADERS });
  const bootstrap = load(anchor.text)("#recaptcha-token").attr("value");
  if (!bootstrap) throw new Error("OUO verification bootstrap missing");
  const body = new URLSearchParams({ v: parameters.get("v")!, reason: "q", c: bootstrap,
    k: parameters.get("k")!, co: parameters.get("co")! });
  const response = await read(`https://www.google.com/recaptcha/api2/reload?k=${parameters.get("k")}`, { method: "POST",
    headers: { ...NAVIGATION_HEADERS, "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() });
  const token = response.text.match(/"rresp"\s*,\s*"([^"]+)"/)?.[1];
  if (!token) throw new Error("OUO verification token missing");
  return token;
}

function destination(input: string, base: string): string {
  const url = new URL(input, base);
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw new Error("Invalid OUO destination");
  return url.href;
}

export async function resolveOuo(input: string, read: PageReader): Promise<string> {
  const url = new URL(input);
  if (!HOSTS.has(url.hostname) || url.protocol !== "https:" || url.username || url.password || url.port) throw new Error("Invalid OUO link");
  // Both public domains use the same form backend.
  url.hostname = "ouo.io";
  let current = url.href;
  let page = await read(current, { headers: ouoHeaders(current) });
  let submissions = 0;
  for (let step = 0; step < 6; step++) {
    if (page.redirect) {
      const next = destination(page.redirect, current);
      if (!HOSTS.has(new URL(next).hostname)) return next;
      current = next;
      page = await read(current, { headers: ouoHeaders(current) });
      continue;
    }
    if (submissions >= 2) break;
    const $ = load(page.text), form = $("#form-captcha, #form-go, #form-shorten").first();
    const action = form.attr("action");
    if (!action || form.attr("method")?.toLowerCase() !== "post") throw new Error("OUO verification form missing");
    const target = destination(action, current);
    if (new URL(target).origin !== new URL(current).origin) throw new Error("Invalid OUO form destination");
    const body = new URLSearchParams();
    form.find("input[name]").each((_, input) => { body.set($(input).attr("name")!, $(input).attr("value") || ""); });
    // Ordinary forms need no challenge token; verification forms require a fresh token at each stage.
    if (form.attr("id") === "form-captcha" || body.has("x-token")) body.set("x-token", await verificationToken(read));
    page = await read(target, { method: "POST", headers: { ...ouoHeaders(target),
      "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() });
    submissions++;
    current = target;
  }
  throw new Error("OUO verification did not return a destination");
}
