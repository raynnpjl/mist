import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function haveMediaTools() {
  return ["ffmpeg", "ffprobe"].every(command => spawnSync(command, ["-version"], { stdio: "ignore", timeout: 2000 }).status === 0);
}

export function makeMediaFixtures(directory: string) {
  function render(filename: string, size: string, audio: string | undefined, options: string[], video = `color=c=blue:s=${size}:r=10`) {
    execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", video,
      ...(audio ? ["-f", "lavfi", "-i", `anullsrc=r=48000:cl=${audio}`] : []),
      "-t", "1", "-c:v", "libx264", "-bf", "0", "-g", "10", "-threads", "1",
      ...(audio ? ["-c:a", "aac"] : []), ...options, filename], { cwd: directory, timeout: 10_000 });
  }
  render("cropped.ts", "318x238", "stereo", ["-f", "mpegts"]);
  render("other.ts", "398x298", "stereo", ["-f", "mpegts"]);
  render("mono.ts", "318x238", "mono", ["-f", "mpegts"]);
  render("dense.ts", "1280x720", "stereo", ["-preset", "ultrafast", "-f", "mpegts"], "testsrc2=size=1280x720:rate=10");
  render("direct.mp4", "318x238", "stereo", ["-movflags", "+faststart"]);
  render("fragmented.m3u8", "318x238", "stereo", ["-f", "hls", "-hls_time", "1", "-hls_segment_type", "fmp4"]);
  const playlist = (segment: string) => `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n${segment}\n#EXT-X-ENDLIST\n`;
  writeFileSync(join(directory, "captions.vtt"), "WEBVTT\n\n00:00:00.000 --> 00:00:00.800\nEnglish fixture caption\n");
  writeFileSync(join(directory, "captions.m3u8"), playlist("captions.vtt"));
  writeFileSync(join(directory, "caption-video.m3u8"), playlist("cropped.ts"));
  writeFileSync(join(directory, "dense.m3u8"), playlist("dense.ts"));
  writeFileSync(join(directory, "caption-master.m3u8"), "#EXTM3U\n" +
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",AUTOSELECT=YES,DEFAULT=YES,FORCED=NO,URI="captions.m3u8"\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=260000,RESOLUTION=318x238,SUBTITLES="subs"\ncaption-video.m3u8\n');
  for (const [filename, time] of [["before.ts", "100"], ["clip.ts", "1.4"], ["after.ts", "101"]]) {
    render(filename, "64x64", undefined, ["-f", "mpegts", "-mpegts_copyts", "1", "-muxdelay", "0", "-output_ts_offset", time]);
  }
  return (filename: string) => readFileSync(join(directory, filename));
}
