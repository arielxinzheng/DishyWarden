# Changelog

This project follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/).

> **1.0.0 is the first public release.** This file records changes from the
> public release onward; the pre-release iteration history is not part of this
> repository.

---

## [Unreleased]

---

## [1.0.1] — 2026-11-23

### Fixed

- **The "24H usage" figure no longer counts traffic that never happened.**
  The estimate multiplied the summed throughput by the average gap between
  samples, so any idle stretch (the app closed, a laptop asleep, a restart)
  was charged traffic for the whole gap. With 128 samples spread over 22.4
  hours that average gap was derived as 635 s instead of 30 s, and the
  reported usage came out roughly 21 times above the traffic actually
  observed. Traffic is now accumulated per sample from the real gap to the
  previous sample, capped at twice the nominal interval: a missed tick is
  still counted in full, an idle stretch is not billed.
- **The browser mock reported eight times the traffic of the real app.**
  The mock path computed bytes as `avgBps * seconds`, i.e. bits labelled as
  bytes, while the SQLite path always divided by 8. The mock now uses the
  same convention as the stored history.
- **E-mail notifications no longer advertised as a supported channel.**
  v1.0.0 shipped a stub that logged "not implemented" but still reported
  *success* to the dispatcher, so a hand-configured e-mail channel would
  silently drop every alert: no retry, no offline queue, no log entry. The
  stub now throws, so the failure is visible in the logs. **Telegram and
  webhook are the supported channels.**
- **Documentation corrections.** The built-in alert rule count was corrected
  from 27 to 28; the README now states that auto-update is Windows-only; a
  "Why DishyWarden?" section was added; Korean grammar particles around the
  app name were fixed; all five language versions were regenerated.

### Changed

- **One version number for the whole product.** The application version is
  no longer typed in several places: it is injected at build time from the
  single source in the package manifest, so the footer of the running app,
  the installer file name, the disk image file name and the release tag can
  no longer disagree.
- **The duplicate language switch in the sidebar was removed.** The switch in
  the top bar is the only one; the sidebar copy is gone.
- **CI now runs eslint.** The check job had no lint step, so lint could stay
  red on `main` while CI stayed green. Errors now block the build. Warnings
  are printed as a debt list instead of blocking, and a stricter variant is
  available for when that debt is paid off.

---

## [1.0.0] — 2026-11-15

First public release.

### Added

- **Live monitoring dashboard** — connection status bar and six metric cards
  (latency / throughput / packet loss / SNR / obstruction / uptime); status is
  rendered as barcode-style vertical strips (24h → 48 slices, worst-first
  aggregation)
- **Obstruction map** — sky obstruction map of the terminal's field of view,
  with azimuth display, obstruction fraction and impact assessment
- **Alerting system** — multiple rule categories including link loss, high
  latency, heavy packet loss, low SNR and stale data; delivery over two
  channels, **Telegram** and **Webhook** (with a universal payload template)
- **Network probes** — ICMP ping (local gateway + public target), DNS
  resolution, DNS dual-track attribution and TLS checks; probe nodes are
  fully manageable with per-node targets and intervals
- **DNS dual-track attribution** — resolves the same name through a baseline
  resolver and the user resolver at the same time, separating local resolver
  failure from upstream DNS failure
- **First-run troubleshooting guide** — when collection fails with no local
  history, a connection wizard is shown instead of a blank page: retry,
  target address display and a four-step checklist
- **History** — telemetry and alerts persisted in SQLite, survives restarts
- **Localization** — 简体中文 / English / 日本語 / 한국어 / Tiếng Việt across
  UI and documentation
- **In-app auto-update (Windows)** — powered by `electron-updater`, with the
  manifest and artifacts hosted on GitHub Releases
- **Prometheus export** — `/metrics` endpoint for external scrapers

### Known limitations

- **No auto-update on macOS** — the app is unsigned (no Apple Developer
  certificate) and Squirrel.Mac's signature verification is unreliable.
  macOS users update by downloading the new dmg manually.
- **macOS builds are unsigned / unnotarized** — the first launch requires an
  explicit allow in *System Settings → Privacy & Security*.
- **Auto-update is Windows-only** — Linux and macOS are manual-download installs.

### Distribution

- Windows: `DishyWarden-Setup-1.0.0.exe` (NSIS, per-machine, requires
  administrator rights)
- macOS: `DishyWarden-1.0.0-mac-arm64.dmg` / `DishyWarden-1.0.0-mac-x64.dmg`
- A `sha512` checksum is published next to every artifact
