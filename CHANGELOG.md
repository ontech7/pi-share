# Changelog

All notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/).

## [0.3.0] - 2026-10-22

### Added
- Container images for amd64 and arm64 on `ghcr.io/ontech7/pi-share`, with build provenance.
- Version shown in the settings.
- MIT license.

### Changed
- `compose.yaml` runs the published image by default.

### Security
- Hardening from CodeQL: service worker download jobs, sensitive list reads, master key creation.

## [0.2.0] - 2026-10-22

### Added
- Folder sharing, with a tree and a zip for recipients.
- Per-link policy when files change: pause until accepted, or follow the disk.
- Defaults for new links and a settings page.
- Recipients see why a link is unavailable.

### Changed
- The download limit counts people; cancelled downloads no longer count.

### Security
- Fixes from an independent review of the folder feature.

## [0.1.0] - 2026-10-22

### Added
- End-to-end encrypted links to files on your disk.
- Password, expiry, download limit and activity log per link.
- Service switch; admin on the LAN, network-less edge behind a tunnel.

[0.3.0]: https://github.com/ontech7/pi-share/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ontech7/pi-share/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ontech7/pi-share/releases/tag/v0.1.0
