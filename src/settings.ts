import { STREAM_SOURCES } from "./providers.js";
import { RESOLUTIONS, Resolution } from "./resolutions.js";
export { RESOLUTIONS, Resolution } from "./resolutions.js";

export interface Settings { sources: string[]; sourceOrder: string[]; inspectionTimeoutMs: number; resolutions: Resolution[] }

export function defaultSettings(): Settings {
  return { sources: STREAM_SOURCES.map(source => source.id), sourceOrder: STREAM_SOURCES.map(source => source.id),
    inspectionTimeoutMs: 6500, resolutions: [...RESOLUTIONS] };
}

export function parseSettings(input: unknown): Settings | undefined {
  if (!input || typeof input !== "object") return;
  const { sources, sourceOrder, inspectionTimeoutMs, resolutions = RESOLUTIONS } = input as Settings;
  const order = sourceOrder === undefined && Array.isArray(sources)
    ? [...sources, ...STREAM_SOURCES.map(source => source.id).filter(id => !sources.includes(id))] : sourceOrder;
  if (!Array.isArray(sources) || !sources.length || new Set(sources).size !== sources.length ||
    !sources.every(id => STREAM_SOURCES.some(source => source.id === id)) ||
    !Array.isArray(order) || order.length !== STREAM_SOURCES.length || new Set(order).size !== order.length ||
    !order.every(id => STREAM_SOURCES.some(source => source.id === id)) ||
    !Number.isInteger(inspectionTimeoutMs) || inspectionTimeoutMs < 1000 || inspectionTimeoutMs > 10000 || inspectionTimeoutMs % 500 !== 0 ||
    !Array.isArray(resolutions) || !resolutions.length || new Set(resolutions).size !== resolutions.length ||
    !resolutions.every(resolution => RESOLUTIONS.includes(resolution))) return;
  return { sources: [...sources], sourceOrder: [...order], inspectionTimeoutMs, resolutions: [...resolutions] };
}
