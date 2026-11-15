# Privacy Policy

_Last updated: %YEAR%_

DishyWarden is a desktop monitoring tool for Starlink terminals. It is designed so
that **your telemetry stays on your machine**. This document explains the only two
cases where something is sent off your machine, and how to switch each of them off.

---

## 1. What never leaves your machine

The following are stored **locally only** and are never transmitted:

| Data | Where it lives |
|---|---|
| Telemetry samples (signal, latency, throughput, availability) | `telemetry.db` (SQLite) in your user-data directory |
| Alerts and their lifecycle | `alerts.db` (SQLite) in your user-data directory |
| Settings, probe nodes, notification configuration | a plain JSON file in your user-data directory |
| Notification credentials (Telegram bot token, webhook URL, e-mail password) | the same local JSON file |

The server never receives your account, your notification credentials, your file
paths, or your host names.

## 2. The two outbound channels

### 2.1 Update check — automatic, minimal

To tell you that a new version exists, the app contacts the update manifest on
`cloud.dishywarden.com` and reports the result.

**Sent:** an anonymous `client_id` (a random UUID v4 generated on your machine),
the app version, the platform, and the IP address the request came from.

**Not sent:** anything listed in section 1.

**Retention:** update events are deleted after 90 days. Access logs are rotated at
14 days.

**How to switch it off:** set the update feed URL to empty in
*Settings → Upgrade & feedback*, or run the app with the cloud endpoint cleared.
The app then never contacts the cloud at all.

### 2.2 False-positive report — off by default, requires your consent

If you mark an alert as a false positive, the app can send an anonymised report so
that the alert rules can be tuned. **This is disabled by default.**

**Sent:** the alert type, its severity, its title, your optional note, the app
version, the platform, the anonymous `client_id`, the IP address, and — only if
your settings still contain a location — your coordinates.

**Not sent:** your account, notification credentials, file paths, host names, or any
other telemetry.

**Retention:** feedback is deleted after 90 days.

**How to switch it off:** leave *Settings → Upgrade & feedback → Report false
positive samples* disabled. The very first upload asks for explicit confirmation
and shows exactly which fields will be sent. You can also clear the cloud endpoint
to disable every outbound request.

## 3. How the reports are anonymised

- `client_id` is a random UUID v4 generated locally. It is **not** derived from
  hardware identifiers, your account, or your network identity, and it cannot be
  linked back to you by the server.
- A field whitelist is enforced **on the client and again on the server**. Fields
  that are not on the list are dropped, even if a caller sends them.
- The cloud endpoint is rate-limited per IP address.

## 4. Where the data is processed

The cloud service runs on a single server operated by the project maintainers,
located in Japan. It stores the data described above in append-only JSON files,
grouped by UTC day.

## 5. Do Not Track / cookies

DishyWarden is a desktop application. It sets no cookies, runs no trackers, embeds
no analytics, and no third-party service receives your data.

## 6. Your rights

Because the data is either anonymous or voluntarily submitted, and is deleted on a
short schedule, you can exercise your rights simply by:

- switching off the channels in section 2, and/or
- clearing the cloud endpoint in the settings, and/or
- asking the maintainer to delete a specific `client_id` from the stored events.

To request deletion of your data, open an issue on the repository or contact the
maintainer directly.

## 7. Changes to this policy

Material changes will be announced in the release notes of the version that
introduces them, and the "last updated" date above will change.

## 8. Contact

Questions about privacy can be raised as an issue in the repository, or sent
directly to the maintainer.

---

See also the [README](README.md) for a feature overview and build instructions.
