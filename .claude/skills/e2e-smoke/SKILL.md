---

name: e2e-smoke
description: Run pi-share's end-to-end smoke test in headless Chrome (setup, create link, password, service-worker download with hash check, activity counters) and inspect the screenshots. Use before merging UI, edge, broker or crypto changes, or when asked to check that the whole flow still works.
---

1. `pnpm build` (the test serves `dist/`).
2. `pnpm e2e`. It starts its own admin, broker and edge on ports 18080/18787 with temporary data, so it does not
   touch a running instance. `COLOR_SCHEME=light pnpm e2e` for the light theme, `CHROME_PATH=...` for another browser.
3. On failure the last state of every page is saved as `e2e/.out/shots/failure.png`: read it before guessing.
4. On success read the screenshots in `e2e/.out/shots` that relate to the change, at both widths.

The test is the contract for the user-visible flow: when a flow changes on purpose, update `e2e/smoke.mjs`
in the same commit.
