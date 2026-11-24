# Changelog

This project follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/).

> **1.0.0 is the first public release.** This file records changes from the
> public release onward; the pre-release iteration history is not part of this
> repository.

---

## [Unreleased]

---

## [1.0.1] — 2026-11-24

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
- **The sky view no longer dropped the serving satellite, the candidates and the
  beam.** A real terminal reported its beam azimuth as a negative angle, and the
  polar chart has a fixed 0 to 360 degree axis, so every point outside that
  range was dropped without an error. Since the serving satellite, the
  candidates and the beam sit at almost the same bearing, a negative bearing
  removed exactly those three layers at once while the visible satellites
  carried on being drawn. Bearings are now wrapped into the axis range, the
  chart always creates all four layers instead of adding them conditionally,
  and the beam no longer goes missing because a timed refresh had captured an
  earlier reading.
- **The dashboard remembered the selected collection period.** The range was
  reset to the default on every start, so the view the user had chosen was
  gone the next morning.
- **Interruptions were no longer dropped because of an assumed timestamp
  unit.** The unit of the device timestamps was inferred from their magnitude,
  which silently misread a nanosecond clock as milliseconds and pushed every
  event far into the future. The unit is now detected, the outage anomalies are
  logged so a remote run can reveal what a terminal actually sends, and the
  events reach the chart instead of vanishing.
- **The interruptions a terminal reports are now read in the shape it reports
  them.** A real terminal sends the start time and duration in nanoseconds
  under different field names than the mock does, and it states outright
  whether a satellite was handed over. The parser accepts both spellings, keeps
  the nanosecond magnitude so the unit can be detected, and trusts the device
  flag instead of guessing from the duration.
- **A terminal with a wrong clock no longer hides its interruptions.** One
  terminal reported timestamps from 2016 and an uptime counter where an epoch
  was expected, so the correction landed on the wrong clock and pushed every
  event into 2073. The clock is now only trusted when it is plausible, and
  events are moved onto the wall clock against the device's own reading of the
  present, with the derived offset pinned so the same event is not rewritten
  on every poll.
- **Interruptions that are really physical problems stay with the alerts.** The
  device flags a satellite handover alongside every interruption, including
  obstruction, which had swallowed all of them and left the obstruction alerts
  with nothing to report. Physical causes now stay on the alert path.
- **The handoff markers are no longer keyed by a timestamp the device can
  make collide.** Rows are now keyed by the device's own clock reading, so
  events with the same corrected instant cannot overwrite each other, and an
  event without a usable clock identity is rejected with a warning instead of
  being written and lost.
- **The gateway latency is measured once.** The settings page and the history
  store each ran their own silent probe, so one of them could fail while the
  other looked healthy and the chart showed nothing. Both now read the same
  probe result, and the gateway dimension explains that it is a local link and
  therefore carries no satellite handover.
- **The empty chart says when the last handover happened.** Previously it could
  only report that the selected range held no records, which is
  indistinguishable from a broken pipeline.

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
