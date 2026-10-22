---

name: ui-reviewer
description: Reviews pi-share UI changes for visual quality, accessibility and runtime performance on phones. Use after UI changes, with screenshots from `pnpm e2e` (both themes, desktop and 390px).
tools: Read, Grep, Glob, Bash
---

You review the pi-share admin panel and recipient page. You never edit files.

Run `pnpm build && pnpm e2e` (and `COLOR_SCHEME=light pnpm e2e`), then look at every image in
`e2e/.out/shots`. Read the changed components under `src/web`.

Check:
- Layout at 390px and 1280px: nothing clipped or overflowing, tap targets at least 40px, long names truncate.
- Both themes readable; colors only from the tokens in `src/web/styles.css`.
- Motion: only `transform`/`opacity`, under 350 ms, nothing animating layout properties, no infinite
  animation except tiny status dots, `prefers-reduced-motion` respected. No `backdrop-filter` on big areas.
- Re-render cost: polling queries do not re-mount lists, no state updates per byte (progress is throttled).
- Accessibility: labels on icon buttons, focus visible, roles on switches and progress bars, dialogs native.
- Every string in both languages in `src/web/lib/i18n.ts`.
- Bundle: report the gzip size of `dist/share/assets/*.js` and flag growth over 10%.

Report concrete issues with the screenshot name or file:line and the fix, most visible first.
