# Mist 0.2.0 — stream-only verification

Verified 15 November 2026, Asia/Singapore.

## Missing-source cause

The original addon advertised and parsed only its own `cnvod:` IDs. cNative uses its own `cnative:` metadata IDs, but its episode mapper deliberately emits standard IMDb or TMDB video IDs. Mist was therefore excluded from those episode requests, and a direct request returned an empty stream list.

The initial regression reproduced both failures: `Mist not eligible for tt26235088:1:1` and `No Mist sources for a normal IMDb episode`. A separate regression also reproduced the dependency on a prior Mist metadata request.

Mist now has one public resource: `stream`, accepting `tt` and `tmdb:` prefixes. Its manifest has `catalogs: []`. There are no catalog or metadata handlers, private title IDs, episode registration or SQLite dependency.

## cNative contract

cNative's `mapEpisode` function was executed read-only from the existing local cNative project. It produced:

- `tt26235088:1:1` for an IMDb-mapped title.
- `tmdb:210757:1:1` for a TMDB title without an IMDb mapping.

The exact output is saved in [cnative-contract.json](cnative-contract.json). The regression suite verifies addon eligibility and stream resolution using this contract, without changing cNative or reading its saved configuration/credentials.

## Live requests

All checks used the default, keyless Wikidata lookup; no TMDB key was configured.

| Request | Title | Returned choices | Cold response |
| --- | --- | --- | --- |
| `tt26235088:1:1` | The Knockout | All 5 providers | 5.94 s |
| `tmdb:210757:1:1` | The Knockout | All 5 providers | 5.94 s |
| `tt14922556:1:1` | Love Between Fairy and Devil | 3 providers | 12.64 s |

Stream names use `Mist | [provider]`. The only Chinese text generated for display is the provider name. Descriptions use English labels such as `S01E01 · Mandarin`.

FFmpeg decoded two seconds of audio and video from the first-ranked IMDb result for both dramas, using its default User-Agent. Both succeeded. See [stream-only-smoke.json](stream-only-smoke.json) for URLs, stream labels and decode results.

## Automated checks

- Type checking and clean TypeScript build passed.
- 19 behavior/HTTP tests passed.
- Coverage includes cNative ID discovery, direct IMDb/TMDB stream requests, matching by native title/year, unrelated-title rejection, exact episode selection, later seasons, all-season collections, date-labelled variety, failed sources, source ranking, English output and CORS.
- The optional official TMDB path is covered with mocked responses, including invalid credentials. It was not tested against TMDB using a real key.
- The Docker image builds as a stateless Node.js service, and compose configuration validates. A fresh final-image container, with no database or volume, returned all five provider choices for `tt26235088:1:1` in 7.13 seconds.

## Client refresh and limits

Restart the running addon process and **remove/re-add Mist in Nuvio or Stremio** to replace the old cached manifest. Otherwise the client may continue applying the old `cnvod:` eligibility filter.

Select an episode from cNative and look for Mist source names. No Mist catalog is needed. A phone/TV must use a server URL it can reach; `localhost` refers to that phone/TV.

Metadata coverage and provider availability vary. A server-side `TMDB_API_KEY` can improve title/episode coverage beyond Wikidata. Unknown mappings and ambiguous variety parts are not guessed. Actual playback in the user's Nuvio Android/TV instance remains a device-level check; the verified path covers cNative episode-ID generation, Mist HTTP requests and media decoding.

Older verification files in this folder describe the superseded 0.1.0 catalog prototype.
