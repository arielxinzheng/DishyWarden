# E2E status: the suite exists but cannot start the app

**Status:** blocked — the Playwright suite in `tests/e2e/` (5 spec files, 18
tests) cannot launch the Electron app, locally or in CI. The unit suite (597
tests), both type checks and both builds are the real gate and all of them
pass.

## What happens

Every test dies in the first step, before any assertion runs:

```
Error: Process failed to launch!
Error: electron.launch: Process failed to launch!
  [err] .../Electron: bad option: --remote-debugging-port=0
```

## Root cause

`playwright-core`'s Electron launcher builds its argument list as:

```js
// node_modules/playwright-core/lib/server/electron/electron.js
let electronArguments = ['--inspect=0', '--remote-debugging-port=0', ...args];
```

The switches come **before** the app path. In that position Electron's Node
runtime parses them as Node options, and Node does not know
`--remote-debugging-port` — so the binary exits with `bad option` and the
process never starts.

Two things make this worth writing down:

- **It is not a Playwright regression.** Every Playwright release from 1.30 to
  1.64 passes that switch in that position, so downgrading `@playwright/test`
  does not help. (Verified by inspecting the `playwright-core` tarballs.)
- **Electron 33 does accept the switch — after the app path.**
  `Electron dist-electron/main/index.js --remote-debugging-port=9222` parses
  fine; it is only the leading position that the Node CLI rejects.

## The second blocker (CI only)

Even with the launch fixed, the suite needs a display on `ubuntu-latest`.
Electron requires an X server, so the CI job would need `xvfb-run` in addition
to the renderer and main-process builds.

## Fix options

| Option | What it costs | Notes |
|---|---|---|
| **A. Launch manually and attach over CDP** | Rewrite `launchElectron()` in `tests/e2e/helpers.ts`: spawn `Electron dist-electron/main/index.js --remote-debugging-port=<port>`, wait for the endpoint, then `chromium.connectOverCDP()`. | Works with Electron 33 as-is. Loses `ElectronApplication.evaluate()` (main-process evaluation) — the suite does not use it today, only `app.close()`. Needs the renderer build (`npx vite build`) and `npm run electron:build` in the CI job. |
| **B. Upgrade Electron** | Upgrade to a major that accepts the switch in the leading position. | Also moves the native-module ABI (better-sqlite3 must be rebuilt for the new Electron ABI), which invalidates the pinned release chain until it is re-validated. Much larger than it looks. |
| **C. Leave it blocked** | Nothing. | The 18 assertions stay unverified; the unit suite covers the logic. |

Option A is the proportionate fix and is a self-contained piece of work in
`tests/e2e/helpers.ts` plus two build steps in `.github/workflows/ci.yml`.

## Interim state

The CI job is **disabled rather than red**, so that the blocking gate
(`Typecheck · Test · Build` and `Repository hygiene`) stays meaningful instead
of being buried under an unrelated failure:

```yaml
  e2e:
    name: E2E (disabled — Playwright/Electron incompatibility, see docs/E2E-STATUS.md)
    if: false
```

## Reproducing the diagnosis

```bash
# The launcher passes the switch in the leading position:
grep -n "remote-debugging-port" node_modules/playwright-core/lib/server/electron/electron.js

# Electron 33 rejects it there …
node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  --remote-debugging-port=9222 --version
# → bad option: --remote-debugging-port=9222

# … and accepts it after the app path:
node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  dist-electron/main/index.js --remote-debugging-port=9222 --version
# → no "bad option"; the app starts
```
