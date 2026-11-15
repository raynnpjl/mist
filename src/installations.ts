import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readLimited } from "./cache.js";
import { defaultSettings, parseSettings, Settings } from "./settings.js";

export const installationId = /^[a-f0-9]{48}$/;
export interface Installation { apiKey: string; settings: Settings; revision: string }

export class Installations {
  private constructor(private url: string, private token: string, private key: Buffer, private fetcher: typeof fetch) {}

  static async open(env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch): Promise<Installations> {
    const values = ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "MIST_ENCRYPTION_KEY"].map(name => {
      const value = env[name]?.trim();
      if (!value) throw new Error(`Missing ${name}. Set it in .env or the server environment.`);
      return value;
    });
    const [url, token, key] = values;
    let endpoint: URL;
    try { endpoint = new URL(url); }
    catch { throw new Error("UPSTASH_REDIS_REST_URL must be a valid HTTPS URL"); }
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash || endpoint.search || endpoint.pathname !== "/") {
      throw new Error("UPSTASH_REDIS_REST_URL must be a valid HTTPS database URL");
    }
    if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error("MIST_ENCRYPTION_KEY must contain 64 hexadecimal characters (32 bytes)");
    return new Installations(url, token, Buffer.from(key, "hex"), fetcher);
  }

  private async request(command: string[]): Promise<unknown> {
    const response = await this.fetcher(this.url, { method: "POST", headers: {
      Authorization: `Bearer ${this.token}`, "Content-Type": "application/json"
    }, body: JSON.stringify(command), signal: AbortSignal.timeout(8000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Redis storage HTTP ${response.status}`); }
    const data = JSON.parse(await readLimited(response, 16 * 1024));
    if (!data || data.error || !("result" in data)) throw new Error("Redis storage command failed");
    return data.result;
  }

  async get(id: string): Promise<Installation | undefined> {
    if (!installationId.test(id)) return;
    const record = await this.request(["HMGET", `mist:installation:${id}`, "credential", "preferences"]);
    if (!Array.isArray(record) || record.length !== 2 || !record.every(field => field === null || typeof field === "string")) {
      throw new Error("Invalid Redis installation response");
    }
    const [credential, preferences] = record as (string | null)[];
    if (credential === null) return;
    const data = JSON.parse(credential);
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(data.iv, "hex"), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(id));
    decipher.setAuthTag(Buffer.from(data.tag, "hex"));
    const apiKey = Buffer.concat([decipher.update(Buffer.from(data.ciphertext, "hex")), decipher.final()]).toString("utf8");
    const settings = preferences === null ? defaultSettings() : parseSettings(JSON.parse(preferences));
    if (!settings) throw new Error("Invalid installation preferences");
    return { apiKey, settings, revision: createHash("sha256").update(JSON.stringify(record)).digest("hex") };
  }

  async save(apiKey: string, id = randomBytes(24).toString("hex")): Promise<string> {
    if (!installationId.test(id)) throw new Error("Invalid installation ID");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(id));
    const ciphertext = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
    const data = JSON.stringify({ iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ciphertext: ciphertext.toString("hex") });
    await this.request(["HSET", `mist:installation:${id}`, "credential", data]);
    return id;
  }

  async saveSettings(id: string, settings: Settings): Promise<void> {
    if (!installationId.test(id) || !parseSettings(settings)) throw new Error("Invalid installation preferences");
    await this.request(["HSET", `mist:installation:${id}`, "preferences", JSON.stringify(settings)]);
  }
}
