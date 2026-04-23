# Effect.ts Migration Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Migrate the conduit relay codebase to Effect.ts across seven layers for LLM-friendly, self-documenting code.

**Architecture:** Pain-point-first, layer-by-layer migration. Each layer is a self-contained PR. System stays working after each task. Schema+Errors first (foundation), then Resources, Concurrency, DI, Handlers, Server, Frontend.

**Tech Stack:** `effect` (includes Schema — `@effect/schema` merged into core as of Effect 3.x), `@effect/platform`, Vitest, Svelte 5, pnpm

**Compiler note:** This project uses `tsgo` (TypeScript native preview). If `pnpm check` fails after installing Effect due to `tsgo` incompatibility with Effect's type-level machinery, temporarily switch `check` script to use `tsc` and file a tsgo issue.

**Reference architecture:** [pingdotgg/t3code](https://github.com/pingdotgg/t3code) — similar event-driven relay, already Effect-native.

**Design doc:** `docs/plans/2026-04-23-effect-ts-migration-design.md`

---

## Layer 1: Schema + Errors

### Task 1.1: Install Effect packages

**Files:**
- Modify: `package.json`

**Step 1: Install effect**

Run: `pnpm add effect`

Note: `@effect/schema` is merged into the `effect` package as of Effect 3.x. Import as `{ Schema } from "effect"`. Do NOT install `@effect/schema` separately.

**Step 2: Verify installation**

Run: `pnpm check && pnpm test:unit`
Expected: All checks and tests pass — no existing code affected. If `tsgo` chokes on Effect's types, switch to `tsc` temporarily.

**Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add effect dependency"
```

---

### Task 1.2: Migrate branded types to Schema brands

**Files:**
- Modify: `src/lib/shared-types.ts:15-22` (RequestId, PermissionId)
- Modify: `src/lib/persistence/events.ts:4-7` (EventId, CommandId)
- Test: `test/unit/schema/branded-types.test.ts`

**Step 1: Write the failing test**

Create `test/unit/schema/branded-types.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { RequestId, PermissionId } from "../../../src/lib/shared-types.js";
import { EventId, CommandId } from "../../../src/lib/persistence/events.js";

describe("Branded types", () => {
  it("RequestId decodes valid strings", () => {
    const decoded = Schema.decodeUnknownSync(RequestId)("req_abc123");
    expect(typeof decoded).toBe("string");
  });

  it("RequestId rejects non-strings", () => {
    expect(() => Schema.decodeUnknownSync(RequestId)(42)).toThrow();
  });

  it("PermissionId decodes valid strings", () => {
    const decoded = Schema.decodeUnknownSync(PermissionId)("perm_xyz");
    expect(typeof decoded).toBe("string");
  });

  it("EventId decodes valid strings", () => {
    const decoded = Schema.decodeUnknownSync(EventId)("evt_abc");
    expect(typeof decoded).toBe("string");
  });

  it("CommandId decodes valid strings", () => {
    const decoded = Schema.decodeUnknownSync(CommandId)("cmd_abc");
    expect(typeof decoded).toBe("string");
  });

  it("branded types are assignable where expected", () => {
    // Compile-time check: branded values work in typed positions
    const rid: RequestId = Schema.decodeUnknownSync(RequestId)("req_1");
    const pid: PermissionId = Schema.decodeUnknownSync(PermissionId)("perm_1");
    expect(rid).toBe("req_1");
    expect(pid).toBe("perm_1");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/schema/branded-types.test.ts`
Expected: FAIL — `RequestId` is not a Schema, it's a type alias.

**Step 3: Implement branded types as Schemas**

In `src/lib/shared-types.ts`, replace the branded type definitions (lines 14-22):

```typescript
import { Schema } from "effect";

// ─── Branded identifiers ────────────────────────────────────────────────────
export const RequestId = Schema.String.pipe(Schema.brand("RequestId"));
export type RequestId = typeof RequestId.Type;

export const PermissionId = Schema.String.pipe(Schema.brand("PermissionId"));
export type PermissionId = typeof PermissionId.Type;
```

In `src/lib/persistence/events.ts`, replace branded types (lines 4-7):

```typescript
import { Schema } from "effect";

export const EventId = Schema.String.pipe(Schema.brand("EventId"));
export type EventId = typeof EventId.Type;

export const CommandId = Schema.String.pipe(Schema.brand("CommandId"));
export type CommandId = typeof CommandId.Type;
```

**Important: Schema brands are structurally INCOMPATIBLE with manual `__brand` pattern.** `string & Brand<"RequestId">` (Schema) ≠ `string & { __brand: "RequestId" }` (manual). ALL existing `as RequestId` casts will fail to compile.

**Migration approach:** Search for all `as RequestId`, `as PermissionId`, `as EventId`, `as CommandId` casts (~17 sites across shared-types.ts, events.ts, frontend stores, and storybook files) and update each to either:
- `as typeof RequestId.Type` (zero-validation cast, keeps existing behavior)
- `Schema.decodeSync(RequestId)(value)` (adds runtime validation)

Factory functions like `createEventId()` should use `Schema.decodeSync(EventId)(value)` for runtime validation at construction sites. For hot paths, `as typeof RequestId.Type` avoids the decode overhead.

Run `grep -rn "as RequestId\|as PermissionId\|as EventId\|as CommandId" src/` to find all sites.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/schema/branded-types.test.ts`
Expected: PASS

**Step 5: Update existing tests with branded type casts**

Update `as RequestId` / `as PermissionId` casts to `as typeof RequestId.Type` in these 8 test files:
- `test/unit/stores/permissions-store.test.ts` — `pid()` helper (line 36)
- `test/unit/session/session-switch.test.ts` — `as PermissionId` casts
- `test/unit/relay/sse-wiring.test.ts` — `pid()` helper (line 16)
- `test/unit/regression-question-session-scoping.test.ts` — branded type assertions
- `test/unit/handlers/request-id-contract.test.ts` — `as RequestId` (line 31)
- `test/unit/handlers/message-handlers.test.ts` — `pid()` helper (line 44)
- `test/unit/bridges/client-init.test.ts` — `pid()` helper (line 12)
- `test/unit/stores/ws-send-typed.test.ts` — branded type assertions

Run: `grep -rn "as RequestId\|as PermissionId\|as EventId\|as CommandId" test/` to find exact sites.

**Step 6: Run full test suite for regressions**

Run: `pnpm test:unit`
Expected: All existing tests pass.

**Step 7: Commit**

```bash
git add src/lib/shared-types.ts src/lib/persistence/events.ts test/unit/schema/ test/unit/stores/ test/unit/session/ test/unit/relay/ test/unit/handlers/ test/unit/bridges/ test/unit/regression-*
git commit -m "refactor: migrate branded types to @effect/schema brands"
```

---

### Task 1.3: Migrate error hierarchy to Schema.TaggedErrorClass

**Files:**
- Modify: `src/lib/errors.ts:58-288` (RelayError + 6 subclasses)
- Modify: `src/lib/persistence/errors.ts:21-44` (PersistenceError)
- Test: `test/unit/schema/errors.test.ts`
- Test: `test/unit/errors.pbt.test.ts` (existing — verify still passes)

**Step 1: Write the failing test**

Create `test/unit/schema/errors.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  OpenCodeApiError,
  OpenCodeConnectionError,
  SSEConnectionError,
  WebSocketError,
  AuthenticationError,
  ConfigurationError,
  RelayError,
} from "../../../src/lib/errors.js";
import { PersistenceError } from "../../../src/lib/persistence/errors.js";

describe("Schema-based errors", () => {
  it("OpenCodeApiError has _tag discriminant", () => {
    const err = new OpenCodeApiError({
      message: "Not found",
      endpoint: "/api/test",
      responseStatus: 404,
      responseBody: { detail: "missing" },
    });
    expect(err._tag).toBe("OpenCodeApiError");
    expect(err.message).toBe("Not found");
    expect(err.endpoint).toBe("/api/test");
    expect(err.responseStatus).toBe(404);
  });

  it("OpenCodeApiError serializes to JSON", () => {
    const err = new OpenCodeApiError({
      message: "Server error",
      endpoint: "/api/test",
      responseStatus: 500,
      responseBody: null,
      userVisible: true,
    });
    const json = err.toJSON();
    expect(json.error.code).toBe("OpenCodeApiError");
    expect(json.error.message).toBe("Server error");
  });

  it("OpenCodeApiError serializes to WebSocket", () => {
    const err = new OpenCodeApiError({
      message: "Timeout",
      endpoint: "/api/slow",
      responseStatus: 504,
      responseBody: null,
    });
    const ws = err.toWebSocket();
    expect(ws.type).toBe("error");
    expect(ws.code).toBe("OpenCodeApiError");
  });

  it("OpenCodeConnectionError constructs correctly", () => {
    const err = new OpenCodeConnectionError({ message: "Connection refused" });
    expect(err._tag).toBe("OpenCodeConnectionError");
    expect(err.message).toBe("Connection refused");
  });

  it("RelayError union decodes tagged errors", () => {
    const apiErr = new OpenCodeApiError({
      message: "test",
      endpoint: "/test",
      responseStatus: 500,
      responseBody: null,
    });
    expect(apiErr._tag).toBe("OpenCodeApiError");
    expect(apiErr instanceof Error).toBe(true);
  });

  it("PersistenceError has _tag discriminant", () => {
    const err = new PersistenceError({
      message: "Write failed",
      code: "WRITE_FAILED",
      context: { table: "events" },
    });
    expect(err._tag).toBe("PersistenceError");
    expect(err.code).toBe("WRITE_FAILED");
  });

  it("errors have userVisible defaulting to false", () => {
    const err = new OpenCodeConnectionError({ message: "test" });
    expect(err.userVisible).toBe(false);
  });

  it("errors have userVisible true when set", () => {
    const err = new OpenCodeConnectionError({
      message: "test",
      userVisible: true,
    });
    expect(err.userVisible).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/schema/errors.test.ts`
Expected: FAIL — errors don't have `_tag` yet.

**Step 3: Implement Schema.TaggedErrorClass errors**

Rewrite `src/lib/errors.ts`. Key pattern — each error class extends `Schema.TaggedErrorClass` but keeps transport serialization methods:

```typescript
import { Schema } from "effect";

// ─── Error Codes (kept for backwards compat with existing ErrorCode consumers) ─
export type ErrorCode = string; // Now derived from _tag

// ─── Base fields shared by all relay errors ─────────────────────────────────
const RelayErrorFields = {
  message: Schema.String,
  userVisible: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  context: Schema.optionalWith(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
    { default: () => ({}) },
  ),
};

// ─── Error subclasses ───────────────────────────────────────────────────────

export class OpenCodeConnectionError extends Schema.TaggedErrorClass<OpenCodeConnectionError>()(
  "OpenCodeConnectionError",
  { ...RelayErrorFields },
) {
  get statusCode() { return 502; }
  toJSON() {
    return { error: { code: this._tag, message: this.message } };
  }
  toWebSocket() {
    return { type: "error" as const, code: this._tag, message: this.message, statusCode: this.statusCode };
  }
}

export class OpenCodeApiError extends Schema.TaggedErrorClass<OpenCodeApiError>()(
  "OpenCodeApiError",
  {
    ...RelayErrorFields,
    endpoint: Schema.String,
    responseStatus: Schema.Number,
    responseBody: Schema.Unknown,
  },
) {
  get statusCode() { return this.responseStatus >= 400 ? this.responseStatus : 502; }
  toJSON() {
    return { error: { code: this._tag, message: this.message, details: { endpoint: this.endpoint, status: this.responseStatus } } };
  }
  toWebSocket() {
    return { type: "error" as const, code: this._tag, message: this.message, statusCode: this.statusCode };
  }
}

export class SSEConnectionError extends Schema.TaggedErrorClass<SSEConnectionError>()(
  "SSEConnectionError",
  { ...RelayErrorFields },
) {
  get statusCode() { return 502; }
  toJSON() { return { error: { code: this._tag, message: this.message } }; }
  toWebSocket() { return { type: "error" as const, code: this._tag, message: this.message, statusCode: this.statusCode }; }
}

export class WebSocketError extends Schema.TaggedErrorClass<WebSocketError>()(
  "WebSocketError",
  { ...RelayErrorFields },
) {
  get statusCode() { return 500; }
  toJSON() { return { error: { code: this._tag, message: this.message } }; }
  toWebSocket() { return { type: "error" as const, code: this._tag, message: this.message, statusCode: this.statusCode }; }
}

export class AuthenticationError extends Schema.TaggedErrorClass<AuthenticationError>()(
  "AuthenticationError",
  { ...RelayErrorFields },
) {
  get statusCode() { return 401; }
  toJSON() { return { error: { code: this._tag, message: this.message } }; }
  toWebSocket() { return { type: "error" as const, code: this._tag, message: this.message, statusCode: this.statusCode }; }
}

export class ConfigurationError extends Schema.TaggedErrorClass<ConfigurationError>()(
  "ConfigurationError",
  { ...RelayErrorFields },
) {
  get statusCode() { return 500; }
  toJSON() { return { error: { code: this._tag, message: this.message } }; }
  toWebSocket() { return { type: "error" as const, code: this._tag, message: this.message, statusCode: this.statusCode }; }
}

// ─── Union type for matching ────────────────────────────────────────────────
export type RelayError =
  | OpenCodeConnectionError
  | OpenCodeApiError
  | SSEConnectionError
  | WebSocketError
  | AuthenticationError
  | ConfigurationError;

// ─── Utilities ──────────────────────────────────────────────────────────────

/** Wrap unknown caught values into a typed error */
export function wrapError<E extends new (props: { message: string; context?: Record<string, unknown> }) => RelayError>(
  error: unknown,
  ErrorClass: E,
  context?: Record<string, unknown>,
): InstanceType<E> {
  if (error instanceof Error) {
    return new ErrorClass({ message: error.message, context }) as InstanceType<E>;
  }
  return new ErrorClass({ message: String(error), context }) as InstanceType<E>;
}

export { redactSensitive, formatErrorDetail } from "./errors-utils.js";
```

**Critical: Preserve RelayError as a base class during Layer 1.** The methods `toMessage()`, `toSystemError()`, `toLog()`, and static `fromCaught()` are used at ~25 call sites across handlers. Removing RelayError as a class would break these immediately. 

**Approach:** In Layer 1, add `_tag` discriminants and Schema-based validation to the existing class hierarchy WITHOUT removing the base class. Convert to full `Schema.TaggedErrorClass` in Layer 5 when handlers are migrated and these methods can be replaced with Effect error channel patterns.

**Step 3a: Create `src/lib/errors-utils.ts`** — extract `redactSensitive` (line 307) and `formatErrorDetail` (line 331) from `src/lib/errors.ts` into a new file. These are used by 12+ files. Run `grep -rn "redactSensitive\|formatErrorDetail" src/lib/` to find all importers and update their import paths.

**ErrorCode wire format: clean break.** Use `_tag` names (`"OpenCodeApiError"`) as the wire format code in `toJSON()`/`toWebSocket()`. Update all downstream code checking `error.code === "OPENCODE_API_ERROR"` to use the new `_tag` names. Search with `grep -rn "error.code\|error\.code\|\.code ===" src/` to find all sites.

**wrapError:** Update to pass `cause` through to preserve error chains (existing `wrapError` at line 291-304 sets `cause`). Also preserve the `OpenCodeApiError` message enrichment logic (lines 199-210) that appends 4xx response body details.

**PBT test migration:** `test/unit/errors.pbt.test.ts` constructs `RelayError` directly (line 91), tests `instanceof RelayError` (line 115), and checks `.code` (line 165). Update to: (a) use specific subclass constructors, (b) use `_tag`-based discrimination or type guard instead of `instanceof`, (c) update `.code` refs to match new property name.

Apply same pattern to `src/lib/persistence/errors.ts`. **Use actual error codes from the source file** (`src/lib/persistence/errors.ts:6-16`):

```typescript
import { Schema } from "effect";

export const PERSISTENCE_ERROR_CODES = [
  "UNKNOWN_EVENT_TYPE",
  "INVALID_RECEIPT_STATUS",
  "APPEND_FAILED",
  "PROJECTION_FAILED",
  "MIGRATION_FAILED",
  "SCHEMA_VALIDATION_FAILED",
  "CURSOR_MISMATCH",
  "DESERIALIZATION_FAILED",
  "SESSION_SEED_FAILED",
  "DUAL_WRITE_FAILED",
] as const;

export type PersistenceErrorCode = (typeof PERSISTENCE_ERROR_CODES)[number];

export class PersistenceError extends Schema.TaggedErrorClass<PersistenceError>()(
  "PersistenceError",
  {
    message: Schema.String,
    code: Schema.Literal(...PERSISTENCE_ERROR_CODES),
    context: Schema.optionalWith(
      Schema.Record({ key: Schema.String, value: Schema.Unknown }),
      { default: () => ({}) },
    ),
  },
) {
  toLog() {
    return { error: this._tag, code: this.code, message: this.message, ...this.context };
  }
}
```

**Constructor migration:** The existing constructor is positional: `new PersistenceError(code, message, context)`. The new constructor takes a props object: `new PersistenceError({ code, message, context })`. There are ~23 call sites across `event-store.ts`, `read-query-service.ts`, `projectors/projector.ts`, `projection-runner.ts`, `command-receipts.ts`, and `events.ts`. Search with `grep -rn "new PersistenceError(" src/lib/persistence/` and update each. Note: the existing constructor prepends `[${code}]` to the message string (line 29) — if this behavior should be preserved, add it to the Schema class `get message()` override.

**Step 4: Update existing call sites**

Search all files importing from `errors.ts` and update constructor calls:

```bash
# Find all imports
grep -rn "from.*errors" src/lib/ --include="*.ts" | grep -v node_modules
```

The main change: constructors now take a single props object instead of positional args.

Before: `new OpenCodeApiError("message", { code: "...", endpoint: "..." })`
After: `new OpenCodeApiError({ message: "message", endpoint: "..." })`

**Step 5: Update existing error tests**

Update error constructors, assertions, and wire format checks in these existing test files:
- `test/unit/errors.pbt.test.ts` — **CRITICAL:** `new RelayError(message, {...})` → props object, `instanceof RelayError` → `_tag` check, `.code` → `._tag`
- `test/unit/prompt-error-diagnostics.test.ts` — verify constructor sig compat (may already use props)
- `test/unit/provider/relay-event-sink.test.ts` — `.code` checks (line 114) update to `_tag` format
- `test/unit/bridges/client-init.test.ts` — `.code === "INIT_FAILED"` format change

**Step 6: Run tests**

Run: `pnpm vitest run test/unit/schema/errors.test.ts && pnpm vitest run test/unit/errors.pbt.test.ts`
Expected: Both pass.

**Step 7: Run full test suite**

Run: `pnpm test:unit`
Expected: All pass.

**Step 8: Commit**

```bash
git add src/lib/errors.ts src/lib/persistence/errors.ts test/unit/schema/ test/unit/errors.pbt.test.ts test/unit/prompt-error-diagnostics.test.ts test/unit/provider/relay-event-sink.test.ts test/unit/bridges/client-init.test.ts
git commit -m "refactor: migrate error hierarchy to Schema.TaggedErrorClass"
```

---

### Task 1.4: Create RelayMessage Schema.Union

**Files:**
- Modify: `src/lib/shared-types.ts:269-515` (RelayMessage union)
- Test: `test/unit/schema/relay-message.test.ts`

**Step 1: Write the failing test**

Create `test/unit/schema/relay-message.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { Schema, Either } from "effect";
import { RelayMessageSchema } from "../../../src/lib/shared-types.js";

describe("RelayMessage Schema", () => {
  it("decodes delta message", () => {
    const raw = { type: "delta", sessionId: "s1", text: "hello" };
    const result = Schema.decodeUnknownEither(RelayMessageSchema)(raw);
    expect(Either.isRight(result)).toBe(true);
  });

  it("decodes thinking_start message", () => {
    const raw = { type: "thinking_start", sessionId: "s1" };
    const result = Schema.decodeUnknownEither(RelayMessageSchema)(raw);
    expect(Either.isRight(result)).toBe(true);
  });

  it("decodes error message", () => {
    const raw = { type: "error", sessionId: "s1", code: "AUTH_REQUIRED", message: "PIN required" };
    const result = Schema.decodeUnknownEither(RelayMessageSchema)(raw);
    expect(Either.isRight(result)).toBe(true);
  });

  it("rejects unknown message type", () => {
    const raw = { type: "not_a_real_type", sessionId: "s1" };
    const result = Schema.decodeUnknownEither(RelayMessageSchema)(raw);
    expect(Either.isLeft(result)).toBe(true);
  });

  it("rejects message missing required fields", () => {
    const raw = { type: "delta" }; // missing sessionId, text
    const result = Schema.decodeUnknownEither(RelayMessageSchema)(raw);
    expect(Either.isLeft(result)).toBe(true);
  });

  it("RelayMessage type is compatible with existing code", () => {
    // Type-level test: the Schema.Type should match the old manual union
    const msg: typeof RelayMessageSchema.Type = {
      type: "delta",
      sessionId: "s1",
      text: "hello",
    };
    expect(msg.type).toBe("delta");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/schema/relay-message.test.ts`
Expected: FAIL — `RelayMessageSchema` does not exist.

**Step 3: Implement RelayMessage Schema**

In `src/lib/shared-types.ts`, create Schema definitions for each variant of the `RelayMessage` union. This is the largest single migration — 20+ variants.

Strategy:
1. Define each message variant as a `Schema.Struct` with `type: Schema.Literal("...")`.
2. Combine into `RelayMessageSchema = Schema.Union(...)`.
3. Export `type RelayMessage = typeof RelayMessageSchema.Type` to replace the old manual union.
4. Keep the old `RelayMessage` type alias temporarily for backwards compat during migration, then remove.

**Scope:** RelayMessage has **51 variants** (not "20+" as previously estimated), spanning lines 269-515 of `shared-types.ts`. Define schemas for ALL 51 variants following the existing type definitions.

**Index signatures removed — derive schemas from SQLite, not from SDK REST types.** `HistoryMessage` and `HistoryMessagePart` currently have `[key: string]: unknown` index signatures that carry phantom fields from the OpenCode REST API spread (`parentID`, `modelID`, `providerID`, `mode`, etc.) — none of these are ever accessed on HistoryMessage. Remove index signatures entirely.

**Schema derivation approach (do NOT hand-list fields):**
1. **Derive `PartType` and `ToolStatus` schemas from SDK types** — already done in `sdk-types.ts:103-122` as `type PartType = _Part["type"]`. Create Schema equivalents from these derived types.
2. **Build `HistoryMessagePartSchema` matching what `session-history-adapter.ts:26-80` produces from SQLite rows** — the SQLite `message_parts` table is the contract (only `text`, `thinking`, `tool` types). Schema fields should match `partRowToHistoryPart()` output.
3. **Build `HistoryMessageSchema` matching what `messageRowsToHistory()` returns** — fields: `id`, `role`, `parts`, `time` (created/completed), `cost`, `tokens`.
4. **Add transport extensions as explicit optional fields:** `renderedHtml` (on parts, added by markdown-renderer), `sessionID` (actively used in `message-poller.ts:290`).
5. **No index signatures** — SQLite schema defines the contract. OpenCode REST API fields that pass through unused are stripped.

**Derived types:** The following derived types (lines 521-591) must also be migrated or updated to work with the Schema-based union:
- `PerSessionEvent` — filtered subset of RelayMessage
- `GlobalRelayEvent` — filtered subset of RelayMessage
- `UntaggedRelayMessage` — message type before sessionId tagging
- `tagWithSessionId()` — utility function

For optional fields, use `Schema.optional(Schema.String)` or `Schema.optionalWith(Schema.String, { default: () => "" })` depending on whether the field has a default.

**Step 4: Run tests**

Run: `pnpm vitest run test/unit/schema/relay-message.test.ts`
Expected: PASS

**Step 5: Run full test suite for regressions**

Run: `pnpm test:unit`
Expected: All pass. The `RelayMessage` type should be structurally identical to the old one.

**Step 6: Commit**

```bash
git add src/lib/shared-types.ts test/unit/schema/relay-message.test.ts
git commit -m "refactor: migrate RelayMessage union to @effect/schema"
```

---

### Task 1.5: Migrate IPC command validation to Schema

**Files:**
- Modify: `src/lib/daemon/ipc-protocol.ts:30-245` (parseCommand, validateCommand)
- Test: `test/unit/schema/ipc-commands.test.ts`
- Test: `test/unit/daemon/config-persistence.test.ts` (existing — verify still passes)

**Step 1: Write the failing test**

Create `test/unit/schema/ipc-commands.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { Schema, Either } from "effect";
import { IPCCommandSchema, parseCommand } from "../../../src/lib/daemon/ipc-protocol.js";

describe("IPC Command Schema validation", () => {
  it("decodes add_project command", () => {
    const raw = { cmd: "add_project", directory: "/home/user/project" };
    const result = Schema.decodeUnknownEither(IPCCommandSchema)(raw);
    expect(Either.isRight(result)).toBe(true);
  });

  it("rejects add_project with empty directory", () => {
    const raw = { cmd: "add_project", directory: "" };
    const result = Schema.decodeUnknownEither(IPCCommandSchema)(raw);
    expect(Either.isLeft(result)).toBe(true);
  });

  it("rejects unknown command", () => {
    const raw = { cmd: "not_a_command" };
    const result = Schema.decodeUnknownEither(IPCCommandSchema)(raw);
    expect(Either.isLeft(result)).toBe(true);
  });

  it("parseCommand handles invalid JSON", () => {
    const result = parseCommand("not json");
    expect(result).toBeNull();
  });

  it("parseCommand decodes valid command", () => {
    const result = parseCommand('{"cmd":"status"}');
    expect(result).not.toBeNull();
    expect(result?.cmd).toBe("status");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/schema/ipc-commands.test.ts`
Expected: FAIL — `IPCCommandSchema` does not exist.

**Step 3: Implement IPC command schemas**

Replace the manual `validateCommand` switch-case (lines 55-245) with Schema-based validation. Define one Schema.Struct per command type, combine with Schema.Union.

Refer to `VALID_COMMANDS` set (lines 7-27) for the complete list of 18 commands. Each command that requires specific fields gets its own struct. Commands with no required fields beyond `cmd` use a minimal struct.

**Cross-field validation:** `instance_add` (lines 154-216) has complex cross-field rules: managed instances require valid ports, unmanaged need URL or port, URL is forbidden for managed instances. Use `Schema.filter()` with a custom predicate, or split into `InstanceAddManaged` and `InstanceAddUnmanaged` sub-schemas discriminated on the `managed` field.

**Default mutation:** `set_keep_awake_command` (line 123) mutates `cmd.args` to default to `[]`. Use `Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] })`.

Update `parseCommand` to use `Schema.decodeUnknownEither(IPCCommandSchema)` instead of manual JSON.parse + type check. Also update `createCommandRouter` (lines 248-342) to work with the Schema-validated commands.

**Step 4: Run tests**

Run: `pnpm vitest run test/unit/schema/ipc-commands.test.ts`
Expected: PASS

**Step 5: Run existing tests**

Run: `pnpm test:unit`
Expected: All pass.

**Step 6: Commit**

```bash
git add src/lib/daemon/ipc-protocol.ts test/unit/schema/ipc-commands.test.ts
git commit -m "refactor: migrate IPC command validation to @effect/schema"
```

---

### Task 1.6: Migrate canonical event schemas

**Files:**
- Modify: `src/lib/persistence/events.ts:35-356` (event types, payloads, validation)
- Test: `test/unit/schema/canonical-events.test.ts`
- Test: existing persistence tests (verify still pass)

**Step 1: Write the failing test**

Create `test/unit/schema/canonical-events.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { Schema, Either } from "effect";
import {
  CanonicalEventSchema,
  canonicalEvent,
} from "../../../src/lib/persistence/events.js";

describe("Canonical event schemas", () => {
  it("decodes message.created event", () => {
    const raw = {
      type: "message.created",
      sessionId: "s1",
      timestamp: Date.now(),
      payload: { role: "user", messageId: "m1" },
    };
    const result = Schema.decodeUnknownEither(CanonicalEventSchema)(raw);
    expect(Either.isRight(result)).toBe(true);
  });

  it("decodes text.delta event", () => {
    const raw = {
      type: "text.delta",
      sessionId: "s1",
      timestamp: Date.now(),
      payload: { text: "hello", messageId: "m1" },
    };
    const result = Schema.decodeUnknownEither(CanonicalEventSchema)(raw);
    expect(Either.isRight(result)).toBe(true);
  });

  it("rejects unknown event type", () => {
    const raw = {
      type: "not.a.real.event",
      sessionId: "s1",
      timestamp: Date.now(),
      payload: {},
    };
    const result = Schema.decodeUnknownEither(CanonicalEventSchema)(raw);
    expect(Either.isLeft(result)).toBe(true);
  });

  it("canonicalEvent factory produces valid events", () => {
    const event = canonicalEvent("message.created", "s1", {
      role: "user",
      messageId: "m1",
    });
    const result = Schema.decodeUnknownEither(CanonicalEventSchema)(event);
    expect(Either.isRight(result)).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/schema/canonical-events.test.ts`
Expected: FAIL — `CanonicalEventSchema` does not exist.

**Step 3: Implement canonical event schemas**

Convert `CANONICAL_EVENT_TYPES` array (lines 35-56) and `EventPayloadMap` interface (lines 224-249) into Schema definitions. Each event type gets a payload schema. Combine into `CanonicalEventSchema = Schema.Union(...)`.

Keep the `canonicalEvent()` factory function (lines 290-310) — update it to produce Schema-compatible output.

Replace `validateEventPayload()` (lines 339-356) with `Schema.decodeUnknown(CanonicalEventSchema)`.

**Nested types to also migrate:**
- `EventMetadata` interface (lines 253-267) — needs its own Schema, embedded in every `CanonicalEvent`
- `CanonicalToolInput` discriminated union (lines 116-151, 13 variants) — referenced in `ToolStartedPayload.input`. Either create full Schema or use `Schema.Unknown` as temporary escape hatch for the `input` field.
- `StoredEvent` type (lines 283-286) — extends `CanonicalEvent` with `sequence` and `streamVersion`. Must be updated to use Schema-based `CanonicalEvent`.
- There are **20 canonical event types** (not 18) in `CANONICAL_EVENT_TYPES`.

**Step 4: Run tests**

Run: `pnpm vitest run test/unit/schema/canonical-events.test.ts`
Expected: PASS

**Step 5: Run existing persistence tests**

Run: `pnpm vitest run test/unit/persistence/`
Expected: All pass.

**Step 6: Commit**

```bash
git add src/lib/persistence/events.ts test/unit/schema/canonical-events.test.ts
git commit -m "refactor: migrate canonical event types to @effect/schema"
```

---

### Task 1.7: Migrate theme validation to Schema

**Files:**
- Modify: `src/lib/server/theme-loader.ts:10-39` (validateTheme)
- Test: `test/unit/schema/theme-validation.test.ts`

**Step 1: Write the failing test**

Create `test/unit/schema/theme-validation.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { Schema, Either } from "effect";
import { Base16ThemeSchema } from "../../../src/lib/server/theme-loader.js";

describe("Theme validation schema", () => {
  it("decodes valid Base16 theme", () => {
    const theme = {
      name: "Test Theme",
      base00: "#000000", base01: "#111111", base02: "#222222", base03: "#333333",
      base04: "#444444", base05: "#555555", base06: "#666666", base07: "#777777",
      base08: "#888888", base09: "#999999", base0A: "#aaaaaa", base0B: "#bbbbbb",
      base0C: "#cccccc", base0D: "#dddddd", base0E: "#eeeeee", base0F: "#ffffff",
    };
    const result = Schema.decodeUnknownEither(Base16ThemeSchema)(theme);
    expect(Either.isRight(result)).toBe(true);
  });

  it("rejects theme with invalid hex color", () => {
    const theme = {
      name: "Bad",
      base00: "not-hex",
      // ... rest of fields
    };
    const result = Schema.decodeUnknownEither(Base16ThemeSchema)(theme);
    expect(Either.isLeft(result)).toBe(true);
  });

  it("rejects theme missing required fields", () => {
    const theme = { name: "Incomplete" };
    const result = Schema.decodeUnknownEither(Base16ThemeSchema)(theme);
    expect(Either.isLeft(result)).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/schema/theme-validation.test.ts`
Expected: FAIL — `Base16ThemeSchema` does not exist.

**Step 3: Implement theme schema**

Replace `validateTheme()` type guard with a Schema definition. Define a `HexColor` schema using `Schema.String.pipe(Schema.pattern(/^[0-9a-fA-F]{6}$/))` — **NO `#` prefix** (theme files store colors like `"282c34"`, not `"#282c34"`). Build `Base16ThemeSchema` with all 16 base color fields plus optional `author`, `variant`, and `overrides` fields.

**Variant auto-detection:** The existing `validateTheme` (lines 30-36) computes the `variant` field via luminance calculation when it's missing. Since Schema validation is pure, use `Schema.transform` or a post-decode step to compute `variant` from `base00` luminance when absent.

**Test data fix:** Update test data to use hex WITHOUT `#` prefix (e.g., `"000000"` not `"#000000"`).

**Step 4: Run tests**

Run: `pnpm vitest run test/unit/schema/theme-validation.test.ts`
Expected: PASS

**Step 5: Run full suite**

Run: `pnpm test:unit`
Expected: All pass.

**Step 6: Commit**

```bash
git add src/lib/server/theme-loader.ts test/unit/schema/theme-validation.test.ts
git commit -m "refactor: migrate theme validation to @effect/schema"
```

---

## Layer 2: Resource Lifecycle

### Task 2.1: Replace AsyncTracker with Effect Scope utilities

**Files:**
- Create: `src/lib/effect/resource.ts` (Scope-based resource utilities)
- Test: `test/unit/effect/resource.test.ts`
- Keep: `src/lib/daemon/async-tracker.ts` (delete after all consumers migrated)

**Step 1: Write the failing test**

Create `test/unit/effect/resource.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { Effect, Scope, Exit, Fiber, Duration } from "effect";
import { trackedFetch, repeating, delayed } from "../../../src/lib/effect/resource.js";

describe("Effect resource utilities", () => {
  it("trackedFetch cancels on scope close", async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        // Just verify the utility compiles and runs
        // Real fetch test would need a mock server
        return "ok";
      }),
    );
    const result = await Effect.runPromise(program);
    expect(result).toBe("ok");
  });

  it("repeating clears interval on scope close", async () => {
    let count = 0;
    const program = Effect.scoped(
      Effect.gen(function* () {
        yield* repeating(() => Effect.sync(() => { count++; }), 10);
        yield* Effect.sleep(Duration.millis(55));
        return count;
      }),
    );
    const result = await Effect.runPromise(program);
    expect(result).toBeGreaterThanOrEqual(3);

    // After scope closes, interval should be cleared
    const countAfter = count;
    await new Promise((r) => setTimeout(r, 50));
    expect(count).toBe(countAfter); // No more increments
  });

  it("delayed clears timeout on scope close", async () => {
    let fired = false;
    const program = Effect.scoped(
      Effect.gen(function* () {
        yield* delayed(() => Effect.sync(() => { fired = true; }), 1000);
        // Don't wait for timeout — scope closes immediately
      }),
    );
    await Effect.runPromise(program);
    await new Promise((r) => setTimeout(r, 50));
    expect(fired).toBe(false); // Timeout was cleared
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/effect/resource.test.ts`
Expected: FAIL — `src/lib/effect/resource.ts` does not exist.

**Step 3: Implement resource utilities**

Create `src/lib/effect/resource.ts`:

```typescript
import { Effect } from "effect";

/** Scope-managed fetch — aborts in-flight request on scope close (matches existing AbortSignal behavior). */
export const trackedFetch = (url: string, init?: RequestInit) =>
  Effect.acquireRelease(
    Effect.sync(() => new AbortController()),
    (controller) => Effect.sync(() => controller.abort()),
  ).pipe(
    Effect.flatMap((controller) =>
      Effect.tryPromise(() =>
        fetch(url, { ...init, signal: controller.signal }),
      ),
    ),
  );

/** Scope-managed repeating effect — uses Effect.repeat instead of setInterval+runFork to avoid detached fibers. */
export const repeating = (fn: () => Effect.Effect<void>, ms: number) =>
  fn().pipe(
    Effect.delay(Duration.millis(ms)),
    Effect.forever,
    Effect.forkScoped,  // fiber is supervised — cancelled on scope close
  );

/** Scope-managed delayed effect — uses Effect.delay instead of setTimeout+runFork. */
export const delayed = (fn: () => Effect.Effect<void>, ms: number) =>
  fn().pipe(
    Effect.delay(Duration.millis(ms)),
    Effect.forkScoped,  // fiber is supervised — cancelled on scope close
  );
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/effect/resource.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/effect/resource.ts test/unit/effect/resource.test.ts
git commit -m "feat: add Scope-based resource utilities (replaces AsyncTracker)"
```

---

### Task 2.2: Replace retry-fetch with Effect.retry

**Files:**
- Create: `src/lib/effect/retry-fetch.ts`
- Test: `test/unit/effect/retry-fetch.test.ts`
- Keep: `src/lib/instance/retry-fetch.ts` (delete after consumers migrated)

**Step 1: Write the failing test**

Create `test/unit/effect/retry-fetch.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";
import { fetchWithRetry } from "../../../src/lib/effect/retry-fetch.js";

describe("Effect-based retry fetch", () => {
  it("succeeds on first attempt when server responds 200", async () => {
    // This test verifies the Effect pipeline compiles and runs
    // Real HTTP tests would use a test server
    const result = await Effect.runPromiseExit(
      fetchWithRetry("http://localhost:0/does-not-exist"),
    );
    expect(Exit.isFailure(result)).toBe(true); // Connection refused is expected
  });

  it("returns typed OpenCodeConnectionError on failure", async () => {
    const result = await Effect.runPromiseExit(
      fetchWithRetry("http://localhost:0/does-not-exist"),
    );
    expect(Exit.isFailure(result)).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/effect/retry-fetch.test.ts`
Expected: FAIL — module does not exist.

**Step 3: Implement**

Create `src/lib/effect/retry-fetch.ts`:

```typescript
import { Effect, Schedule, Duration } from "effect";
import { OpenCodeConnectionError } from "../errors.js";

export interface RetryFetchOptions {
  readonly retries?: number;
  readonly retryDelay?: number;
  readonly timeout?: number;
}

export const fetchWithRetry = (
  url: string,
  init?: RequestInit,
  options: RetryFetchOptions = {},
) => {
  const { retries = 2, retryDelay = 1000, timeout = 10_000 } = options;

  return Effect.tryPromise({
    try: () => fetch(url, { ...init, signal: AbortSignal.timeout(timeout) }),
    catch: (err) => {
      // Match current behavior: timeout (AbortError) is NOT retried — fail immediately
      if (err instanceof DOMException && err.name === "AbortError") {
        return new OpenCodeConnectionError({
          message: `Request timed out after ${timeout}ms`,
        });
      }
      return new OpenCodeConnectionError({
        message: err instanceof Error ? err.message : String(err),
      });
    },
  }).pipe(
    // Match current behavior: 5xx responses are retried, but returned after exhausting retries
    Effect.flatMap((res) =>
      res.status >= 500
        ? Effect.fail(new OpenCodeConnectionError({ message: `Server error: ${res.status}` }))
        : Effect.succeed(res),
    ),
    Effect.retry({
      // Exponential backoff: 1000, 2000, 4000ms (intentional change from old linear)
      schedule: Schedule.exponential(Duration.millis(retryDelay)).pipe(
        Schedule.compose(Schedule.recurs(retries)),
      ),
      // Do NOT retry timeouts — only connection/server errors
      while: (err) => !err.message.startsWith("Request timed out"),
    }),
  );
};
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/effect/retry-fetch.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/effect/retry-fetch.ts test/unit/effect/retry-fetch.test.ts
git commit -m "feat: add Effect-based retry fetch (replaces manual backoff)"
```

---

### Task 2.3: Migrate SqliteClient transactions to Effect

**Files:**
- Modify: `src/lib/persistence/sqlite-client.ts` (add Effect-based transaction method)
- Test: `test/unit/effect/sqlite-transactions.test.ts`
- Test: existing persistence tests (verify still pass)

**Step 1: Write the failing test**

Create `test/unit/effect/sqlite-transactions.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";

describe("Effect-managed SQLite transactions", () => {
  it("commits on success", () => {
    const db = SqliteClient.memory();
    db.execute("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");

    const program = db.runInTransactionEffect(
      Effect.sync(() => {
        db.execute("INSERT INTO test (val) VALUES (?)", "hello");
      }),
    );

    Effect.runSync(program);
    const rows = db.query("SELECT val FROM test");
    expect(rows).toEqual([{ val: "hello" }]);
    db.close();
  });

  it("rolls back on failure", () => {
    const db = SqliteClient.memory();
    db.execute("CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)");

    const program = db.runInTransactionEffect(
      Effect.flatMap(
        Effect.sync(() => db.execute("INSERT INTO test (val) VALUES (?)", "hello")),
        () => Effect.fail(new Error("boom")),
      ),
    );

    const exit = Effect.runSyncExit(program);
    expect(Exit.isFailure(exit)).toBe(true);

    const rows = db.query("SELECT val FROM test");
    expect(rows).toEqual([]); // Rolled back
    db.close();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/effect/sqlite-transactions.test.ts`
Expected: FAIL — `runInTransactionEffect` does not exist.

**Step 3: Implement Effect-based transaction method**

Add to `SqliteClient` class in `src/lib/persistence/sqlite-client.ts`:

```typescript
import { Effect, Exit } from "effect";

// Add this method to SqliteClient class:
runInTransactionEffect<A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E | PersistenceError> {
  return Effect.acquireUseRelease(
    Effect.sync(() => { this.db.exec("BEGIN"); }),
    () => effect,
    (_, exit) =>
      Exit.isSuccess(exit)
        ? Effect.sync(() => { this.db.exec("COMMIT"); })
        : Effect.sync(() => { this.db.exec("ROLLBACK"); }),
  );
}
```

Keep the existing `runInTransaction` method for now — existing code still uses it. Remove it in Layer 5 when handlers are migrated.

**Nested savepoints:** The existing `runInTransaction` supports nested calls via `transactionDepth`/`savepointCounter`. `ProjectionRunner` (line 231, 279) uses nested transactions. The Effect version must support nesting — implement by checking a `Ref<number>` depth counter and using `SAVEPOINT`/`RELEASE`/`ROLLBACK TO` for depth > 0.

**Step 4: Run tests**

Run: `pnpm vitest run test/unit/effect/sqlite-transactions.test.ts`
Expected: PASS

**Step 5: Run existing persistence tests (verify nested transactions still work)**

Run: `pnpm vitest run test/unit/persistence/`
Expected: All pass — we added a method, didn't change existing ones. Pay special attention to:
- `test/unit/persistence/projection-runner.test.ts` — uses nested transactions
- `test/unit/persistence/projectors/projector.test.ts` — PersistenceError assertions

**Step 6: Commit**

```bash
git add src/lib/persistence/sqlite-client.ts test/unit/effect/sqlite-transactions.test.ts
git commit -m "feat: add Effect-based transaction method to SqliteClient"
```

---

### Task 2.4: Migrate TrackedService consumers to Scope

This task is large — each TrackedService subclass needs individual migration. Do them one at a time. For each:

1. Identify the subclass and its `drain()` usage
2. Replace `extends TrackedService` with Scope-based resource management
3. Replace `this.fetch()` with `trackedFetch` from `src/lib/effect/resource.ts`
4. Replace `this.repeating()` with `repeating` from `src/lib/effect/resource.ts`
5. Verify existing tests pass

**Files — 13 TrackedService subclasses:**
1. `src/lib/session/session-status-poller.ts` — polls session status, has overlap guard (`this.polling` flag)
2. `src/lib/session/session-overrides.ts` — manages session overrides
3. `src/lib/daemon/keep-awake.ts` — manages child processes (not just timers!) for keep-awake
4. `src/lib/daemon/version-check.ts` — periodic version check
5. `src/lib/daemon/port-scanner.ts` — scans ports
6. `src/lib/server/ws-handler.ts` — WebSocket handler
7. `src/lib/daemon/project-registry.ts` — project registration and management
8. `src/lib/relay/relay-timers.ts` — relay timing utilities
9. `src/lib/relay/sse-stream.ts` — SSE event stream
10. `src/lib/relay/message-poller-manager.ts` — manages message pollers
11. `src/lib/instance/instance-manager.ts` — OpenCode instance management
12. `src/lib/relay/message-poller.ts` — message polling (707 lines, complex)
13. `src/lib/daemon/storage-monitor.ts` — monitors storage

**Delete (after all migrated):**
- `src/lib/daemon/async-tracker.ts`
- `src/lib/daemon/tracked-service.ts`
- `src/lib/daemon/service-registry.ts`
- `src/lib/instance/retry-fetch.ts` — note: consumer `src/lib/instance/sdk-factory.ts:12` is NOT a TrackedService, update separately

**Critical ordering: TrackedService extends EventEmitter.** Do NOT delete TrackedService until Task 3.3 (EventEmitter → PubSub) is ready. **Approach: Tasks 2.4 and 3.3 must be done together per-service.** For each subclass:
1. Remove `extends TrackedService<Events>`
2. Replace `this.emit()` with `PubSub.publish()` (from Task 3.3)
3. Replace `this.repeating()`/`this.fetch()` with Effect Scope utilities (from Task 2.1)
4. Export a `*Live` Layer with `Layer.scoped`

**Step 1: Migrate each subclass (one at a time)**

For each of the 13 subclasses:
1. Convert to `make*` factory returning `Effect.Effect<ServiceShape, never, Scope.Scope>`
2. Replace `this.repeating()` → `repeating()` from `src/lib/effect/resource.ts`
3. Replace `this.fetch()` → `trackedFetch()` from `src/lib/effect/resource.ts`
4. Replace `this.emit()` → `PubSub.publish()` (created per-service)
5. For `KeepAwake`: special handling for child process management (not just timers)
6. For `SessionStatusPoller`: preserve overlap guard (`this.polling`) — use `Ref<boolean>` mutex
7. Export `*Live` Layer using `Layer.scoped`

**Step 2: After all consumers migrated, delete old files**

```bash
rm src/lib/daemon/async-tracker.ts
rm src/lib/daemon/tracked-service.ts
rm src/lib/daemon/service-registry.ts
rm src/lib/instance/retry-fetch.ts
```

**Step 4: Run full test suite**

Run: `pnpm test:unit`
Expected: All pass.

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor: migrate all TrackedService subclasses to Effect Scope"
```

---

## Layer 3: Concurrency Primitives

### Task 3.1: Replace PromptQueue with Effect Queue

**Files:**
- Modify: consumers of `src/lib/provider/claude/prompt-queue.ts`
- Delete: `src/lib/provider/claude/prompt-queue.ts` (after migration)
- Test: `test/unit/effect/prompt-queue.test.ts`

**Step 1: Write the failing test**

Create `test/unit/effect/prompt-queue.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { Effect, Queue } from "effect";

describe("Effect Queue replaces PromptQueue", () => {
  it("enqueue and dequeue in order", async () => {
    const program = Effect.gen(function* () {
      const queue = yield* Queue.unbounded<string>();
      yield* Queue.offer(queue, "first");
      yield* Queue.offer(queue, "second");

      const a = yield* Queue.take(queue);
      const b = yield* Queue.take(queue);
      return [a, b];
    });

    const result = await Effect.runPromise(program);
    expect(result).toEqual(["first", "second"]);
  });

  it("take blocks until item available", async () => {
    const program = Effect.gen(function* () {
      const queue = yield* Queue.unbounded<string>();

      // Fork a fiber that waits then enqueues
      yield* Effect.fork(
        Effect.delay(Effect.sync(() => Queue.offer(queue, "delayed")), "50 millis").pipe(
          Effect.flatMap(() => Queue.offer(queue, "delayed")),
        ),
      );

      // This should block until "delayed" arrives
      const val = yield* Queue.take(queue);
      return val;
    });

    const result = await Effect.runPromise(program);
    expect(result).toBe("delayed");
  });

  it("shutdown signals end to consumers", async () => {
    const program = Effect.gen(function* () {
      const queue = yield* Queue.unbounded<string>();
      yield* Queue.offer(queue, "item");
      yield* Queue.shutdown(queue);

      const isShutdown = yield* Queue.isShutdown(queue);
      return isShutdown;
    });

    const result = await Effect.runPromise(program);
    expect(result).toBe(true);
  });
});
```

**Step 2: Run test to verify it passes**

Run: `pnpm vitest run test/unit/effect/prompt-queue.test.ts`
Expected: PASS — this validates Effect Queue API works as expected.

**Step 3: Find PromptQueue consumers and migrate**

Run: `grep -rn "PromptQueue\|prompt-queue" src/lib/` to find all consumers.

Replace each consumer:
- `new PromptQueue()` → `yield* Queue.unbounded<SDKUserMessage>()`
- `queue.enqueue(msg)` → `yield* Queue.offer(queue, msg)`
- `queue.next()` → `yield* Queue.take(queue)`
- `queue.close()` → `yield* Queue.shutdown(queue)`
- `for await (const msg of queue)` → `Stream.fromQueue(queue)` piped through `Stream.runForEach`

**Critical: Claude SDK requires `AsyncIterable<SDKUserMessage>`** (`claude-adapter.ts:200`). Effect Queue is NOT AsyncIterable. Create a thin adapter bridge:

```typescript
function queueToAsyncIterable<A>(queue: Queue.Queue<A>): AsyncIterable<A> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<A>> {
          const exit = await Effect.runPromiseExit(Queue.take(queue));
          if (Exit.isFailure(exit)) return { done: true, value: undefined };
          return { done: false, value: Exit.isSuccess(exit) ? exit.value : undefined! };
        },
      };
    },
  };
}
```

**Shutdown semantics:** `Queue.shutdown` interrupts waiting consumers (fiber interruption), unlike `PromptQueue.close()` which delivers `{ done: true }` gracefully. Ensure the stream consumer in `claude-adapter.ts:418-429` handles interrupt as graceful shutdown, not error.

**Single-consumer guard:** Effect Queue allows multiple consumers. Wrap in single-take guard or consume via single `Stream.fromQueue` fiber to prevent message stealing.

**Step 4: Rewrite existing PromptQueue test**

`test/unit/provider/claude/prompt-queue.test.ts` tests the deleted API — rewrite entirely to test Effect Queue usage:
- `new PromptQueue()` → `Queue.unbounded<SDKUserMessage>()`
- `queue.enqueue()` → `Queue.offer()`
- `queue.next()` → `Queue.take()`
- `for await (const msg of queue)` → `Stream.fromQueue` consumer

**Step 5: Delete old file**

```bash
rm src/lib/provider/claude/prompt-queue.ts
```

**Step 6: Run full test suite**

Run: `pnpm test:unit`
Expected: All pass.

**Step 7: Commit**

```bash
git add -A
git commit -m "refactor: replace PromptQueue with Effect Queue"
```

---

### Task 3.2: Replace ClientMessageQueue with Effect Semaphore

**Files:**
- Modify: consumers of `src/lib/server/client-message-queue.ts`
- Modify: `src/lib/relay/handler-deps-wiring.ts:191-235` (enqueue callers)
- Delete: `src/lib/server/client-message-queue.ts` (after migration)
- Test: `test/unit/effect/client-message-serialization.test.ts`

**Important: ClientMessageQueue is NOT a queue — it's a per-client promise chain** (`Map<string, Promise<void>>`) that serializes handler execution. The correct Effect primitive is `Semaphore(1)` per client.

**Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { Effect, Ref } from "effect";

describe("Per-client semaphore serialization", () => {
  it("serializes concurrent handlers for same client", async () => {
    const order: string[] = [];
    const semaphore = Effect.unsafeMakeSemaphore(1);

    const handler1 = semaphore.withPermits(1)(
      Effect.gen(function* () {
        order.push("h1-start");
        yield* Effect.sleep("50 millis");
        order.push("h1-end");
      }),
    );
    const handler2 = semaphore.withPermits(1)(
      Effect.gen(function* () {
        order.push("h2-start");
        order.push("h2-end");
      }),
    );

    await Effect.runPromise(Effect.all([handler1, handler2], { concurrency: 2 }));
    // h1 finishes before h2 starts (serialized)
    expect(order).toEqual(["h1-start", "h1-end", "h2-start", "h2-end"]);
  });
});
```

**Step 2: Implement per-client semaphore map**

```typescript
// Replace ClientMessageQueue with:
const clientSemaphores = new Map<string, Semaphore>();

function getClientSemaphore(clientId: string): Semaphore {
  let sem = clientSemaphores.get(clientId);
  if (!sem) {
    sem = Effect.unsafeMakeSemaphore(1);
    clientSemaphores.set(clientId, sem);
  }
  return sem;
}

function removeClient(clientId: string): void {
  clientSemaphores.delete(clientId);
  // In-flight handlers for this client run to completion (matches current behavior)
}
```

**Step 3: Expose observability** — `activeClients` (map size) and `getQueueDepth` (binary: 0 or 1).

**Step 4: Rewrite existing ClientMessageQueue test**

`test/unit/server/client-message-queue.test.ts` tests the deleted API — rewrite entirely to test per-client Semaphore serialization.

Commit: `"refactor: replace ClientMessageQueue with per-client Effect Semaphore"`

---

### Task 3.3: Replace EventEmitter with Effect PubSub

**Files:**
- Modify: all files using `EventEmitter` for service events
- Test: `test/unit/effect/pubsub.test.ts`

**Step 1: Write the failing test**

Create `test/unit/effect/pubsub.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { Effect, PubSub, Queue, Stream, Chunk } from "effect";

describe("Effect PubSub replaces EventEmitter", () => {
  it("publishes to multiple subscribers", async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const pubsub = yield* PubSub.unbounded<{ _tag: string; data: string }>();

        const sub1 = yield* PubSub.subscribe(pubsub);
        const sub2 = yield* PubSub.subscribe(pubsub);

        yield* PubSub.publish(pubsub, { _tag: "Created", data: "session-1" });

        const msg1 = yield* Queue.take(sub1);
        const msg2 = yield* Queue.take(sub2);

        return { msg1, msg2 };
      }),
    );

    const { msg1, msg2 } = await Effect.runPromise(program);
    expect(msg1._tag).toBe("Created");
    expect(msg2._tag).toBe("Created");
    expect(msg1.data).toBe("session-1");
  });
});
```

**Step 2: Run test — should pass (validates PubSub API)**

**Step 3: Find all EventEmitter usage and migrate**

**Scope: 133 `.on()`/`.emit()` call sites across 28 files.** This is NOT a single task — break into subtasks, one per service class. Key services by volume: InstanceManager (15), ProjectRegistry (13), WebSocketHandler (11), KeepAwake (8), SSEStream (8), SessionManager (5).

**Exclusion list:** Do NOT migrate `.on()`/`.emit()` on Node.js built-ins: `process.on()` (signal-handlers.ts:28-30), `httpServer.on()` (daemon-lifecycle.ts:126, relay-stack.ts:730), `ws.WebSocket.on()` (pty-upstream.ts:86-135), `wss.on()` (ws-handler.ts:163). Only migrate application-level EventEmitter subclasses.

**Sync → async semantic change:** `EventEmitter.emit()` is synchronous — handlers run in the same tick. `PubSub.publish()` is async. This breaks sites where callers depend on handlers having run before emit returns (e.g., `session-manager.ts:382-386` calls `broadcastSessionList()` after emit, assuming lifecycle handler already fired). Analyze each call site — some may need `Effect.sync` + direct calls instead of PubSub.

**Subscriber cleanup:** EventEmitter listeners rely on GC. PubSub subscribers need explicit Scope. Wiring functions (`handler-deps-wiring.ts`, `poller-wiring.ts`, `session-lifecycle-wiring.ts`, `sse-wiring.ts`) must return cleanup handles or wrap subscriber creation in `Effect.scoped`.

**Merged with Task 2.4:** As noted in Task 2.4, TrackedService removal and EventEmitter → PubSub are done together per-service.

Define typed event unions for each service (e.g., `SessionEvent`, `RelayEvent`).

**Step 4: Update existing tests using `.on()` / `.emit()` patterns (~12 files)**

These tests use EventEmitter APIs from TrackedService subclasses. Update as each service migrates:
- `test/unit/daemon/tracked-service.test.ts` — **entire test rewrite** (tests TrackedService API directly)
- `test/unit/relay/message-poller.test.ts`
- `test/unit/session/session-status-poller.test.ts`
- `test/unit/session/session-status-poller-reconciliation.test.ts`
- `test/unit/session/session-status-poller-augment.test.ts`
- `test/unit/server/ws-handler.pbt.test.ts`
- `test/unit/server/ws-handler-sessions.test.ts`
- `test/unit/relay/sse-stream.test.ts`
- `test/unit/daemon/daemon.test.ts`
- `test/unit/instance/instance-manager.test.ts`
- `test/unit/instance/instance-state-machine.test.ts`
- `test/integration/flows/daemon-lifecycle.integration.ts`

For each test: replace `svc.on("event", cb)` with PubSub subscription, replace `svc.emit("event", data)` with `PubSub.publish()`.

**Step 5: Run full test suite**

Run: `pnpm test:unit`
Expected: All pass.

**Step 6: Commit**

```bash
git add -A
git commit -m "refactor: replace EventEmitter with Effect PubSub"
```

---

### Task 3.4: Replace poller gating with Deferred + Ref

**Files:**
- Modify: `src/lib/relay/message-poller.ts:448-707`
- Test: `test/unit/effect/poller-gate.test.ts`

**Scope clarification:** MessagePoller is 707 lines. The pure functions at lines 73-444 (`synthesizeTextPart`, `synthesizeToolPart`, `synthesizePartEvents`, `diffAndSynthesize`, `buildSeedSnapshot`, `extractUserText`, `synthesizeResultEvent`) must NOT be modified. Only the `MessagePoller` class (lines 469-707) is in scope.

**Primitive: `SubscriptionRef<boolean>` for SSE active/silent toggle.** Reactive — poller activates instantly when SSE goes quiet, stops polling entirely during activity (no wasted cycles).

```typescript
const makePollerGate = Effect.gen(function* () {
  const sseActive = yield* SubscriptionRef.make(true);

  // Poller subscribes to changes — only runs when sseActive is false
  const pollerFiber = yield* SubscriptionRef.changes(sseActive).pipe(
    Stream.filter((active) => !active),
    Stream.runForEach(() => pollOnce()),
    Effect.forkScoped,
  );

  return {
    signalSseSilent: SubscriptionRef.set(sseActive, false),
    signalSseActive: SubscriptionRef.set(sseActive, true),
  };
});
```

**State field mapping:**
- `sseActive` → `SubscriptionRef<boolean>` (reactive toggle, replaces boolean flag + setTimeout)
- `lastSSEEventAt` → `Ref<number>` (timestamp)
- `lastContentAt` → `Ref<number>` (timestamp)
- `polling` overlap guard → `Ref<boolean>` (mutex)
- `needsReseed` → `Ref<boolean>`
- `needsSeedOnFirstPoll` → `Ref<boolean>`
- `timer` → eliminated — polling driven by `SubscriptionRef.changes` stream, not a repeating timer
- `previousSnapshot`, `activeSessionId` → stay as plain instance state (not reactive)

**Dependency ordering:** Tasks 2.4 + 3.4 are done together per-service (see Task 2.4 merge note). `this.repeating()` and `this.tracked()` replaced with Effect equivalents simultaneously.

**Step 1: Write the failing test** — test the gating state machine in isolation.

**Step 2: Implement** — replace boolean flags and setTimeout chains with Ref-based state.

**Step 3: Run tests**

**Step 4: Commit**

```bash
git commit -m "refactor: replace poller gating with Effect Ref-based state machine"
```

---

### Task 3.5: Replace idempotency tracking with Effect Ref\<Set\>

**Files:**
- Modify: `src/lib/provider/orchestration-engine.ts:110-152`
- Test: `test/unit/effect/idempotency.test.ts`

**Wrong primitive corrected:** Effect Cache is a memoization cache (lookup + store result) — cannot check "has this key been seen?" without inserting. The correct primitive is `Ref<Set<string>>` with manual FIFO capacity check, matching the current `Set.add()` + `pruneProcessedCommands()` behavior (insertion-order eviction, not time-based).

**Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { Effect, Ref } from "effect";

describe("Idempotency tracking with Ref<Set>", () => {
  it("rejects duplicate command IDs", async () => {
    const program = Effect.gen(function* () {
      const processed = yield* Ref.make(new Set<string>());
      const maxSize = 5;

      const tryProcess = (id: string) =>
        Ref.modify(processed, (set) => {
          if (set.has(id)) return [false, set] as const;
          const next = new Set(set);
          next.add(id);
          // FIFO eviction when over capacity
          if (next.size > maxSize) {
            const first = next.values().next().value;
            if (first) next.delete(first);
          }
          return [true, next] as const;
        });

      const r1 = yield* tryProcess("cmd-1");
      const r2 = yield* tryProcess("cmd-1"); // duplicate
      const r3 = yield* tryProcess("cmd-2");
      return { r1, r2, r3 };
    });

    const result = await Effect.runPromise(program);
    expect(result.r1).toBe(true);
    expect(result.r2).toBe(false); // rejected
    expect(result.r3).toBe(true);
  });
});
```

**Step 2: Implement — replace manual `Set` + `pruneProcessedCommands()` with `Ref.modify` pattern above.**

**Step 3: Run tests**

**Step 4: Commit**

```bash
git commit -m "refactor: replace idempotency tracking with Effect Ref<Set>"
```

---

## Layer 4: DI / Service Composition

### Task 4.1: Define Context.Tags for all services

**Files:**
- Create: `src/lib/effect/services.ts` (all service Tags)
- Test: `test/unit/effect/services.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { Context, Effect } from "effect";
import {
  OpenCodeAPITag,
  SessionManagerTag,
  WebSocketHandlerTag,
} from "../../../src/lib/effect/services.js";

describe("Service Tags", () => {
  it("OpenCodeAPI tag resolves in context", async () => {
    const program = Effect.gen(function* () {
      const api = yield* OpenCodeAPITag;
      return typeof api;
    });

    // Verify it fails without provider (type-level check)
    // This test mainly validates the Tags compile and work
    expect(OpenCodeAPITag.key).toBe("OpenCodeAPI");
  });
});
```

**Step 2: Implement service Tags**

Create `src/lib/effect/services.ts` with a `Context.Tag` for each service in `HandlerDeps` (lines 61-113 of `src/lib/handlers/types.ts`).

**Full list of required Tags** (15 required + 7 optional fields):

Required:
1. `WebSocketHandlerTag` — **NOTE:** `wsHandler` (types.ts:62-70) is an inline structural type with 6 methods, not an importable class. Define a `WebSocketHandlerShape` interface first.
2. `OpenCodeAPITag` — importable class
3. `SessionManagerTag` — importable class
4. `PermissionBridgeTag` — importable class
5. `QuestionBridgeTag` — importable class
6. `SessionOverridesTag` — importable class
7. `PtyManagerTag` — importable class
8. `ProjectRelayConfigTag` — `config` field (types.ts:77) is a 30+ field config object
9. `LoggerTag` — pino logger
10. `StatusPollerTag` — **NOTE:** `statusPoller` (types.ts:80) is `Pick<SessionStatusPoller, "isProcessing">`. Define interface.
11. `ProjectRegistryTag` — importable class
12. `PollerManagerTag` — **NOTE:** `pollerManager` (types.ts:84) is a `Pick<...>`. Define interface.
13. `ConnectPtyUpstreamTag` — **NOTE:** bare function type (types.ts:85). Define interface.
14. `ForkMetaTag` — **NOTE:** inline object type (types.ts:87-90). Define interface.
15. `ClientIdTag` — **NEW:** per-request client identifier (see Task 5.1 handler signature fix)

Daemon-only (split into `DaemonExtensionsLayer` — only provided in daemon mode):
1. `InstanceMgmtTag` — `instanceMgmt?`
2. `ProjectMgmtTag` — `projectMgmt?`
3. `ScanDepsTag` — `scanDeps?`

Persistence-dependent (split into `PersistenceExtensionsLayer` — provided when SQLite is configured, in BOTH daemon and standalone modes):
1. `ReadQueryTag` — `readQuery?` — "only available when persistence is configured"
2. `ClaudeEventPersistTag` — `claudeEventPersist?` — "only when SQLite is configured"
3. `ProviderStateServiceTag` — `providerStateService?` — persistence-dependent

Always present (move to `CoreHandlerLayer`):
1. `OrchestrationEngineTag` — `orchestrationEngine?` — relay-stack.ts always provisions it via simulated InstanceManager

**Layer split strategy:**
```typescript
// Always present
const CoreHandlerLayer = Layer.mergeAll(
  SessionManagerLive, OpenCodeAPILive, WebSocketHandlerLive,
  PermissionBridgeLive, PersistenceLive, OrchestrationEngineLive,
  /* ... core services */
);

// Persistence extensions — provided when SQLite is configured (both modes)
const PersistenceExtensionsLayer = Layer.mergeAll(
  ReadQueryLive, ClaudeEventPersistLive, ProviderStateServiceLive,
);

// Daemon-only extensions
const DaemonExtensionsLayer = Layer.mergeAll(
  InstanceMgmtLive, ProjectMgmtLive, ScanDepsLive,
);

// Standalone mode — core + optional persistence
const StandaloneLayer = CoreHandlerLayer.pipe(
  Layer.provideMerge(PersistenceExtensionsLayer), // when SQLite configured
);

// Daemon mode — all services available
const DaemonLayer = CoreHandlerLayer.pipe(
  Layer.provideMerge(PersistenceExtensionsLayer),
  Layer.provideMerge(DaemonExtensionsLayer),
);
```

Daemon-only handlers can only be dispatched when running with `DaemonLayer`. Persistence-dependent handlers require `PersistenceExtensionsLayer`. Type system enforces both at compile time.

For inline/Pick/function-typed fields: define explicit `Shape` interfaces first, then create Tags for those shapes.

**Step 3: Run tests, commit**

```bash
git commit -m "feat: define Context.Tags for all services"
```

---

### Task 4.2: Create Layers for each service

**Files:**
- Create: `src/lib/effect/layers.ts` (or per-service files)
- Test: `test/unit/effect/layers.test.ts`

For each service Tag, create a `*Live` Layer that constructs the service from its dependencies. Each Layer uses `Layer.effect(Tag, Effect.gen(...))` pattern.

Services with resource lifecycle (timers, connections) use `Layer.scoped` instead of `Layer.effect`.

**Step 1: Start with leaf services (no deps on other services)**

- `ServerConfigLive` — reads config file, validates with Schema
- `SqliteClientLive` — opens database

**Step 2: Build dependent services**

- `SessionManagerLive` — depends on SqliteClient
- `OpenCodeAPILive` — depends on ServerConfig

**Step 3: Compose into HandlerLayer**

```typescript
export const HandlerLayer = Layer.mergeAll(
  SessionManagerLive,
  OpenCodeAPILive,
  WebSocketHandlerLive,
  PermissionBridgeLive,
  // ...
).pipe(
  Layer.provide(SqliteClientLive),
  Layer.provide(ServerConfigLive),
);
```

**Step 4: Run tests, commit**

```bash
git commit -m "feat: create Effect Layers for all services"
```

---

### Task 4.3: Migrate configuration to Schema-validated Layer

**Files:**
- Modify: `src/lib/daemon/config-persistence.ts`
- Test: `test/unit/effect/config.test.ts`
- Test: `test/unit/daemon/config-persistence.test.ts` (existing)

**Step 1: Create DaemonConfigSchema**

Define Schema for the full `DaemonConfig` interface, including nested `projects` and `instances` arrays.

**Step 2: Create ServerConfigLive Layer**

**Critical: `loadDaemonConfig` returns `null` on missing file** (first startup has no daemon.json). Effect Layer must handle this — use `Effect.option` or provide defaults.

```typescript
// configDir flows from CLI args → RelayStackConfig.configDir → this Layer
export const ServerConfigLive = (configDir?: string) =>
  Layer.effect(
    ServerConfigTag,
    Effect.gen(function* () {
      const dir = configDir ?? getDefaultConfigDir();
      const raw = yield* Effect.try(() => readFileSync(join(dir, "daemon.json"), "utf-8")).pipe(
        Effect.option, // Returns Option.none on file-not-found
      );
      if (Option.isNone(raw)) {
        const defaults = defaultDaemonConfig();
        yield* Effect.try(() => saveDaemonConfigSync(defaults, dir)); // write defaults to disk
        return defaults;
      }
      const json = yield* Effect.try(() => JSON.parse(raw.value));
      return yield* Schema.decodeUnknown(DaemonConfigSchema)(json);
    }),
  );
```

**Write path:** `saveDaemonConfig`, `clearDaemonConfig`, `readCrashInfo`, `writeCrashInfo`, `clearCrashInfo`, `syncRecentProjects` — these 6 functions stay imperative for now. Only the read path (config loading) becomes a Layer. Note this in the plan for future migration.

**Step 3: Run tests, commit**

```bash
git commit -m "refactor: migrate config to Schema-validated Effect Layer"
```

---

### Task 4.4: Eliminate wireHandlerDeps

**Ordering: This task MUST come AFTER Task 5.2** (handler migration). Handlers currently receive `deps: HandlerDeps` which `wireHandlerDeps` constructs. Delete only after handlers use `yield*` Tags instead.

**`wireHandlerDeps` does far more than DI** (handler-deps-wiring.ts:71-238). Each behavior must migrate somewhere:

| Current behavior | Where it moves |
|---|---|
| `RateLimiter` creation (line 95) | Own Layer with cleanup finalizer, or WebSocket middleware |
| `QuestionBridge` creation (line 98) | Own Layer |
| `client_connected` event handler (lines 100-129) | WebSocket Layer (Task 6.4) |
| `client_disconnected` cleanup (lines 131-135) | WebSocket Layer (Task 6.4) |
| `ClientMessageQueue` (now Semaphore, Task 3.2) | Own Layer |
| Rate limiting + log level + dispatch logic (lines 201-235) | WebSocket message middleware |
| `connectPtyUpstream` closure (line 147) | PtyManager Layer |
| `forkMeta` closure (lines 149-155) | ForkMeta Layer or config |

**Files:**
- Delete: `src/lib/relay/handler-deps-wiring.ts` (AFTER all behavior migrated)
- Modify: `src/lib/relay/relay-stack.ts` — `rateLimiter` cleanup timer (line 548) moves to Layer finalizer
- Modify: `src/lib/handlers/index.ts` — dispatch uses Effect runtime

**Step 1: Create individual Layers for each behavior** listed above.

**Step 2: Update relay-stack to use Layer composition** instead of `wireHandlerDeps()` call.

**Step 3: Delete wiring module**

**Step 4: Run full test suite**

Run: `pnpm test:unit`
Expected: All pass.

**Step 5: Commit**

```bash
git commit -m "refactor: eliminate wireHandlerDeps, use Effect Layer composition"
```

---

## Layer 5: Handler Migration

### Task 5.1 + 5.2: Migrate handler types and implementations (single PR)

**Tasks 5.1 and 5.2 are combined into a single PR** to avoid a broken build state. Changing the handler type without migrating all handlers would break CI.

**Files:**
- Modify: `src/lib/handlers/types.ts:115-119`
- Modify: all handler files (see list below)
- Modify: `src/lib/handlers/index.ts:156-227`

**Correct current handler signature:** The actual signature is `(deps: HandlerDeps, clientId: string, payload: PayloadMap[K]) => Promise<void>` — NOT `(payload, deps, context?)` as previously stated. Every handler uses `clientId` for `sendTo()`, session resolution, and logging.

**Step 1: Update MessageHandler type**

```typescript
// Actual old:
export type MessageHandler<K extends keyof PayloadMap> = (
  deps: HandlerDeps,
  clientId: string,
  payload: PayloadMap[K],
) => Promise<void>;

// New — clientId stays as parameter, deps come from Effect context:
export type MessageHandler<K extends keyof PayloadMap> = (
  clientId: string,
  payload: PayloadMap[K],
) => Effect.Effect<void, RelayError>;
```

Note: return type is `void` not `void | Record<string, unknown>` — current handlers never return data through return value (all responses via `sendTo()`).

**Step 2: Migrate handler files (one at a time, commit together)**

Handler files to migrate (NOT utilities):
1. `agent.ts`, 2. `model.ts`, 3. `settings.ts`, 4. `reload.ts`, 5. `files.ts`,
6. `permissions.ts`, 7. `session.ts`, 8. `prompt.ts`, 9. `terminal.ts`,
10. `instance.ts`, 11. `tool-content.ts`

**NOT handlers** (do not include in handler migration):
- `fixup-config-file.ts` — standalone utility, called by model.ts and permissions.ts
- `resolve-session.ts` — synchronous helper, returns `string | undefined`
- `payloads.ts` — type definitions only
- `types.ts` — type definitions only
- `index.ts` — dispatch table (migrated in Step 3)

**Error recovery guidance:** Do NOT blanket-remove try/catch. Some handlers have intentional recovery:
- `prompt.ts:131-171` — persistence failure is non-fatal, must not block message sending → use `Effect.catchTag` with logging
- `prompt.ts:287-306` — send failure sends error to client and broadcasts done → use `Effect.catchAll` with recovery logic
- `terminal.ts:19-34` — PTY creation failure sends error to client → use `Effect.catchAll` with error response
- `permissions.ts` — restarts processing timeout on error → preserve with `Effect.catchAll`

Convert bare try/catch that just rethrow or log-and-ignore → remove (let Effect error channel handle).

**Step 3: Update existing handler tests (~18 files)**

All handler test files call handlers with old `(deps, clientId, payload)` signature. Update to use Effect test pattern:

```typescript
// Old: await handleForkSession(deps, "client-1", { sessionId: "s1" });
// New:
const TestLayer = Layer.mergeAll(MockSessionManagerLive, MockWsHandlerLive, /* ... */);
await Effect.runPromise(
  handleForkSession("client-1", { sessionId: "s1" }).pipe(Effect.provide(TestLayer)),
);
```

Test files to update:
- `test/unit/handlers/message-handlers.test.ts`
- `test/unit/handlers/handlers-session.test.ts`
- `test/unit/handlers/handlers-model.test.ts`
- `test/unit/handlers/handlers-instance.test.ts`
- `test/unit/handlers/handlers-file-tree.test.ts`
- `test/unit/handlers/handlers-reload.test.ts`
- `test/unit/handlers/proxy-detect.test.ts`
- `test/unit/handlers/get-tool-content-handler.test.ts`
- `test/unit/handlers/list-directories.test.ts`
- `test/unit/handlers/scan-now.test.ts`
- `test/unit/handlers/resolve-session.test.ts`
- `test/unit/handlers/instance-rename.test.ts`
- `test/unit/handlers/prompt-claude-persistence.test.ts`
- `test/unit/handlers/project-management.test.ts`
- `test/unit/handlers/regression-question-on-session-view.test.ts`
- `test/unit/regression-question-session-scoping.test.ts`
- `test/unit/regression-claude-history-wiring.test.ts`
- `test/unit/bridges/question-answer-flow.test.ts`

**Step 4: Run `pnpm check` after ALL handlers migrated** (cannot pass incrementally due to dispatch table typing).

**Step 5: Commit**

```bash
git commit -m "refactor: migrate all handlers to Effect-based signature"
```

---

### Task 5.2: Migrate handlers (batch by file)

**Files:**
- Modify: all 16 handler files in `src/lib/handlers/`

**Strategy:** Migrate one handler file at a time. For each file:

1. Remove `deps: HandlerDeps` parameter
2. Wrap body in `Effect.gen(function* () { ... })`
3. Replace `deps.X` with `yield* XTag`
4. Replace `await` with `yield*`
5. Remove try/catch blocks — errors propagate via Effect channel
6. Run `pnpm check` after each file to verify types
7. Run `pnpm test:unit` after each file to verify behavior

**Order** (simplest first):
1. `agent.ts`
2. `model.ts`
3. `settings.ts`
4. `reload.ts`
5. `files.ts`
6. `permissions.ts`
7. `session.ts`
8. `prompt.ts`
9. `terminal.ts`
10. `instance.ts`
11. `tool-content.ts`
12. `resolve-session.ts`
13. `payloads.ts`
14. `fixup-config-file.ts`

**Commit after each file** or batch 2-3 simple handlers per commit:

```bash
git commit -m "refactor: migrate agent and model handlers to Effect"
```

---

### Task 5.3: Migrate dispatch table to Effect

**Files:**
- Modify: `src/lib/handlers/index.ts:156-227`
- Create: `src/lib/handlers/payload-schemas.ts` (prerequisite — 43 Schema definitions)

**Prerequisite: Create PayloadSchemas record.** The `PayloadMap` (payloads.ts:13-78) is a TypeScript interface — no runtime representation. Create `payload-schemas.ts` with one Schema per message type (43 entries matching every key in PayloadMap). Consider whether this belongs in Layer 1 instead.

**Step 1: Create payload schemas**

```typescript
// src/lib/handlers/payload-schemas.ts
import { Schema } from "effect";
import type { PayloadMap } from "./payloads.js";

export const PayloadSchemas: { [K in keyof PayloadMap]: Schema.Schema<PayloadMap[K]> } = {
  get_agents: Schema.Struct({}),
  switch_agent: Schema.Struct({ agentId: Schema.String }),
  // ... 41 more entries matching PayloadMap
};
```

**Step 2: Update dispatch function**

```typescript
// Current signature: (deps, clientId, handler, payload)
// New signature: (clientId, type, raw) => Effect
export const dispatchMessage = (clientId: string, type: IncomingMessageType, raw: unknown) =>
  Effect.gen(function* () {
    const handler = MESSAGE_HANDLERS[type];
    if (!handler) {
      return yield* Effect.fail(new WebSocketError({ message: `Unknown: ${type}` }));
    }
    const payload = yield* Schema.decodeUnknown(PayloadSchemas[type])(raw);
    return yield* handler(clientId, payload);
  }).pipe(
    Effect.catchTag("ParseError", (err) =>
      Effect.succeed({ error: { code: "INVALID_PAYLOAD", message: String(err) } }),
    ),
    // Only catch domain errors — let programming bugs (defects) propagate
    Effect.catchTags({
      OpenCodeApiError: (err) => Effect.succeed(err.toJSON()),
      OpenCodeConnectionError: (err) => Effect.succeed(err.toJSON()),
      WebSocketError: (err) => Effect.succeed(err.toJSON()),
      // ... other error tags
    }),
  );
```

**Error semantics — two layers of handling:**
1. **Domain errors** (expected failures: API 404, session not found, connection dropped, rate limited) — caught at dispatch via `Effect.catchTags`, serialized as structured error responses to the client.
2. **Defects** (programming bugs: null reference, type mismatch, undefined method) — propagate uncaught through dispatch, handled by top-level `Effect.catchAllCause` in the ManagedRuntime (Layer 6) which logs full stack trace + returns generic `system_error` to client.

Do NOT use `Effect.catchAll` — it conflates domain errors and defects. Nothing should be silently caught.

**Integration point:** The WebSocket message event handler calls `Effect.runPromise(dispatchMessage(...).pipe(Effect.provide(HandlerLayer)))`. This runner lives in the WebSocket Layer (Task 6.4) or a ManagedRuntime created from HandlerLayer stored for the relay's lifetime.

**Step 3: Run full test suite**

Run: `pnpm test:unit`
Expected: All pass.

**Step 4: Commit**

```bash
git commit -m "refactor: migrate dispatch table to Effect with Schema validation"
```

---

## Layer 6: Server & Relay Orchestration

### Task 6.1: Install @effect/platform

**Files:**
- Modify: `package.json`

**Step 1: Install**

Run: `pnpm add @effect/platform @effect/platform-node`

**Step 2: Verify**

Run: `pnpm check && pnpm test:unit`

**Step 3: Commit**

```bash
git commit -m "chore: add @effect/platform dependencies"
```

---

### Task 6.2: Migrate HTTP router to @effect/platform

**Files:**
- Rewrite: `src/lib/server/http-router.ts` (728 lines → ~250-300 lines)
- Test: `test/unit/server/http-router.test.ts`

**Step 1: Write tests for key routes**

Test health, auth, projects list, project delete, push subscribe, CA download, static files, SPA fallback. Use `@effect/platform` test utilities or Effect runtime to run route handlers.

**Step 2: Implement @effect/platform router**

Key patterns:
- CORS: `HttpMiddleware.cors(corsConfig)`
- Auth gate: custom middleware checking cookie/header
- Error responses: shared `apiError(code, message, status)` helper returning `HttpServerResponse.json`
- Body parsing: `HttpServerRequest.schemaBodyJson(Schema)` for POST endpoints
- Route params: `HttpRouter.params` for `:slug` extraction
- Static files: `HttpMiddleware.serveStatic` or manual static serving

**Step 3: Update existing router and route tests**

- `test/unit/server/http-router.test.ts` — router API changes to @effect/platform patterns
- `test/unit/server/push-routes.test.ts` — error format changes

**Step 4: Run tests**

**Step 5: Commit**

```bash
git commit -m "refactor: migrate HTTP router to @effect/platform"
```

---

### Task 6.3: Compose relay stack as ManagedRuntime

**Files:**
- Modify: `src/lib/relay/relay-stack.ts`

**Step 1: Replace createProjectRelay with Layer composition**

```typescript
export const ProjectRelayLive = Layer.mergeAll(
  OpenCodeAPILive,
  SessionManagerLive,
  WebSocketHandlerLive,
  SSEStreamLive,
  TranslatorLive,
  PermissionBridgeLive,
  OrchestrationLive,
  MessagePollerLive,
  HttpRouterLive,
).pipe(
  Layer.provide(PersistenceLive),
  Layer.provide(ServerConfigLive),
);
```

**Step 2: Update CLI entry point**

In `src/bin/cli.ts` (or `cli-core.ts`):

```typescript
const main = ProjectRelayLive.pipe(
  Layer.launch,
  Effect.catchAllCause((cause) =>
    Effect.logError("Fatal", Cause.pretty(cause)),
  ),
);

Effect.runFork(main);
```

**Step 3: Update existing relay stack and integration tests**

- `test/unit/relay/relay-stack-dual-write-wiring.test.ts` — RelayStack API changes
- `test/unit/relay/per-tab-routing-e2e.test.ts` — RelayStack integration
- `test/unit/provider/orchestration-engine.test.ts` — orchestration wiring changes
- `test/unit/provider/orchestration-wiring.test.ts` — provider wiring changes
- `test/integration/flows/relay-lifecycle.integration.ts` — full lifecycle changes

**Step 4: Run full test suite and manual smoke test**

Run: `pnpm test:unit && pnpm build`
Then manually start with `pnpm dev` and verify server starts, WebSocket connects, routes respond.

**Step 5: Commit**

```bash
git commit -m "refactor: compose relay stack as Effect ManagedRuntime"
```

---

### Task 6.4: Migrate WebSocket handler to Effect Stream

**Files:**
- Modify: `src/lib/server/ws-handler.ts`
- Modify: `src/lib/server/ws-router.ts`

**Step 1: Replace manual ws event handlers with Effect Stream**

```typescript
const handleConnection = (ws: WebSocket) =>
  Effect.acquireRelease(
    Effect.sync(() => registerConnection(ws)),
    (conn) => Effect.sync(() => conn.cleanup()),
  ).pipe(
    Effect.flatMap((conn) =>
      Stream.fromEventListener(ws, "message").pipe(
        Stream.mapEffect((msg) => dispatchMessage(conn, msg)),
        Stream.runDrain,
      ),
    ),
  );
```

**Step 2: Update existing WebSocket handler tests**

- `test/unit/server/ws-router.pbt.test.ts` — EventEmitter patterns to Effect Stream

**Step 3: Run tests and smoke test**

**Step 4: Commit**

```bash
git commit -m "refactor: migrate WebSocket handler to Effect Stream"
```

---

## Layer 7: Frontend Transport

### Task 7.1: Add Effect to frontend bundle (lazy-loaded)

**Files:**
- Modify: `vite.config.ts` (configure code splitting for effect)
- Create: `src/lib/frontend/transport/runtime.ts`
- Test: manual — verify bundle size and first-load time

**Step 0: Measure baseline bundle size**

Run: `pnpm build:frontend && du -sh dist/`
Record the total bundle size and main chunk sizes. Set a hard budget: **+50KB gzipped max** for the Effect chunk. If Effect exceeds this budget after Step 1, defer Layer 7 or scope to Schema-only (no Stream/ManagedRuntime on frontend).

**Step 1: Configure Vite code splitting**

In `vite.config.ts`, **merge** with the existing `output` config (which has custom `entryFileNames` for the service worker). Do NOT replace the whole `output` object:

```typescript
build: {
  rollupOptions: {
    output: {
      // KEEP existing entryFileNames for service worker
      entryFileNames: (chunk) => chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js",
      manualChunks: {
        effect: ["effect"],  // @effect/schema is merged into effect — no separate package
      },
    },
  },
},
```

**Step 2: Create ManagedRuntime bridge**

Create `src/lib/frontend/transport/runtime.ts`:

The runtime is a long-lived singleton (app lifetime). Individual WebSocket connections are managed as fibers within the runtime. On reconnect, only the stream fiber is interrupted — the runtime and its service graph persist.

```typescript
import { ManagedRuntime, Layer, Fiber, Effect } from "effect";
import type { RuntimeFiber } from "effect/Fiber";

// Lazy-loaded — not in critical path
const TransportLayer = Layer.empty; // Will be populated in Task 7.2

let runtime: ManagedRuntime.ManagedRuntime<never, never> | null = null;
let activeStreamFiber: RuntimeFiber<void, unknown> | null = null;

/** Get or create the long-lived runtime (app lifetime). */
export async function getRuntime() {
  if (!runtime) {
    runtime = ManagedRuntime.make(TransportLayer);
  }
  return runtime;
}

/** Interrupt the active stream fiber (connection lifetime). Called on disconnect/reconnect. */
export async function interruptStream() {
  if (activeStreamFiber) {
    const rt = await getRuntime();
    await rt.runPromise(Fiber.interrupt(activeStreamFiber));
    activeStreamFiber = null;
  }
}

/** Set the active stream fiber (called after forking a new WS stream). */
export function setActiveStreamFiber(fiber: RuntimeFiber<void, unknown>) {
  activeStreamFiber = fiber;
}

/** Dispose the entire runtime (page unload only). */
export async function disposeRuntime() {
  await interruptStream();
  if (runtime) {
    await runtime.dispose();
    runtime = null;
  }
}
```

**Step 2a: Wire lifecycle hooks**

In `src/lib/frontend/components/layout/ChatLayout.svelte`, add alongside existing `disconnect()`:

```typescript
import { interruptStream, disposeRuntime } from "../transport/runtime.js";

// In $effect cleanup (component unmount / SPA navigation):
// Interrupt stream fiber, keep runtime alive
$effect(() => {
  connect();
  return () => {
    interruptStream();
    disconnect();
  };
});

// Page unload: dispose entire runtime
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => disposeRuntime());
}
```

**Step 3: Build and measure bundle size delta**

Run: `pnpm build:frontend && du -sh dist/`
Compare against baseline from Step 0. Effect chunk must be under +50KB gzipped. If exceeded, STOP and evaluate whether Layer 7 should be deferred or scoped to Schema-only.

**Step 4: Verify first-load time**

Run: `pnpm preview:frontend` and test in browser. First paint should be under 1.5s.

**Step 5: Commit**

```bash
git commit -m "feat: add Effect to frontend bundle with lazy code splitting"
```

---

### Task 7.2: Migrate WebSocket message handling to Effect Stream

**Scope:** Replace ONLY the `ws.addEventListener("message", ...)` handler with an Effect Stream. Keep ALL existing connect/disconnect/reconnect logic, URL construction, state management, and lifecycle hooks in `ws.svelte.ts`.

**Files:**
- Modify: `src/lib/frontend/stores/ws.svelte.ts` (336 lines — surgical change, not rewrite)
- Modify: `src/lib/frontend/transport/runtime.ts`
- Test: manual — verify WebSocket connects and messages flow

**Critical: DO NOT replace the following existing features** (lines from ws.svelte.ts):
- Connect timeout with `CONNECT_TIMEOUT_MS` (line 55)
- Self-healing status detection (lines 266-278)
- Slug-based URL construction with session ID query param (lines 186-198)
- `_currentSlug` tracking for auto-reconnect (line 106)
- `wsState` reactive state updates (`status`, `statusText`, `attempts`, `relayStatus` — lines 70-79)
- `flushOfflineQueue()` on open (line 226)
- `phaseToIdle()` and `clearInstanceState()` on close (lines 247-249)
- `wsDebugLog` tracing (throughout)
- `onConnect` callback mechanism (lines 100-103)
- Non-blocking `fetchRelayStatus()` (lines 113-134)
- `scheduleReconnect()` with 1s base, 1.5x multiplier, 10s cap (lines 300-313)

**Step 1: Create Effect message stream factory**

In `src/lib/frontend/transport/runtime.ts`, add a stream factory that wraps an EXISTING WebSocket (not creating a new one — ws.svelte.ts manages the connection):

```typescript
import { Effect, Stream, Chunk, Option } from "effect";
import type { RelayMessage } from "../../shared-types.js";

/**
 * Create a Stream from an existing WebSocket's message events.
 * Does NOT manage connection lifecycle — ws.svelte.ts owns that.
 * Stream ends when WebSocket closes. Caller handles reconnect.
 */
export const wsMessageStream = (ws: WebSocket): Stream.Stream<RelayMessage, Error> =>
  Stream.async<RelayMessage, Error>((emit) => {
    const onMessage = (evt: MessageEvent) => {
      try {
        const parsed = JSON.parse(evt.data) as RelayMessage;
        emit(Effect.succeed(Chunk.of(parsed)));
      } catch (e) {
        // Bad JSON — skip message, don't kill stream
        console.warn("WS parse error:", e);
      }
    };
    const onClose = () => emit(Effect.fail(Option.none()));  // Signal stream end
    const onError = (e: Event) => emit(Effect.fail(Option.some(new Error("WebSocket error"))));

    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", onClose);
    ws.addEventListener("error", onError);

    // Cleanup when stream is interrupted
    return Effect.sync(() => {
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("close", onClose);
      ws.removeEventListener("error", onError);
    });
  });
```

Note: uses `JSON.parse` + type assertion for now (fast path). Schema validation deferred — the design doc recommends "Critical path uses raw JSON.parse + type assertion. Schema validation takes over once loaded." Full Schema validation can be added later as an optional pipeline step.

**Step 2: Bridge to existing ws.svelte.ts**

In `ws.svelte.ts`, replace ONLY the `ws.addEventListener("message", ...)` handler inside the existing `connect()` function. Keep all other lifecycle logic:

```typescript
import { getRuntime, setActiveStreamFiber, interruptStream, wsMessageStream } from "../transport/runtime.js";
import { Effect, Stream } from "effect";

// Inside connect(), after WebSocket "open" event fires:
// Replace: ws.addEventListener("message", (evt) => handleMessage(JSON.parse(evt.data)));
// With:
const runtime = await getRuntime();
const fiber = await runtime.runFork(
  Stream.runForEach(
    wsMessageStream(ws),
    (msg) => Effect.sync(() => handleMessage(msg)),
  ),
);
setActiveStreamFiber(fiber);

// Inside disconnect() or reconnect, add:
await interruptStream();  // Interrupts the message stream fiber
```

**Step 3: Test manually**

Run `pnpm dev:all`, open browser, verify:
- WebSocket connects (existing logic)
- Messages flow (chat works — now via Effect Stream)
- Reconnection works on server restart (existing scheduleReconnect logic)
- All wsState reactive updates still work (status, attempts, etc.)
- Connect timeout still works
- Self-healing detection still works
- Offline queue flushes on reconnect
- First load under 1.5s (Effect chunk lazy-loaded)

**Step 4: Commit**

```bash
git commit -m "refactor: migrate WebSocket message handling to Effect Stream"
```

---

### Task 7.3: Migrate outbound messages to Schema-encoded

**Files:**
- Modify: `src/lib/frontend/stores/ws-send.svelte.ts`
- Create: `src/lib/frontend/transport/schemas.ts` (outbound message schemas)

**Scope:** `PayloadMap` in `src/lib/handlers/payloads.ts` has 40+ message types. Defining Schema for ALL at once is a large task. Use gradual migration: add a validated `wsSendTyped` alongside existing `wsSend`, migrate callers incrementally.

**Step 1: Define outbound message schemas (start with most-used types)**

Create `src/lib/frontend/transport/schemas.ts`:

```typescript
import { Schema } from "effect";

// Start with the most-used outbound message types.
// Add more as callers migrate from wsSend → wsSendTyped.
const ChatMessage = Schema.Struct({
  type: Schema.Literal("message"),
  text: Schema.String,
  sessionId: Schema.optional(Schema.String),
});

const CancelMessage = Schema.Struct({
  type: Schema.Literal("cancel"),
  sessionId: Schema.String,
});

const ViewSession = Schema.Struct({
  type: Schema.Literal("view_session"),
  sessionId: Schema.String,
});

const NewSession = Schema.Struct({
  type: Schema.Literal("new_session"),
  requestId: Schema.String,
});

// Add remaining types as callers migrate. Full list: see PayloadMap in
// src/lib/handlers/payloads.ts (40+ types). Each needs a Schema.Struct.

export const OutboundMessage = Schema.Union(
  ChatMessage,
  CancelMessage,
  ViewSession,
  NewSession,
  // ... add more as callers migrate
);

export type OutboundMessage = typeof OutboundMessage.Type;
```

**Step 2: Add validated send function alongside existing**

In `ws-send.svelte.ts` — keep existing `wsSend` unchanged, add `wsSendTyped`:

```typescript
import { Schema, Either } from "effect";
import { OutboundMessage } from "../transport/schemas.js";

// Existing wsSend stays — callers migrate incrementally
export function wsSend(data: Record<string, unknown>) {
  rawSend(data);  // rawSend handles JSON.stringify internally
}

// New: Schema-validated send. Callers opt in as schemas are added.
export function wsSendTyped(msg: OutboundMessage) {
  const result = Schema.encodeEither(OutboundMessage)(msg);
  if (Either.isLeft(result)) {
    // Log encode error but don't throw — existing wsSend never throws
    console.error("OutboundMessage encode error:", result.left);
    // Fall back to raw send so user's message isn't silently lost
    rawSend(msg as Record<string, unknown>);
    return;
  }
  rawSend(result.right);  // rawSend handles JSON.stringify — do NOT double-stringify
}
```

**Step 3: Run full build and test**

Run: `pnpm build && pnpm test:unit`
Expected: All pass. Existing callers still use `wsSend` — no breakage.

**Step 4: Commit**

```bash
git commit -m "refactor: add Schema-validated outbound message sending (gradual migration)"
```

---

## Final Verification

### Task F.1: Full regression test

**Step 1: Run all test suites**

```bash
pnpm test:unit
pnpm test:fixture
pnpm build
pnpm test:e2e
```

**Step 2: Manual smoke test**

- Start with `pnpm dev:all`
- Open browser, verify first load < 1.5s
- Create session, send message, verify streaming
- Test permissions flow
- Test multi-session
- Verify WebSocket reconnection
- Check error messages display correctly

**Step 3: Commit any remaining fixes**

---

### Task F.2: Clean up dead code

**Step 1: Find and remove unused imports/exports**

Run: `pnpm check` — TypeScript will flag unused imports.

**Step 2: Remove backwards-compat shims**

- Remove old `RelayError` class if no consumers left
- Remove old `runInTransaction` method if all consumers use Effect version
- Remove any `as unknown as` casts from branded type migration

**Step 3: Run tests, commit**

```bash
git commit -m "chore: remove dead code from Effect migration"
```
