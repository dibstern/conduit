# Bandaid Fix Remediation — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate all bandaid fixes (silent error swallowing, type casts, magic numbers, race-condition workarounds, dead code) identified in the deep audit, replacing each with a proper solution.

**Architecture:** Infrastructure-first approach — build shared utilities (type declarations, constants, test factories) first, then fix individual instances. Defers to the strict-type-checking plan (`2026-03-06-strict-type-checking-design.md`) for compiler flags, handler payload typing, and lint rules.

**Tech Stack:** TypeScript, Vitest, Svelte 5, Node.js

**Relationship to strict-type-checking plan:** This plan does NOT touch:
- Compiler flags (`noImplicitReturns`, `exactOptionalPropertyTypes`, etc.)
- `PayloadMap` typed handler payloads
- `RelayMessage` unknown field typing
- `noNonNullAssertion` lint rule
- Valibot runtime validation

---

## Task 1: Navigator Type Declaration

Eliminate the duplicated `navigator as unknown as { standalone?: boolean }` cast in two files by augmenting the global `Navigator` interface.

**Files:**
- Create: `src/lib/public/safari-navigator.d.ts`
- Modify: `src/lib/public/pages/DashboardPage.svelte:44-46`
- Modify: `src/lib/public/utils/setup-utils.ts:47-49`

**Step 1: Verify the problem compiles today**

Run: `pnpm check:frontend`
Expected: PASS (the double-casts currently suppress the error)

**Step 2: Create the type declaration**

Create `src/lib/public/safari-navigator.d.ts`:

```ts
/**
 * Augment Navigator with the non-standard iOS Safari `standalone` property.
 * @see https://developer.apple.com/documentation/webkitjs/navigator/1382801-standalone
 */
interface Navigator {
	readonly standalone?: boolean;
}
```

This file is already included by the frontend tsconfig's `"./**/*.d.ts"` glob.

**Step 3: Remove the cast in DashboardPage.svelte**

In `src/lib/public/pages/DashboardPage.svelte`, change line 44-46:

```svelte
<!-- Before -->
const isStandalone =
	window.matchMedia("(display-mode:standalone)").matches ||
	(navigator as unknown as { standalone?: boolean }).standalone;

<!-- After -->
const isStandalone =
	window.matchMedia("(display-mode:standalone)").matches ||
	navigator.standalone;
```

**Step 4: Remove the cast in setup-utils.ts**

In `src/lib/public/utils/setup-utils.ts`, change line 47-49:

```ts
// Before
const isStandalone =
	window.matchMedia("(display-mode:standalone)").matches ||
	!!(navigator as unknown as { standalone?: boolean }).standalone;

// After
const isStandalone =
	window.matchMedia("(display-mode:standalone)").matches ||
	!!navigator.standalone;
```

**Step 5: Verify typecheck passes**

Run: `pnpm check:frontend`
Expected: PASS

**Step 6: Run tests**

Run: `pnpm test`
Expected: PASS (no behavioral change)

**Step 7: Review and refactor**

Check: Is the `.d.ts` file placed correctly? Does the tsconfig include glob pick it up? Any other files that access `navigator.standalone`? If so, they can now use it directly.

**Step 8: Commit**

```
feat: add Navigator.standalone type declaration, remove double-casts
```

---

## Task 2: Vite Client Types for import.meta.env

Eliminate the `(import.meta as { env?: { DEV?: boolean } }).env?.DEV` cast by adding Vite's client type reference.

**Files:**
- Create: `src/lib/public/vite-env.d.ts`
- Modify: `src/lib/public/stores/ws-dispatch.ts:334-335`

**Step 1: Create the Vite environment type declaration**

Create `src/lib/public/vite-env.d.ts`:

```ts
/// <reference types="vite/client" />
```

This gives the frontend access to `ImportMetaEnv` and `ImportMeta.env` types (including `DEV`, `PROD`, `MODE`, etc.).

**Step 2: Remove the cast in ws-dispatch.ts**

In `src/lib/public/stores/ws-dispatch.ts`, change lines 333-337:

```ts
// Before
		default:
			// Unknown message type — log for debugging
			// Cast needed: import.meta.env is Vite-specific, not in standard tsconfig
			if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
				console.debug("[ws] Unhandled message type:", msg.type, msg);
			}

// After
		default:
			// Unknown message type — log in dev mode only
			if (import.meta.env.DEV) {
				console.debug("[ws] Unhandled message type:", msg.type, msg);
			}
```

**Step 3: Verify typecheck passes**

Run: `pnpm check:frontend`
Expected: PASS

**Step 4: Run tests**

Run: `pnpm test`
Expected: PASS

**Step 5: Review and refactor**

Check for any other `import.meta` casts in frontend code. Grep for `import.meta as` in `src/lib/public/`. If found, fix those too.

**Step 6: Commit**

```
fix: add Vite client types, remove import.meta.env cast
```

---

## Task 3: Shared Constants Module

Extract hardcoded port `4096` and UI timeout magic numbers into named constants.

**Files:**
- Create: `src/lib/constants.ts`
- Create: `src/lib/public/ui-constants.ts`
- Modify: `src/lib/daemon.ts:240,304`
- Modify: `src/lib/opencode-client.ts:164`
- Modify: `src/lib/public/components/features/FileViewer.svelte:159`
- Modify: `src/lib/public/stores/ws-notifications.ts:86`
- Modify: `src/lib/public/stores/terminal.svelte.ts:283-284,306-308`
- Modify: `src/lib/public/components/overlays/ConnectOverlay.svelte:127-131,142`
- Modify: `src/lib/public/components/features/ProjectSwitcher.svelte:121-126`
- Modify: `src/lib/public/components/chat/ToolItem.svelte:32-34`
- Modify: `src/lib/public/pages/SetupPage.svelte:174,257`

### Step 1: Write a test for the constants module

Create a quick sanity test in `test/unit/constants.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_OPENCODE_PORT, DEFAULT_OPENCODE_URL } from "../../src/lib/constants.js";

describe("constants", () => {
	it("DEFAULT_OPENCODE_PORT is 4096", () => {
		expect(DEFAULT_OPENCODE_PORT).toBe(4096);
	});

	it("DEFAULT_OPENCODE_URL uses the default port", () => {
		expect(DEFAULT_OPENCODE_URL).toBe("http://localhost:4096");
	});
});
```

### Step 2: Run test to verify it fails

Run: `pnpm vitest run test/unit/constants.test.ts`
Expected: FAIL — module not found

### Step 3: Create the server-side constants module

Create `src/lib/constants.ts`:

```ts
// ─── Server-Side Constants ──────────────────────────────────────────────────

/** Default port for the OpenCode server. */
export const DEFAULT_OPENCODE_PORT = 4096;

/** Default base URL for the OpenCode server. */
export const DEFAULT_OPENCODE_URL = `http://localhost:${DEFAULT_OPENCODE_PORT}`;

/** Delay before daemon shuts down after scheduleShutdown() (ms). */
export const DAEMON_SHUTDOWN_DELAY_MS = 100;
```

### Step 4: Run test to verify it passes

Run: `pnpm vitest run test/unit/constants.test.ts`
Expected: PASS

### Step 5: Refactor — check if constant names are clear and well-placed

Review: Are there any other server-side magic numbers worth extracting right now? If so, add them. Otherwise, move on.

### Step 6: Create the frontend UI constants module

Create `src/lib/public/ui-constants.ts`:

```ts
// ─── Frontend UI Timing Constants ───────────────────────────────────────────

/** How long to show copy-success feedback icon (ms). */
export const COPY_FEEDBACK_MS = 1500;

/** How long browser notifications stay visible before auto-dismiss (ms). */
export const NOTIFICATION_DISMISS_MS = 5000;

/** How long status messages display before clearing (ms). */
export const STATUS_MESSAGE_MS = 3000;

/** Fade duration for verb cycling in connect overlay (ms). */
export const VERB_FADE_MS = 300;

/** Interval between verb cycles in connect overlay (ms). */
export const VERB_CYCLE_MS = 2000;

/** Fade-out animation duration when connection is established (ms). */
export const CONNECT_FADEOUT_MS = 600;

/** Safety timeout waiting for server response to add-project (ms). */
export const ADD_PROJECT_TIMEOUT_MS = 15_000;

/** Timeout waiting for full tool content to load (ms). */
export const TOOL_CONTENT_LOAD_TIMEOUT_MS = 10_000;

/** Timeout for HTTPS verification probe during setup (ms). */
export const HTTPS_VERIFY_TIMEOUT_MS = 3000;

/** Delay before auto-advancing to next setup step (ms). */
export const SETUP_STEP_TRANSITION_MS = 1200;
```

### Step 7: Update server-side files to use constants

In `src/lib/daemon.ts`, line 240:
```ts
// Before
const port = urlPort ? parseInt(urlPort, 10) : 4096;
// After
const port = urlPort ? parseInt(urlPort, 10) : DEFAULT_OPENCODE_PORT;
```
Add import: `import { DEFAULT_OPENCODE_PORT, DEFAULT_OPENCODE_URL, DAEMON_SHUTDOWN_DELAY_MS } from "./constants.js";`

In `src/lib/daemon.ts`, line 304:
```ts
// Before
const probeUrl = "http://localhost:4096";
// After
const probeUrl = DEFAULT_OPENCODE_URL;
```

In `src/lib/daemon.ts`, line 958:
```ts
// Before
setTimeout(() => this.stop(), 100);
// After
setTimeout(() => this.stop(), DAEMON_SHUTDOWN_DELAY_MS);
```

In `src/lib/opencode-client.ts`, line 164:
```ts
// Before
this.baseUrl = (options.baseUrl ?? "http://localhost:4096").replace(
// After
this.baseUrl = (options.baseUrl ?? DEFAULT_OPENCODE_URL).replace(
```
Add import: `import { DEFAULT_OPENCODE_URL } from "./constants.js";`

### Step 8: Update frontend files to use UI constants

Replace each magic number with the corresponding constant. Add the import `from "../../ui-constants.js"` (adjust relative path per file) at the top of each modified file.

- `FileViewer.svelte:159` — `1500` → `COPY_FEEDBACK_MS`
- `ws-notifications.ts:86` — `5000` → `NOTIFICATION_DISMISS_MS`
- `terminal.svelte.ts:284,307` — `3000` → `STATUS_MESSAGE_MS` (both instances)
- `ConnectOverlay.svelte:130` — `300` → `VERB_FADE_MS`
- `ConnectOverlay.svelte:131` — `2000` → `VERB_CYCLE_MS`
- `ConnectOverlay.svelte:142` — `600` → `CONNECT_FADEOUT_MS`
- `ProjectSwitcher.svelte:126` — `15_000` → `ADD_PROJECT_TIMEOUT_MS`
- `ToolItem.svelte:34` — `10_000` → `TOOL_CONTENT_LOAD_TIMEOUT_MS`
- `SetupPage.svelte:174` — `3000` → `HTTPS_VERIFY_TIMEOUT_MS`
- `SetupPage.svelte:257` — `1200` → `SETUP_STEP_TRANSITION_MS`

Also check `ToolGroupItem.svelte` for the same 10_000 pattern.

### Step 9: Verify typecheck and tests pass

Run: `pnpm check && pnpm test`
Expected: PASS

### Step 10: Review and refactor

Check: Are all imports correct? Are any constants unused? Are the names clear to someone reading the code for the first time? Rename if needed. Run tests again after any renames.

### Step 11: Commit

```
refactor: extract magic numbers into named constants modules
```

---

## Task 4: Production Type Cast Fixes

Fix the 6 remaining `as unknown as` casts in production code (those not handled by the strict-type-checking plan).

**Files:**
- Modify: `src/lib/pty-manager.ts:9-14`
- Modify: `src/lib/relay-stack.ts:231`
- Modify: `src/lib/daemon-ipc.ts:109-111`
- Modify: `src/lib/daemon.ts:970`
- Modify: `src/lib/public/utils/xterm-adapter.ts:11-33,121`
- Modify: `src/lib/public/components/features/TerminalTab.svelte:166`
- Modify: `src/lib/public/utils/notifications.ts:60-62,85-93`
- Modify: `src/lib/opencode-client.ts:132-143`

### 4a: PtyUpstream interface (relay-stack.ts cast)

**Step 1: Run existing pty-manager tests**

Run: `pnpm vitest run test/unit/pty-manager`
Expected: PASS (baseline)

**Step 2: Widen the PtyUpstream interface**

In `src/lib/pty-manager.ts`, change lines 9-14:

```ts
// Before
export interface PtyUpstream {
	readyState: number;
	send(data: string): void;
	close(code?: number, reason?: string): void;
	terminate(): void;
}

// After
export interface PtyUpstream {
	readyState: number;
	send(data: string | Buffer | ArrayBuffer, cb?: (err?: Error) => void): void;
	close(code?: number, reason?: string | Buffer): void;
	terminate(): void;
}
```

**Step 3: Remove the cast in relay-stack.ts**

In `src/lib/relay-stack.ts`, line 231:

```ts
// Before
ptyManager.registerSession(ptyId, upstream as unknown as PtyUpstream);

// After
ptyManager.registerSession(ptyId, upstream);
```

**Step 4: Verify typecheck and tests**

Run: `pnpm check && pnpm vitest run test/unit/pty-manager`
Expected: PASS

**Step 5: Refactor**

Review: Is `PtyUpstream` used anywhere else? Does the wider `send` signature affect any callers? (`ptyManager.sendInput` calls `upstream.send(data)` with a string, which still matches.)

### 4b: buildIPCHandlers signature (daemon.ts cast)

**Step 1: Change the parameter type in daemon-ipc.ts**

In `src/lib/daemon-ipc.ts`, change line 111:

```ts
// Before
getStatus: () => IPCResponse,

// After
getStatus: () => DaemonStatus,
```

Add import at top of file: `import type { DaemonStatus } from "./daemon.js";`

Note: Line 152 already does `return { ...getStatus() }` which spreads `DaemonStatus` into a fresh object that IS assignable to `IPCResponse`.

**Step 2: Remove the cast in daemon.ts**

In `src/lib/daemon.ts`, line 970:

```ts
// Before
() => this.getStatus() as unknown as IPCResponse,

// After
() => this.getStatus(),
```

Remove the `IPCResponse` import if no longer used in daemon.ts (check first).

**Step 3: Verify typecheck and tests**

Run: `pnpm check && pnpm vitest run test/unit/daemon`
Expected: PASS

### 4c: ANSI_THEME type (TerminalTab.svelte cast)

**Step 1: Remove `as const` from ANSI_THEME and type it explicitly**

In `src/lib/public/utils/xterm-adapter.ts`, change the declaration:

```ts
// Before
export const ANSI_THEME = {
	background: "#111111",
	// ... all properties ...
	brightWhite: "#EEEEEE",
} as const;

// After
export const ANSI_THEME: Record<string, string> = {
	background: "#111111",
	// ... all properties ...
	brightWhite: "#EEEEEE",
};
```

**Step 2: Remove the cast in TerminalTab.svelte**

In `src/lib/public/components/features/TerminalTab.svelte`, line 166:

```ts
// Before
adapter.setTheme(ANSI_THEME as unknown as Record<string, string>);

// After
adapter.setTheme(ANSI_THEME);
```

**Step 3: Verify typecheck**

Run: `pnpm check:frontend`
Expected: PASS

### 4d: Uint8Array return type (notifications.ts cast)

**Step 1: Narrow the return type of urlBase64ToUint8Array**

In `src/lib/public/utils/notifications.ts`, change line 85:

```ts
// Before
export function urlBase64ToUint8Array(base64String: string): Uint8Array {

// After
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
```

**Step 2: Remove the cast at the call site**

In `src/lib/public/utils/notifications.ts`, change lines 60-62:

```ts
// Before
const applicationServerKey = urlBase64ToUint8Array(
	publicKey,
) as unknown as BufferSource;

// After
const applicationServerKey = urlBase64ToUint8Array(publicKey);
```

**Step 3: Verify typecheck**

Run: `pnpm check:frontend`
Expected: PASS. If TS version doesn't support `Uint8Array<ArrayBuffer>`, use `applicationServerKey: publicKey` directly (the Push API accepts a string).

### 4e: normalizeMessage type guard (opencode-client.ts casts)

**Step 1: Write a test for the type guard**

Add to `test/unit/opencode-client.test.ts` (or create if needed):

```ts
import { describe, expect, it } from "vitest";

describe("normalizeMessage", () => {
	// normalizeMessage is not exported, so test via the client methods
	// that call it (getMessages, getSession). If needed, export it for
	// direct testing.
});
```

Since `normalizeMessage` is a private function, test it indirectly through existing client tests. Alternatively, extract and export a `isValidMessage` type guard.

**Step 2: Add a type guard function**

In `src/lib/opencode-client.ts`, above the `normalizeMessage` function (around line 128):

```ts
/** Runtime check that an object has the minimum shape of a Message. */
function hasMessageShape(obj: Record<string, unknown>): obj is Message {
	return (
		typeof obj["id"] === "string" &&
		typeof obj["role"] === "string" &&
		typeof obj["sessionID"] === "string"
	);
}
```

**Step 3: Refactor normalizeMessage to use the type guard**

```ts
// Before
function normalizeMessage(raw: unknown): Message {
	const obj = raw as Record<string, unknown>;
	if (obj["info"] && typeof obj["info"] === "object") {
		const info = obj["info"] as Record<string, unknown>;
		return {
			...info,
			parts: obj["parts"] ?? info["parts"],
		} as unknown as Message;
	}
	return obj as unknown as Message;
}

// After
function normalizeMessage(raw: unknown): Message | null {
	if (!raw || typeof raw !== "object") return null;
	const obj = raw as Record<string, unknown>;

	let candidate: Record<string, unknown>;
	if (obj["info"] && typeof obj["info"] === "object") {
		const info = obj["info"] as Record<string, unknown>;
		candidate = { ...info, parts: obj["parts"] ?? info["parts"] };
	} else {
		candidate = obj;
	}

	return hasMessageShape(candidate) ? candidate : null;
}
```

**Step 4: Update callers to handle null**

Search for all calls to `normalizeMessage` — they likely do `.map(normalizeMessage)`. Change to `.map(normalizeMessage).filter((m): m is Message => m !== null)`.

**Step 5: Verify typecheck and tests**

Run: `pnpm check && pnpm test`
Expected: PASS

**Step 6: Review and refactor**

Does returning `null` silently drop malformed messages? Consider logging a warning when `hasMessageShape` returns false, so API changes are visible:

```ts
if (!hasMessageShape(candidate)) {
	console.warn("[opencode-client] Dropping malformed message:", candidate["id"] ?? "unknown");
	return null;
}
return candidate;
```

### Step 7: Commit all Task 4 changes

```
fix: replace production as-unknown-as casts with proper types
```

---

## Task 5: Dead Code and Null/Undefined Fixes

Remove dead `?? undefined` expressions and fix null-to-undefined conversion mismatches.

**Files:**
- Modify: `src/lib/public/stores/chat.svelte.ts:260`
- Modify: `src/lib/session-manager.ts:122`
- Modify: `src/lib/client-init.ts:180`
- Modify: `src/lib/session-status-poller.ts:216,221,223`
- Modify: `src/lib/question-bridge.ts` (getPending signature)

### 5a: Remove dead ?? undefined (2 instances)

**Step 1: Remove dead code in chat.svelte.ts**

In `src/lib/public/stores/chat.svelte.ts`, line 260:

```ts
// Before
result: content ?? undefined,

// After
result: content,
```

**Step 2: Remove dead code in session-manager.ts**

In `src/lib/session-manager.ts`, line 122:

```ts
// Before
const resolvedStatuses = statuses ?? this.getStatuses?.() ?? undefined;

// After
const resolvedStatuses = statuses ?? this.getStatuses?.();
```

### 5b: Fix null-to-undefined in client-init.ts

**Step 1: Widen QuestionBridge.getPending to accept null**

In `src/lib/question-bridge.ts`, find the `getPending` method signature and add `| null`:

```ts
// Before
getPending(sessionId?: string): PendingQuestion[] {

// After
getPending(sessionId?: string | null): PendingQuestion[] {
```

**Step 2: Remove the coercion in client-init.ts**

In `src/lib/client-init.ts`, line 180:

```ts
// Before
for (const q of questionBridge.getPending(activeSessionId ?? undefined)) {

// After
for (const q of questionBridge.getPending(activeSessionId)) {
```

### 5c: Fix double-conversion in session-status-poller.ts

**Step 1: Change cache to use undefined instead of null**

In `src/lib/session-status-poller.ts`, change the cache type and usage:

Line ~30 (find the cache declaration):
```ts
// Before
private childToParentCache = new Map<string, string | null>();

// After
private childToParentCache = new Map<string, string | undefined>();
```

Line 216:
```ts
// Before
parentId = this.childToParentCache.get(busyId) ?? undefined;

// After
parentId = this.childToParentCache.get(busyId);
```

Lines 221-223:
```ts
// Before
const pid = session.parentID ?? null;
this.childToParentCache.set(busyId, pid);
parentId = pid ?? undefined;

// After
const pid = session.parentID;
this.childToParentCache.set(busyId, pid);
parentId = pid;
```

**Step 2: Verify typecheck and tests**

Run: `pnpm check && pnpm vitest run test/unit/session-status-poller`
Expected: PASS

**Step 3: Review and refactor**

Check: Are there other uses of `childToParentCache` that depend on `null` semantics? Grep for `childToParentCache`. If the `.has()` check on line 215 still distinguishes cache-hit from cache-miss (it does — `Map.has` returns true for keys with `undefined` values), the semantics are preserved.

**Step 4: Commit**

```
fix: remove dead ?? undefined, fix null/undefined mismatches
```

---

## Task 6: Error Handling — Replace Silent Catches

Replace `.catch(() => {})` and `catch { /* ignore */ }` with appropriate logging.

**Files:**
- Modify: `src/lib/sse-wiring.ts:147,163,245,255`
- Modify: `src/lib/public/sw.ts:145`
- Modify: `src/lib/public/components/overlays/NotifSettings.svelte:99`
- Modify: `src/lib/opencode-client.ts:562`
- Modify: `src/lib/daemon.ts:500-502,516-518,668-670`

### 6a: Fix critical — service worker notification display (sw.ts)

**Step 1: Replace silent catch with logging + fallback**

In `src/lib/public/sw.ts`, change line 145:

```ts
// Before
		.catch(() => {}),

// After
		.catch((err) => {
			console.warn("[sw] Failed to show notification:", err);
		}),
```

### 6b: Fix push notification silencing (sse-wiring.ts — 4 instances)

**Step 1: Replace all four `.catch(() => {})` with logging**

The `log` function is available via `deps` in the enclosing `wireSSE` function's `handleSSEEvent` closure. However, `handleSSEEvent` captures `log` directly.

In `src/lib/sse-wiring.ts`:

Line 147:
```ts
// Before
.catch(() => {});
// After
.catch((err: unknown) => log(`   [sse] Push send failed (permission): ${err}`));
```

Line 163:
```ts
// Before
.catch(() => {});
// After
.catch((err: unknown) => log(`   [sse] Push send failed (question): ${err}`));
```

Line 245:
```ts
// Before
.catch(() => {});
// After
.catch((err: unknown) => log(`   [sse] Push send failed (done): ${err}`));
```

Line 255:
```ts
// Before
.catch(() => {});
// After
.catch((err: unknown) => log(`   [sse] Push send failed (error): ${err}`));
```

### 6c: Fix unsubscribe silencing (NotifSettings.svelte)

In `src/lib/public/components/overlays/NotifSettings.svelte`, line 99:

```ts
// Before
}).catch(() => {});

// After
}).catch((err) => console.warn("[push] Unsubscribe API call failed:", err));
```

### 6d: Fix error body read silencing (opencode-client.ts)

In `src/lib/opencode-client.ts`, line 562:

```ts
// Before
responseBody = await res.text().catch(() => undefined);

// After
responseBody = await res.text().catch(() => "[body unreadable]");
```

### 6e: Add logging to shutdown catches (daemon.ts)

In `src/lib/daemon.ts`:

Lines 500-502:
```ts
// Before
} catch {
	// ignore
}

// After
} catch (err) {
	console.warn(`[daemon] Error stopping relay during shutdown: ${err}`);
}
```

Lines 516-518:
```ts
// Before
} catch {
	// ignore
}

// After
} catch (err) {
	console.warn(`[daemon] Error destroying IPC client during shutdown: ${err}`);
}
```

Lines 668-670 (project removal — runtime, not shutdown):
```ts
// Before
} catch {
	// ignore
}

// After
} catch (err) {
	console.warn(`[daemon] Failed to stop relay for removed project "${slug}": ${err}`);
}
```

### Step 2: Verify tests pass

Run: `pnpm test`
Expected: PASS (logging changes are non-behavioral)

### Step 3: Review and refactor

Check: Are any of the new log messages too noisy for normal operation? Shutdown catches should use `console.warn` (not error) since they're expected during teardown. The `sse-wiring.ts` ones use the relay's `log()` function which respects the daemon's logging configuration.

### Step 4: Commit

```
fix: replace silent error catches with diagnostic logging
```

---

## Task 7: Console.debug Cleanup

Remove or properly gate diagnostic `console.debug` statements left in production code.

**Files:**
- Modify: `src/lib/public/stores/ws-dispatch.ts:155-156,239-242`
- Modify: `src/lib/public/stores/permissions.svelte.ts:139-144,163-168`

The `console.debug` in `src/lib/opencode-client.ts:300` is already gated behind `ENV.debug` — leave it.

### Step 1: Gate debug logging behind dev mode

In `src/lib/public/stores/ws-dispatch.ts`, lines 155-157:

```ts
// Before
		case "session_switched": {
			console.debug(
				`[ws] session_switched id=${msg.id} events=${Array.isArray(msg.events) ? msg.events.length : "none"} history=${msg.history ? "yes" : "no"}`,
			);

// After
		case "session_switched": {
```

Remove the `console.debug` entirely — this is a high-frequency event that provides no value in production. Dev-mode logging is handled by the unhandled-message default case.

Lines 239-242:

```ts
// Before
		case "ask_user":
			console.debug("[ws] Received ask_user message:", {
				toolId: msg.toolId,
				questionCount: msg.questions?.length ?? "N/A",
			});
			handleAskUser(msg);

// After
		case "ask_user":
			handleAskUser(msg);
```

In `src/lib/public/stores/permissions.svelte.ts`, lines 139-144:

```ts
// Before
	console.debug("[permissions] handleAskUser: storing question", {
		toolId,
		toolUseId,
		questionCount: questions.length,
		options: questions.map((q) => q.options?.length ?? 0),
	});

// After (remove entirely)
```

Lines 163-168:

```ts
// Before
	console.debug("[permissions] handleAskUserResolved:", {
		toolId,
		wasStored: permissionsState.pendingQuestions.some(
			(q) => q.toolId === toolId,
		),
	});

// After (remove entirely)
```

### Step 2: Run tests

Run: `pnpm test`
Expected: PASS

### Step 3: Review and refactor

Grep for remaining `console.debug` in `src/lib/public/`. Any that aren't gated behind a dev-mode check should be removed or gated.

### Step 4: Commit

```
fix: remove ungated console.debug statements from production code
```

---

## Task 8: Theme JSON Build Fix

Replace the fragile `cp -r` shell command in the build script with TypeScript's `resolveJsonModule`.

**Files:**
- Modify: `package.json:15-16` (build scripts)
- Modify: `tsconfig.json` (add resolveJsonModule)
- Modify: `src/lib/theme-loader.ts` (import JSON directly)

### Step 1: Check current theme-loader implementation

Read `src/lib/theme-loader.ts` to understand how themes are loaded. If they're loaded via `readFileSync` at runtime (reading from filesystem), then `resolveJsonModule` won't help — the `cp` is needed because tsc doesn't copy non-TS files.

If themes are loaded dynamically via filesystem reads, the better fix is to use a build copy plugin (like `cpy-cli`) or add a postbuild script, rather than inline `cp -r` in the build command.

**Step 2: Evaluate alternatives**

Option A: Keep `cp -r` but extract to a named script:
```json
"copy:themes": "cp -r src/lib/themes dist/src/lib/themes",
"build": "tsc && pnpm copy:themes && vite build",
```

Option B: Use a `tsc` plugin or `tsconfig` `outDir` include.

Option C: If themes are read at runtime via `readFileSync`, this is actually the correct approach — `tsc` intentionally doesn't copy non-TS assets. Extract the `cp` to a named script for clarity.

**Step 3: Extract to named script (Option A — pragmatic)**

In `package.json`, lines 15-16:

```json
// Before
"build": "tsc && cp -r src/lib/themes dist/src/lib/themes && vite build",
"build:server": "tsc && cp -r src/lib/themes dist/src/lib/themes",

// After
"copy:assets": "cp -r src/lib/themes dist/src/lib/themes",
"build": "tsc && pnpm copy:assets && vite build",
"build:server": "tsc && pnpm copy:assets",
```

### Step 4: Verify build works

Run: `pnpm build`
Expected: Build succeeds, `dist/src/lib/themes/` contains all JSON files.

### Step 5: Commit

```
refactor: extract theme copy to named build script
```

---

## Task 9: Test Mock Factories

Create a shared test factory module to eliminate 172+ `as unknown as` double-casts across 22 test files.

**Files:**
- Create: `test/helpers/mock-factories.ts`
- Modify: ~22 test files (migrate incrementally)

### Step 1: Write a test for the factories themselves

Create `test/unit/mock-factories.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
	createMockHandlerDeps,
	createMockSSEWiringDeps,
	createMockClientInitDeps,
} from "../helpers/mock-factories.js";

describe("mock-factories", () => {
	it("createMockHandlerDeps returns a fully-typed object", () => {
		const deps = createMockHandlerDeps();
		expect(deps.wsHandler.broadcast).toBeDefined();
		expect(deps.client).toBeDefined();
		expect(deps.sessionMgr).toBeDefined();
		expect(deps.log).toBeDefined();
	});

	it("createMockHandlerDeps accepts overrides", () => {
		const customLog = vi.fn();
		const deps = createMockHandlerDeps({ log: customLog });
		expect(deps.log).toBe(customLog);
	});

	it("createMockSSEWiringDeps returns a fully-typed object", () => {
		const deps = createMockSSEWiringDeps();
		expect(deps.translator.translate).toBeDefined();
		expect(deps.wsHandler.broadcast).toBeDefined();
	});

	it("createMockClientInitDeps returns a fully-typed object", () => {
		const deps = createMockClientInitDeps();
		expect(deps.client).toBeDefined();
		expect(deps.permissionBridge.getPending).toBeDefined();
	});
});
```

### Step 2: Run test to verify it fails

Run: `pnpm vitest run test/unit/mock-factories.test.ts`
Expected: FAIL — module not found

### Step 3: Create the mock factories module

Create `test/helpers/mock-factories.ts`:

```ts
/**
 * Shared typed mock factories for test dependency objects.
 *
 * Eliminates `as unknown as` double-casts by providing fully-typed mocks
 * with sensible defaults for every field. Each factory accepts a
 * Partial<T> override to customize per-test.
 */
import { vi } from "vitest";
import type { HandlerDeps } from "../../src/lib/handlers/types.js";
import type { SSEWiringDeps } from "../../src/lib/sse-wiring.js";
import type { ClientInitDeps } from "../../src/lib/client-init.js";
import { ToolContentStore } from "../../src/lib/tool-content-store.js";

// ─── Sub-component factories ────────────────────────────────────────────────

export function createMockWsHandler(
	overrides?: Partial<HandlerDeps["wsHandler"]>,
): HandlerDeps["wsHandler"] {
	return {
		broadcast: vi.fn(),
		sendTo: vi.fn(),
		setClientSession: vi.fn(),
		getClientSession: vi.fn(),
		getClientsForSession: vi.fn().mockReturnValue([]),
		sendToSession: vi.fn(),
		...overrides,
	};
}

// ─── Top-level factories ────────────────────────────────────────────────────

export function createMockHandlerDeps(
	overrides?: Partial<HandlerDeps>,
): HandlerDeps {
	return {
		wsHandler: createMockWsHandler(),
		client: {
			sendMessageAsync: vi.fn().mockResolvedValue(undefined),
			abortSession: vi.fn().mockResolvedValue(undefined),
			replyPermission: vi.fn().mockResolvedValue(undefined),
			replyQuestion: vi.fn().mockResolvedValue(undefined),
			rejectQuestion: vi.fn().mockResolvedValue(undefined),
			getSession: vi.fn().mockResolvedValue({ id: "s1", modelID: "gpt-4" }),
			getMessages: vi.fn().mockResolvedValue([]),
			listSessions: vi.fn().mockResolvedValue([]),
			createSession: vi.fn().mockResolvedValue({ id: "session-new" }),
			deleteSession: vi.fn().mockResolvedValue(undefined),
			listAgents: vi.fn().mockResolvedValue([]),
			listProviders: vi.fn().mockResolvedValue({
				providers: [],
				defaults: {},
				connected: [],
			}),
			listCommands: vi.fn().mockResolvedValue([]),
			listProjects: vi.fn().mockResolvedValue([]),
			listDirectory: vi.fn().mockResolvedValue([]),
			getFileContent: vi.fn().mockResolvedValue({
				content: "",
				binary: false,
			}),
			createPty: vi.fn().mockResolvedValue({
				id: "pty-1",
				title: "Terminal",
				pid: 42,
			}),
			deletePty: vi.fn().mockResolvedValue(undefined),
			resizePty: vi.fn().mockResolvedValue(undefined),
			listPtys: vi.fn().mockResolvedValue([]),
			revertSession: vi.fn().mockResolvedValue(undefined),
			forkSession: vi.fn().mockResolvedValue({ id: "ses_forked" }),
			listPendingQuestions: vi.fn().mockResolvedValue([]),
			getAuthHeaders: vi.fn().mockReturnValue({}),
			getHealth: vi.fn().mockResolvedValue({ ok: true }),
			switchModel: vi.fn().mockResolvedValue(undefined),
		} as HandlerDeps["client"],
		sessionMgr: {
			getActiveSessionId: vi.fn().mockReturnValue("session-1"),
			setActiveSessionId: vi.fn(),
			createSession: vi.fn().mockResolvedValue({ id: "session-new" }),
			listSessions: vi.fn().mockResolvedValue([]),
			switchSession: vi.fn(),
			recordMessageActivity: vi.fn(),
			getSessionCacheKey: vi.fn().mockReturnValue("session-1"),
		} as HandlerDeps["sessionMgr"],
		messageCache: {
			recordEvent: vi.fn(),
			getEvents: vi.fn().mockReturnValue(null),
			remove: vi.fn(),
		} as HandlerDeps["messageCache"],
		permissionBridge: {
			onPermissionResponse: vi.fn().mockReturnValue(null),
			getPending: vi.fn().mockReturnValue([]),
			onPermissionRequest: vi.fn(),
			onPermissionReplied: vi.fn(),
			findPendingForSession: vi.fn().mockReturnValue([]),
		} as HandlerDeps["permissionBridge"],
		questionBridge: {
			onAnswer: vi.fn().mockReturnValue(null),
			getPending: vi.fn().mockReturnValue([]),
			findPendingForSession: vi.fn().mockReturnValue([]),
			onAnswerById: vi.fn().mockReturnValue(null),
			remove: vi.fn(),
			onQuestion: vi.fn(),
		} as HandlerDeps["questionBridge"],
		overrides: {
			agent: undefined,
			model: undefined,
			modelUserSelected: false,
			defaultModel: undefined,
			setAgent: vi.fn(),
			clearAgent: vi.fn(),
			setModel: vi.fn(),
			clearModel: vi.fn(),
			setDefaultModel: vi.fn(),
			clear: vi.fn(),
			clearSession: vi.fn(),
			resetProcessingTimeout: vi.fn(),
			clearProcessingTimeout: vi.fn(),
		} as HandlerDeps["overrides"],
		ptyManager: {
			sendInput: vi.fn(),
			closeSession: vi.fn(),
			hasSession: vi.fn().mockReturnValue(false),
			listSessions: vi.fn().mockReturnValue([]),
			getScrollback: vi.fn().mockReturnValue(""),
			getSession: vi.fn().mockReturnValue(undefined),
			registerSession: vi.fn(),
			sessionCount: 0,
		} as HandlerDeps["ptyManager"],
		toolContentStore: new ToolContentStore(),
		config: {
			httpServer: {},
			opencodeUrl: "http://localhost:4096",
			projectDir: "/test/project",
			slug: "test-project",
		} as HandlerDeps["config"],
		log: vi.fn(),
		connectPtyUpstream: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

export function createMockSSEWiringDeps(
	overrides?: Partial<SSEWiringDeps>,
): SSEWiringDeps {
	return {
		translator: {
			translate: vi.fn().mockReturnValue(null),
			reset: vi.fn(),
			getSeenParts: vi.fn().mockReturnValue(new Map()),
			rebuildStateFromHistory: vi.fn(),
		} as SSEWiringDeps["translator"],
		sessionMgr: {
			getActiveSessionId: vi.fn().mockReturnValue("active-session"),
			recordMessageActivity: vi.fn(),
		} as SSEWiringDeps["sessionMgr"],
		messageCache: {
			recordEvent: vi.fn(),
			getEvents: vi.fn().mockReturnValue(null),
			remove: vi.fn(),
		} as SSEWiringDeps["messageCache"],
		permissionBridge: {
			onPermissionRequest: vi.fn(),
			onPermissionReplied: vi.fn(),
		} as SSEWiringDeps["permissionBridge"],
		questionBridge: {
			onQuestion: vi.fn(),
		} as SSEWiringDeps["questionBridge"],
		overrides: {
			clearProcessingTimeout: vi.fn(),
			resetProcessingTimeout: vi.fn(),
		} as SSEWiringDeps["overrides"],
		toolContentStore: new ToolContentStore(),
		wsHandler: {
			broadcast: vi.fn(),
			sendToSession: vi.fn(),
			getClientsForSession: vi.fn().mockReturnValue(["c1"]),
		},
		log: vi.fn(),
		...overrides,
	};
}

export function createMockClientInitDeps(
	overrides?: Partial<ClientInitDeps>,
): ClientInitDeps {
	return {
		wsHandler: {
			broadcast: vi.fn(),
			sendTo: vi.fn(),
			setClientSession: vi.fn(),
		},
		client: {
			listSessions: vi.fn().mockResolvedValue([]),
			getMessages: vi.fn().mockResolvedValue([]),
			listAgents: vi.fn().mockResolvedValue([]),
			listProviders: vi.fn().mockResolvedValue({
				providers: [],
				defaults: {},
				connected: [],
			}),
			listCommands: vi.fn().mockResolvedValue([]),
			getAuthHeaders: vi.fn().mockReturnValue({}),
			listPtys: vi.fn().mockResolvedValue([]),
			listPendingQuestions: vi.fn().mockResolvedValue([]),
		} as ClientInitDeps["client"],
		sessionMgr: {
			getActiveSessionId: vi.fn().mockReturnValue("session-1"),
			listSessions: vi.fn().mockResolvedValue([]),
		} as ClientInitDeps["sessionMgr"],
		messageCache: {
			getEvents: vi.fn().mockReturnValue(null),
		} as ClientInitDeps["messageCache"],
		overrides: {
			agent: undefined,
			model: undefined,
			defaultModel: undefined,
		} as ClientInitDeps["overrides"],
		ptyManager: {
			listSessions: vi.fn().mockReturnValue([]),
			getScrollback: vi.fn().mockReturnValue(""),
		} as ClientInitDeps["ptyManager"],
		permissionBridge: {
			getPending: vi.fn().mockReturnValue([]),
		},
		questionBridge: {
			getPending: vi.fn().mockReturnValue([]),
		},
		log: vi.fn(),
		...overrides,
	};
}
```

### Step 4: Run test to verify it passes

Run: `pnpm vitest run test/unit/mock-factories.test.ts`
Expected: PASS

### Step 5: Refactor — review factory completeness

Check: Do the factory return types actually satisfy the full interfaces without `as`? If the compiler complains about missing methods, add them with sensible defaults. The `as HandlerDeps["client"]` casts on sub-objects are acceptable here since we're in test code and the sub-objects are partial by nature — but ideally the factory provides every method. Each test will override the methods it cares about.

**Important:** If the factory compiles without any `as` casts on the top-level return, that's ideal. The sub-object casts (`as HandlerDeps["client"]`) are acceptable for now — the strict-type-checking plan's narrow interface refactor (Section 3: `PayloadMap`) will make these unnecessary long-term.

### Step 6: Migrate one test file as proof of concept

Pick `test/unit/message-handlers.test.ts` (it already has a local `createMockDeps`). Replace its local factory with the shared one:

```ts
// Before (at top of file)
function createMockDeps(overrides?: Partial<HandlerDeps>): HandlerDeps {
	// ... 100 lines of mock setup ...
}

// After
import { createMockHandlerDeps } from "../helpers/mock-factories.js";
// Remove the local createMockDeps function
// Replace all createMockDeps() calls with createMockHandlerDeps()
```

### Step 7: Run that file's tests

Run: `pnpm vitest run test/unit/message-handlers.test.ts`
Expected: PASS

### Step 8: Migrate remaining test files

Repeat for each test file that has `as unknown as HandlerDeps`, `as unknown as SSEWiringDeps`, or `as unknown as ClientInitDeps`. Key files:

- `test/unit/handlers-model.test.ts`
- `test/unit/handlers-session.test.ts`
- `test/unit/sse-wiring.test.ts`
- `test/unit/client-init.test.ts`
- `test/unit/handlers-instance.test.ts`
- `test/unit/question-answer-flow.test.ts`
- `test/unit/get-tool-content-handler.test.ts`
- `test/unit/instance-wiring.test.ts`
- (and others — grep for `as unknown as HandlerDeps`)

For each file:
1. Import the shared factory
2. Remove the local factory
3. Replace calls — use `createMockHandlerDeps({ fieldToOverride: customMock })`
4. Run that file's tests to verify

### Step 9: Verify all tests pass

Run: `pnpm test`
Expected: PASS

### Step 10: Final refactor

Review: Are there any test files that still have `as unknown as` for these three types? Grep for remaining instances. Any file-specific mock patterns that don't fit the factory? If so, use the overrides parameter or extend the factory.

### Step 11: Commit

```
refactor: create shared test mock factories, eliminate 170+ double-casts
```

---

## Task 10: Test setTimeout Cleanup

Replace arbitrary `setTimeout` delays in tests with deterministic patterns.

**Files:**
- Modify: ~15 test files with `setTimeout` workarounds

### Approach

There are three categories of `setTimeout` in tests:

1. **Socket/IPC lifecycle waits** (daemon.test.ts) — Replace with `vi.waitFor()` polling
2. **WebSocket message propagation** (ws-handler.pbt.test.ts) — Replace with message event listeners or `vi.waitFor()`
3. **Integration test delays** (instance-manager.test.ts) — Replace with `vi.waitFor()` predicates

### Step 1: Create a small helper for async polling

Add to `test/helpers/mock-factories.ts` (or a separate `test/helpers/async-utils.ts`):

```ts
/**
 * Wait for a predicate to become true, polling every `interval` ms.
 * Throws after `timeout` ms if the predicate never passes.
 *
 * Prefer vi.waitFor() when available — this is for cases where
 * vi.waitFor() doesn't work well (e.g., non-Vitest assertion predicates).
 */
export async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	{ timeout = 5000, interval = 50 } = {},
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		if (await predicate()) return;
		await new Promise((r) => setTimeout(r, interval));
	}
	throw new Error(`waitFor timed out after ${timeout}ms`);
}
```

### Step 2: Migrate daemon.test.ts setTimeout patterns

Replace patterns like:
```ts
await new Promise((r) => setTimeout(r, 50));
expect(d.getStatus().clientCount).toBe(1);
```

With:
```ts
await vi.waitFor(() => {
	expect(d.getStatus().clientCount).toBe(1);
}, { timeout: 1000 });
```

### Step 3: Migrate ws-handler.pbt.test.ts

Replace:
```ts
await new Promise((r) => setTimeout(r, 300));
```

With `vi.waitFor()` or message event listeners.

### Step 4: Migrate instance-manager.test.ts integration delays

Replace:
```ts
await new Promise((r) => setTimeout(r, 2500));
expect(mgr.getInstance("no-auth")!.status).toBe("unhealthy");
```

With:
```ts
await vi.waitFor(() => {
	expect(mgr.getInstance("no-auth")!.status).toBe("unhealthy");
}, { timeout: 5000 });
```

### Step 5: Run all tests

Run: `pnpm test`
Expected: PASS — tests should be faster and less flaky

### Step 6: Refactor

Review: Are any `vi.waitFor()` calls using excessively long timeouts? Tighten them. Are any still flaky? May need to investigate the underlying race condition.

**Note:** Leave legitimate timeout guards in test helpers (e.g., `sendIPCCommand` connection timeouts) — those are proper safety nets, not workarounds.

### Step 7: Commit

```
refactor: replace test setTimeout workarounds with vi.waitFor()
```

---

## Task 11: Storybook Workaround Cleanup

Fix the `undefined as unknown as typeof Component` pattern in Storybook stories.

**Files:**
- Modify: `src/lib/public/components/overlays/NotifSettings.stories.ts:9`
- Check: Any other `.stories.ts` files with the same pattern

### Step 1: Find all instances

Grep for `as unknown as` in `*.stories.ts` files.

### Step 2: Fix the pattern

The pattern exists because Storybook decorators need a `Component` field that isn't used:

```ts
// Before
Component: undefined as unknown as typeof NotifSettings,

// After — use a proper empty component or omit
```

Check if the Storybook version being used allows omitting `Component` from decorators. If so, remove it. If not, use a minimal placeholder.

### Step 3: Run Storybook build

Run: `pnpm build-storybook` (or equivalent)
Expected: PASS

### Step 4: Commit

```
fix: clean up Storybook type workarounds
```

---

## Verification Checklist

After all tasks are complete, run the full suite:

```bash
pnpm check          # Both tsconfigs
pnpm lint           # Biome
pnpm test           # All unit + fixture tests
pnpm build          # Full build (server + frontend)
```

Then verify the cleanup is thorough:

```bash
# Should return 0 results in src/ (excluding test files):
grep -r "as unknown as" src/lib/ --include="*.ts" --include="*.svelte" | grep -v node_modules

# Should return significantly fewer results in test/:
grep -c "as unknown as" test/unit/*.test.ts | awk -F: '{sum+=$2} END {print sum}'

# Should return 0 results:
grep -r "?? undefined" src/lib/ --include="*.ts" --include="*.svelte"

# Should return 0 results:
grep -rn "\.catch(() => {})" src/lib/ --include="*.ts" --include="*.svelte"

# Should return 0 results (in src/lib/public/, ungated):
grep -rn "console\.debug" src/lib/public/ --include="*.ts" --include="*.svelte"
```

---

## Task Dependency Graph

```
Task 1 (Navigator .d.ts) ─────────────┐
Task 2 (Vite env types) ──────────────┤
Task 3 (Constants) ────────────────────┤
Task 4 (Prod type casts) ─────────────┤── All independent,
Task 5 (Dead code + null/undefined) ───┤   can be done in
Task 6 (Error handling) ───────────────┤   any order
Task 7 (console.debug) ───────────────┤
Task 8 (Theme build fix) ─────────────┘

Task 9 (Test factories) ──────────────── Depends on nothing, but is
                                          the largest task

Task 10 (Test setTimeout) ────────────── Independent of Task 9
                                          (different files)

Task 11 (Storybook) ──────────────────── Independent
```

Tasks 1-8 can be parallelized. Task 9 is the largest and can run in parallel with Tasks 1-8. Tasks 10-11 are independent cleanup.
