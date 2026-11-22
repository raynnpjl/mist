import { STREAM_SOURCES } from "./providers.js";
import { RESOLUTIONS, Resolution } from "./resolutions.js";
export { RESOLUTIONS, Resolution } from "./resolutions.js";

export interface Settings { sources: string[]; sourceOrder: string[]; inspectionTimeoutMs: number; resolutions: Resolution[];
  resolutionFirst: boolean; includeEpisodeExtras: boolean }

export function defaultSettings(): Settings {
  return { sources: STREAM_SOURCES.map(source => source.id), sourceOrder: STREAM_SOURCES.map(source => source.id),
    inspectionTimeoutMs: 6500, resolutions: [...RESOLUTIONS], resolutionFirst: false, includeEpisodeExtras: false };
}

export function parseSettings(input: unknown, scope: "submitted" | "stored" = "submitted"): Settings | undefined {
  if (!input || typeof input !== "object") return;
  const ids = STREAM_SOURCES.map(source => source.id);
  const validSource = (id: unknown): id is string => typeof id === "string" && /^[a-z][a-z0-9_-]*$/.test(id) &&
    (scope === "stored" || ids.includes(id));
  const { sources, sourceOrder, inspectionTimeoutMs, resolutions = RESOLUTIONS,
    resolutionFirst = false, includeEpisodeExtras = false } = input as Settings;
  const order = sourceOrder === undefined && Array.isArray(sources)
    ? [...sources, ...STREAM_SOURCES.map(source => source.id).filter(id => !sources.includes(id))] : sourceOrder;
  if (!Array.isArray(sources) || !sources.length || new Set(sources).size !== sources.length ||
    !sources.every(validSource) ||
    !Array.isArray(order) || !order.length || new Set(order).size !== order.length ||
    !order.every(validSource) ||
    !Number.isInteger(inspectionTimeoutMs) || inspectionTimeoutMs < 1000 || inspectionTimeoutMs > 10000 || inspectionTimeoutMs % 500 !== 0 ||
    !Array.isArray(resolutions) || !resolutions.length || new Set(resolutions).size !== resolutions.length ||
    !resolutions.every(resolution => RESOLUTIONS.includes(resolution)) || typeof resolutionFirst !== "boolean" ||
    typeof includeEpisodeExtras !== "boolean") return;
  const currentOrder = order.filter(id => ids.includes(id));
  return { sources: sources.filter(id => ids.includes(id)), sourceOrder: [...currentOrder, ...ids.filter(id => !currentOrder.includes(id))],
    inspectionTimeoutMs, resolutions: [...resolutions], resolutionFirst, includeEpisodeExtras };
}
