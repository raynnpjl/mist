# Media inspection and playback playlists

## Configuration

These optional environment variables are validated at startup. The limits apply to one Mist process.

| Variable | Default | Allowed values |
| --- | ---: | --- |
| `MIST_FFPROBE_PROCESSES` | 2 | 1–16 running FFprobe processes across general inspection, playback ad clocks and MKV headers |
| `MIST_FFPROBE_QUEUE` | 32 | 0–256 waiting FFprobe jobs across those paths |
| `MIST_HLS_ANALYSIS_TTL_MS` | 30000 | 0–30000 milliseconds for completed, supported VOD analysis. Zero disables completed analysis reuse. |
| `MIST_MEDIA_CACHE_MIB` | 64 | 1–256 MiB estimated completed-result budget. Half goes to VOD analysis, 3/8 to media facts and availability, and 1/8 to MKV facts. Each cache also has an entry cap. |

All FFprobe callers share the scheduler. Playback clocks get priority, with an enrichment job due after at most three consecutive playback starts when both queues have work. Queue waiting is measured separately from child execution. General inspection retains the installation's 1–10 second active budget and allows up to 30 seconds in each applicable queue. In a general inspection, time spent on the lightweight attempt comes out of the active budget. HLS playback repair and MKV headers retain their shorter end-to-end deadlines, including any FFprobe queue wait. A child is killed at its deadline and the slot is released after it closes. Network fetches have separate concurrency limits.

## Playlist and media identity

- Every playback request fetches the current upstream playlist. Simultaneous reads with the same exact upstream URL, headers and network path can share that fetch. URL query strings remain intact. Mist retains the upstream response's final redirect URL to resolve relative URIs.
- The HLS analysis key hashes the full requested URL, resolved base, raw body hash, normalized request headers, network path and analysis version. Only complete decisions are cached. Timeouts, skipped required clocks and other gaps produce failed or partial analysis. A partial analysis can apply verified removals during that response and will be retried on a subsequent read. Live and stateful playlists bypass clock analysis. Compatible in-flight segment probes share the exact segment URL and request context. Byte-range playlists bypass ad splicing.
- Where recognized URL expiry is earlier, it caps freshness with a five-second margin. Expiry checks include playlist and sampled segment redirect URLs, plus referenced media URLs. Supported forms include epoch `exp`, `expires`, `expiry`, `expire` and `e`, plus AWS and Google signed date and duration pairs. An unparseable expiry disables reuse.
- Rendering makes fresh installation-specific child playlist signatures after analysis. Segments, keys and other media assets remain provider URLs. Playback playlists and private manifests are non-cacheable. Stream listings retain a client-only 30-second cache lifetime.
- Inspection starts from the exact URL selected by discovery. The fact cache can retain codec observations for five minutes. Availability has independent reachable, unreachable and unknown states and a reachability window of at most 30 seconds. A failed inspection has a cooldown of up to five seconds for its own budget. A later reachability failure can retain prior dimensions for the same identity without retaining a successful availability state. A longer budget can fill details omitted by an otherwise successful short probe.
- HLS fact refresh compares the selected media playlist and sample identities. The identity includes the chain's exact URLs and redirect bases, the master structure and leaf playlist hash, the sample URI and range, and any observed redirect or strong ETag for the sampled resources. A changed bandwidth label updates declared bitrate independently. Direct FFprobe-only formats start with the exact probe input and network context, then validate newly observed redirect targets or ETags on refresh. Warm fMP4 checks include its required init object. Encrypted streams and streams with alternate renditions use full verification when current availability expires. MKV stable IDs can reuse completed metadata, while different signed URLs keep their pending probes and failures independent.
- Running jobs have separate bounded registries. Completed result eviction cannot evict an in-flight job. Waiters can leave independently, and aborting the last waiter cancels cooperative network and process work. The completed caches hold facts and decisions. Media bytes are released after work finishes.

## Codec headers and fallback

Inspection recognizes HLS by its playlist prefix on extensionless playback URLs, and it reuses the response to resolve the playlist chain. For supported completed HLS, Mist follows the selected media playlist, makes an up-to-64 KiB sample request, and checks MPEG-TS PAT, PMT and PES structure before reading H.264 SPS, PPS and the slice's parameter-set reference. Dimensions include SPS cropping. A single recognized video track and supported AAC-LC stereo headers can supply the dimensions, codecs and channel layout without FFprobe. [HLS container requirements](https://datatracker.ietf.org/doc/html/rfc8216#section-3.2), [H.264 parameter-set syntax](https://www.itu.int/rec/T-REC-H.264-202408-I/en).

An incomplete sample, unsupported codec or container, encryption, live/stateful playlists, multiple video variants or an alternate rendition uses FFprobe. This preserves the existing master-playlist probe and rich details. If just one standalone TS segment was sampled in full, FFprobe can read the same bytes from stdin for missing details. For fMP4, FFprobe tries first. If dimensions are missing, Mist can inspect up to 128 KiB of the selected AVC initialization segment, including an explicit byte range. Init evidence alone does not establish current playback availability. The parser leaves HEVC, multiple AVC video tracks, unverified ranges and malformed containers to fallback. MKV provider height labels remain declared evidence, and the bounded MKV probe still supplies subtitle and bitrate details.

Mist applies byte limits to the playlist, segment-clock, header and availability reads it controls. It requests bounded ranges for header and availability samples and closes the response at its limit. Socket and HTTP-client buffering can deliver some extra bytes if a server ignores the range. FFprobe's `probesize` controls demuxer probing, while its deadlines limit execution time. Total bytes transferred by its own HTTP client are not capped by `probesize`.

## Metrics

`mist.source-loading` and `mist.playback-playlist` report request time, p50 and p95 over up to 256 recent requests per route, caller waits, and request-scoped stages. `mist.probe-work` reports process-wide executions, joins, queue depth and peak, queue and active times, timeouts, cancellations, observed bytes, cache hits and misses, header outcomes and fallback reasons. Resolution disagreements and missing detail counters expose changes in metadata quality. Metric labels use fixed names and carry no installation identifiers, credentials or URLs.

## Reproduce the comparison

Run from the repository root with Node.js, the installed npm dependencies, and FFmpeg with `libx264` and FFprobe on `PATH`. The benchmark extracts the baseline source from Git into a temporary directory, creates its own provider fixture config and serves generated media over loopback. It does not require accounts or live providers.

```sh
npm run check
npm run build
npm test
for mode in legacy new-2 new-4; do
  /usr/bin/time -p node --import tsx scripts/benchmark-media.ts \
    --baseline-ref a4ec000 --iterations 12 --mode "$mode" > "media-$mode.json"
done
```

The JSON reports p50/p95 per caller, scenario wall time, actual FFprobe launches, fixture HTTP responses and payload bytes, estimated peak Node RSS, Node CPU time, and metadata counts. The fixture payload counter excludes HTTP headers, socket buffering and retransmits. Run each mode in its own process for the reported RSS and use the external `time` report for whole-run CPU time including children. Warm inspection is seeded before measurement. Cold signed URLs and playlist body revisions force independent work. The expiry scenario advances the fixture clock to exercise the five-second margin and a later HTTP 403.

## Recorded fixture results

Measured on November 24, 2026 on an Apple M4 Mac with 10 logical CPUs and 16 GiB RAM, Node.js 22.17.0 and FFmpeg/FFprobe 8.1.2. Baseline was `a4ec000`. No measurements were taken on Oracle Cloud.

Each result cell shows **p50 / p95 milliseconds · FFprobe launches · HTTP payload bytes**. Each concurrent batch had eight callers for media inspection or four for playback playlists.

| Scenario | Calls | Baseline | New, 2 slots | New, 4 slots |
| --- | ---: | ---: | ---: | ---: |
| Cold unique compact H.264 TS | 24 | 26.60 / 31.40 · 24 · 192,816 | 0.73 / 2.53 · 0 · 191,160 | 0.77 / 2.54 · 0 · 191,160 |
| Warm repeated compact H.264 TS | 96 | 0.00 / 0.00 · 0 · 0 | 0.01 / 0.01 · 0 · 0 | 0.01 / 0.01 · 0 · 0 |
| Concurrent same compact H.264 TS | 96 | 26.28 / 26.67 · 12 · 96,408 | 0.59 / 1.16 · 0 · 95,580 | 0.60 / 0.65 · 0 · 95,580 |
| Concurrent distinct mixed TS and MP4 | 96 | 36.17 / 39.34 · 96 · 529,104 | 4.71 / 54.91 · 48 · 525,840 | 5.91 / 28.99 · 48 · 525,840 |
| Concurrent distinct MP4 fallback | 96 | 34.77 / 40.21 · 96 · 287,136 | 55.79 / 108.32 · 96 · 287,136 | 29.60 / 55.80 · 96 · 287,136 |
| Cold dense 720p H.264 TS | 12 | 33.45 / 34.49 · 12 · 4,791,096 | 33.75 / 35.35 · 12 · 5,577,528 | 33.86 / 35.85 · 12 · 5,577,528 |
| Mono TS with details fallback | 12 | 27.79 / 28.57 · 12 · 94,104 | 25.85 / 26.35 · 12 · 93,300 | 26.13 / 26.60 · 12 · 93,300 |
| fMP4 with details fallback | 12 | 26.55 / 27.22 · 12 · 42,732 | 27.27 / 28.52 · 12 · 42,732 | 27.03 / 27.89 · 12 · 42,732 |
| Alternate subtitle rendition | 12 | 27.09 / 28.04 · 12 · 102,732 | 28.33 / 28.76 · 12 · 102,732 | 27.91 / 28.35 · 12 · 102,732 |
| Shared, repeated, updated and expiring playback | 65 | 54.79 / 83.94 · 192 · 1,273,550 | 51.22 / 52.89 · 45 · 300,560 | 52.30 / 54.63 · 45 · 300,560 |

| Resource use | Baseline | New, 2 slots | New, 4 slots |
| --- | ---: | ---: | ---: |
| Peak sampled Node RSS | 160.86 MiB | 157.20 MiB | 156.83 MiB |
| Node CPU across measured scenarios | 644 ms | 465 ms | 450 ms |
| Whole-run user + system CPU, including child processes and fixture setup | 14.12 s | 6.69 s | 6.75 s |
| Peak concurrent FFprobe children measured by scheduler | Uninstrumented | 2 | 4 |

Metadata counts matched in all three modes. All 456 media results per mode retained availability, dimensions, video codec, audio codec and channel layout. All 12 caption fixtures retained their English subtitle label and declared bitrate. All 64 successful playback reads per mode removed the verified clip, and the expired URL returned HTTP 403.

The compact TS results show the benefit of skipping the child process on a cold lookup. The dense TS sample had dimensions but lacked audio details within the first 64 KiB, so URL fallback added the full 64 KiB per lookup. Mono TS reused the in-memory sample. fMP4 transferred the same bytes as baseline after making the init read conditional on missing dimensions. Four slots reduced tail latency on the fallback-heavy fixture bursts. That comparison on a 10-core host does not establish throughput or contention on 2 OCPUs. The remaining questions are the share of real provider TS episodes that can skip FFprobe, latency through the configured media proxy, and the best process limit on the Oracle instance.
