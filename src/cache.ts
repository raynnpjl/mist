export class Cache<T> {
  private entries = new Map<string, { expires: number; pending: Promise<T> }>();
  constructor(private limit: number) {}

  get(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(key);
    if (existing && existing.expires > Date.now()) return existing.pending;
    this.entries.delete(key);
    const entry = { expires: Date.now() + ttl, pending: Promise.resolve().then(load) };
    this.entries.set(key, entry);
    if (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
    entry.pending.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    return entry.pending;
  }
}

export class Pool {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(private limit: number) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>(resolve => this.waiting.push(resolve));
    else this.active++;
    try { return await work(); }
    finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

export async function readLimited(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error("Response exceeded size limit");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { await reader.cancel(); }
}
