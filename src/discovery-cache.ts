import { createHash } from "node:crypto";
import { Cache, readLimited } from "./cache.js";
import type { Fetcher } from "./providers.js";
import { timed } from "./loading.js";

const MAX_BYTES = 64 * 1024;
interface Record<T> { expires: number; value: T }

// Deliberately separate from installation storage: every operation is optional and expiring.
export class DiscoveryStore {
  private endpoint?: string;
  private token?: string;
  constructor(env: NodeJS.ProcessEnv = process.env, private fetcher: Fetcher = fetch) {
    try {
      const url = new URL(env.UPSTASH_REDIS_REST_URL || "");
      const token = env.UPSTASH_REDIS_REST_TOKEN?.trim();
      if (url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/" && token) {
        this.endpoint = url.href; this.token = token;
      }
    } catch { /* An unconfigured discovery cache still allows uncached discovery. */ }
  }

  private async command(command: string[], signal?: AbortSignal): Promise<unknown> {
    if (!this.endpoint) return;
    try {
      const timeout = AbortSignal.timeout(750);
      const response = await timed("redis.http", () => this.fetcher(this.endpoint!, { method: "POST", headers: {
        Authorization: `Bearer ${this.token}`, "Content-Type": "application/json"
      }, body: JSON.stringify(command), signal: signal ? AbortSignal.any([signal, timeout]) : timeout }));
      if (!response.ok) { await response.body?.cancel(); return; }
      const data = JSON.parse(await readLimited(response, MAX_BYTES * 2 + 1024));
      if (data && !data.error) return data.result;
    } catch { /* Redis is an optimization, never a discovery dependency. */ }
  }

  async read<T>(key: string, valid: (value: unknown) => value is T, signal?: AbortSignal): Promise<Record<T> | undefined> {
    const raw = await this.command(["GET", key], signal);
    if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_BYTES) return;
    try {
      const entry = JSON.parse(raw);
      if (Number.isSafeInteger(entry?.expires) && entry.expires > Date.now() && valid(entry.value)) return entry;
    } catch { /* Malformed records are misses. */ }
  }

  async write<T>(key: string, entry: Record<T>, signal?: AbortSignal): Promise<void> {
    const raw = JSON.stringify(entry), seconds = Math.floor((entry.expires - Date.now()) / 1000);
    if (seconds > 0 && Buffer.byteLength(raw) <= MAX_BYTES) await this.command(["SET", key, raw, "EX", String(seconds)], signal);
  }

  async delete(key: string, signal?: AbortSignal): Promise<void> { await this.command(["DEL", key], signal); }
}

export class DiscoveryCache<T> {
  private memory: Cache<Record<T>>;
  constructor(private namespace: string, limit: number, private valid: (value: unknown) => value is T,
    private store = new DiscoveryStore()) { this.memory = new Cache(limit); }

  async get(key: string, ttl: number | ((value: T) => number), load: () => Promise<T>,
    signal?: AbortSignal, refresh = false): Promise<T> {
    const id = `mist:discovery:v1:${this.namespace}:${createHash("sha256").update(key).digest("hex")}`;
    if (refresh) this.memory.delete(id);
    const entry = await this.memory.get(id, record => Math.max(0, record.expires - Date.now()), async () => {
      if (refresh) await this.store.delete(id, signal);
      else {
        const shared = await this.store.read(id, this.valid, signal);
        if (shared) return shared;
      }
      signal?.throwIfAborted();
      const value = await load();
      const lifetime = typeof ttl === "number" ? ttl : ttl(value);
      const record = { value, expires: Date.now() + lifetime };
      if (!this.valid(value) || Buffer.byteLength(JSON.stringify(record)) > MAX_BYTES) record.expires = Date.now();
      else if (lifetime > 0) await this.store.write(id, record, signal);
      return record;
    });
    return entry.value;
  }
}
