# Event fixtures

- `provisional-v2.ndjson` — hand-written (kept because it covers every detection status). Shaped from OpenCode V2's source
  (`packages/cli/src/run/noninteractive.ts`, `packages/core/src/tool/plugin/skill.ts`), not captured from a
  real run.
- `golden-v2.ndjson` + `golden-v2.meta.json` — the real `opencode run --format json` output from the pinned
  OpenCode, produced by `bun scripts/capture-events.ts` (captured 2026-11-14). `test/events.golden.test.ts`
  asserts detection against it. Re-capture when the OpenCode pin changes.
