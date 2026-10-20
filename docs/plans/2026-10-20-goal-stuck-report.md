# Goal stuck projection: failure modes and evidence

Ticket: conduit-test-aoqb.41. All reasons in the tests and measurements are synthetic.

The public seams under test are the reference detector API, persisted session projection/read models, and the existing daemon goal-details integration path.

## Failure modes recorded before implementation

Detector test names:

- `recognises synthetic blockers despite drifting wording`: wording drift splits the same blocker.
- `waits for three consecutive checks at the product threshold`: two checks produce an early Stuck header.
- `a progress check ends the current stuck run`: progress is hidden by an old confirmed blocker.
- `keeps run ids stable as a blocker continues`: extra repeated checks change a confirmed run's identity.
- `does not change earlier verdicts when later checks arrive`: future checks rewrite earlier verdicts.
- `missing reasons and iteration gaps end a run`: unknown history is mistaken for consecutive evidence.
- `changed revisions and question sets separate otherwise similar blockers`: a material context change is swallowed by similarity.
- `rejects invalid check ordering and detector options`: corrupt ordering silently produces a result.

Projection test names:

- `publishes goalStuck with the third repeated check and clears it on progress`: storage, read mapping or commit notification omits the updated run, or a progress check leaves it set.
- `keeps goalStuck while paused and clears met, cleared and replaced goals`: lifecycle transitions show an obsolete header or lose a paused blocker.
- `isolates checks by session, setAt and condition and ignores duplicate resyncs`: another goal or duplicate event changes the run.
- `a projection rebuild produces the same goalStuck`: replay depends on mutable process state or includes future checks.
- Existing `orders checks by iteration and maps timestamps and nullable reasons`: a wall-clock regression must not reject an otherwise ordered goal check or corrupt raw history times.
- `repeated checks match full replay after wording changes and iteration gaps`: repeated checks change detector results or hide a gap/context change.
- `a goal check announces goalStuck in the same session update`: a committed check publishes before the header is available at the announced row version.
- `upgrades existing sessions with a nullable goal_stuck column`: the next migration breaks existing data or defaults an old session to stuck.
- `reports the per-check projection cost with 2500 synthetic checks`: full-history detection adds more than the 30 ms budget per check.

Integration test name:

- `projects a stuck header after three SDK checks and clears it when met`: real SDK translation, projection or session-info delivery loses Stuck or does not clear completion.

Summary/key/service test names:

- `continuing a confirmed blocker keeps the summary key`: extra checks or a changed central reason invalidate a reusable summary.
- `new blockers, progress, pause, resume and completion change the key`: a material change reuses obsolete text.
- `goal identity, pause reason, prompt version and model isolate cache keys`: unrelated goals or settings share summaries.
- `segments preserve chronological runs and standalone checks`: compression omits progress or duplicates a confirmed run.
- `quotes untrusted reasons and reports dropped older history within the input budget`: reasons become instructions, historical blockers replace the current pause reason, or input grows without bounds.
- `details only reads cached summaries and the enabled preference`: opening details unexpectedly spends model quota or hides disabled summaries.
- `reopening the same blocker makes no additional model calls`: cache misses spend quota on unchanged evidence.
- `a meaningful change makes one new model call`: stale text cannot refresh.
- `concurrent requests share one model call per key`: simultaneous opens duplicate model work.
- `a check during generation returns the captured summary as stale`: late completion claims to cover newer evidence.
- `older concurrent completions cannot overwrite a newer summary`: out-of-order model responses discard the latest result.
- `summaries off rejects generation without calling the model`: disabled settings still spend quota.
- `no checks rejects generation without calling the model`: a model invents progress without evidence.
- `failed, empty and timed out summaries return short RPC errors and allow retry`: failures poison the cache or leak provider errors.
- `evicts the least recently used goal after 200 entries`: an unbounded relay cache leaks memory or evicts the wrong goal.
- `uses the summary model and daemon default Claude login`: goal account or title-model defaults route quota incorrectly.

## Implementation

- `src/lib/persistence/goal-stuck-detector.ts` ports the dependency-free reference API. Defaults and exports are unchanged; product callers pass only `{ minChecks: 3 }`. Token vectors are memoised by raw reason within each invocation; no state survives the call.
- `src/lib/persistence/migrations/0068_sessions_goal_stuck.sql` adds nullable `sessions.goal_stuck`. Effect registry key `0069_sessions_goal_stuck` follows the existing one-key offset caused by the code-only migration at key 10. `schema.ts`, migration lineage expectations, and the append-only hash guard register it; existing SQL files and hashes remain unchanged.
- `src/lib/persistence/effect/projectors-effect.ts` computes the current identity's check prefix in iteration order before the session's existing version stamp. It stores `{since,lastAt,count}` or NULL in the same transaction as the check. The existing advance therefore announces both facts together. Met, cleared and replacement facts clear the header; pauses retain it.
- `src/lib/persistence/effect/read-query-effect.ts` decodes the stored field through `GoalStuckSchema` into session info. Sidebar and detail readers share this projection.
- Every active-goal projection calls the detector over the full persisted check prefix. Algorithm-specific shortcuts stay out of the projector, so replacing the detector file body leaves callers intact. Vector reuse within the detector incrementally computes tokenisation once per distinct raw reason during each invocation.
- Check iteration defines chronology. Existing histories can contain a wall-clock regression, so detector-only timestamps use the cumulative maximum; displayed `since` is remapped by `sinceIteration`, and `lastAt` comes from the latest raw check. Raw history is never rewritten. Rebuilds derive the same header from persisted events.

## Performance

The initial full-history implementation exceeded the budget: p95 **37.88 ms** for one committed check on a 2,500-check synthetic goal. This triggered per-invocation vector memoisation inside the detector. An attempted caller shortcut was rejected because it coupled projection to the detector's current centroid algorithm; the final projector always uses the detector API over full history.

The repeatable benchmark seeds 2,499 checks, then measures the actual append/project/stamp/sidebar transaction for check 2,500. It excludes setup and reset writes, uses 453-character synthetic reasons, and records five warmups plus 40 measured samples per case. It checks both identical reasons and a wording change against a history cycling three related reasons. Both cases run the full detector. The artifact is `test-results/goal-stuck-projection.json`.

Final standalone measurements on Node v26.10.0, darwin/arm64:

| Case, full-history projection | Wall median / p95 / maximum | Process CPU median / p95 / maximum |
| --- | --- | --- |
| Consecutive identical reason | 4.708 / 9.053 / 9.881 ms | 4.952 / 13.405 / 17.623 ms |
| Drifting wording | 4.680 / 11.834 / 47.715 ms | 4.576 / 12.966 / 15.261 ms |

Both cases have measured wall and CPU p95 below 30 ms. The single drifting-case wall maximum exceeded 30 ms while its maximum process CPU was 15.261 ms; all samples remain available rather than hiding the scheduling/GC outlier.

The artifact retains every wall and CPU sample. The repeatable benchmark asserts process CPU p95 <=30 ms so unrelated work on the shared machine cannot create a flaky gate. Wall-clock samples remain explicit: the implementation does not guarantee a strict 30 ms scheduling bound.

## Verification commands

Every command uses the requested environment, stdin and wrapper:

```sh
export npm_config_verify_deps_before_run=false pnpm_config_verify_deps_before_run=false STORYBOOK_PORT=6397 ACCEPTANCE_PORT=4397 PATH=/tmp/redesign/oc-1.19.1/node_modules/.bin:$PATH
mise exec -- pnpm exec vitest run test/unit/persistence/goal-stuck-detector.test.ts test/unit/persistence/goal-stuck-effect.test.ts test/unit/persistence/read-model-advance.test.ts </dev/null
mise exec -- pnpm exec vitest run --config vitest.integration.config.ts test/integration/daemon/goal-details.test.ts </dev/null
GOAL_STUCK_BENCHMARK=1 mise exec -- pnpm exec vitest run test/unit/persistence/goal-stuck-effect.test.ts </dev/null
```

Output was redirected to `/tmp/aoqb-41-stuck-*.log`, with the exit code retained and a byte-capped tail printed. Before production changes, detector imports failed because the file was absent; projection/read-model tests failed because the header and column were absent; the integration test failed on the third SDK check. Those expected failures established the red phase. The clock-regression test also failed before input normalisation.

Focused verification:

- The detector/projection/read-model-advance suite passed 34 tests before the performance change.
- An eight-file regression invocation passed all 159 functional tests (detector, projection, migration lineage, migration immutability, read-model advances, goal details, session read-model contract and session projector). Its optional wall-time benchmark failed under machine contention, prompting the explicit wall/CPU measurement above.
- The final standalone full-detector benchmark/projection invocation passed all seven tests, including the CPU budget measurement (2.07 seconds).
- The daemon goal-details integration spec was run alone: three tests passed, including three SDK checks showing `goalStuck` and completion clearing it. The parent reruns this spec after the requested full gates.
- Scoped Biome checks passed after formatting. The parent session owns `pnpm check`, `pnpm lint`, `pnpm test:unit`, `pnpm build`, post-build integration checks and commits.
- The first full unit gate exposed eight expected schema-fixture differences across six existing test files. Their migration tails now include Effect key 69; legacy-fork unchanged-row expectations include the new nullable column; the recorded projector snapshot received exactly `goal_stuck: null` without regeneration. No recorded reasons were copied or changed. Files: `claude-turn-cost.test.ts`, `legacy-fork-migration.test.ts`, `persistence-effect.test.ts`, `project-provenance.test.ts`, `projector-replay.test.ts` (its `.snap` only), and `schema.test.ts` under `test/unit/persistence/`. Running those six test files together after the fixture updates passed all 51 tests (6.42 seconds).

The eight-file regression command was:

```sh
GOAL_STUCK_BENCHMARK=1 mise exec -- pnpm exec vitest run test/unit/persistence/goal-stuck-effect.test.ts test/unit/persistence/goal-stuck-detector.test.ts test/unit/persistence/effect-migrations.test.ts test/unit/persistence/migration-immutability.test.ts test/unit/persistence/read-model-advance.test.ts test/unit/persistence/goal-details-effect.test.ts test/unit/persistence/session-read-model-contract.test.ts test/unit/persistence/projectors-effect/session-projector.test.ts </dev/null
```

The migration-fixture rerun command was:

```sh
mise exec -- pnpm exec vitest run test/unit/persistence/legacy-fork-migration.test.ts test/unit/persistence/persistence-effect.test.ts test/unit/persistence/project-provenance.test.ts test/unit/persistence/projector-replay.test.ts test/unit/persistence/schema.test.ts test/unit/persistence/claude-turn-cost.test.ts </dev/null
```

## Residual risks

- The reference detector is an advisory text heuristic; repeated evaluator wording does not prove the agent has stopped making useful progress.
- Full-history projection still scales with history length and distinct reason text. The benchmark covers a 2,500-check synthetic goal with repeated/drifting reasons; larger or substantially more varied reasons may cost more.
- Clock regressions can make the displayed raw `lastAt` precede `since`, matching existing historical timestamps. Detector chronology and prefix causality follow iterations.
