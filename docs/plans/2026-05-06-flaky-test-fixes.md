# Flaky Test Fixes — Deterministic Sequential Execution

**Goal:** Make `pnpm test:all` pass 100% reliably every time, not just when suites run individually.

**Working directory:** `.worktrees/effect-ts-migration/`

---

## Task 1: Split integration config into isolated projects

**Problem:** `effect-layers.test.ts` and `shutdown.test.ts` use `@effect/vitest` dynamic registration which fails in `forks` pool ("No test suite found"). Concurrent relay harnesses cause port/memory contention.

**File:** `vitest.integration.config.ts`

**Change:** Replace single pool config with 3 projects + `fileParallelism: false`:
- `integration-flows` (`.integration.ts` files) — `forks`, `singleFork: true`
- `integration-effect` (effect-layers, shutdown) — `threads` pool for @effect/vitest
- `integration-other` (remaining `.test.ts`) — `forks`, `singleFork: true`

---

## Task 2: Isolate better-sqlite3 tests into forks pool

**Problem:** better-sqlite3 native module segfaults when loaded across multiple worker threads under memory pressure.

**File:** `vitest.config.ts`

**Change:** Add `unit-sqlite` project with `pool: "forks"`, `singleFork: true` for:
- `test/unit/effect/sqlite-transactions.test.ts`
- `test/unit/persistence/**/*.test.ts`

Exclude these from the main `unit` project.

---

## Task 3: Add inter-suite cleanup to test-all.sh

**Problem:** No waiting between sequential vitest runs; zombie processes and lingering listeners contaminate next suite.

**File:** `scripts/test-all.sh`

**Change:** Add `wait_for_cleanup` function (1s sleep) between unit, integration, and contract test runs.

---

## Task 4: Add shutdown settling delay to relay harness

**Problem:** `stop()` doesn't wait for OS to fully release ports/file descriptors.

**File:** `test/integration/helpers/relay-harness.ts`

**Change:** Add 100ms settling delay after `stack.stop()` and `mock.stop()`.

---

## Task 5: Increase timeouts for pipeline integration tests

**Problem:** 10s timeouts too tight when running after other suites consumed resources. 500ms beforeEach drain insufficient under load.

**Files:**
- `test/integration/flows/sse-to-ws-pipeline.integration.ts`
- `test/integration/flows/message-lifecycle.integration.ts`

**Change:** Increase per-test timeout from 10s to 30s. Increase beforeEach drain delay from 500ms to 1000ms.

---

## Task 6: Add defensive delay to contract global-setup

**Problem:** Contract test spawns OpenCode immediately after integration tests may still be tearing down.

**File:** `test/contract/global-setup.ts`

**Change:** Add 500ms delay before spawning OpenCode instance.

---

## Verification

```bash
# Run 3 times to verify no flakes
for i in 1 2 3; do echo "=== Run $i ===" && pnpm test:all && echo "PASS" || echo "FAIL"; done
```
