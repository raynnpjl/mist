# Verification

Verified on 15 November 2026 (Asia/Singapore). Source availability is a snapshot, not a guarantee for every title.

## Build and behavior

- `npm run check`: passed.
- `npm test`: 14 tests passed, including real HTTP routes/CORS, pagination, source failure isolation, movie/variety handling and persistent identities.
- `npm run build`: passed.
- Dependency installation and production image build reported zero npm vulnerabilities after the scoped transitive overrides.
- Production Docker image built successfully on Node.js 24. Its health check reported `healthy` with a custom `PORT=7100`.
- The same title ID and first episode ID remained valid after a container restart and replacement with the final image, using the same data volume.
- Temporary verification container and volume were removed. The built `mist-chinese-addon:local` image remains available.

## Live addon HTTP checks

All three catalogs returned 100 items on the first page and 100 on the second page, with no overlapping IDs between those pages.

Chinese search for **狂飙** found the 2023 series. Its detail response contained 39 episodes and its first episode returned choices from all five providers. Consecutive episode IDs resolved to different media URLs.

Movie **白夜最长时** returned movie metadata without an episode list and choices from four providers. Variety show **追星星的人第三季** returned 10 dated episodes and a direct stream choice.

The first-ranked drama, movie and variety URLs returned by the addon were inspected with FFprobe. All contained H.264 video and AAC audio. The same URLs also worked with FFmpeg's default User-Agent, without browser headers.

FFmpeg then successfully decoded two seconds of both audio and video for each of those three titles, discarding the output rather than downloading complete videos. Results are recorded under `shortDecode` in the HTTP report.

See [http-smoke.json](http-smoke.json) for concrete title/video IDs, source choices and media results. The IDs in that report belong to the local test databases; another fresh deployment generates its own IDs.

## Provider sample matrix

The final `npm run probe` sampled one Chinese drama, movie and variety entry per provider. **13 of 15** playlist/key/segment checks passed.

| Source | Drama | Movie | Variety |
| --- | --- | --- | --- |
| 红牛 | Pass | Pass | Pass |
| 天堂 | Pass | Pass | Pass |
| 暴风 | Pass | Fetch failed for 白夜最长时 | Pass |
| 量子 | HTTP 504 for 非你之物 | Pass | Pass |
| 优酷 | Pass | Pass | Pass |

An earlier probe detected H.264/AAC media in one drama from each provider, including the later-timed-out 量子 sample. These changing results demonstrate why the addon offers multiple sources and ranks reachable URLs first. The failed 暴风 movie sample did not prevent the addon from returning a working 量子 alternative for the same film.

See [live-probe.json](live-probe.json) for the final sample matrix, and [decoder-probe.json](decoder-probe.json) for the earlier per-provider FFprobe results. Failed checks are retained in the reports.

## Remaining device checks

Native Nuvio Android/Android TV and Stremio desktop installation, seeking, resume and autoplay have not been exercised on actual target devices. The browser automation host was unavailable for a visual inspection of the installation page; its HTTP response was verified.

Public HTTPS hosting and a domain have not been provisioned. The local preview is `http://localhost:7000`, and the install URL is `http://localhost:7000/manifest.json`. A phone or TV needs a reachable deployment; see the repository README.

HLS accessibility and short media checks do not prove uninterrupted playback of an entire title. Upstream links, metadata, subtitles, ads and codec availability remain provider-dependent.
