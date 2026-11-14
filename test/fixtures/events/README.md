# Event fixtures

- `provisional-v2.ndjson` — **PROVISIONAL, hand-written.** Shaped from OpenCode V2's source
  (`packages/cli/src/run/noninteractive.ts`, `packages/core/src/tool/plugin/skill.ts`), not captured from a
  real run. The parser tests use it until a golden log exists.
- `golden-v2.ndjson` + `golden-v2.meta.json` — the real `opencode run --format json` output from the pinned
  OpenCode, produced by `bun scripts/capture-events.ts`. When present, `test/events.golden.test.ts` asserts
  detection against it. To swap the parser over, nothing else needs changing; if the golden test fails,
  fix the field lookups in `src/runner/events.ts`.
