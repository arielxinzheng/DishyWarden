## What & why

<!-- One or two sentences: what changes, and why. -->

## Verification

- [ ] `npx tsc --noEmit -p tsconfig.json`
- [ ] `npx tsc --noEmit -p tsconfig.electron.json`
- [ ] `npx vitest run`

## Checklist

- [ ] Changes under `src/main/**`, `src/core/**` or `src/storage/**` were verified
      in the **Electron window** — main-process changes do not hot-reload
- [ ] New or changed UI strings were added to **all five** locales
      (`zh-CN`, `en`, `ja`, `ko`, `vi`) — `keys.test.ts` must stay green
- [ ] `npmRebuild: false` in `package.json` was left untouched
- [ ] `README.md` / `PRIVACY.md` were **not edited directly** — if they need
      changes, edit the sources under `docs/readme/` / `docs/privacy/` and run
      `npm run docs:generate`
- [ ] No machine-local absolute paths (home-directory prefixes) and no credentials
      in the diff
