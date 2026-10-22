# pi-share

Self-hosted share links for files that already live on a disk, end-to-end encrypted. Read `README.md` for the
architecture and the threat model before changing anything that touches the broker, the edge or the crypto.

## Commands

- `pnpm test` (Vitest), `pnpm typecheck`, `pnpm lint` (Biome), `pnpm build` (admin, share page, service worker)
- `pnpm e2e` after `pnpm build`: real headless Chrome through the whole flow, screenshots in `e2e/.out/shots`
- `pnpm db:generate` after changing `src/server/db/schema.ts`; commit the generated migration in `drizzle/`

All five must pass before a commit lands on `develop`.

## Conventions

- TypeScript run natively by Node (type stripping): erasable syntax only, so no enums, no namespaces, no
  constructor parameter properties; relative imports end in `.ts`.
- Validate every input with Zod at the boundary (`src/shared/api.ts` holds the shared schemas and types).
- Few comments: only for the non-obvious why. No commented-out code.
- Git: GitFlow (`feature/*` from `develop`, merged with `--no-ff`; releases to `main`), Conventional Commits in English.

## Security invariants (never break these)

- The edge (`src/server/edge.ts`) never touches the disk or the database and has no network in production;
  it only forwards to the broker. Anything that decides access lives in the broker.
- The link key exists only in the URL fragment and in the admin's sealed column. Never log it, never send it
  to a server, never put it in a query string. Same for tickets and password verifiers in logs.
- Files are read only through `Storage`, which refuses traversal, symlinks, hidden and denied paths.
- A changed nonce scheme, record format or key derivation is a breaking change of the wire format: bump the
  `v1` labels in `src/shared/wire.ts` and keep both sides in sync (tests in `test/crypto.test.ts`).
- Responses from the edge carry `no-store` (except hashed assets) and the strict CSP set in `buildEdge`.

## UI

- Tailwind 4 tokens live in `src/web/styles.css`; use them instead of raw colors. Both themes must work.
- Animate only `transform` and `opacity`, keep durations under 350 ms, no animation libraries,
  no `backdrop-filter` on large areas. `prefers-reduced-motion` is honoured globally.
- Every user-facing string goes through `src/web/lib/i18n.ts` in both English and Italian.

## Agents

- `.claude/agents/security-reviewer.md`: run it on any change to `src/server`, `src/shared` or `src/web/sw.ts`.
- `.claude/agents/ui-reviewer.md`: run it on UI changes, with fresh screenshots from `pnpm e2e`.
