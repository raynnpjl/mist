import { resolve } from "node:path";

// Verified snapshot for 今天是太阳雨 S01E18; no upstream fetch is needed at playback.
export const liangziEpisode18 = {
  source: "https://v.lzcdn27.com/20261115/22075_2c9a8bdc/index.m3u8",
  mediaPath: "2000k/hls/index.m3u8",
  route: "/repairs/liangzi-tt36982492-s01e18.m3u8",
  file: resolve(__dirname, "../playlists/liangzi-tt36982492-s01e18.m3u8")
};
