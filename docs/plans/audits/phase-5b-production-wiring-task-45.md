# Task 45: Frontend validation integration -- Audit Report

**Summary:** The plan has a wrong import path that will cause a compile error, a type-safety gap from `as RelayMessage` cast on potentially-invalid data, dead code left behind (effect-boundary.ts `validateIncomingMessage` never wired), and skeleton tests that provide no actual validation coverage. Three findings require plan amendments; one requires a user decision; one is informational.

---

## Findings

| # | Category | Action | Issue | File:Line | Amendment / Question |
|---|----------|--------|-------|-----------|----------------------|
| 1 | Incorrect Code | **Amend Plan** | Wrong relative import path for `RelayMessageSchema` | Plan snippet line `import { RelayMessageSchema } from "../shared-types.js"` | Change to `../../shared-types.js` -- runtime.ts is at `src/lib/frontend/transport/runtime.ts`, two levels below `src/lib/` where `shared-types.ts` lives. The existing import on runtime.ts line 18 already uses `../../shared-types.js`. |
| 2 | Non-Strict Typing | **Amend Plan** | `as RelayMessage` cast on decode-failure fallback hides invalid data | Plan snippet: `const msg = (Either.isRight(result) ? result.right : raw) as RelayMessage` | On the failure branch, `raw` is arbitrary `unknown` data that failed schema validation. Casting it `as RelayMessage` defeats the purpose of validation -- downstream code believes it has a valid `RelayMessage` when it does not. Two options: (a) drop invalid messages (skip emit, log warning) which is a behavior change, or (b) keep graceful degradation but narrow the cast to `as RelayMessage` only on the Right branch and use a separate type (e.g., `unknown`) or explicit `type`-field check for the Left branch. At minimum, the plan should document that the Left branch intentionally passes unvalidated data to preserve forward compatibility, and the cast should be on the Right branch only: `const msg = Either.isRight(result) ? (result.right as RelayMessage) : (raw as RelayMessage)` -- making the intentional unsafety on the Left branch visually distinct. |
| 3 | Implicit Assumptions | **Ask User** | `effect-boundary.ts` `validateIncomingMessage` becomes dead code | `.worktrees/effect-ts-migration/src/lib/frontend/effect-boundary.ts:48` | Phase 5 Task 36 created `validateIncomingMessage` with lazy-load code-splitting. Task 45 duplicates the same decoding logic inline with synchronous eager import, making `effect-boundary.ts` entirely unused in production. Should the plan: (a) delete `effect-boundary.ts` in Task 45 or Task 46, (b) keep it as an alternative entry point for future consumers that prefer code-splitting, or (c) refactor Task 45 to import the decoder factory from `effect-boundary.ts` instead of duplicating it? Option (c) would require making `effect-boundary.ts` export a synchronous decoder too. |
| 4 | Insufficient Test Coverage | **Amend Plan** | Test skeleton has no actual implementation -- only comments | Plan test snippet for `test/unit/frontend/runtime-validation.test.ts` | All three test bodies are empty comments (`// Create a mock WebSocket...`). The plan must provide at minimum: (1) a mock WebSocket class or factory that can emit `MessageEvent`s, (2) actual assertions that consume the stream (using Effect `Stream.runCollect` or similar), (3) a test that verifies invalid JSON is silently skipped (the existing behavior preserved), (4) a test that verifies an unknown `type` field passes through (graceful degradation). Without real test implementations, the executing agent has no contract to validate against. |
| 5 | Implicit Assumptions | **Accept** | Schema-derived type and manual `RelayMessage` type can diverge | `.worktrees/effect-ts-migration/src/lib/shared-types.ts:930` and `:1022` | `RelayMessageSchema` (line 930) and the `RelayMessage` type union (line 1022) are maintained in parallel with no `Schema.Type<typeof RelayMessageSchema>` derivation. If a new variant is added to one but not the other, the decoder will silently reject valid messages (or accept invalid ones). This is pre-existing technical debt, not introduced by this task, but the `as RelayMessage` cast in Task 45 relies on the two staying in sync. Noting for awareness. |

---

## Details

### Finding 1: Wrong import path

The file `runtime.ts` is located at `src/lib/frontend/transport/runtime.ts`. The plan's code snippet says:

```typescript
import { RelayMessageSchema } from "../shared-types.js";
```

This resolves to `src/lib/frontend/shared-types.js` which does not exist. The correct path is `../../shared-types.js`, matching the existing type-only import on line 18 of `runtime.ts`:

```typescript
import type { RelayMessage } from "../../shared-types.js";
```

### Finding 2: Type safety hole with `as RelayMessage`

The plan's decode logic:

```typescript
const result = decodeRelayMessage(raw);
const msg = (Either.isRight(result) ? result.right : raw) as RelayMessage;
```

When `Either.isLeft(result)`, `raw` is data that *failed* schema validation. Casting it `as RelayMessage` tells TypeScript it is a valid `RelayMessage`, which is false. This could cause runtime errors in downstream switch statements or property accesses that assume fields exist based on the `type` discriminant.

The `effect-boundary.ts` file has the same graceful-degradation pattern (line 34: `return result._tag === "Right" ? result.right : raw`) but its return type is `unknown`, which is honest. The Task 45 approach hides the unsafety behind a cast.

### Finding 3: Dead code (effect-boundary.ts)

After Task 45, the codebase will have two independent decoders for the same schema:
- `effect-boundary.ts`: async lazy-load decoder (never imported in production)
- `runtime.ts`: synchronous eager decoder (the one actually used)

The U45-1 audit fix chose synchronous eager import, which is correct for ordering. But the plan does not address what happens to `effect-boundary.ts`.

### Finding 4: Empty test skeletons

The plan's test file has three `it()` blocks, all with only comments as bodies. Compare to the `effect-boundary.test.ts` file which has 9 fully implemented tests at `.worktrees/effect-ts-migration/test/unit/frontend/effect-boundary.test.ts`. Task 45's tests should be at least as thorough, covering:
- Valid known message type (e.g., `{ type: "delta", sessionId: "s1", text: "hi" }`) is decoded
- Invalid JSON (non-parseable string) is silently skipped
- Unknown message type (e.g., `{ type: "future_type" }`) passes through
- Malformed known type (e.g., `{ type: "delta" }` missing required `sessionId`) -- should this pass through or be dropped?

---

**No issues found in:** Fragile Code, State Issues, Missing Wiring (the import additions and code changes in runtime.ts are straightforward once the path is corrected)
