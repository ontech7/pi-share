# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.3.0] - 2026-10-22

### Added

- **Container images** for `amd64` and `arm64` on `ghcr.io/ontech7/pi-share`, built natively for each platform on
  every release, with a signed build provenance attestation. Installing no longer needs a clone or a local build.
- The running version is shown in the settings.
- MIT license.

### Changed

- `compose.yaml` runs the published image by default (`PI_SHARE_IMAGE` picks another one).

### Security

- Hardening from the first CodeQL analysis: the service worker accepts download jobs only from its own origin and
  only for pi-share download URLs, the sensitive list is read through a single descriptor, the master key is
  created without a check-then-use race.

## [0.2.0] - 2026-10-22

### Added

- **Folders.** Tick a folder in the picker to share everything below it. Recipients browse it as a tree and
  download single files or the whole folder as a zip.
- **What happens when files change**, chosen per link: _pause_ the link until you review and accept the list of
  added, removed and changed files, or _follow_ the disk like a shared folder.
- **Defaults for new links** in the settings: change policy, expiry, download limit, generated password.
- **Settings page** with a sidebar on wide screens and a list of sections on phones.
- Recipients holding the link learn why it is unavailable (paused, expired, limit reached, turned off).

### Changed

- **The download limit counts people, not downloads.** Someone counts once they got the files; they may retry
  and fetch every other file of the link, while someone new finds it exhausted. Cancelled or interrupted
  downloads no longer count.
- Downloads address files by an opaque id instead of their position.
- The container health probes check the real answer of each process.

### Security

- Fixes from an independent review of the folder feature: the service switch no longer walks folders on public
  requests, folder walks are capped and cached, misleading file names are left out, accepting changes names the
  exact version the owner reviewed and asks before sensitive content.

### Fixed

- Folders the service may not read answer with a clear message instead of an error.

## [0.1.0] - 2026-10-22

First release: end-to-end encrypted links to files on your disk, password, expiry and download limit per link,
activity log, service switch, admin on the LAN, edge without network behind a tunnel.

[0.3.0]: https://github.com/ontech7/pi-share/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ontech7/pi-share/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ontech7/pi-share/releases/tag/v0.1.0
