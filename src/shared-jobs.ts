import { createHash } from "node:crypto";
import { workDuration, workCount } from "./loading.js";

export const identity = (...inputs: unknown[]): string =>
  createHash("sha256").update(JSON.stringify(inputs)).digest("hex");

export const requestHeaders = (headers: HeadersInit) => [...new Headers(headers)];

export class SharedJobs<T> {
  private jobs = new Map<string, { promise: Promise<T>; controller: AbortController; callers: number }>();
  constructor(private name: string, private limit: number, private onCapacity?: () => T) {}

  run(key: string, lifetimeMs: number, start: (signal: AbortSignal) => Promise<T>, caller?: AbortSignal): Promise<T> {
    if (caller?.aborted) return Promise.reject(caller.reason);
    let job = this.jobs.get(key);
    if (job?.controller.signal.aborted) {
      // Keep the slot occupied until the cancelled producer has finished cleaning up.
      const settled = job.promise.then(() => undefined, () => undefined);
      return waitFor(settled, caller).then(() => this.run(key, lifetimeMs, start, caller));
    }
    if (job) workCount(`${this.name}.joins`);
    else {
      if (this.jobs.size >= this.limit) {
        workCount(`${this.name}.overloaded`);
        return this.onCapacity ? Promise.resolve(this.onCapacity()) : Promise.reject(new Error("Shared job capacity reached"));
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new DOMException("Shared job deadline", "TimeoutError")), lifetimeMs);
      timer.unref();
      const began = performance.now();
      let failed = true;
      const promise = Promise.resolve().then(async () => {
        controller.signal.throwIfAborted();
        const result = await start(controller.signal);
        failed = false;
        return result;
      }).finally(() => {
        clearTimeout(timer);
        this.jobs.delete(key);
        if (controller.signal.aborted) workCount(`${this.name}.${controller.signal.reason?.name === "TimeoutError" ? "timeouts" : "cancelled"}`);
        workDuration(`${this.name}.execution`, performance.now() - began, failed || controller.signal.aborted);
      });
      job = { promise, controller, callers: 0 };
      this.jobs.set(key, job);
      workCount(`${this.name}.started`);
    }
    if (!caller) {
      // A caller without an abort signal waits for the job itself.
      job.callers++;
      const began = performance.now();
      const finished = (failed: boolean) => {
        job.callers--;
        workDuration(`${this.name}.callerWait`, performance.now() - began, failed);
      };
      void job.promise.then(() => finished(false), () => finished(true));
      return job.promise;
    }
    const active = job;
    active.callers++;
    const began = performance.now();
    return new Promise<T>((resolve, reject) => {
      const done = (failed: boolean) => {
        caller.removeEventListener("abort", abort);
        active.callers--;
        workDuration(`${this.name}.callerWait`, performance.now() - began, failed);
      };
      const abort = () => {
        done(true);
        workCount(`${this.name}.${caller.reason?.name === "TimeoutError" ? "callerTimeouts" : "callerCancelled"}`);
        if (!active.callers) active.controller.abort(caller.reason);
        reject(caller.reason);
      };
      caller.addEventListener("abort", abort, { once: true });
      active.promise.then(value => { if (!caller.aborted) { done(false); resolve(value); } },
        error => { if (!caller.aborted) { done(true); reject(error); } });
    });
  }
}

export function waitFor<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export const CACHE_BYTES = 64 * 1024 * 1024;

export class ResultCache<T> {
  private entries = new Map<string, { value: T; expires: number; bytes: number }>();
  private bytes = 0;
  constructor(private limit: number, private byteLimit: number) {}

  delete(key: string): void {
    const old = this.entries.get(key);
    if (old) this.bytes -= old.bytes;
    this.entries.delete(key);
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    if (entry.expires <= Date.now()) { this.bytes -= entry.bytes; return; }
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, ttl: number): void {
    this.delete(key);
    // Serialized data plus an allowance for JS objects, strings and bookkeeping.
    const bytes = 256 + 4 * (Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value)));
    if (ttl <= 0 || bytes > this.byteLimit) return;
    this.entries.set(key, { value, expires: Date.now() + ttl, bytes });
    this.bytes += bytes;
    while (this.bytes > this.byteLimit || this.entries.size > this.limit) this.delete(this.entries.keys().next().value!);
  }
}

export function urlLifetime(input: string, maximum: number): number {
  const params = new URL(input).searchParams;
  for (const [key, raw] of params) {
    if (!/^(exp|expires|expiry|expire|e)$/i.test(key)) continue;
    const expiry = Number(raw);
    if (!Number.isFinite(expiry)) return 0;
    maximum = Math.min(maximum, (expiry < 1e12 ? expiry * 1000 : expiry) - Date.now() - 5000);
  }
  for (const prefix of ["X-Amz", "X-Goog"]) {
    const date = params.get(`${prefix}-Date`), seconds = params.get(`${prefix}-Expires`);
    if (date === null && seconds === null) continue;
    const start = date?.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z");
    const expiry = Date.parse(start || "") + Number(seconds) * 1000;
    if (seconds === null || !Number.isFinite(expiry)) return 0;
    maximum = Math.min(maximum, expiry - Date.now() - 5000);
  }
  return Math.max(0, maximum);
}
