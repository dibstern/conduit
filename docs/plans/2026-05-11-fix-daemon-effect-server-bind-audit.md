# Audit Synthesis — 2026-05-11 Fix Daemon Effect Server Bind

**Plan audited:** `docs/plans/2026-05-11-fix-daemon-effect-server-bind.md`
**Auditors dispatched:** 5 (one per task with code substance — Tasks 1–5; Tasks 6–7 are pure process steps)
**Audit status:** **PARTIAL** — only Task 4 returned a complete audit file. Tasks 1, 2, 3, 5 auditors hit their tool-use budget mid-investigation and did not finalize their reports. The Task 4 finding alone is critical (Amend Plan) and must be resolved before execution. After amending, **re-run audits for Tasks 1, 2, 3, 5** in a fresh dispatch.

---

## Critical Findings (Amend Plan)

### Finding A — Parallel-bind race between HTTP and onboarding servers (Task 4)
**Source:** `docs/plans/audits/2026-05-11-fix-daemon-effect-server-bind-task-4.md`, Finding #1.

Tier 3 of `makeDaemonLive` composes `Layer.mergeAll(makeHttpServerLive, makeIpcServerLive, makeOnboardingServerLive)` at `src/lib/effect/daemon-layers.ts:432-436`. `Layer.mergeAll` runs constructors **concurrently** (per the Effect docs). Task 3 has `makeHttpServerLive` write the resolved bound port back into `DaemonConfigRef` AFTER `listen()`. Task 4 has `makeOnboardingServerLive` read `config.port` from the same Ref to derive `httpsPort` for redirect URLs. With concurrent execution, onboarding can read the **pre-write** snapshot (`config.port === 0`) and build broken redirect URLs (`https://hostBase:0/setup`).

In production with `--port 2633` (default), the bug is benign because the port never changes. But:
- Step 4.5's TLS test uses `baseConfig.port = 0` — exact race window.
- Any user running `--port 0` (OS-assigned) hits the bug in production.

The Step 4.5 test as written would still pass because it only asserts `ctx.onboardingServer.address().address === "0.0.0.0"`. It never fetches `/api/setup-info` or the catch-all redirect — so the bug is invisible to the test.

**Required amendment:** Restructure Tier 3 to sequence onboarding **after** HTTP+IPC via `Layer.provideMerge`:

```typescript
const httpAndIpc = Layer.mergeAll(
  makeHttpServerLive(options.ctx),
  makeIpcServerLive(options.ctx, options.ipcContext, options.getStatus),
);
const servers = makeOnboardingServerLive(options.ctx, options.onboarding).pipe(
  Layer.provideMerge(httpAndIpc),
).pipe(Layer.provideMerge(registries));
```

This guarantees `makeHttpServerLive`'s `Ref.update(port)` happens-before `makeOnboardingServerLive`'s `Ref.get`.

**Required test addition (extend Step 4.5):** After the onboarding server is up, fetch `/api/setup-info` over HTTP and assert that the returned `httpsUrl` contains the actual HTTPS port (`ctx.upgradeServer.address().port`), not `0`. This catches the race.

### Finding B — Step 4.3 must explicitly delete the `if (!ctx.tls)` early return
**Source:** Task 4 audit, Finding #2.

Step 4.3 says "moved up" but does not include an explicit "delete lines 511-514" instruction. With `ctx.tls` removed by Task 2, the line would be a type error. The plan should not rely on the compiler to catch this — add an explicit delete bullet.

**Required amendment:** Add to Step 4.3: "Delete lines 511-514 (the `if (!ctx.tls) return Promise.resolve();` early return)."

### Finding C — Step 4.4 missing `OnboardingServerStartConfig` import note
**Source:** Task 4 audit, Finding #3.

Task 3's Step 3.3 includes an "imports" note for `HttpServerStartConfig`; Task 4 omits the parallel note for `OnboardingServerStartConfig`.

**Required amendment:** Add to end of Step 4.4: "Extend the existing import from `../daemon/daemon-lifecycle.js` (top of `daemon-layers.ts`) to include `type OnboardingServerStartConfig`."

---

## Accepted (informational) findings

From the Task 4 audit, all `Accept` findings (no plan change needed):
- The `actualPort` vs `config.httpsPort` distinction in Step 4.3's remap rule is correct (Finding #4).
- The `config.port + 1 > 65535` overflow at line 518 is a pre-existing bug, out of scope (Finding #5).
- Step 4.5 correctly fills the test-fail placeholder from Step 4.1 (Finding #6).
- `tls.certs` truthiness gate is correctly typed (Finding #7).
- No `as` casts or `any` introduced (Finding #8).
- `closeOnboardingServer` is unaffected by the refactor (Finding #9).
- Tier-1 host write to Ref is properly visible to Tier 3 (Finding #10) — this is a separate concern from the port race in Finding A.

---

## Tasks 1, 2, 3, 5 — Audits incomplete (re-audit required)

The auditors for these tasks hit their tool-use budget while investigating. Their partial traces suggest:

- **Task 1** (`tlsEnabled` / `hostExplicit` threading): auditor was checking whether the test in Step 1.8 correctly handles `TlsCertLayer`'s `tlsEnabled=false` short-circuit interaction. No finding committed.
- **Task 2** (`DaemonLifecycleContext` strip + `startHttpServer` refactor): auditor was checking the `router: { handleRequest: async () => {} }` type compatibility under `exactOptionalPropertyTypes: true` and the `tls.certs` field shape. Preliminary read: "this should be fine". No finding committed.
- **Task 3** (`makeHttpServerLive` Tag deps): auditor was verifying that `runPromise(Effect.void)` does build the Layer eagerly (it does — `ManagedRuntime.make` + `runPromise` triggers acquisition). The Task 4 audit independently confirmed the relevant `Layer.provideMerge` semantics. The parallel-bind race finding from Task 4 also applies to Task 3 (the write-back happens here).
- **Task 5** (delete sync, route via Ref): auditor was checking existing daemon-layers test patterns to size the `SetupInfoProvider` interface cascade. No finding committed.

**Action:** After the plan-audit-fixer applies the Task 4 amendments, re-dispatch auditors for Tasks 1, 2, 3, 5 with their original audit briefs. The re-audit may surface additional findings, but the parallel-bind fix from Finding A is structural and unblocks the highest-risk issue.

---

## Summary

| Action | Count |
|---|---|
| **Amend Plan** | 3 (all from Task 4 — race, delete-early-return, import note) |
| **Ask User** | 0 |
| **Accept** | 7 (Task 4 informational) |
| **Re-audit required** | Tasks 1, 2, 3, 5 (audits incomplete) |

**Routing:** Hand off to `superpowers:plan-audit-fixer` to apply the 3 Amend Plan findings (Finding A is structural — Tier 3 reorganization plus new test assertion; Findings B and C are small plan edits). After fixer hands back, re-run audits for Tasks 1, 2, 3, 5.

---

## Amendments Applied (by plan-audit-fixer)

| Finding | Task | Amendment |
|---------|------|-----------|
| A — Parallel-bind race | 4 | Inserted new **Step 4.5** that restructures Tier 3 in `daemon-layers.ts:429-436` so onboarding is sequenced AFTER HTTP+IPC via `Layer.provideMerge(httpAndIpc)`. Old Step 4.5 (run tests) renumbered to 4.6 and rewritten to compose `makeHttpServerLive` + `makeOnboardingServerLive` together with `port: 0`, then fetch `/api/setup-info` over HTTP and assert `httpsUrl` contains the real bound port (regression test for the race). Old Step 4.6 (commit) renumbered to 4.7. |
| B — Explicit early-return deletion | 4 | Step 4.3 augmented with "**Also delete lines 511-514** (the `if (!ctx.tls) return Promise.resolve();` early return)" and a disambiguation reference table mapping each existing `ctx.*` site to its replacement. |
| C — `OnboardingServerStartConfig` import note | 4 | Added "**Imports:** Extend the existing import from `../daemon/daemon-lifecycle.js`..." note at end of Step 4.4. Files list at the top of Task 4 also updated to enumerate the additional modified line ranges. |

Re-audit dispatch follows for Tasks 1, 2, 3, 5 (whose original audits exceeded their tool budget). The re-audit for Task 4 picks up the amended steps and verifies the parallel-bind fix.
