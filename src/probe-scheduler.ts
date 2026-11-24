import { spawn } from "node:child_process";
import { workCount, workDepth, workDuration } from "./loading.js";
import { CACHE_BYTES } from "./shared-jobs.js";

interface ProbeOptions {
  timeoutMs: number;
  priority?: "playback";
  signal?: AbortSignal;
  input?: Buffer;
  maxOutput?: number;
  env?: NodeJS.ProcessEnv;
}

export class ProbeError extends Error {
  constructor(readonly reason: "queue-full" | "queue-timeout" | "timeout" | "cancelled" | "process-error" | "output-limit") {
    super(`FFprobe ${reason}`);
  }
  get killed(): boolean { return this.reason === "timeout" || this.reason === "output-limit"; }
}

interface QueuedProbe { playback: boolean; start: () => void }

export class ProbeScheduler {
  private queue: QueuedProbe[] = [];
  private running = 0;
  private playbackStreak = 0;

  constructor(private limit = 2, private queueLimit = 32, private command = "ffprobe", private queueTimeoutMs = 30_000) {}

  run(args: string[], options: ProbeOptions): Promise<string> {
    if (options.signal?.aborted) return Promise.reject(new ProbeError(
      options.signal.reason?.name === "TimeoutError" ? "queue-timeout" : "cancelled"));
    if (this.running >= this.limit && this.queue.length >= this.queueLimit) {
      workCount("ffprobe.queueFull");
      return Promise.reject(new ProbeError("queue-full"));
    }
    const queuedAt = performance.now();
    return new Promise<string>((resolve, reject) => {
      const cancel = (reason: "queue-timeout" | "cancelled") => {
        const index = this.queue.indexOf(entry);
        if (index === -1) return;
        this.queue.splice(index, 1);
        cleanup();
        workDepth("ffprobe.queued", this.queue.length);
        workCount(`ffprobe.${reason}`);
        workDuration("ffprobe.queue", performance.now() - queuedAt, true);
        reject(new ProbeError(reason));
      };
      const abort = () => cancel(options.signal?.reason?.name === "TimeoutError" ? "queue-timeout" : "cancelled");
      const timer = setTimeout(() => cancel("queue-timeout"), this.queueTimeoutMs);
      timer.unref();
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
      };
      const entry = { playback: options.priority === "playback", start: () => {
        cleanup();
        workDuration("ffprobe.queue", performance.now() - queuedAt);
        this.running++;
        workDepth("ffprobe.running", this.running);
        this.execute(args, options).finally(() => {
          this.running--;
          workDepth("ffprobe.running", this.running);
          this.drain();
        }).then(resolve, reject);
      } };
      options.signal?.addEventListener("abort", abort, { once: true });
      this.queue.push(entry);
      this.drain();
      workDepth("ffprobe.queued", this.queue.length);
    });
  }

  private drain(): void {
    if (this.running >= this.limit || !this.queue.length) return;
    const preferred = this.queue.findIndex(entry => entry.playback === (this.playbackStreak < 3));
    const [entry] = this.queue.splice(preferred < 0 ? 0 : preferred, 1);
    this.playbackStreak = entry.playback ? Math.min(3, this.playbackStreak + 1) : 0;
    workDepth("ffprobe.queued", this.queue.length);
    entry.start();
  }

  private execute(args: string[], options: ProbeOptions): Promise<string> {
    const started = performance.now();
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, args, { env: options.env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
      const chunks: Buffer[] = [];
      let error: ProbeError | undefined, bytes = 0;
      const stop = (reason: ProbeError["reason"]) => {
        error ??= new ProbeError(reason);
        child.kill("SIGKILL");
      };
      const abort = () => stop(options.signal?.reason?.name === "TimeoutError" ? "timeout" : "cancelled");
      const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
      options.signal?.addEventListener("abort", abort, { once: true });
      child.once("spawn", () => workCount("ffprobe.calls"));
      child.once("error", () => { error ??= new ProbeError("process-error"); });
      child.stdin.on("error", () => { /* A child can finish before reading stdin. */ });
      child.stdin.end(options.input);
      child.stdout.on("data", (chunk: Buffer) => {
        if (error) return;
        bytes += chunk.length;
        if (bytes > (options.maxOutput ?? 256 * 1024)) stop("output-limit");
        else chunks.push(chunk);
      });
      child.once("close", code => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (code !== 0) error ??= new ProbeError("process-error");
        workDuration("ffprobe.execution", performance.now() - started, Boolean(error));
        if (error) { workCount(`ffprobe.${error.reason}`); reject(error); }
        else resolve(Buffer.concat(chunks, bytes).toString("utf8"));
      });
    });
  }
}

// The server supplies its configured instance. Standalone callers share a lazy default.
let standaloneScheduler: ProbeScheduler | undefined;
export function standaloneProbeScheduler(): ProbeScheduler {
  return standaloneScheduler ??= new ProbeScheduler();
}

export function probeConfig(env: NodeJS.ProcessEnv) {
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const raw = env[key];
    const n = raw === undefined ? fallback : Number(raw);
    if ((raw !== undefined && !/^\d+$/.test(raw)) || !Number.isInteger(n) || n < min || n > max) {
      throw new Error(`${key} must be an integer between ${min} and ${max}`);
    }
    return n;
  };
  return {
    processes: integer("MIST_FFPROBE_PROCESSES", 2, 1, 16),
    queued: integer("MIST_FFPROBE_QUEUE", 32, 0, 256),
    analysisTtlMs: integer("MIST_HLS_ANALYSIS_TTL_MS", 30_000, 0, 30_000),
    cacheBytes: integer("MIST_MEDIA_CACHE_MIB", CACHE_BYTES / 1024 ** 2, 1, 256) * 1024 ** 2
  };
}
