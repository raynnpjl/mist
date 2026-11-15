import type { Stream } from "stremio-addon-sdk";

// DefinitelyTyped's SDK 1.x declarations omit the current bingeGroup hint.
export type DirectStream = Omit<Stream, "behaviorHints"> & {
  url: string;
  description: string;
  behaviorHints: { notWebReady: boolean; bingeGroup: string; filename: string };
};
