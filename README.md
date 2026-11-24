<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/readme-wordmark-dark.svg">
  <img src="public/readme-wordmark-light.svg" alt="Mist" width="300">
</picture>

### HTTP Addon Built for Nuvio · Stremio

[![Version][badge-version]](package.json)
[![License][badge-license]](LICENSE)
[![TypeScript][badge-typescript]](package.json)
[![Nodejs][badge-node]](package.json)
[![Nuvio · Stremio][badge-clients]](#install)

[Features](#features) · [Install](#install) · [Configuration](#configuration) · [FAQ](#faq) · [License](#license) · [Self-host](self-host.md)

</div>

Mist is a private, self-hosted addon that finds Chinese movies, dramas, animation and variety streams from your configured providers. Browse your existing catalogs, open a title or episode, and choose a Mist source to play.

Mist supplies streams alongside catalog addons such as cNative. Your catalog handles browsing and metadata; your player handles playback and watch progress. Video travels directly from the source to your player, while Mist processes HLS playlists when needed.

## Features

### The addon

An HTTP stream addon for Chinese movies, dramas, animation and variety, with TMDB-based matching, configurable providers and private accounts for Nuvio and Stremio.

| Capability | Detail |
| --- | --- |
| **Matching** | TMDB and IMDb title matching with release-year, season and episode checks; date-labelled variety episodes and Chinese animation. |
| **Sources** | Enable providers, drag to set priority, filter from 360p through 4K, or put higher resolutions first; optional episode extras as separate choices. |
| **Stream details** | Resolution, bitrate, language, provider and available codec and subtitle metadata; a configurable 1–10 second inspection window. |
| **Ad detection** | Automatic removal of verified HLS ad blocks while keeping program segments in order; unverified breaks and ads baked into the video can remain. |
| **Workspace** | Light and dark themes, source preferences and provider status checks; access-key accounts, encrypted TMDB credentials and a dedicated installation URL. |
| **Resilience** | Shared caches, timeouts and API backups help healthy sources keep working when another fails. |
| **Direct files** | Experimental MKVDrama discovery of direct MKV/MP4 files through PixelDrain and Send; playback in Nuvio and Stremio remains unverified for these hosts. |

## Install

You'll need a running Mist deployment, an access key from its operator, and a [TMDB v3 API key](https://www.themoviedb.org/settings/api). Hosting your own instance? Start with [Self-host](self-host.md).

1. Open your deployment's `/configure` page and enter your access key.
2. Connect TMDB, select your sources and preferences, then save.
3. Install Mist in your player:

| Player | Installation |
| --- | --- |
| **Nuvio** | Use **Copy Manifest URL**, then add the URL in Nuvio's addon settings. |
| **Stremio** | Choose **Install in Stremio**, or add the private manifest URL manually. |

Keep a compatible catalog addon installed. Mist accepts IMDb and TMDB movie and episode IDs. Native players are the intended clients, and playback depends on source availability and codec support.

Your access key restores the same workspace on another device. Saving preferences updates your existing installation, so you don't need to reinstall Mist after each change.

## Configuration

Open your deployment's `/configure` page to manage Mist. Source selections and lookup preferences are saved to your account; appearance is remembered in your browser.

| Setting | Default | Detail |
| --- | --- | --- |
| **TMDB connection** | Not connected | Enter a TMDB v3 API key during setup; update it under Preferences. Credentials are encrypted on the server. |
| **Sources** | All configured providers | Enable providers and drag to set their priority. Disabled providers retain their position. |
| **Resolutions** | All tiers enabled | Select 360p, 480p, 720p, 1080p, 4K and Unknown. Unknown covers streams without detected resolution. |
| **Higher resolution first** | Off | Order choices from 4K down to Unknown; matching tiers follow your provider priority. |
| **Include Episode Extras** | Off | Show confidently matched extras and alternate editions as separate choices from API providers. |
| **Detail lookup time** | 6.5 seconds | Adjust from 1–10 seconds in half-second steps. Shorter windows can return fewer media details; title searches and provider requests add their own time. |

Use **Status** to check source availability, response times and last-check timestamps. Save source and lookup changes to apply them to your existing installation. Server credentials and provider endpoints are covered in [Self-host](self-host.md).

## FAQ

**Do I still need a catalog addon?**

Yes. Mist supplies streams, while your catalog supplies browsing, artwork, metadata and episode lists. Use a compatible catalog that provides IMDb or TMDB IDs.

**Do I need a TMDB API key?**

Yes. Enter a TMDB v3 API key through the configuration workspace. Your key is encrypted before being stored on the server. Each access-key account saves its own TMDB connection and preferences.

**Will Mist support other Asian content, such as K-dramas and Thai dramas?**

Mist already includes MKVDrama as a provider, and its library contains K-dramas and Thai dramas. Bringing that content into Mist is in the works, but broader Asian-content support is not the top priority right now.

**Why are streams missing or details marked Unknown?**

Check your enabled sources, resolution filters and provider Status. Missing title or episode metadata can prevent a match. Unknown details mean Mist could not determine them from the available metadata within the inspection window; a longer lookup may help.

**Does Mist remove every advertisement?**

No. It removes verified inserted HLS ad blocks. Unverified breaks, unreadable playlists and ads baked into program segments can remain.

**Does Mist provide subtitles?**

Mist reports available embedded or declared subtitle languages, but does not supply external subtitle downloads. External subtitles come from your player or subtitle addons.

**Do I need to reinstall after changing settings or switching devices?**

Saving settings updates your existing installation URL. Enter the same access key on another device to restore the workspace, then install that manifest URL in the player if needed.

## License

[MIT](LICENSE) © 2026 Mist contributors.

<!-- Static badges also work when the repository is private. Keep versions in sync with package.json and package-lock.json. -->
[badge-version]: https://img.shields.io/badge/version-1.5.3-0066CC?style=for-the-badge&labelColor=1a1a1a
[badge-license]: https://img.shields.io/badge/license-MIT-0066CC?style=for-the-badge&labelColor=1a1a1a
[badge-typescript]: https://img.shields.io/badge/TypeScript-7.0.2-3178C6?style=for-the-badge&logo=typescript&logoColor=white&labelColor=1a1a1a
[badge-node]: https://img.shields.io/badge/Nodejs-22.17%2B-5FA04E?style=for-the-badge&logo=nodedotjs&logoColor=white&labelColor=1a1a1a
[badge-clients]: https://img.shields.io/badge/Nuvio%20%C2%B7%20Stremio-8B5CF6?style=for-the-badge
