# SDK Migration Plan — Audit Synthesis

> Dispatched 15 auditors across 15 tasks. Individual reports at `docs/plans/audits/sdk-migration-task-*.md`.

---

## Amend Plan (38 findings)

### CRITICAL — Architectural / Design-Level

1. **Task 3: `class RelayClient extends OpencodeClient` is almost certainly wrong.**
   The SDK's `OpencodeClient` extends `_HeyApiClient` and does NOT accept `{ client: internalClient }` in its constructor. The `super()` call will fail at runtime. The plan must be rewritten to use composition (wrap SDK client) rather than inheritance.
   → Rewrite Task 3 as a wrapper/adapter class, not subclass.

2. **Task 3: `getBaseUrl()` not exposed on RelayClient.**
   Used by `relay-stack.ts` (logging), `ProjectRelay.client` public API, and test helpers. `RelayClient` must expose `getBaseUrl(): string`.
   → Add `getBaseUrl()` method to RelayClient.

3. **Task 3: `normalizeMessage`/`normalizeMessages` not accounted for.**
   Currently embedded in `OpenCodeClient.getMessages()`. SDK returns `{ info, parts }[]` envelope — consumers expect flat `Message[]`. The normalization must live somewhere after migration.
   → Task 3 should provide a `getMessages(sessionId)` compatibility method that normalizes internally.

4. **Task 3: Only 4 custom endpoints listed; at least 7 are missing from SDK.**
   Missing from SDK: `GET /permission`, `GET /question`, `POST /question/{id}/reply`, `POST /question/{id}/reject`, `GET /skill`, `PATCH /session/{id}` (update), `GET /session/{id}/message?limit&before` (paginated). The plan only covers the first 4.
   → Add `listSkills()`, `updateSession()`, `getMessagesPage()` to custom endpoints.

5. **Task 7/all: SDK `throwOnError: false` silently breaks error recovery.**
   The poller's `poll()` wraps client calls in try/catch. With `throwOnError: false`, errors return `{ data: undefined, error: {...} }` instead of throwing. Catch blocks become dead code. `augmentStatuses` will crash on `undefined.parentID`.
   → Use `throwOnError: true` on calls that rely on try/catch error handling, OR add explicit `result.error` checks everywhere.

6. **Task 8: Permission reply requires `sessionId` — handler doesn't have it.**
   SDK path is `/session/{id}/permissions/{permissionID}` requiring BOTH sessionId and permissionID. Current handler only has permissionID. If old `/permission/{id}/reply` endpoint is removed from server, handler breaks.
   → Verify server still supports old path. If not, thread sessionId through PermissionBridge. Either way, add `replyPermission()` to RelayClient custom methods.

7. **Task 8: SDK `Session` type lacks `modelID`, `providerID`, `agentID`.**
   `session.ts` and `model.ts` access `session.modelID`/`session.providerID`. These fields don't exist on SDK `Session` type. Compile error guaranteed.
   → Access via type assertion or raw fetch, or verify server returns them as extra fields.

8. **Task 8: SDK `Agent` type has no `id` or `hidden` fields.**
   `filterAgents()` uses `a.id`, `a.hidden`, `a.mode`. SDK Agent uses `name` as identifier, has no `hidden`, and `mode` is a required strict union.
   → Rewrite `filterAgents()` to work with SDK Agent type.

9. **Task 11: SDK `Message` is discriminated union; `parts` not on Message type.**
   Parts are in separate `{ info, parts }` envelope. Poller accesses `msg.parts`, `msg.cost`, `msg.tokens` unconditionally. SDK `Part` is strict union — index-signature access (`part["text"]`) breaks.
   → If RelayClient provides normalized `getMessages()`, poller is fine. If not, Task 11 becomes a 200-300 line refactor.

10. **Task 2: Exhausted retries return response instead of throwing.**
    Existing client throws `OpenCodeConnectionError` after all retries. New fetch wrapper returns raw 5xx Response. Every caller expects exceptions on failure.
    → Throw after retry exhaustion, or document that SDK layer handles this.

### HIGH — Missing Files / Wiring

11. **Task 5: Intentionally breaks compilation through Task 8.**
    Changing `HandlerDeps.client` type before migrating call sites creates a multi-task window where `pnpm check` fails. Violates AGENTS.md verification path.
    → Either execute Tasks 5-10 as atomic unit, or defer type change until all call sites migrated.

12. **Task 5: `ClientInitDeps` also declares `client: OpenCodeClient` — not in plan.**
    `client-init.ts:31` has a separate interface that also needs updating simultaneously.
    → Add `ClientInitDeps` update to Task 5.

13. **Task 5: Test mock factory `createMockClient()` not in plan.**
    `test/helpers/mock-factories.ts:28-73` returns `HandlerDeps["client"]` shape. When type changes, all 30+ method stubs need updating.
    → Add mock factory update to plan.

14. **Task 10: 5 component constructors receive `client` — all need compatible types.**
    `SessionManager`, `SessionStatusPoller`, `MessagePollerManager`, `ClientInitDeps`, `HandlerDeps` all receive the same `client` object. Tasks 5-11 must ALL complete before Task 10, or all land in one commit.
    → Add explicit task ordering dependency.

15. **Task 10: Variable shadowing in config call.**
    Plan's Step 4 uses `const config = result.data` which shadows the function parameter `config: ProjectRelayConfig`, breaking all subsequent `config.*` references.
    → Use `const ocConfig = ocResult.data`.

16. **Task 10: Dynamic type import `import("...opencode-client.js").SessionStatus` at line 167.**
    Not mentioned in Task 10, will break after Task 13 deletion.
    → Update in Task 10.

17. **Task 13: 3 source files never assigned to any task.**
    `daemon.ts:1001` (dynamic value import), `status-transitions.ts:5`, `sse-wiring.ts:78`, `message-poller-manager.ts:13` — none appear in Tasks 4-12.
    → Assign to existing tasks or expand Task 13.

18. **Task 13: 10 test files import from opencode-client.ts — not mentioned anywhere.**
    All will fail on `pnpm test:unit`. Several need substantial rewriting (not just import changes).
    → Add test file migration to relevant tasks.

19. **Task 13: `SessionStatus` type has no surviving home after deletion.**
    It's relay-local, not in SDK. 8+ files import it. Task 4's sdk-types.ts re-exports it, but Task 14 may delete sdk-types.ts.
    → Move `SessionStatus` to a permanent location before deletion.

### MEDIUM — Behavioral / Normalization

20. **Task 2: Missing `Content-Type` and `Accept` headers.**
    Existing client always sends these. New fetch wrapper doesn't. SDK may or may not set them.
    → Verify SDK sets them, or add to persistent headers.

21. **Task 2: Error handling behavior change — non-2xx returned as-is.**
    Existing client throws `OpenCodeApiError` on ALL non-2xx. New wrapper returns raw Response. Error handling contract changes.
    → Document or add error wrapping.

22. **Task 6: Line numbers all wrong; 10 call sites, not 5.**
    Plan misses `searchSessions()`, `getDefaultSessionId()`, and duplicate `createSession`/`listSessions` calls.
    → Update line references and enumerate all 10 call sites.

23. **Task 6: `listSessions()` now takes `{ roots }` option — not in plan.**
    → Add `roots` query parameter to SDK call mapping.

24. **Task 6: `listSessions()` response normalization (object→array) may be lost.**
    → Verify SDK returns array, or add `Object.values()` conversion.

25. **Task 8: `sendMessageAsync` body construction logic has no defined destination.**
    `PromptOptions.text` → parts conversion currently in client. Must move to handler.
    → Show explicit parts construction code in prompt handler.

26. **Task 8: `listProviders()` normalization is complex and unresolved.**
    SDK returns `{ all, default, connected }` with models as keyed objects. Relay expects `{ providers, defaults, connected }` with model arrays and `variants` field.
    → Keep normalization function or build one for SDK responses.

27. **Task 9: `listProviders()` target inconsistent with Task 8.**
    Task 9 says `provider.list()`, Task 8 says `config.providers()` for same endpoint.
    → Be consistent — use same SDK method everywhere.

28. **Task 14: `OpenCodeEvent` extended by 15+ event interfaces — must not be removed.**
    → Mark as relay-specific, do not replace.

29. **Task 15: Integration and E2E tests not included in verification.**
    Testing guide recommends them for relay/session/handler changes.
    → Add `pnpm test:integration` and `pnpm test:e2e`.

### LOW — Line Numbers / Documentation

30-38. Multiple tasks have stale line numbers (Tasks 6, 7, 8), missing file documentation steps (Task 1), and underspecified type comparison methodology (Task 14). See individual audit reports.

---

## Ask User (7 findings)

1. **Task 2: Node.js 18 vs `AbortSignal.any()`.**
   `AbortSignal.any()` requires Node 20+. Project supports >= 18. Should minimum be bumped, or use manual signal chaining?

2. **Task 3: Should Task 3 be rewritten as composition instead of inheritance?**
   The plan's extend-SDK-client approach won't work. Two viable architectures: (A) thin wrapper delegating to SDK with response unwrapping + custom endpoints via raw fetch, or (B) keep existing `OpenCodeClient` and gradually replace individual methods. Which approach?

3. **Task 4: Does SDK export `SessionStatus` type with same discriminated union structure?**
   If SDK type differs, need mapping adapter, not simple alias.

4. **Task 5: Should type change happen before or after handler migration?**
   Current plan creates compile-error window. Alternative: migrate all call sites under old type, then swap type as final step.

5. **Task 6: Which `responseStyle` for SDK client?**
   `"fields"` (default, returns `{ data, error, response }`) requires `.data` everywhere. `"data"` returns data directly but loses error access. Must be decided before any task executes.

6. **Task 8: `listProviders()` — which SDK method?**
   `provider.list()` (has `connected` but raw shape) vs `config.providers()` (different shape, no `connected`).

7. **Task 8: Single commit for all 8 handlers — split into smaller commits?**
   Could split into simple/complex/high-risk groups for easier bisection.

---

## Accept (31 findings)

Informational findings across all tasks. No action needed. Key notes:
- SDK exists on npm (v1.2.27), zero runtime dependencies
- `SessionStatus` types are structurally identical between SDK and relay
- `session.get()` return type compatible with poller's `parentID` usage
- PTY upstream (Task 12) is a clean no-op — duck-typed interface works
- Part field names are runtime-compatible between SDK and hand-rolled types
- Handler files correctly identified (6 non-client-using handlers properly excluded)

---

## Verdict

**38 Amend Plan + 7 Ask User findings. Handed off to plan-audit-fixer.**

---

## Amendments Applied (Round 1)

The plan was **substantially rewritten** based on audit findings and user decisions. The composition approach changed the migration strategy from "rewrite every call site" to "swap imports."

| Finding | Resolution | Plan Change |
|---------|-----------|-------------|
| Task 3: extends OpencodeClient won't work | Use composition | **Rewrote Task 3** — RelayClient wraps SDK, mirrors flat API |
| Task 3: getBaseUrl() missing | Add to RelayClient | Added `getBaseUrl()` method |
| Task 3: normalizeMessage not accounted for | Normalize inside RelayClient | `getMessages()` normalizes internally |
| Task 3: Only 4 custom endpoints | 7 missing from SDK | Added `replyPermission`, `listSkills`, `getMessagesPage`, `updateSession` |
| Task 7/all: throwOnError:false breaks catch | Use throwOnError:true + responseStyle:data | SDK config resolves globally |
| Task 8: Permission reply needs sessionId | Old path is non-deprecated | `replyPermission()` uses `/permission/{id}/reply` |
| Task 8: Session lacks modelID/providerID | Handled by SDK returning extra fields | Noted; RelayClient passes through |
| Task 8: Agent lacks id/hidden | Adapt filterAgents | Use `name` as id, `mode !== "subagent"` for hidden |
| Task 11: Message type incompatible | Normalize inside RelayClient | Poller receives same flat Message type |
| Task 2: Retry returns response | Throw after exhaustion | Fixed in fetch wrapper spec |
| Tasks 5-8: Compile error window | Flat API eliminates it | Import swaps only, no method changes |
| Tasks 5/9: ClientInitDeps not mentioned | Included in import swap | Task 5 covers all interfaces |
| Task 5: Mock factory not in plan | Added | Task 5 includes mock-factories.ts |
| Task 10: 5 component constructors | All done in single task | Task 5 handles all import swaps together |
| Task 10: Config variable shadowing | Use ocConfig | Noted in plan |
| Task 10: Dynamic type import line 167 | Included in swap | Task 5 covers sse-wiring dynamic import too |
| Task 13: 3 source files unassigned | All included in Task 5 | daemon.ts, status-transitions.ts, sse-wiring.ts, message-poller-manager.ts |
| Task 13: 10 test files unassigned | New Task 6 | Dedicated task for test file updates |
| Task 13: SessionStatus homeless | relay-types.ts or SDK re-export | Task 4 creates permanent type home |
| Task 2: Missing Content-Type headers | SDK handles via hey-api | Verified in Task 1 exploration |
| Task 6: Line numbers wrong, 10 calls not 5 | Moot — no method changes needed | Composition eliminates call-site rewrites |
| Task 8: sendMessageAsync body logic | Inside RelayClient | `sendMessageAsync()` converts PromptOptions internally |
| Task 8/9: listProviders inconsistent | provider.list() everywhere | Resolved; normalization in RelayClient |
| Task 14: OpenCodeEvent must not be removed | Marked relay-specific | Keep list in Task 8 |
| Task 15: Integration/E2E tests missing | Added to Task 9 | Full test suite in final verification |
| Task 2: AbortSignal.any() Node 18 | Bump to Node 20 | Task 1 bumps minimum |
| All: responseStyle decision | "data" with throwOnError:true | Configured in Task 3 constructor |
| Task 8: Split commits | By risk level | Commit strategy in each task |
| **Plan restructured from 15 tasks to 9 tasks** | Composition simplifies everything | Tasks 5-12 collapsed into Tasks 5-6 (import swaps + test updates) |
