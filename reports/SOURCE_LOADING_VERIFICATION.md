# Source-list loading

Measured 15 November 2026, Asia/Singapore, using the saved installation key internally. No API key or private installation URL is included in the benchmark artifacts.

## Removed sequential waits

Provider discovery now starts while episode metadata loads. Matching still waits for that metadata before selecting an episode. Each provider starts media inspection as soon as its candidates are available, rather than waiting for every provider search to finish.

All providers, media checks, URL deduplication, provider priority and final ranking remain in place. Concurrent inspections of the same URL share the existing cache entry.

Two deterministic regression tests held episode metadata or a provider response pending. Both failed before the change and passed afterward: provider discovery overlaps metadata loading, and a ready provider starts inspection while a slower search is pending. The duplicate-URL case also confirms one inspection and unchanged provider priority.

## Live measurements with the original inspection window

These are individual backend service measurements, not a UI latency guarantee. Each benchmark used a fresh service followed by an immediate repeat. The network and CDN responses varied between runs.

| Request | Before, cold | Overlapped, cold | Streams in both runs |
| --- | ---: | ---: | ---: |
| 折月亮 S01E01 | 7.52 s | 7.94 s | 5 |
| 女子推理社 S01E01 | 9.20 s | 7.75 s | 5 |

First media inspection started at 2.27 s / 4.14 s before the change and 0.84 s / 0.89 s afterward. The remaining delay was media inspection: one 折月亮 check reached the 6.5-second deadline in the second run. This explains why earlier inspection did not make that particular total faster. Immediate cached repeats took 3–8 ms in these backend runs.

Artifacts: [before](source-loading-before.json), [overlapped](source-loading-overlap.json).

## Eight inspection slots

The inspection pool increased from four to eight concurrent jobs per installation. Each job still runs FFprobe and playlist inspection in parallel, and the existing 6.5-second deadline including queue time is unchanged. Metadata and provider-request pool limits were not changed.

In two additional five-source cold checks, peak concurrent probes rose from four to five. Maximum queue delay fell from 613 ms / 1028 ms to 2 ms / 4 ms, so all five probes began with their full inspection budget.

| Request | Four slots | Eight slots | Stream count |
| --- | ---: | ---: | ---: |
| 折月亮 S01E01 | 7.07 s | 6.33 s | 5 |
| 女子推理社 S01E01 | 8.08 s | 7.86 s | 5 |

These are individual live samples. Some probes still failed or timed out despite having the full budget, so more concurrency does not guarantee that a slow or unavailable CDN will provide every field. It removes local queueing for batches of up to eight inspections.

A deterministic test starts ten inspections, holds their probes pending, and confirms that eight start immediately while two stay queued. It checks that duplicate URLs share a job, all successful jobs retain video/audio details, concurrency stays bounded, and the inspection budget remains 6500 ms.

Artifacts: [four slots](inspection-workers-before.json), [eight slots](inspection-workers-after.json). Credentials and private installation URLs are omitted.

## Checks

- 38 tests passed, including HTTP configuration, encryption, correct episodes/parts, provider failures, display, pipeline concurrency and the eight-slot inspection case.
- Type checking and production build passed.
- No temporary instrumentation was added to application code.
