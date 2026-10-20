# Goal summary input and key report

## Failure modes, recorded before implementation

The public seams are `goalSummaryIdentity`, `goalSummaryKey`, and
`goalSummaryPrompt`. All reasons in the tests are synthetic. No reasons from the
private study data are copied into the repository.

- More checks on a confirmed blocker change the key because of counts, times,
  drifting wording, or a changed central reason.
- A new blocker or progress check reuses the old key.
- Pause, a changed pause reason, resume, met, or cleared reuses the old key.
- Pause and resume between opens return to an earlier active key.
- A different session, goal set time, condition, or model reuses the old key.
- Separator characters in identity fields cause key collisions.
- Equivalent lifecycle objects produce different keys because property insertion
  order differs.
- Confirmed runs lose their first unconfirmed checks, central reason, time range,
  or count, or repeat those checks as individual segments.
- Individual checks or separate runs disappear, merge, or appear out of order.
- Old history exceeds eight segments or 8,000 JSON characters without an omission
  notice.
- One oversized reason exceeds the character limit, disappears entirely, or is
  shortened without a notice.
- A differing latest raw reason disappears behind its run representative, or an
  identical latest reason is redundantly sent again.
- A missing reason crashes prompt construction or invents evaluator evidence.
- `clock rollback preserves raw evidence and a stable key as the blocker continues`:
  decreasing stored wall-clock times crash the detector or rewrite prompt times.
- Quoted instructions in the condition, pause reason, or check reason escape the
  data payload or become model instructions.
- The prompt omits goal/lifecycle context, confuses a pause reason with a
  historical blocker, decides completion itself, or requests markdown, a list,
  or more than 60 words.

## Scope

- Pure module: `src/lib/persistence/goal-summary-input.ts`.
- Tests: `test/unit/persistence/goal-summary-input.test.ts`.
- The parent task owns the service, handler, cache, and full verification gates.
- The stuck detector is supplied separately at
  `src/lib/persistence/goal-stuck-detector.ts` with `minChecks: 3` at this call site.

## Verification

All commands used this environment and stdin from `/dev/null`, with log output
byte-capped and the original exit code preserved:

```sh
export npm_config_verify_deps_before_run=false pnpm_config_verify_deps_before_run=false STORYBOOK_PORT=6397 ACCEPTANCE_PORT=4397 PATH=/tmp/redesign/oc-1.19.1/node_modules/.bin:$PATH
```

- `mise exec -- pnpm exec vitest run test/unit/persistence/goal-summary-input.test.ts`
  initially failed because the production module did not yet exist. The first
  implementation passed all 22 tests. A subsequent lifecycle property ordering
  test failed before its implementation. The slice run passed all 23 tests.
  A later clock-rollback regression failed with the reference detector's
  ordering error before caller normalization; the final combined run passed
  all 24 input/key tests, 16 service tests and 18 session RPC tests.
- `mise exec -- pnpm exec biome check --write src/lib/persistence/goal-summary-input.ts test/unit/persistence/goal-summary-input.test.ts`
  passed, formatting the test file.
- `mise exec -- pnpm exec tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --strict --skipLibCheck src/lib/persistence/goal-summary-input.ts test/unit/persistence/goal-summary-input.test.ts`
  passed.

The key test also proves the representative changes as a synthetic run grows,
while the key stays the same. Tests inspect the generated JSON evidence for
chronological runs, dropped history, reason truncation, and quoted instructions.

## Changes

`goalSummaryIdentity` serialises the session, set time, and condition as an
unambiguous tuple. `goalSummaryKey` adds canonical lifecycle fields, the
consecutive-deduplicated causal verdict signature, `goal-summary-v1`, and model.
It excludes changing run counts, timestamps, raw wording, and representatives.
The optional lifecycle transition epoch lets the service distinguish active
states separated by a pause and resume.

`goalSummaryPrompt` compresses confirmed runs and keeps singleton checks in
chronological order. It retains at most eight segments and at most 8,000 JSON
characters for history, including the optional latest raw reason. If one reason
alone exceeds that budget, it retains a marked prefix. Goal and lifecycle data
are JSON-quoted beside the history. Instructions ask for at most 60 words of
plain text, what is done and left, and the specific blocker.

## Risks

The prompt asks the model to treat quoted evidence as data; no prompt can prove
that every model response follows that instruction. Input history is bounded,
and any omitted history or shortened reason is explicitly marked.
