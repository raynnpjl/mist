import { AsyncLocalStorage } from "node:async_hooks";

interface Stage { calls: number; errors: number; ms: number }
interface Metrics { counters: Record<string, number>; stages: Record<string, Stage> }
const context = new AsyncLocalStorage<Metrics>();
const windows = { "source-loading": [] as number[], "playback-playlist": [] as number[] };
let work: Metrics = { counters: {}, stages: {} };
const depths: Record<string, number> = {};
let peaks: Record<string, number> = {};

export function workCount(name: string, amount = 1): void {
  count(name, amount);
  work.counters[name] = (work.counters[name] || 0) + amount;
}

export function workDuration(name: string, ms: number, failed = false): void {
  duration(name, ms, failed);
  const stage = work.stages[name] ||= { calls: 0, errors: 0, ms: 0 };
  stage.calls++;
  stage.errors += Number(failed);
  stage.ms = rounded(stage.ms + ms);
}

export function workDepth(name: string, depth: number): void {
  depths[name] = depth;
  peaks[name] = Math.max(peaks[name] || 0, depth);
}

export function takeProbeMetrics() {
  const report = { ...work, depths: { ...depths }, peaks };
  work = { counters: {}, stages: {} };
  peaks = { ...depths };
  return report;
}
const rounded = (value: number) => Math.round(value * 100) / 100;

export function count(name: string, amount = 1): void {
  const metrics = context.getStore();
  if (metrics) metrics.counters[name] = (metrics.counters[name] || 0) + amount;
}

export function duration(name: string, ms: number, failed = false): void {
  const metrics = context.getStore();
  if (!metrics) return;
  const stage = metrics.stages[name] ||= { calls: 0, errors: 0, ms: 0 };
  stage.calls++;
  stage.errors += Number(failed);
  stage.ms = rounded(stage.ms + ms);
}

export async function timed<T>(name: string, work: () => Promise<T>): Promise<T> {
  if (!context.getStore()) return work();
  const started = performance.now();
  let failed = true;
  try { const value = await work(); failed = false; return value; }
  finally { duration(name, performance.now() - started, failed); }
}

export function observeLoading<T>(work: () => Promise<T>, kind: keyof typeof windows = "source-loading"): Promise<T> {
  const recent = windows[kind];
  return context.run({ counters: {}, stages: {} }, async () => {
    const metrics = context.getStore()!;
    const started = performance.now();
    let outcome = "error";
    try { const value = await work(); outcome = "ok"; return value; }
    finally {
      const ms = performance.now() - started;
      recent.push(ms);
      if (recent.length > 256) recent.shift();
      const sorted = [...recent].sort((a, b) => a - b);
      console.info(JSON.stringify({ event: `mist.${kind}`, outcome, ms: rounded(ms), ...metrics,
        window: { samples: sorted.length, p50Ms: rounded(sorted[Math.ceil(sorted.length * 0.5) - 1]),
          p95Ms: rounded(sorted[Math.ceil(sorted.length * 0.95) - 1]) } }));
    }
  });
}
