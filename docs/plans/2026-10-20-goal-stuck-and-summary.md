# Goal stuck detection and summary

Ticket: `conduit-test-aoqb.41`. Server behavior and verification use synthetic
evidence in repository tests. Study data and parity artifacts remain external.

## Failure modes recorded before implementation

- Wording drift splits one blocker; progress, a new identifier, changed polarity,
  missing reasons or iteration gaps fail to end it. Counts, clocks and durations
  incorrectly signal new work. Two checks announce Stuck too early.
- Growing runs change identity or future evidence rewrites past verdicts.
  Duplicate or unordered imported rows throw and stall projection, or an empty
  fallback signature lets summaries survive new checks. Oversized reasons make
  parsing expensive. Clock rollback breaks detection or rewrites raw evidence.
- Sessions or goal identities contaminate one another; resyncs double-count;
  replay sees future checks or differs from live projection. Lifecycle changes
  leave obsolete headers, or clients see checks before the matching header.
  Migration changes old rows or initializes a false stuck state.
- Continuing one blocker invalidates a summary; progress, lifecycle changes,
  pause/resume between opens, goal identity, model or pause reason reuse stale
  text. Compression loses ordering, singleton progress, latest evidence or
  omission notices, exceeds its budget, or treats quoted evidence as instructions.
- Reads spend model quota, simultaneous opens duplicate calls, or late results
  claim newer evidence or overwrite newer summaries. Disabled, no-check, failed,
  empty, timeout and cancellation paths leak errors, poison retry state or keep
  work reserved. Cache growth is unbounded, model/account routing is wrong, or
  missing-session and unsupported-provider RPC guards disappear.

The follow-up boundary, domain-neutral and imported-row tests were written and
run before changing production code. They exposed the old guard behavior, the
missing shared entry point and the projection/summary ordering exceptions.

## Design

`goal-stuck-detector.ts` preserves the final study detector's algorithm and
defaults. Generic identifier syntax, shared-prefix identifier sets and subject
polarity supply context guards. Times, dates, numbers and measured quantities
never supply identity. Segmentation uses cosine similarity to the observed
centroid, continuation hysteresis and the exact linear cosine medoid. Anchored
run IDs and verdicts are prefix-causal. Identifier context survives inferred
boundaries and resets on missing evidence or explicit gaps.

Only immutable extraction is memoized by exact reason string. FIFO retention is
bounded by 4,096 entries and 4,194,304 weighted units. Reasons over 4,096 UTF-16
units and entries over 65,536 weighted units bypass the memo. Hits do not refresh
eviction order. Checks, options, segmentation and Results are never cached.

`detectGoalStuck` is the single production entry point used by the projector and
summary input. It selects `minChecks: 3`, threshold `0.55`, limits each detection
reason to 4,096 characters and normalizes clocks by cumulative maximum in input
order. Raw history is unchanged. It catches detector failures and returns no
stuck state or runs, with false per-check verdicts for summary-key fallback.
Invalid histories are neither sorted nor deduplicated into plausible evidence.

`effect/projectors-effect.ts` reads the current session/set-time/condition's
iteration prefix and persists `{since,lastAt,count}` in nullable
`sessions.goal_stuck` before the same version stamp is published. Raw timestamps
supply displayed bounds. Met, cleared and replaced goals clear the header;
pauses retain it. Read queries expose it as `SessionInfo.goalStuck`. Migration
`0073_sessions_goal_stuck.sql` uses Effect registry key `0075`, following main's
SQL and Effect migration chains. Rebuilds derive the same state from events.

`goal-summary-input.ts` keys summaries by session and goal identity, canonical
lifecycle fields and transition epoch, consecutive-deduplicated causal blocker
IDs or individual iteration IDs, prompt version and model. Growing one confirmed
run preserves its key even when the representative changes. Prompt evidence
keeps chronological runs and standalone checks, raw time bounds and differing
latest evidence. History retains at most eight segments and 8,000 JSON characters
with omission/truncation notices. Goal, lifecycle and reasons are quoted data.

`GoalSummaryService` keeps a per-relay 200-identity LRU and coalesces concurrent
requests for a captured key. Details read cached metadata without generation;
only `GenerateGoalSummary` calls `makeClaudeOneShot` using the recap-model
preference and daemon default Claude login. Workers belong to the relay scope,
reservation/start is atomic, individual opener cancellation does not cancel
shared work, and generation times out after 60 seconds. Failed or empty results
remain retryable. Captured-key metadata detects stale results and prevents older
completions replacing newer summaries. Details and metadata share a SQL snapshot.

## Verification

Whole-Result study parity passed 6,701 comparisons with zero deep-equality or
JSON-byte differences. It covered 21 original and 51 blind goals at minimums 2/3,
thresholds 0.35/0.55/0.87 and guards on/off: 864 grid cases, 5,762 causal prefixes
at 3/0.55 including empty prefixes, 62 synthetic/cache cases and 13 validation
cases. Input immutability and reference contracts also passed.

Repository tests cover domain-neutral identifiers and quantities, drift, stable
IDs, causality, capped pathological text, backwards clocks, invalid history
fallback and continued commits after duplicate imported iterations. Existing
projection, read-model notification, replay, lifecycle, migration, prompt,
service concurrency/cancellation and RPC coverage remains in place.

All requested gates passed, with stdin closed and dependency verification
disabled in the caller environment:

| Command | Result |
| --- | --- |
| `mise exec -- pnpm check </dev/null` | Pass, zero Svelte errors/warnings |
| `mise exec -- pnpm lint </dev/null` | Pass, existing informational warnings |
| `mise exec -- pnpm test:unit </dev/null` | 689 files, 9,576 passed, 2 skipped, 11 TODO |
| `mise exec -- pnpm build </dev/null` | Pass |

Post-build daemon verification passed three tests:

```sh
CONDUIT_TEST_DIST=dist mise exec -- pnpm exec vitest run --config vitest.integration.config.ts test/integration/daemon/goal-details.test.ts </dev/null
```

Each persistence file below was then run alone with
`mise exec -- pnpm exec vitest run <path> </dev/null`, all passing, 251 tests total:

| Path under `test/unit/persistence/` | Passed |
| --- | ---: |
| `projectors-effect.test.ts` | 105 |
| `projector-replay.test.ts` | 1 |
| `projectors-effect/session-projector.test.ts` | 46 |
| `projectors-effect/message-projector.test.ts` | 46 |
| `projectors-effect/turn-projector.test.ts` | 34 |
| `projectors-effect/provider-projector.test.ts` | 8 |
| `projectors-effect/approval-projector.test.ts` | 11 |

The focused detector/projection/input/service run passed 72 tests. A fresh
Codex review of the detector, shared boundary and caller/test changes found no
material correctness or regression issues. No paid model prompt was needed.

## Measured projection cost

The unchanged benchmark seeds 2,499 checks and measures the real append,
projection, stamp and publication transaction for check 2,500. It uses
453-character synthetic reasons, five warmups and forty samples per identical
or drifting-wording case. Setup/reset writes are excluded. All wall and process
CPU samples are retained in `test-results/goal-stuck-projection.json`.

Measurements on Node v26.10.0, darwin/arm64, in milliseconds:

| Case | Wall median | Wall p95 | Wall max | CPU median | CPU p95 | CPU max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Before, identical | 4.651 | 75.559 | 155.888 | 4.645 | 10.737 | 16.936 |
| After, identical | 5.283 | 10.107 | 12.570 | 5.572 | 15.549 | 16.516 |
| Before, drifting | 4.643 | 118.559 | 152.332 | 4.698 | 11.967 | 12.186 |
| After, drifting | 4.897 | 9.887 | 10.806 | 4.802 | 11.356 | 11.645 |

Both before and after passed the 30 ms process CPU p95 budget. These repeated
reasons exercise warm memo reuse, not cold distinct-reason parsing. Wall-time
outliers varied with machine load; the measurements do not establish a speedup
over the previous detector or a scheduling guarantee. Reproduce with:

```sh
GOAL_STUCK_BENCHMARK=1 mise exec -- pnpm exec vitest run test/unit/persistence/goal-stuck-effect.test.ts </dev/null
```

## Residual risks

Detection is an advisory text heuristic. Reused old identifiers, lowercase quoted
values and unsupported syntax can hide new work. Capping may omit meaningful
evidence beyond character 4,096. Invalid histories deliberately suppress the
header and run compression until repaired. Full-history work still grows with
history length; cold extraction and memo eviction cost more than warm reuse.
Memo accounting bounds retention weights, not exact heap bytes. Shared-machine
scheduling can dominate wall time. Raw clock rollback can display a last time
before the first. Model instructions cannot guarantee every generated summary
respects the requested format or treats quoted text safely. Summary caches reset
with the relay.
