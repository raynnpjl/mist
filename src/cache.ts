import { workCount } from "./loading.js";

export class Cache<T> {
  private entries = new Map<string, { expires: number; pending: Promise<T> }>();
  constructor(private limit: number) {}

  delete(key: string): void { this.entries.delete(key); }

  peek(key: string): Promise<T> | undefined {
    const entry = this.entries.get(key);
    return entry && entry.expires > Date.now() ? entry.pending : undefined;
  }

  set(key: string, value: T, ttl: number): void {
    this.entries.set(key, { expires: Date.now() + ttl, pending: Promise.resolve(value) });
    if (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
  }

  get(key: string, ttl: number | ((value: T) => number), load: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(key);
    if (existing && existing.expires > Date.now()) return existing.pending;
    this.entries.delete(key);
    const entry = { expires: Infinity, pending: Promise.resolve().then(load) };
    this.entries.set(key, entry);
    if (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
    entry.pending.then(value => {
      entry.expires = Date.now() + (typeof ttl === "number" ? ttl : ttl(value));
      if (entry.expires <= Date.now() && this.entries.get(key) === entry) this.entries.delete(key);
    }, () => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    return entry.pending;
  }
}

export class Pool {
  private active = 0;
  private waiting: { start: () => void; cancel: () => void }[] = [];
  constructor(private limit: number) {}

  async run<T>(work: () => Promise<T>, signal?: AbortSignal, priority = false): Promise<T> {
    signal?.throwIfAborted();
    if (this.active >= this.limit) await new Promise<void>((resolve, reject) => {
      const entry = {
        start: () => { signal?.removeEventListener("abort", entry.cancel); resolve(); },
        cancel: () => {
          this.waiting.splice(this.waiting.indexOf(entry), 1);
          reject(signal!.reason);
        }
      };
      if (priority) this.waiting.unshift(entry);
      else this.waiting.push(entry);
      signal?.addEventListener("abort", entry.cancel, { once: true });
    });
    else this.active++;
    try { signal?.throwIfAborted(); return await work(); }
    finally {
      const next = this.waiting.shift();
      if (next) next.start();
      else this.active--;
    }
  }
}

export async function readLimited(response: Response, limit: number): Promise<string> {
  return (await readBytes(response, limit)).toString("utf8");
}

export async function readBytes(response: Response, limit: number,
  checkPrefix?: (bytes: Buffer) => void): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      workCount("bodyBytesRead", value.length);
      size += value.length;
      if (size > limit) throw new Error("Response exceeded size limit");
      chunks.push(value);
      if (checkPrefix && size >= 64) {
        checkPrefix(Buffer.concat(chunks, 64));
        checkPrefix = undefined;
      }
    }
    const bytes = Buffer.concat(chunks);
    checkPrefix?.(bytes);
    return bytes;
  } finally { await reader.cancel(); }
}
