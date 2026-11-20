import { neon } from "@neondatabase/serverless";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { defaultSettings, parseSettings, Settings } from "./settings.js";

export const installationId = /^[a-f0-9]{48}$/;
export const accountId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export interface Account { id: string; installation: string; configured: boolean }
export interface Installation { apiKey: string; settings: Settings; revision: string }
export type AccountQuery = (text: string, parameters?: unknown[]) => Promise<Record<string, unknown>[]>;

export class Accounts {
  private key: Buffer;

  constructor(private query: AccountQuery, encryptionKey: string) {
    if (!/^[a-f0-9]{64}$/i.test(encryptionKey)) throw new Error("MIST_ENCRYPTION_KEY must contain 64 hexadecimal characters (32 bytes)");
    this.key = Buffer.from(encryptionKey, "hex");
  }

  static async open(env: NodeJS.ProcessEnv = process.env): Promise<Accounts> {
    const connection = env.DATABASE_URL?.trim();
    if (!connection) throw new Error("Missing DATABASE_URL. Set the Neon connection string on the server.");
    let endpoint: URL;
    try { endpoint = new URL(connection); }
    catch { throw new Error("DATABASE_URL must be a PostgreSQL connection string"); }
    if (!["postgres:", "postgresql:"].includes(endpoint.protocol) || !endpoint.hostname || !endpoint.username || endpoint.pathname.length < 2) {
      throw new Error("DATABASE_URL must be a PostgreSQL connection string");
    }
    const sql = neon(connection);
    return new Accounts((text, parameters) => sql.query(text, parameters, {
      fetchOptions: { signal: AbortSignal.timeout(8000) }
    }), env.MIST_ENCRYPTION_KEY?.trim() || "");
  }

  private async request(text: string, parameters: unknown[] = []): Promise<Record<string, unknown>[]> {
    try { return await this.query(text, parameters); }
    catch { throw new Error("Neon account storage unavailable. Check DATABASE_URL and run access-key init."); }
  }

  async initialize(): Promise<void> {
    await this.request(`CREATE TABLE IF NOT EXISTS mist_accounts (
      id uuid PRIMARY KEY,
      key_hash text NOT NULL UNIQUE CHECK (key_hash ~ '^[a-f0-9]{64}$'),
      installation_id text NOT NULL UNIQUE CHECK (installation_id ~ '^[a-f0-9]{48}$'),
      credential jsonb,
      preferences jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz
    )`);
  }

  async check(): Promise<void> { await this.request("SELECT id FROM mist_accounts LIMIT 0"); }

  async createAccessKey(): Promise<{ id: string; accessKey: string }> {
    const id = randomUUID(), accessKey = randomBytes(32).toString("hex");
    const hash = createHash("sha256").update(accessKey).digest("hex");
    await this.request(`INSERT INTO mist_accounts (id, key_hash, installation_id, preferences)
      VALUES ($1, $2, $3, $4::jsonb)`, [id, hash, randomBytes(24).toString("hex"), JSON.stringify(defaultSettings())]);
    return { id, accessKey };
  }

  async listAccessKeys(): Promise<Record<string, unknown>[]> {
    return this.request("SELECT id, created_at, revoked_at FROM mist_accounts ORDER BY created_at, id");
  }

  async revokeAccessKey(id: string): Promise<boolean> {
    if (!accountId.test(id)) throw new Error("Invalid account ID");
    return (await this.request("UPDATE mist_accounts SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id", [id])).length > 0;
  }

  private account(row?: Record<string, unknown>): Account | undefined {
    if (!row) return;
    return { id: String(row.id), installation: String(row.installation_id), configured: row.configured === true };
  }

  async authenticate(accessKey: string): Promise<Account | undefined> {
    if (!/^[a-f0-9]{64}$/.test(accessKey)) return;
    const hash = createHash("sha256").update(accessKey).digest("hex");
    return this.account((await this.request(`SELECT id, installation_id, credential IS NOT NULL AS configured
      FROM mist_accounts WHERE key_hash = $1 AND revoked_at IS NULL`, [hash]))[0]);
  }

  async accountForSession(id: string): Promise<Account | undefined> {
    if (!accountId.test(id)) return;
    return this.account((await this.request(`SELECT id, installation_id, credential IS NOT NULL AS configured
      FROM mist_accounts WHERE id = $1 AND revoked_at IS NULL`, [id]))[0]);
  }

  async get(id: string): Promise<Installation | undefined> {
    if (!installationId.test(id)) return;
    const row = (await this.request("SELECT credential, preferences FROM mist_accounts WHERE installation_id = $1 AND revoked_at IS NULL", [id]))[0];
    if (!row || row.credential === null) return;
    const data = row.credential as { iv: string; tag: string; ciphertext: string };
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(data.iv, "hex"), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(id));
    decipher.setAuthTag(Buffer.from(data.tag, "hex"));
    const apiKey = Buffer.concat([decipher.update(Buffer.from(data.ciphertext, "hex")), decipher.final()]).toString("utf8");
    const settings = parseSettings(row.preferences);
    if (!settings) throw new Error("Invalid account preferences");
    return { apiKey, settings, revision: createHash("sha256").update(JSON.stringify([data, row.preferences])).digest("hex") };
  }

  async save(apiKey: string, id: string): Promise<string> {
    if (!installationId.test(id)) throw new Error("Invalid installation ID");
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(id));
    const ciphertext = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
    const credential = JSON.stringify({ iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ciphertext: ciphertext.toString("hex") });
    const rows = await this.request("UPDATE mist_accounts SET credential = $1::jsonb WHERE installation_id = $2 AND revoked_at IS NULL RETURNING id", [credential, id]);
    if (!rows.length) throw new Error("Account unavailable");
    return id;
  }

  async saveSettings(id: string, settings: Settings): Promise<void> {
    const parsed = parseSettings(settings);
    if (!installationId.test(id) || !parsed) throw new Error("Invalid installation preferences");
    const rows = await this.request("UPDATE mist_accounts SET preferences = $1::jsonb WHERE installation_id = $2 AND revoked_at IS NULL RETURNING id", [JSON.stringify(parsed), id]);
    if (!rows.length) throw new Error("Account unavailable");
  }
}
