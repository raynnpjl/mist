# Mist 0.5.0 — workspace redesign

Verified 15 November 2026, Asia/Singapore.

## Design

Built from [DESIGN-apple.md](../DESIGN-apple.md): system/SF typography, neutral light and dark canvases, blue actions, 18px utility cards, generous spacing and flat surfaces without decorative gradients or chrome shadows. The public [pengu.uk](https://pengu.uk/) notice and sign-in layout informed the top-left brand and centered setup flow. Mist uses its own wind icon and artwork.

The website now has Overview, Sources, Preferences and Status views. The mobile layout replaces the side navigation with a compact four-item navigation row. Appearance is toggleable from the header and Preferences. The header controls sit inward from the screen edges. Its divider is hidden during opening/setup and visible in the workspace. The key popup displays Mist beside its wind icon, with no setup eyebrow or theme button inside it. Backgrounds remain clear; the header theme button stays usable during key entry while workspace controls are inert.

## Working flows

- **First visit:** the exact user-supplied DMCA notice appears before setup or installation API calls. Native modal behavior makes the background inert. Escape and clicking outside do not dismiss it. Only I Understand proceeds, and acknowledgement is remembered in this browser.
- **TMDB setup:** a centered password dialog validates the v3 key through the existing server endpoint, reports rejected keys, clears the password after success and opens the workspace. Updates keep the same installation ID. API keys are not written to browser storage or returned by configuration endpoints.
- **Overview:** real saved-source and lookup summaries, encrypted-key status, copy controls and the private Stremio/Nuvio installation URL.
- **Sources:** cards contain just the provider name and toggle, without icons or endpoint links. Selection is persisted per installation and filters actual provider searches and stream results. Empty, duplicate and unknown source selections are rejected. Unsaved changes can be saved or discarded.
- **Preferences:** a 1–10 second detail window, in half-second increments, changes the actual media inspector deadline. The default is still 6.5 seconds with eight inspection slots. Lower values show the warning about faster lists and more Unknown quality, bitrate or codec information. Title/provider search time remains separate.
- **Status:** all five providers are checked regardless of selection. Summary cards show Total sources, Up and Down; each row has a Status column with green Up or red Down, response time and timestamps. Unchecked results stay neutral rather than counting as Down. Results are coalesced/cached for 30 seconds. These checks neither occupy stream-search slots nor place stream searches in cooldown after a failed health request.

Provider endpoints load from the ignored local `.env` or server environment. No provider URL defaults remain in application code, tests, public assets or the built output. `.env.example` lists empty required variables; Compose reads `.env` without copying it into the image. Configuration responses expose provider names and IDs without hostnames. Existing encrypted TMDB configuration is unchanged.

Encrypted API-key records and private URLs retain their existing format. Source and timing overrides are stored separately in owner-only preference files. An installation without saved overrides uses all sources and 6.5 seconds, including newly created installations. Corrupt saved preferences fail validation rather than being silently substituted.

## Validation

- **44 backend tests passed.** Coverage includes encrypted key persistence, preference persistence across key updates/restarts, source filtering, real inspector budgets, invalid settings, private routes, status caching, isolation of health checks from stream lookups, environment-only provider endpoints, missing/invalid configuration and endpoint-free configuration responses.
- Type checking, JavaScript syntax checks, production build and compose configuration passed.
- Headless Chrome exercised the complete notice → invalid/valid key → workspace flow using an isolated fixture backend and temporary encrypted installation. Production keys and preferences were not used or changed.
- Browser checks confirmed theme and acknowledgement persistence, cleared password inputs, no browser-stored API key, saved source/lookup changes affecting stream responses, minimum source selection, and healthy/unavailable status rows.
- All four views were checked at 320, 390, 768, 1024 and 1440px widths without horizontal page overflow. Light/dark desktop, mobile views and both first-visit dialogs were rendered and visually inspected.
- Docker packaging was checked with a fake-key installation, a temporary volume and a dynamically assigned loopback port. The new assets, private manifest and preferences persisted across container replacement. Temporary Docker resources were removed.
- A separate public-API check found all five sources available at the time of verification. This is a point-in-time API check, not a guarantee of video playback.

The browser tool was unavailable, so visual verification used an isolated headless Chrome profile. Browser acceptance details are saved in [design/checks.json](design/checks.json); public API results are in [design/live-source-status.json](design/live-source-status.json).

The popup/header refinement was also checked in [design/popup-refinement-checks.json](design/popup-refinement-checks.json): no background blur, no theme control or setup eyebrow inside the popup, Mist beside the wind icon, inset header controls, and a working header theme toggle during key entry. Setup and editing/cancel restore workspace interaction correctly; the DMCA acknowledgement gate remains mandatory.

The source/status refinement is checked in [design/source-status-refinement-checks.json](design/source-status-refinement-checks.json). An isolated fixture installation with only one source selected still showed five status rows and a 5/4/1 Total/Up/Down summary. Green/red text was verified in both themes, pending counts stayed neutral, and Sources/Status had no horizontal overflow at 320, 390, 768, 1024 and 1440px. Separate runtime checks confirmed `.env` loading, environment-variable precedence, missing-file handling for environment-only deployments, and Compose configuration.

## Previews

| View | Light | Dark / mobile |
| --- | --- | --- |
| Overview | [Desktop](design/overview-light.png) | [Dark](design/overview-dark.png), [Mobile](design/mobile-overview.png) |
| Setup | [Desktop](design/setup-light.png) | [Dark](design/setup-dark.png), [Mobile](design/mobile-setup.png) |
| DMCA notice | [Desktop](design/dmca-light.png) | [Mobile](design/mobile-dmca.png) |
| Sources | [Desktop](design/sources-light.png) | [Mobile](design/mobile-sources.png) |
| Preferences | [Desktop](design/preferences-light.png) | [Mobile](design/mobile-preferences.png) |
| Status | [Desktop](design/status-dark.png) | [Mobile](design/mobile-status.png) |

Screenshot data comes from the isolated test installation. Status fixtures deliberately include an unavailable source to verify the error state; they do not represent current provider availability.
