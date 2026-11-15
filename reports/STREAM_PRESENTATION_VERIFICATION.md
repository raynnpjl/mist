# Mist 0.3.0 — source display and badges

Historical snapshot. Current 0.4.0 behavior is documented in [MISSING_SHOWS_VERIFICATION.md](MISSING_SHOWS_VERIFICATION.md).

Verified 15 November 2026, Asia/Singapore.

## Requested format

The visible source title uses `[Provider] Resolution`. The four description lines are:

```text
[红牛] 1080p
狂飙 S01E01
Quality: Unknown
Bitrate: Unavailable
Language: Chinese
```

The show name is Chinese/native. `Mist |` is removed. Source names remain 红牛、天堂、暴风、量子、优酷. Movies use `Movie` in place of a season/episode.

`Quality` means release type, separate from pixel resolution. WEB-DL, WEBRip, Remux, BluRay, HDTV and DVDRip are recognized only when explicitly stated in the provider's version/remarks fields. A transport URL alone does not establish release provenance.

## Media facts

FFprobe reads frame dimensions, video/audio codecs and channel layout. Dimensions detected from media take priority over declared HLS resolution; cropped heights such as 606p are retained. An HLS master can supply declared resolution when probing is unavailable.

Bitrate comes from a probed media file or HLS-declared average/peak bandwidth. HLS container `format.bit_rate` is deliberately ignored: a live source returned 122 bps computed from playlist text, which was not a useful media bitrate. Single-segment and shared-file size estimates are also excluded. Missing values stay `Unavailable`; no network-speed number is mislabeled as bitrate.

Inspection is cached for five minutes and bounded by a 6.5-second deadline. Failed inspection leaves a stream choice available with explicit unknown fields. FFprobe is included in the Docker image; a local installation must provide it on PATH for codec probing.

## Nuvio badge compatibility

Official Nuvio TV and Mobile badge matchers both read `behaviorHints.filename`, stream name, title and description. Mist supplies known facts in that standard filename field, for example:

```text
狂飙 S01E01 1080p 1920x1080 H.264 AAC 2.0 Chinese.m3u8
```

An explicitly identified release type is included as another token. Unknown HDR, Atmos and source-quality attributes are not fabricated. Imported/enabled badge rules determine which images appear; nonstandard resolutions require matching rules in the user's pack.

Primary implementations inspected:

- [Nuvio TV StreamBadgeRules.kt](https://github.com/NuvioMedia/NuvioTV/blob/dev/app/src/main/java/com/nuvio/tv/core/streams/StreamBadgeRules.kt)
- [Nuvio Mobile StreamBadgeRules.kt](https://github.com/NuvioMedia/NuvioMobile/blob/cmp-rewrite/composeApp/src/commonMain/kotlin/com/nuvio/app/features/streams/StreamBadgeRules.kt)
- [Nuvio TV display-name/description mapping](https://github.com/NuvioMedia/NuvioTV/blob/dev/app/src/main/java/com/nuvio/tv/domain/model/Stream.kt)

This verifies the addon data contract. Rendering in the user's installed badge pack and Android/TV app remains a device-level check.

## Checks

- Type checking and clean build passed.
- 29 tests passed, including exact display layout, Chinese titles, bitrate units, release-type honesty, unknown fields, bounded reads, caching, HLS variants, codec/channel tags, cNative compatibility and HTTP routes.
- Live HTTP checks used `tt26235088:1:1` and verified returned source names, all four description lines and filename metadata.
- Live media inspection detected 1080p H.264/AAC and a cropped 606p rendition. Some providers did not expose usable bitrate or respond to codec probing within the deadline; their unknown fields remain explicit.
- The FFprobe-enabled Docker image builds successfully, and compose configuration validates.

The final HTTP output is saved in [stream-presentation-smoke.json](stream-presentation-smoke.json). Values are a point-in-time snapshot of provider responses, not a promise that every source or title will expose metadata.
