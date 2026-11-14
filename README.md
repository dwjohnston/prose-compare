# Prose Skill Comparer

Runs one prompt against several sets of `SKILL.md` files and shows the outputs side by side, with a check on
whether each skill actually triggered (read from the harness's tool-call events). [SPEC.md](SPEC.md) is the
source of truth.

## Layout

| Path | What |
| --- | --- |
| `src/index.ts` | Worker entry: app/API (`fetch`), lane runner (`queue`), `LaneSandbox` and `Outbound` exports |
| `src/app.ts`, `src/submit.ts`, `src/auth.ts` | Routes, submit / run again, password gate |
| `src/github/` | Link parser, SHA resolver, contents-API folder fetcher |
| `src/skills/` | Folder rules (paths, caps, frontmatter, names) and content-addressed snapshots |
| `src/config/harness.ts` | OpenCode V2 pin, env flags, permissions config (`OPENCODE_CONFIG_CONTENT`) |
| `src/runner/` | Sandbox DO, outbound Worker + policy, materialise plan, event parser + detection |
| `src/queue.ts`, `src/db.ts` | Queue consumer, D1 rows and R2 keys |
| `src/render/` | Output renderer Worker (separate origin, `wrangler.render.jsonc`) |
| `public/` | Client JS/CSS, served under `/static/` |
| `migrations/` | D1 schema |
| `test/` | Unit tests, hostile skills (`test/hostile`), event fixtures (`test/fixtures/events`) |
| `scripts/` | `capture-events.ts`, `hash-password.ts`, `ci-provision.ts` |

## Develop

```bash
bun install
bun run check          # typecheck + tests
npx wrangler d1 migrations apply DB --local
npx wrangler dev --enable-containers=false   # pages + API; lanes need a real sandbox
```

For local dev, put `APP_PASSWORD_HASH`, `OPENROUTER_TOKEN` and `RENDER_ORIGIN=http://localhost:8788` in
`.dev.vars` (gitignored), and run the renderer with
`npx wrangler dev -c wrangler.render.jsonc --port 8788 --inspector-port 9332 --persist-to .wrangler/state`
plus `APP_ORIGIN=http://localhost:8787`.

## Deploy

GitHub Actions (`.github/workflows/ci.yml`) runs typecheck, tests and wrangler dry-run builds on every PR.
On pushes to `main` it creates the D1 database, R2 bucket and queue if missing, applies migrations and
deploys both Workers, using the repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

Worker secrets (once, before the first deploy):

```bash
npx wrangler secret put OPENROUTER_TOKEN
```

```bash
bun scripts/hash-password.ts | npx wrangler secret put APP_PASSWORD_HASH
```

Optional: `npx wrangler secret put GITHUB_TOKEN` (a read-only token for public repos) raises GitHub's API limit
from the 60/hour shared by unauthenticated Workers traffic.

Sandboxes need the Workers Paid plan.

## Golden event log

The event parser was written against a provisional, hand-written fixture. To capture the real one from the
pinned OpenCode V2 (one short Sonnet 5.5 run, a few cents):

```bash
OPENROUTER_API_KEY=<your key> bun scripts/capture-events.ts
```

Add `--docker` to run inside the sandbox image instead of the native binary. Commit
`test/fixtures/events/golden-v2.ndjson` and `golden-v2.meta.json`; `test/events.golden.test.ts` then asserts
against them.
