# Mist 0.4.0 — missing shows and encrypted website configuration

Verified 15 November 2026, Asia/Singapore.

## Cause and fix

The previous keyless resolver returned no title mapping for `tmdb:270431`, `tmdb:224755` and `tmdb:259700`. All three provider searches were therefore skipped. A live reproduction asserted that streams must be nonempty and failed. The running Mist process also had no TMDB key configured; cNative's key is independent.

Mist now uses one configured TMDB metadata path. Open `/configure`, enter a TMDB v3 key and save. The server verifies the key, saves an encrypted installation and returns a private manifest URL containing a random installation ID. The public manifest requires configuration. Older Mist installations must be replaced with the generated private URL.

There was also a variety-show matching defect: a catalog episode index can differ from the provider's broadcast-period number. For example, 女子推理社 S01E02 is 第1集（下）, and 忙忙碌碌寻宝藏 S01E03 is 第2期下. Matching now uses explicit period numbers and upper/lower parts from TMDB episode names, or matching air dates and parts. First-season listing names ending in 第一季/第1季 are accepted. Bonus entries remain separate; playlist position is not used to guess parts. Both failing regression cases passed after the fix.

## Requested display

```text
1080p
女子推理社 S01E01
Bitrate: 0.8 Mbps
Language: Chinese
天堂云播
```

The source title is resolution only. The four description lines contain Chinese show name/episode, bitrate, language and a plain provider name ending in 云播. There is no Quality line or Provider label. Known release types and codecs remain available to Nuvio badge rules through `behaviorHints.filename`. Missing media facts remain explicit rather than fabricated.

## Credential storage

- AES-256-GCM, random 96-bit IV per write, 128-bit authentication tag, with the installation ID as authenticated additional data.
- Random 192-bit installation IDs; API keys are not returned in configuration responses, manifests or installation URLs.
- Server-generated 256-bit encryption key in `data/master.key`. Directory permissions are `0700`; key and encrypted records are `0600`.
- Ciphertext tampering and copying a record to another installation fail authentication. Missing master keys fail startup when encrypted records remain.
- Website key updates preserve the installation URL and invalidate its cached addon service. The password input clears after success; the app does not save keys in browser storage.
- Same-origin checks on configuration requests, bounded JSON bodies, generic errors, no-referrer policy, and no public data-file route.
- Docker uses a persistent data volume. A two-container test with a fake key confirmed encrypted persistence and private filesystem permissions, then removed its temporary volume.

Encryption protects stored records; someone with both the records and master key can decrypt them. Remote configuration must use HTTPS, and the private installation URL must remain private.

## Validation

- 35 offline tests passed, including exact display, encrypted persistence, tamper rejection, key validation/update, credential-free responses, private addon HTTP routes, cNative ID formats and split variety episodes.
- Type checking and production build passed; Docker image builds and compose configuration validates.
- The website accepted and verified the user's key. Live configured requests returned sources for all three reported shows.
- Live checks include cNative's IMDb path for 折月亮, plus later upper/lower episodes in both variety shows. Returned split-part URLs are compared with the provider API's original labels.
- Sanitized results are saved in [missing-shows-smoke.json](missing-shows-smoke.json). The report omits API keys and private installation IDs.

Native playback and badge-pack rendering on the user's Android/TV and Stremio desktop devices are outside these server checks. Source availability and metadata remain provider-dependent.
