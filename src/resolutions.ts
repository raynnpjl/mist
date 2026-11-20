export type Resolution = 360 | 480 | 720 | 1080 | 2160 | "unknown";
export const RESOLUTIONS: Resolution[] = [360, 480, 720, 1080, 2160, "unknown"];

export function resolutionFor(height?: number): Resolution | undefined {
  return height ? RESOLUTIONS.find(value => typeof value === "number" && height <= value) : "unknown";
}
