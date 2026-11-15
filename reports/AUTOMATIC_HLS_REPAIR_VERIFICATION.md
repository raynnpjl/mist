# Automatic HLS repair across all five providers

Verified locally on 2026-11-15 (Asia/Singapore). Changes are not deployed.

The previous repair matched only the exact S01E18 source. The newly supplied
`22074_9bc7a87a` source is 今天是太阳雨 S01E19, confirmed against the configured
provider listing. Its ads use the same independent clock as S01E18.

## Playback behavior

All five providers' HLS stream choices now use signed, installation-bound playlist URLs.
Each request fetches the current upstream playlist. Master variants and alternate
playlists use the same route; media segments, keys and initialization files remain
direct CDN URLs. The signing key is the existing `MIST_ENCRYPTION_KEY`, so links
work across instances without storing a playlist snapshot.

Explicit removal recognizes the exact `# ppvod-ad-injected v1` marker or complete
`/video/adjump/time/` segment blocks, bounded by discontinuities, with positive
durations and a separate media directory. A malformed block containing program
segments is retained.

For unlabelled blocks of at most 120 seconds, automatic detection probes the
preceding program segment, first and last inserted segments, and resumed program
segment. Removal requires an inserted clock starting between 0 and 2 seconds,
an inserted clock span matching its EXTINF duration within 0.1 seconds, an inserted
clock ending before the preceding program clock, and resumed program time within
0.1 seconds of the preceding program end. This detects independent inserted clips,
not advertisements by their visual content.

Probe work is shared per segment URL within one request, limited to four concurrent
tasks, and bounded by the remaining eight-second playlist budget. Each probe fetches
at most 4 MiB through Node.js and passes bytes to FFprobe over stdin. Live testing
caught direct remote FFprobe exceeding the budget; bounded Node downloads plus local
probing verified the same clocks successfully. Failed, oversized or unavailable
probes retain the unverified block. Encrypted, live and other stateful playlists are
preserved without clock probes.

If an upstream request fails or returns an unreadable playlist, the route issues
a non-cacheable HTTP 307 to the original URL. This preserves direct playback but
cannot repair ads when the CDN rejects Mist's requests.

## Real-source results

The configured provider APIs supplied 今天是太阳雨 S01E19 streams for every provider;
no additional links or manual ad timestamps were needed. All five were then tested
through the shared local HTTP stream and playback routes:

| Provider | Original segments | Retained segments | Removed segments | Seconds removed | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| 红牛 | 474 | 474 | 0 | 0 | Encrypted playlist preserved, including key URI and IV |
| 天堂 | 699 | 690 | 9 | 34.83 | Two unlabelled inserted clips detected from packet clocks |
| 暴风 | 937 | 919 | 18 | 51.52 | Two explicit adjump blocks removed |
| 量子 | 704 | 690 | 14 | 51.52 | Two marked ppvod blocks removed |
| 优酷 | 919 | 919 | 0 | 0 | No discontinuity blocks; playlist retained |

Every retained program URI and EXTINF duration matched the original source. No
provider or episode-specific ad clip blacklist is used. MP4 choices remain direct.
红牛 initially timed out, then recovered and returned HTTP 200 through the new
route; temporary rejection still uses the tested HTTP 307 behavior.

天堂's original first break jumped from video DTS 298.60 s to 1.40 s, then resumed
at 298.64 s; its second resumed at 1500.52 s after 1500.48 s. 暴风 resumed at
301.663 s after 301.623 s, and 2402.983 s after 2402.943 s. All four program joins
remain continuous after removing the inserted clips.

FFmpeg sought through the full HTTP playback route at 296 s and 1497 s for 天堂,
and 298 s and 2399 s for 暴风. All four checks decoded 124 video frames and five
seconds of audio/video across a repaired join. The initial 天堂 playlist inspection
took 4.647 seconds in this local test; this is an observation, not a production
latency guarantee. Clock verification repeats for each playback request.

### Original 量子 regression

Both sources were fetched by Node.js through the new local HTTP stream and
playlist routes. Every retained segment URL and EXTINF duration was compared
with the live upstream program records, including consecutive segment numbers.

| Episode | Original segments | Retained program segments | Ad segments removed | Seconds removed | Repaired duration |
| --- | ---: | ---: | ---: | ---: | ---: |
| S01E18 (`22075_2c9a8bdc`) | 697 | 683 | 14 | 51.52 | 2730.64 s |
| S01E19 (`22074_9bc7a87a`) | 704 | 690 | 14 | 51.52 | 2759.08 s |

No program URL or duration changed. Both marked ad blocks disappeared from each
repaired playlist. No episode-specific source mapping remains in production code.

FFprobe measured the following video DTS values around the original ads:

| Episode / break | Last program packet | First ad packet | First resumed program packet |
| --- | ---: | ---: | ---: |
| S01E18 / first | 305.08 s | 1.40 s | 305.12 s |
| S01E18 / second | 1984.76 s | 1.40 s | 1984.80 s |
| S01E19 / first | 302.60 s | 1.40 s | 302.64 s |
| S01E19 / second | 1983.80 s | 1.40 s | 1983.84 s |

After removing ads, each sampled program join advances by 0.04 seconds without
a backward clock jump. FFmpeg opened the complete HTTP playback route, sought
to 302 s and 1981 s for S01E18, and 300 s and 1980 s for S01E19. Each check decoded
124 video frames and five seconds of audio/video across the repaired join.

## Automated checks

- Regression first failed because S01E19 bypassed repair and returned the CDN URL.
- All 58 tests pass, including all-five-provider routing and CDN redirects,
  explicit and unlabelled ad detection, false-positive guards, malformed blocks,
  protected playlists, probe sharing/concurrency/deadlines, fresh upstream content,
  direct segment URLs, and signature rejection for tampering or another installation.
- `npm run check` and `npm run build` pass.
- `git diff --check` passes.

## Remaining verification

Nuvio's internal player UI has not been exercised on the user's device. Playlist
and decoder checks establish removal of the observed clock-reset trigger, not a
general repair of Nuvio's controls. Production CDN access must be checked after
deployment because local access does not establish access from Vercel.

After deployment, manually select the Mist provider from the episode's Sources to replace
cached stream links. The old `/repairs/` snapshot route is no longer served.
Unverifiable, encrypted or baked-in ads are outside this repair.
