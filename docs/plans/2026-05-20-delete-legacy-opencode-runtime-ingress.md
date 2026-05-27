# Delete Legacy OpenCode Runtime Ingress Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Delete the temporary sync OpenCode runtime ingress shim before durable provider orchestration work begins.

**Architecture:** Production OpenCode SSE ingestion has one owner: `EffectOpenCodeRuntimeIngress`, which translates SSE events into `ProviderRuntimeEvent` batches and delegates durable append/projection to `ProviderRuntimeIngestion`. Tests that still need direct ingress behavior should exercise the Effect ingress with fake `ProviderRuntimeIngestion` or real Effect persistence layers, not a sync class that maps/appends/projects by hand.

**Tech Stack:** TypeScript, Effect, Vitest, SQLite event store/projectors.

---

## Why Before Plan 4

- [ ] Plan 4 introduces durable command receipts and a side-effect reactor. Keeping a sync compatibility ingress that maps runtime events directly to domain events would make it easier for the reactor to copy the wrong path.
- [ ] Deleting the shim makes the desired boundary explicit: provider runtime output enters through `ProviderRuntimeIngestion`, then domain events/projections/relay replay are authoritative.
- [ ] This does not solve the deeper event-store FK issue; plan 4 still owns removing event-log dependency on projection/read-model tables.

## Files

- [ ] Delete: `src/lib/domain/relay/Services/opencode-runtime-ingress-legacy.ts`
- [ ] Modify: `src/lib/domain/relay/Services/opencode-runtime-ingress-service.ts`
- [ ] Modify: `src/lib/relay/sse-wiring.ts` only if sync port types remain.
- [ ] Modify: `test/unit/contracts/providers/provider-runtime-event.test.ts`
- [ ] Modify: `test/unit/effect/runtime-boundary-grep.test.ts`
- [ ] Modify: `test/unit/domain/relay/opencode-runtime-ingress-effect.test.ts`
- [ ] Modify: `test/unit/domain/relay/opencode-runtime-ingress-projection.test.ts`
- [ ] Modify: `test/unit/relay/opencode-runtime-ingress-integration.test.ts`
- [ ] Modify: `test/unit/relay/relay-stack-opencode-runtime-ingress-wiring.test.ts`
- [ ] Delete: `test/unit/domain/relay/opencode-runtime-ingress-legacy.test.ts`
- [ ] Modify: `docs/plans/2026-05-18-full-provider-runtime-event-adoption.md` to remove the temporary-legacy acceptance language after deletion.

## Acceptance Criteria Matrix

| Criterion | Proof | Expected Assertion |
|---|---|---|
| Legacy sync ingress is gone. | Static contract/boundary test. | `src/lib/domain/relay/Services/opencode-runtime-ingress-legacy.ts` does not exist and no test imports it. |
| Production ingress still uses durable ingestion. | Relay-stack wiring and Effect ingress tests. | `makeEffectOpenCodeRuntimeIngress` receives `ProviderRuntimeIngestionTag` and calls `ingestBatch`. |
| No OpenCode ingress path appends/projects by hand. | Static grep test. | OpenCode ingress code does not import `EventStore`, `PersistenceLayer`, `CanonicalEvent`, or `translateProviderRuntimeEventToDomain`. |
| Behavior coverage survives without the shim. | Effect ingress behavior tests. | no-session skip, not-translatable skip, successful batch ingest, error handling, reconnect reset, and projection/recovery tests still pass. |
| Plan 4 starts from one provider-output boundary. | Plan 4 prereq and guardrail. | Durable receipts/reactor plan references only Effect ingress plus `ProviderRuntimeIngestion`, not the sync shim. |

## Task 1: Add Failing Static Guards

**Files:**
- Modify: `test/unit/contracts/providers/provider-runtime-event.test.ts`
- Modify: `test/unit/effect/runtime-boundary-grep.test.ts`

**Step 1: Write the failing tests**

Add a contract test that fails while the legacy file still exists:

```ts
it("does not keep a legacy sync OpenCode runtime ingress", () => {
	const legacyIngress = join(
		REPO_ROOT,
		"src/lib/domain/relay/Services/opencode-runtime-ingress-legacy.ts",
	);

	expect(existsSync(legacyIngress)).toBe(false);
});
```

Add or tighten the runtime-boundary grep so OpenCode ingress cannot append/project directly:

```ts
expect(openCodeRuntimeIngressSource).not.toMatch(/translateProviderRuntimeEventToDomain/);
expect(openCodeRuntimeIngressSource).not.toMatch(/EventStore|PersistenceLayer|CanonicalEvent/);
expect(openCodeRuntimeIngressSource).toMatch(/ProviderRuntimeIngestionTag/);
expect(openCodeRuntimeIngressSource).toMatch(/ingestBatch/);
```

**Step 2: Run tests to verify they fail**

Run:

```bash
./node_modules/.bin/vitest run test/unit/contracts/providers/provider-runtime-event.test.ts test/unit/effect/runtime-boundary-grep.test.ts
```

Expected: fail because `opencode-runtime-ingress-legacy.ts` still exists or stale imports remain.

## Task 2: Move Legacy Behavior Coverage Onto Effect Ingress

**Files:**
- Modify: `test/unit/domain/relay/opencode-runtime-ingress-effect.test.ts`
- Delete: `test/unit/domain/relay/opencode-runtime-ingress-legacy.test.ts`

**Step 1: Port behavior tests before deleting implementation**

Move any unique assertions from the legacy test into the Effect ingress suite. Keep the fake at the ingestion boundary:

```ts
const ingestion = {
	ingest: vi.fn((event) => Effect.succeed(1)),
	ingestBatch: vi.fn((events) => Effect.succeed(events.length)),
	drain: vi.fn(() => Effect.void),
} satisfies ProviderRuntimeIngestion;
```

Required behaviors:

- [ ] no `sessionId` returns `{ ok: false, reason: "no-session" }` and never calls `ingestBatch`.
- [ ] non-translatable SSE event returns `{ ok: false, reason: "not-translatable" }`.
- [ ] first translatable event for a session includes synthetic `session.created` before translated events in the `ingestBatch` call.
- [ ] later events for the same session do not emit duplicate synthetic `session.created`.
- [ ] ingestion failure returns `{ ok: false, reason: "error" }` and increments error stats.
- [ ] `onReconnect()` resets translator state without resetting already-seen session IDs unless the current production behavior intentionally changes.

**Step 2: Run the effect ingress suite**

Run:

```bash
./node_modules/.bin/vitest run test/unit/domain/relay/opencode-runtime-ingress-effect.test.ts
```

Expected: pass with behavior coverage now on the production Effect ingress.

## Task 3: Convert Projection And Integration Tests Off The Sync Shim

**Files:**
- Modify: `test/unit/domain/relay/opencode-runtime-ingress-projection.test.ts`
- Modify: `test/unit/relay/opencode-runtime-ingress-integration.test.ts`
- Modify: `test/unit/relay/relay-stack-opencode-runtime-ingress-wiring.test.ts`

**Step 1: Replace sync construction**

Replace imports or construction of `OpenCodeRuntimeIngress` from `opencode-runtime-ingress-legacy.ts` with one of:

- `makeEffectOpenCodeRuntimeIngress(log)` provided with fake Effect services when the test is about wiring.
- `new EffectOpenCodeRuntimeIngress({ sql, projectionRunner, ingestion, log })` when the test is about ingress behavior only.
- Real `ProviderRuntimeIngestionLive` plus test SQLite persistence when the test is about projection/recovery.

**Step 2: Preserve only behaviorful assertions**

Keep assertions that prove durable behavior:

- [ ] relay wiring constructs the Effect ingress with `ProviderRuntimeIngestionLive`.
- [ ] projection/recovery still works from stored domain events.
- [ ] failures in ingestion/projection are logged and surfaced through the ingress result without crashing the relay pipeline.

Delete assertions that only prove the old sync shim called `eventStore.appendBatch` or `projectionRunner.projectBatch` directly.

**Step 3: Run converted suites**

Run:

```bash
./node_modules/.bin/vitest run test/unit/domain/relay/opencode-runtime-ingress-projection.test.ts test/unit/relay/opencode-runtime-ingress-integration.test.ts test/unit/relay/relay-stack-opencode-runtime-ingress-wiring.test.ts
```

Expected: pass without importing the legacy ingress file.

## Task 4: Delete The Sync Ingress API

**Files:**
- Delete: `src/lib/domain/relay/Services/opencode-runtime-ingress-legacy.ts`
- Modify: `src/lib/domain/relay/Services/opencode-runtime-ingress-service.ts`
- Modify: `src/lib/relay/sse-wiring.ts` if needed.

**Step 1: Delete the file**

Delete `opencode-runtime-ingress-legacy.ts`.

**Step 2: Remove sync-only exported types**

In `opencode-runtime-ingress-service.ts`, remove `OpenCodeRuntimeIngressPort` if no production or test code uses it. Keep `EffectOpenCodeRuntimeIngressPort` as the public ingress port.

**Step 3: Verify no imports remain**

Run:

```bash
rg -n "opencode-runtime-ingress-legacy|OpenCodeRuntimeIngressPort|new OpenCodeRuntimeIngress|translateProviderRuntimeEventToDomain" src test
```

Expected: no legacy file/class imports. Any remaining `translateProviderRuntimeEventToDomain` hits must be the mapper module, mapper tests, or explicitly allowed provider-runtime ingestion tests.

## Task 5: Update Plan 3 And Run Verification

**Files:**
- Modify: `docs/plans/2026-05-18-full-provider-runtime-event-adoption.md`

**Step 1: Remove temporary-shim language**

Update plan 3 so its final state says:

- [ ] OpenCode runtime ingress lives under relay/domain ownership.
- [ ] Production and test ingress go through `EffectOpenCodeRuntimeIngress` plus `ProviderRuntimeIngestion`.
- [ ] There is no sync legacy ingress shim.

**Step 2: Run focused verification**

Run:

```bash
./node_modules/.bin/vitest run \
  test/unit/contracts/providers/provider-runtime-event.test.ts \
  test/unit/effect/runtime-boundary-grep.test.ts \
  test/unit/domain/relay/opencode-runtime-ingress-effect.test.ts \
  test/unit/domain/relay/opencode-runtime-ingress-projection.test.ts \
  test/unit/relay/opencode-runtime-ingress-integration.test.ts \
  test/unit/relay/relay-stack-opencode-runtime-ingress-wiring.test.ts
```

Then run:

```bash
./node_modules/.bin/tsgo --noEmit
git diff --check
```

Expected: all pass.

## Done Criteria

- [ ] `rg -n "opencode-runtime-ingress-legacy|new OpenCodeRuntimeIngress|OpenCodeRuntimeIngressPort" src test` returns no production/test hits.
- [ ] `rg -n "translateProviderRuntimeEventToDomain" src/lib/domain src/lib/relay src/lib/provider` shows no OpenCode ingress or reactor bypass outside the intended ingestion/mapper ownership.
- [ ] Focused ingress, contract, wiring, and boundary tests pass.
- [ ] Plan 4 prereq can be checked off without carrying a known sync-ingress exception.
