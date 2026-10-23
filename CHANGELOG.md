# Changelog

All notable changes to this project. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Allowed networks per link: addresses or ranges (IPv4 and IPv6) a link may be opened from. Anyone else holding
  the link is told it is not available from their network, before any password is tried; downloads stop if the
  visitor moves to another network.
- The provider behind each visit (home ISP, mobile operator, cloud), from a public table the admin downloads
  weekly and looks up on disk. Clouds, servers and VPN exits are marked.
- Notifications through ntfy, a Telegram bot or email (SMTP) for opens, downloads, wrong passwords, refused
  attempts and chat previews, with secrets encrypted at rest.
- A link previewed by a chat app says which one, and that the chat now holds the whole link.
- Integration tokens (**Settings → Integrations**): named, with an expiry or none, shown once and stored as a hash,
  revocable. A token can create links and see or delete the ones it created, nothing else; its links show which
  token made them.

### Changed

- A new link takes the expiry and download limit of **Settings → New links** when the request leaves them out,
  not only when it comes from the admin's dialog. `null` still means never and no limit.

## [0.4.2] - 2026-10-23

### Changed

- Runs on Node 24 LTS (was Node 22).
- CI and release workflows on the latest version of every action.

## [0.4.1] - 2026-10-22

### Fixed

- The image's version label is the bare version (`0.4.1`, not `v0.4.1`), so the updater accepts it; it also
  accepts 0.4.0's.

## [0.4.0] - 2026-10-22

### Added

- The running version next to the logo, and a notice when a newer release is out (checked every few hours, can be
  turned off).
- **Settings → Updates**: release notes and one-click installs through an optional updater on the host, which
  checks the release and the image again, backs up the database and rolls back if the new version is not healthy.

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

[0.4.2]: https://github.com/ontech7/pi-share/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/ontech7/pi-share/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/ontech7/pi-share/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/ontech7/pi-share/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ontech7/pi-share/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ontech7/pi-share/releases/tag/v0.1.0
