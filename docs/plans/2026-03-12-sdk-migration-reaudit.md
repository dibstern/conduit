# SDK Migration Plan — Re-Audit Synthesis

> **Re-audit of the amended plan (9 tasks).** Dispatched 9 auditors. Individual reports at `docs/plans/audits/sdk-migration-task-*.md`.

> **Important note:** Auditors for Tasks 2, 3, 4, and 5 audited the **old pre-amendment plan** rather than the current amended plan. Their findings are almost entirely already resolved by the Round 1 amendments (composition architecture, flat API, 7 custom endpoints, Node 20+, throwOnError:true, etc.). Only genuinely new findings are included below.

---

## Amend Plan (17 findings)

### Task 1: Install SDK, Bump Node

1. **Step 1 is stale: `engines.node` already `>=20.19.0`.**
   The plan says "change from `>= 18.0.0` to `>= 20.0.0`" but `package.json:102` already has `>=20.19.0` (bumped by session-switch-perf plan). Taking Step 1 literally would downgrade the minimum. Mark as already done.
   → Amend Step 1: "**Already done.** `engines.node` is already `>=20.19.0`. No change needed."

2. **Add exploration item: custom fetch injection.**
   Task 2's entire design depends on `createOpencodeClient({ fetch: customFetch })` accepting a custom fetch implementation. This should be explicitly verified in Task 1 exploration, not discovered in Task 2.
   → Add exploration item 8: "Verify `createOpencodeClient({ fetch })` accepts custom fetch and receives full `url` + `init` args."

3. **Add exploration item: baseUrl/auth accessibility.**
   The composition design stores baseUrl and credentials as RelayClient's own properties. Confirm the SDK client does NOT expose public accessors for these, validating the composition approach.
   → Add exploration item 9: "Confirm `OpencodeClient` has no public `getBaseUrl()` or `getConfig()` method."

### Task 6: Update Test Files

4. **`session-manager.pbt.test.ts` needs more than import swap.**
   Has 4 `OpenCodeClient` references (line 7, 9, 24, 84) — type casts and mock construction, not just import. All must be renamed to `RelayClient`.
   → Note in Step 1: "Rename all 4 `OpenCodeClient` type references to `RelayClient`, not just import path."

5. **`session-manager-parentid.test.ts` has type cast on line 22.**
   `} as unknown as OpenCodeClient` must become `} as unknown as RelayClient`. Plan says "import swap" but this is also a type reference rename.
   → Note in Step 1.

6. **`m4-backend.test.ts` dynamic import details underspecified.**
   Lines 153-156 use `const { OpenCodeClient } = await import(...)` — must change destructured name, import path, and constructor.
   → Amend Step 3: "Change dynamic import path to `sdk-client.js`, destructure `RelayClient`, rename `new OpenCodeClient(...)` to `new RelayClient(...)`."

7. **`rest-client.integration.ts` tests trailing-slash normalization.**
   Lines 182-188 verify `baseUrl + "/"` works. RelayClient constructor does `.replace(/\/+$/, "")`. SDK may also normalize — verify double-normalization is benign.
   → Add to Step 2: "Verify trailing-slash normalization test still passes."

8. **`rest-client.integration.ts` also imports `SessionDetail` type.**
   Lines 7, 85, 95 use `SessionDetail`. Must redirect import per Task 4 type mapping.
   → Add to Step 2: "Update `SessionDetail` type import to new location."

9. **`sse-consumer.integration.ts` is simpler than described.**
   Plan says "rewrite" but it only uses `OpenCodeClient` as a REST helper (3 lines: import, type annotation, constructor). No SSE test logic changes needed.
   → Clarify: "Simple 3-line swap, not a rewrite."

10. **Clarify: tests must import from NEW paths, not bridge.**
    Task 7 deletes `opencode-client.ts`, so tests must use new import locations by end of Task 6.
    → Add note: "Import from `sdk-client.ts` (RelayClient) and `relay-types.ts`/SDK (types). Do not rely on Task 4 bridge."

11. **Add type import mapping table.**
    Six test files import types (`SessionStatus`, `Message`, `SessionDetail`) from `opencode-client.ts`. Plan says "update import paths" but doesn't specify destinations.
    → Add: "`SessionStatus` → SDK or `relay-types.ts`, `Message` → SDK or `relay-types.ts`, `SessionDetail` → SDK `Session`, `OpenCodeClient` → `RelayClient` from `sdk-client.ts`."

### Task 7: Delete opencode-client.ts

12. **Dead import sweep will match `terminal.ts:114` comment.**
    `rg "opencode-client"` will find a comment referencing the old module name. Not an import — not blocking.
    → Amend Step 1: "Comments referencing `opencode-client` (e.g., `terminal.ts:114`) should be updated but are not blocking."

### Task 8: Clean Up Redundant Types

13. **Don't delete `relay-types.ts` — contradicts Task 4.**
    Task 4 creates `relay-types.ts` specifically for non-SDK types. Task 8 says "Possibly delete." By definition, if Task 4 was implemented correctly, the file contains only relay-specific types.
    → Remove "Possibly delete: `src/lib/instance/relay-types.ts`". Replace with "Verify `relay-types.ts` contains only relay-specific types. Keep the file."

14. **Reframe Task 8 as post-deletion cleanup.**
    By the time Task 8 runs, `opencode-client.ts` is already deleted (Task 7). Types targeted for "replacement" should already be migrated. Reframe as verification pass.
    → Reframe intro: "Verify type migrations from Tasks 4-7 are correct. Clean up dead types and document relay-specific types."

15. **Commit to Message→HistoryMessage cast strategy.**
    Plan says "consider adding a `toHistoryMessage()` mapping function." Since `RelayClient.getMessages()` normalizes into old flat `Message` shape (Task 3), the `as unknown as HistoryMessage[]` cast continues to work. But should add a TODO comment for follow-up.
    → Add: "The unsafe cast continues to work. Add TODO comment noting `toHistoryMessage()` mapping should replace the cast in a follow-up."

16. **Clean up dead types in `types.ts`.**
    `PartState`, `PartDelta`, and `ModelEntry` are defined but never imported. Dead code.
    → Add to Step 2: "Remove dead types: `PartState`, `PartDelta`, `ModelEntry` (zero importers)."

17. **Explicitly state `shared-types.ts` types are not SDK replacement candidates.**
    All types in `shared-types.ts` are relay-to-browser transforms (WebSocket messages, frontend stores). None are direct SDK equivalents.
    → Add: "`shared-types.ts` contains relay-to-browser transform types. Do not attempt SDK replacement."

### Task 9: Final Verification

(Consolidated with Task 7 finding 12 on terminal.ts comment)

18. **Add contract tests to Step 1.**
    `pnpm test:contract` validates REST endpoint response shapes against a real server — the most relevant automated check for an SDK migration.
    → Add `pnpm test:contract` to Step 1 after `pnpm test:integration`.

19. **Add `test:e2e:live` as optional.**
    Automated equivalent of the manual smoke test. Spawns real OpenCode instance.
    → Add optional step: "If `opencode` is on `$PATH`, also run `pnpm test:e2e:live`."

---

## Ask User (1 finding)

1. **Task 8: `SessionDetail.title` optionality.**
   Relay's `SessionDetail.title` is `string | undefined`. SDK's `Session.title` may be `string` (required). `toSessionInfoList()` does `s.title ?? "Untitled"`. If SDK guarantees title is present, the fallback becomes unreachable. Keep as defensive coding, or simplify?
   → Recommend keeping `?? "Untitled"` as defensive coding. Low risk either way.

---

## Stale Findings (already addressed by Round 1 amendments)

Auditors for Tasks 2, 3, 4, and 5 audited the old pre-amendment plan. Their findings are **already resolved**:

| Task | Stale Findings | Why Already Resolved |
|------|---------------|---------------------|
| Task 2 | Retry exhaustion, retry delay formula, Content-Type headers, error handling, AbortSignal.any(), timer cleanup, 4xx exclusion | Plan already specifies: throw after exhaustion, linear delay, SDK handles headers, throwOnError:true, Node 20+, clearTimeout in finally |
| Task 3 | Inheritance won't work, _client access, JSON double-stringify, getBaseUrl missing, normalizeMessage, missing endpoints, type compatibility, any cast, response unwrapping, provider normalization, auth config, directory header, retry/timeout | Plan already uses composition, 40+ flat methods, normalization inside RelayClient, 7 custom endpoints, relay-fetch wrapper |
| Task 4 | Import count, normalizeMessage functions, SessionStatus match, Message.parts types, Agent mode/hidden, ProviderListResult, re-export bridge, OpenCodeClientOptions, PromptOptions | Plan already has full categorization table, 21 importers listed, normalization in RelayClient, Agent adaptation noted |
| Task 5 | PromptOptions, ClientInitDeps, compile errors, mock factory, relay-stack construction, ProjectRelay/RelayStack interfaces, compile window | Plan already covers all interfaces, mock-factories.ts listed, flat API means no compile errors |

---

## Accept (12 findings across all tasks)

- Task 1: CI already on Node 22/24, no .nvmrc/Dockerfile, SDK not yet installed, AbortSignal types available, dual lockfile (pre-existing)
- Task 2: Buffer.from for Base64 (matches existing), extractAuthHeaders duplication (handled in later tasks)
- Task 3: Loose types on custom endpoints (matches existing pattern), no shared mutable state
- Task 6: All 10 test files accounted for, simple test files confirmed simple
- Task 8: types.ts relay infrastructure types unaffected, SDK not installed yet (expected)
- Task 9: Subagent/fork tests covered by E2E, pnpm ls adequate for dep check

---

## Verdict

**17 Amend Plan + 1 Ask User.**

All Amend Plan findings are **minor clarifications and completeness improvements** — no architectural issues. The plan's core design (composition-based RelayClient, flat API, import-swap migration) is sound and validated.

**Severity assessment:**
- **No critical findings.** The Round 1 amendments resolved all architectural issues.
- **3 medium findings:** Task 6 test file details (findings 4-6), Task 8 reframing (findings 13-14), Task 9 contract tests (finding 18).
- **14 low findings:** Stale Node step, exploration items, type mapping table, dead types, comments, defensive coding.

**Recommendation:** Apply the 17 amendments (all are straightforward text clarifications), resolve the 1 Ask User question, then proceed to execution.

---

## Amendments Applied

All 17 Amend Plan findings applied directly to `2026-03-12-sdk-migration-plan.md`:

| # | Finding | Amendment Applied |
|---|---------|-------------------|
| 1 | Task 1: Stale Node engine step | Marked Step 1 as "ALREADY DONE", updated commit message |
| 2 | Task 1: Custom fetch exploration | Added exploration item 8 |
| 3 | Task 1: BaseUrl/auth exploration | Added exploration item 9 |
| 4-5 | Task 6: Non-mechanical test swaps | Added detail for pbt.test.ts and parentid.test.ts |
| 6 | Task 6: m4-backend dynamic import | Specified destructured name + import path changes |
| 7 | Task 6: Trailing-slash test | Added verification note to Step 2 |
| 8 | Task 6: SessionDetail type import | Added to Step 2 |
| 9 | Task 6: sse-consumer simplicity | Clarified "3-line swap, not rewrite" |
| 10 | Task 6: Import from new paths | Added note about not relying on bridge |
| 11 | Task 6: Type mapping table | Added mapping table to Step 1 |
| 12 | Task 7: terminal.ts comment | Added note about non-blocking comment match |
| 13 | Task 8: Don't delete relay-types.ts | Removed "Possibly delete", changed to "Verify and keep" |
| 14 | Task 8: Post-deletion reframing | Reframed task intro as verification & cleanup |
| 15 | Task 8: HistoryMessage cast strategy | Committed to TODO comment approach |
| 16 | Task 8: Dead types cleanup | Added PartState, PartDelta, ModelEntry removal |
| 17 | Task 8: shared-types.ts not candidates | Added explicit note |
| 18-19 | Task 9: Contract tests + e2e:live | Added to verification steps |

**Ask User resolved:** `SessionDetail.title` — keep `?? "Untitled"` fallback as defensive coding.

**Plan is ready for execution.**
