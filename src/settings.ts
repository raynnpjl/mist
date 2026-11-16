import { STREAM_SOURCES } from "./providers.js";

export interface Settings { sources: string[]; inspectionTimeoutMs: number }

export function defaultSettings(): Settings {
  return { sources: STREAM_SOURCES.map(source => source.id), inspectionTimeoutMs: 6500 };
}

export function parseSettings(input: unknown): Settings | undefined {
  if (!input || typeof input !== "object") return;
  const { sources, inspectionTimeoutMs } = input as Settings;
  if (!Array.isArray(sources) || !sources.length || new Set(sources).size !== sources.length ||
    !sources.every(id => STREAM_SOURCES.some(source => source.id === id)) ||
    !Number.isInteger(inspectionTimeoutMs) || inspectionTimeoutMs < 1000 || inspectionTimeoutMs > 10000 || inspectionTimeoutMs % 500 !== 0) return;
  return { sources: [...sources], inspectionTimeoutMs };
}
