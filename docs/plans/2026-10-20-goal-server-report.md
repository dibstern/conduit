# Goal sheet server report

Ticket: `conduit-test-aoqb.41`. Workspace: `conduit-rd-goal-srv`, branch
`rd/goal-srv`, starting contract `4436aef95` (`rd/goal-base`). No frontend changes.

## Failure modes

All failure modes were recorded and synthetic tests written before their
implementation. Details and test names are in the [detector/projection report](2026-10-20-goal-stuck-report.md),
[input/key report](2026-10-20-goal-summary-input-report.md), and
[service report](2026-10-20-goal-summary-service-report.md).

- Drifting wording splits a blocker, two checks announce Stuck too early,
  progress/gaps/missing reasons fail to break it, or context changes are merged.
- Run ids change with extra checks, future evidence rewrites earlier verdicts,
  invalid detector input is silently accepted, or clock rollback breaks callers.
- Other sessions/goals contaminate a run, resyncs double-count, replay differs,
  lifecycle clearing is lost, or clients see a check before its header state.
- Migration changes shipped history, loses old rows, or initializes old sessions
  with a false stuck state.
- Counts, representative wording or more checks on one blocker invalidate a
  summary; progress, lifecycle, identity, model or pause/resume do not invalidate it.
- Prompt compression loses individual progress, ordering, raw latest evidence,
  lifecycle/pause context or omission notices, exceeds its budget, or treats
  quoted reasons as instructions.
- Reading details spends quota, concurrent opens spend twice, or a late result
  claims to cover new checks or overwrites a newer generation.
- Off/no-check/error/empty/timeout paths call Claude, leak private errors, cache
  failures, or leave a key reserved forever after cancellation.
- Cache retention is unbounded, eviction is not LRU, or the wrong model/account
  is selected. Missing-session/provider RPC guards disappear.

## Changes

- `src/lib/persistence/goal-stuck-detector.ts`: one pure, dependency-free file
  preserving the reference API. Product callers select `minChecks: 3`.
  Per-invocation vector memoization preserves results and keeps optimization
  inside the replaceable detector body.
- `src/lib/persistence/migrations/0068_sessions_goal_stuck.sql`: the only new
  migration, adding nullable `sessions.goal_stuck`. Its Effect registry key is
  `0069`, following the pre-existing code-only migration offset.
- `src/lib/persistence/effect/projectors-effect.ts`: derives the current run
  from the matching goal's ordered checks before the same version is published.
  Projection replay uses the event's check prefix. Met, clear and replacement
  clear the field; pause retains it.
- `src/lib/persistence/effect/read-query-effect.ts`: maps the column to
  `SessionInfo.goalStuck`. Associated schema/row metadata is appended.
- `src/lib/persistence/goal-summary-input.ts`: stable identity/key, lifecycle
  signature and bounded JSON evidence from detector runs and individual checks.
  Clock rollback is normalized only for detection; prompt evidence retains raw times.
- `src/lib/domain/relay/Services/goal-summary-service.ts`: per-relay 200-identity
  LRU, captured-key results, shared in-flight requests, 60-second timeout, recap
  model preference and daemon default Claude login through `makeClaudeOneShot`.
  Durable lifecycle transition sequences invalidate pause/resume between opens.
  Worker startup is atomic and work belongs to the relay scope.
- `src/lib/server/ws-rpc/sessions.ts`: replaces the summary stub and returns
  summary metadata from `GetGoalDetails` without generation. Details and summary
  metadata share a database snapshot.
- `src/lib/relay/project-relay-layers.ts`: constructs the summary service with
  the existing one-shot test seam and surfacing preferences.

## Verification protocol

Every pnpm invocation used the following exported environment, stdin from
`/dev/null`, `mise exec --`, redirected logs with byte-capped display, and its
original exit code. Gate and commit subprocess timeouts are 1,800 seconds.

```sh
export npm_config_verify_deps_before_run=false pnpm_config_verify_deps_before_run=false STORYBOOK_PORT=6397 ACCEPTANCE_PORT=4397 PATH=/tmp/redesign/oc-1.19.1/node_modules/.bin:$PATH
mise exec -- pnpm install --frozen-lockfile --offline </dev/null
mise exec -- pnpm check </dev/null
mise exec -- pnpm lint </dev/null
mise exec -- pnpm test:unit </dev/null
mise exec -- pnpm build </dev/null
```

Installation passed. Gate results and isolated integration commands are recorded
below. Commit ids are returned in the final handoff.

Final gate results:

| Command | Result |
| --- | --- |
| `mise exec -- pnpm install --frozen-lockfile --offline </dev/null` | Pass |
| `mise exec -- pnpm check </dev/null` | Pass; zero Svelte errors/warnings |
| `mise exec -- pnpm lint </dev/null` | Pass; existing informational warnings remain |
| `mise exec -- pnpm test:unit </dev/null` | Pass; 689 files, 9,558 passed, 2 skipped, 11 TODO |
| `mise exec -- pnpm build </dev/null` | Pass |

The first full unit run exposed eight expected schema fixture failures. Existing
migration lists were appended and the recorded replay snapshot gained only
`goal_stuck: null`; no recorded reasons were regenerated. The corrected six-file
focused run passed 51 tests, then the complete unit gate passed. Gate logs and
exit codes are retained in `test-results/aoqb41-verification/`.

Post-build integration specs run individually, using the same environment above:

```sh
CONDUIT_TEST_DIST=dist mise exec -- pnpm exec vitest run --config vitest.integration.config.ts test/integration/daemon/goal-details.test.ts </dev/null
CONDUIT_TEST_DIST=dist mise exec -- pnpm exec vitest run --config vitest.integration.config.ts test/integration/persistence/store-tier.test.ts </dev/null
CONDUIT_TEST_DIST=dist mise exec -- pnpm exec vitest run --config vitest.integration.config.ts test/integration/persistence/shared-store-scope.test.ts </dev/null
CONDUIT_TEST_DIST=dist mise exec -- pnpm exec vitest run --config vitest.integration.config.ts test/integration/persistence/daemon-store-import.test.ts </dev/null
CONDUIT_TEST_DIST=dist mise exec -- pnpm exec vitest run --config vitest.integration.config.ts test/integration/persistence/daemon-store-import-failures.test.ts </dev/null
CONDUIT_TEST_DIST=dist mise exec -- pnpm exec vitest run --config vitest.integration.config.ts test/integration/daemon/recap-process.test.ts </dev/null
```

All six commands passed individually, 94 tests total:

| Spec | Passed |
| --- | ---: |
| `test/integration/daemon/goal-details.test.ts` | 3 |
| `test/integration/persistence/store-tier.test.ts` | 3 |
| `test/integration/persistence/shared-store-scope.test.ts` | 27 |
| `test/integration/persistence/daemon-store-import.test.ts` | 2 |
| `test/integration/persistence/daemon-store-import-failures.test.ts` | 58 |
| `test/integration/daemon/recap-process.test.ts` | 1 |

The extended goal-details spec verifies three translated SDK checks populate
`SessionInfo.goalStuck` and a met event clears it. Unit read-model advance tests
verify the field is present in the same committed session update. The summary
service and RPC tests use fake one-shots; no paid Claude prompt was needed.

## Measured projection cost

The final implementation measures the full check commit, including reading
2,500 synthetic checks, projection, version stamping and publication. It uses
453-character reasons, five warmups and 40 samples on Node v26.10.0,
darwin/arm64. Both cases call the full detector, without a projector shortcut.

| Case | Wall median | Wall p95 | Wall max | CPU p95 |
| --- | ---: | ---: | ---: | ---: |
| Identical wording | 4.708 ms | 9.053 ms | 9.881 ms | 13.405 ms |
| Drifting wording | 4.680 ms | 11.834 ms | 47.715 ms | 12.966 ms |

The initial uncached path exceeded 30 ms. Vector memoization within one detector
invocation reuses each distinct reason's token vector without changing results.
A projector shortcut was rejected because it coupled the caller to this
detector's internal algorithm. Both final wall p95 measurements are below 30 ms;
the maximum wall outlier remains explicit. This is not a strict scheduling bound.

Reproduction and every sample are in `test-results/goal-stuck-projection.json`:

```sh
GOAL_STUCK_BENCHMARK=1 mise exec -- pnpm exec vitest run test/unit/persistence/goal-stuck-effect.test.ts </dev/null
```

## Review

Independent reviews inspected summary caching/concurrency/RPC behavior and
detector/projection/migration behavior. The summary worker-start cancellation
gap was fixed and re-reviewed without further material findings. The detector
review compared 2,000 deterministic synthetic cases/options with the reference;
all matched. The final projector uses the detector API without algorithm-specific
continuation assumptions, preserving the future file-body replacement seam.

## Residual risks

The detector is advisory; repeated evaluator wording does not prove useful work
has stopped. The model is prompted to respect quoted evidence and the 60-word
plain-text limit; those instructions are not a deterministic output guarantee.
Cache entries intentionally disappear on relay restart. Raw historical clock
rollback can make a displayed last time precede its first time. Wall-clock
benchmark outliers on a shared machine are reported separately from CPU work.
