# Structured Logging Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace all manual `log("   [tag] message")` patterns with a structured `Logger` interface that handles tags, alignment, and log levels.

**Architecture:** New `Logger` interface with `debug/info/warn/error/child` methods. `createLogger(tag, parent?)` factory with column-aligned formatting. Injected through existing dependency patterns. Root logger created by daemon/relay-stack, child loggers distributed to subsystems.

**Tech Stack:** TypeScript, Vitest for tests

---

### Task 1: Create Logger Module with Tests

**Files:**
- Create: `src/lib/logger.ts`
- Create: `test/unit/logger.test.ts`

**Step 1: Write the failing tests**

Create `test/unit/logger.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { createLogger, type Logger } from "../../src/lib/logger.js";

describe("createLogger", () => {
	it("creates a root logger that writes to console", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const log = createLogger("test");
		log.info("hello");
		expect(spy).toHaveBeenCalledOnce();
		const output = spy.mock.calls[0][0];
		expect(output).toContain("[test]");
		expect(output).toContain("hello");
		spy.mockRestore();
	});

	it("maps levels to correct console methods", () => {
		const spyLog = vi.spyOn(console, "log").mockImplementation(() => {});
		const spyWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const spyError = vi.spyOn(console, "error").mockImplementation(() => {});
		const spyDebug = vi.spyOn(console, "debug").mockImplementation(() => {});

		const log = createLogger("test");
		log.info("i");
		log.warn("w");
		log.error("e");
		log.debug("d");

		expect(spyLog).toHaveBeenCalledOnce();
		expect(spyWarn).toHaveBeenCalledOnce();
		expect(spyError).toHaveBeenCalledOnce();
		expect(spyDebug).toHaveBeenCalledOnce();

		spyLog.mockRestore();
		spyWarn.mockRestore();
		spyError.mockRestore();
		spyDebug.mockRestore();
	});

	it("child logger includes parent and child tags", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const parent = createLogger("relay");
		const child = parent.child("sse");
		child.info("connected");
		const output = spy.mock.calls[0][0];
		expect(output).toContain("[relay]");
		expect(output).toContain("[sse]");
		expect(output).toContain("connected");
		spy.mockRestore();
	});

	it("aligns message bodies to consistent column", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const root = createLogger("relay");
		const short = root.child("sse");
		const long = root.child("status-poller");

		short.info("msg-a");
		long.info("msg-b");

		const outputA = spy.mock.calls[0][0] as string;
		const outputB = spy.mock.calls[1][0] as string;
		const idxA = outputA.indexOf("msg-a");
		const idxB = outputB.indexOf("msg-b");
		expect(idxA).toBe(idxB);
		spy.mockRestore();
	});

	it("passes extra args through", () => {
		const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const log = createLogger("test");
		const err = new Error("boom");
		log.warn("failed:", err);
		expect(spy.mock.calls[0]).toContain(err);
		spy.mockRestore();
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/logger.test.ts`
Expected: FAIL — module `../../src/lib/logger.js` does not exist

**Step 3: Implement the Logger module**

Create `src/lib/logger.ts`:

```ts
/**
 * Structured logger with tag hierarchy and column-aligned output.
 *
 * Usage:
 *   const log = createLogger('relay');
 *   const sseLog = log.child('sse');
 *   sseLog.info('Connected');  // → "[relay] [sse]          Connected"
 */

export interface Logger {
	debug(...args: unknown[]): void;
	info(...args: unknown[]): void;
	warn(...args: unknown[]): void;
	error(...args: unknown[]): void;
	child(tag: string): Logger;
}

/**
 * Fixed column width for the tag portion of log lines.
 * The longest known tag chain is "[relay] [status-poller]" (24 chars).
 * We pad to 26 to leave a 2-char margin before the message body.
 */
const TAG_COLUMN_WIDTH = 26;

type ConsoleFn = (...args: unknown[]) => void;

interface RootOutput {
	log: ConsoleFn;
	warn: ConsoleFn;
	error: ConsoleFn;
	debug: ConsoleFn;
}

function padTag(tag: string): string {
	return tag.length >= TAG_COLUMN_WIDTH
		? tag + " "
		: tag + " ".repeat(TAG_COLUMN_WIDTH - tag.length);
}

function createChildLogger(
	tag: string,
	parentTags: string,
	root: RootOutput,
): Logger {
	const fullTag = `${parentTags} [${tag}]`;
	const padded = padTag(fullTag);

	const write = (fn: ConsoleFn, args: unknown[]): void => {
		if (args.length === 1) {
			fn(`${padded}${args[0]}`);
		} else {
			fn(padded, ...args);
		}
	};

	const logger: Logger = {
		debug: (...args) => write(root.debug, args),
		info: (...args) => write(root.log, args),
		warn: (...args) => write(root.warn, args),
		error: (...args) => write(root.error, args),
		child: (childTag) => createChildLogger(childTag, fullTag, root),
	};
	return logger;
}

/**
 * Create a logger with the given tag.
 *
 * @param tag - Component identifier (e.g. "relay", "daemon")
 * @param parent - Optional parent logger. If provided, this logger's output
 *   is nested under the parent's tag chain.
 */
export function createLogger(tag: string, parent?: Logger): Logger {
	// If parent is provided, delegate to it (for external composition).
	// This path is used when a caller has a Logger but not access to the
	// internal root output — the parent handles formatting.
	if (parent) {
		const bracket = `[${tag}]`;
		return {
			debug: (...args) => parent.debug(bracket, ...args),
			info: (...args) => parent.info(bracket, ...args),
			warn: (...args) => parent.warn(bracket, ...args),
			error: (...args) => parent.error(bracket, ...args),
			child: (childTag) => createLogger(childTag, createLogger(tag, parent)),
		};
	}

	// Root logger — owns the console output
	const root: RootOutput = {
		log: console.log,
		warn: console.warn,
		error: console.error,
		debug: console.debug,
	};

	const padded = padTag(`[${tag}]`);

	const write = (fn: ConsoleFn, args: unknown[]): void => {
		if (args.length === 1) {
			fn(`${padded}${args[0]}`);
		} else {
			fn(padded, ...args);
		}
	};

	const logger: Logger = {
		debug: (...args) => write(root.debug, args),
		info: (...args) => write(root.log, args),
		warn: (...args) => write(root.warn, args),
		error: (...args) => write(root.error, args),
		child: (childTag) => createChildLogger(childTag, `[${tag}]`, root),
	};
	return logger;
}

/**
 * Create a silent logger (all methods are no-ops).
 * Useful as a default when logging is optional.
 */
export function createSilentLogger(): Logger {
	const noop = () => {};
	return {
		debug: noop,
		info: noop,
		warn: noop,
		error: noop,
		child: () => createSilentLogger(),
	};
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/logger.test.ts`
Expected: PASS — all 5 tests pass

**Step 5: Commit**

```
feat: add structured Logger interface with tag alignment
```

---

### Task 2: Update Core Type Interfaces

**Files:**
- Modify: `src/lib/types.ts:182-183` — `ProjectRelayConfig.log`
- Modify: `src/lib/handlers/types.ts:41` — `HandlerDeps.log`
- Modify: `src/lib/relay/relay-stack.ts:92-93` — `RelayStackConfig.log`

**Step 1: Update ProjectRelayConfig**

In `src/lib/types.ts`, add the import and change the log field:

```ts
// Add import at top:
import type { Logger } from "./logger.js";

// Change line 182-183 from:
/** Log function — defaults to console.log, pass () => {} to silence */
log?: (...args: unknown[]) => void;
// To:
/** Logger instance — defaults to a console-backed root logger */
log?: Logger;
```

**Step 2: Update HandlerDeps**

In `src/lib/handlers/types.ts`, add the import and change the log field:

```ts
// Add import at top:
import type { Logger } from "../logger.js";

// Change line 41 from:
log: (...args: unknown[]) => void;
// To:
log: Logger;
```

**Step 3: Update RelayStackConfig**

In `src/lib/relay/relay-stack.ts`, add the import and change the log field:

```ts
// Add import at top:
import { createLogger, createSilentLogger, type Logger } from "../logger.js";

// Change lines 92-93 from:
/** Log function — defaults to console.log, pass () => {} to silence */
log?: (...args: unknown[]) => void;
// To:
/** Logger instance — defaults to a console-backed root logger */
log?: Logger;
```

**Step 4: Run type check**

Run: `pnpm check`
Expected: Type errors in ~25 files where `log` is used as a function call. This is expected — we'll fix them in subsequent tasks.

**Step 5: Commit**

```
refactor: update log type from function to Logger in core interfaces
```

---

### Task 3: Update relay-stack.ts (Central Hub)

This is the largest single file change. `relay-stack.ts` creates the log function and distributes it to all subsystems.

**Files:**
- Modify: `src/lib/relay/relay-stack.ts`

**Step 1: Update the log default and create child loggers**

In `createProjectRelay` (starting around line 134), change:
```ts
// Line 134 — from:
const log = config.log ?? console.log;
// To:
const log = config.log ?? createLogger("relay");
```

Then throughout `createProjectRelay`, replace every log call. Reference the exploration data for exact line numbers. The key patterns:

**Startup messages (✓ prefix):**
```ts
// Line 179 — from:
log(`   ✓ Default model from settings: ${relaySettings.defaultModel}`);
// To:
log.info(`✓ Default model from settings: ${relaySettings.defaultModel}`);
```
Apply same pattern to lines 188, 226, 247, 260, 898.

**Tagged messages — create child loggers and pass them:**
```ts
// After the log default, create child loggers:
const wsLog = log.child("ws");
const sessionLog = log.child("session");
const sseLog = log.child("sse");
const statusLog = log.child("status-poller");
const pollerLog = log.child("msg-poller");
const pollerMgrLog = log.child("poller-mgr");
const ptyLog = log.child("pty");
const pipelineLog = log.child("pipeline");
```

Then update all call sites and deps objects to use the appropriate child logger. For example:

```ts
// Line 299-300 — from:
log(`   [ws] Client connected: ${clientId}`);
// To:
wsLog.info(`Client connected: ${clientId}`);

// Line 307-309 — from:
log(`   [ws] Client init failed for ${clientId}:`);
// To:
wsLog.error(`Client init failed for ${clientId}:`);
```

**Pass child loggers to subsystem constructors/deps:**
```ts
// SessionManager (line ~149):
log: sessionLog,

// SessionStatusPoller (line ~196):
log: statusLog,

// MessagePollerManager (line ~208):
log: pollerMgrLog,

// PtyManager (line ~220):
log: ptyLog,

// HandlerDeps (line ~391):
log: log,  // handlers create their own children

// wireSSEConsumer deps (line ~461):
log: sseLog,

// PipelineDeps (line ~477):
log: pipelineLog,
```

**Line 701 — `createRelayStack`:**
```ts
// From:
const log = config.log ?? console.log;
// To:
const log = config.log ?? createLogger("relay");
```

**Line 928-929 — direct console.error:**
```ts
// From:
console.error(`[relay] Error stopping relay:`, err);
// To:
log.error("Error stopping relay:", err);
```

**Step 2: Run type check**

Run: `pnpm check`
Expected: Remaining errors in subsystem files (handlers, pollers, etc.) but relay-stack.ts itself should be clean.

**Step 3: Commit**

```
refactor: update relay-stack to create and distribute child loggers
```

---

### Task 4: Update Component Classes

These classes receive `log` via constructor options and store as `this.log`.

**Files:**
- Modify: `src/lib/session/session-manager.ts` (lines 22, 75, 109-115, 227-228)
- Modify: `src/lib/session/session-status-poller.ts` (lines 41, 97, 113-314)
- Modify: `src/lib/relay/message-poller.ts` (lines 436, 456, 482, 512-651)
- Modify: `src/lib/relay/message-poller-manager.ts` (lines 33, 44, 53, 75-76)
- Modify: `src/lib/relay/pty-manager.ts` (lines 27, 37, 115)

For each file, the pattern is:

1. Add import: `import type { Logger } from "../logger.js";` (adjust path as needed)
2. Change the option type from `log?: (...args: unknown[]) => void` to `log?: Logger`
3. Change the field type from `(...args: unknown[]) => void` to `Logger`
4. Change the default from `() => {}` or `null` to `createSilentLogger()`
5. Update every `this.log(...)` call to `this.log.info(...)`, `this.log.warn(...)`, etc.
6. Strip the `"   [tag] "` prefix from every log message string

**Example — session-status-poller.ts:**

```ts
// Import:
import { createSilentLogger, type Logger } from "../logger.js";

// Line 41 — option type from:
log?: (...args: unknown[]) => void;
// To:
log?: Logger;

// Line 97 — field + default from:
this.log = options.log ?? (() => {});
// To:
this.log = options.log ?? createSilentLogger();

// Field type (wherever declared):
private readonly log: Logger;

// Line 113-114 — from:
this.log(`   [status-poller] message-activity BUSY session=${sessionId}`);
// To:
this.log.info(`message-activity BUSY session=${sessionId}`);

// Line 238 — from:
this.log(`   [status-poller] poll failed: ${msg}`);
// To:
this.log.warn(`poll failed: ${msg}`);
```

Apply the same pattern to all 5 files. Use `log.warn` for failure messages, `log.info` for normal operational messages, `log.debug` for verbose/noisy messages.

**Level mapping guidance:**
- `START`, `STOP`, `INIT`, `CHANGED`, status transitions → `log.info`
- `poll failed`, `Error`, `Failed` → `log.warn`
- `poll skipped`, verbose polling details → `log.debug`
- `SYNTHESIZED`, `RESEEDED` → `log.info`
- `IDLE TIMEOUT` → `log.info`

**Special case — session-manager.ts:**
```ts
// Line 75 — currently defaults to null:
this.log = options.log ?? null;
// Change to:
this.log = options.log ?? createSilentLogger();

// Remove null guards — lines 109-115 currently have:
if (this.log) { this.log(`   [session] listSessions: ...`); }
// Change to:
this.log.info(`listSessions: ...`);

// Line 227-228 uses optional chaining:
this.log?.(`   [session] Failed to fetch messages ...`);
// Change to:
this.log.warn(`Failed to fetch messages ...`);
```

**Step: Run type check after all 5 files updated**

Run: `pnpm check`

**Step: Run unit tests for these components**

Run: `pnpm vitest run test/unit/session/ test/unit/relay/message-poller test/unit/relay/message-poller-manager test/unit/relay/pty-manager`
Expected: FAIL — test mocks need updating (Task 8)

**Step: Commit**

```
refactor: update component classes to use Logger interface
```

---

### Task 5: Update Handler Files

All handlers access `deps.log` which is typed as `Logger` after Task 2.

**Files:**
- Modify: `src/lib/handlers/session.ts` — tag: `[session]`, 11 log calls
- Modify: `src/lib/handlers/permissions.ts` — tags: `[perm]`, `[question]`, 12 log calls
- Modify: `src/lib/handlers/terminal.ts` — tag: `[pty]`, 10 log calls
- Modify: `src/lib/handlers/model.ts` — tag: `[model]`, 7 log calls
- Modify: `src/lib/handlers/prompt.ts` — tags: `[msg]`, `[timeout]`, `[cancel]`, `[session]`, 6 log calls
- Modify: `src/lib/handlers/agent.ts` — tag: `[agent]`, 2 log calls
- Modify: `src/lib/handlers/index.ts` — tag: `[ws]`, 1 log call
- Modify: `src/lib/handlers/files.ts` — tag: `[file-tree]`, 1 log call

**Approach:**

Each handler currently does `deps.log("   [tag] message")`. The handlers don't create their own child loggers — they receive `deps.log` which is the relay-stack's root logger.

For handlers that use a **single tag**, create a child logger at the top of the handler function:

```ts
// In session handler (each handler function):
const log = deps.log.child("session");
log.info(`client=${clientId} Viewing: ${id}`);
```

For handlers that use **multiple tags** (like `permissions.ts` with `[perm]` and `[question]`, or `prompt.ts` with `[msg]`, `[cancel]`, `[timeout]`, `[session]`), create multiple child loggers:

```ts
// In permissions.ts:
const permLog = deps.log.child("perm");
const questionLog = deps.log.child("question");
```

**Level mapping for handlers:**
- `Failed`, `Error`, `WARNING` → `log.warn`
- `client=... Viewing:`, `Created:`, `Deleted:`, `Switched to:` → `log.info`
- `Unhandled:` → `log.warn`

**Example — session.ts handler functions:**

```ts
// Line 54-55 — from:
deps.log(`   [session] Failed to load history for ${clientId}: ${err}`);
// To:
log.warn(`Failed to load history for ${clientId}: ${err}`);

// Line 162 — from:
deps.log(`   [session] client=${clientId} Viewing: ${id}`);
// To:
log.info(`client=${clientId} Viewing: ${id}`);
```

**Example — files.ts (inconsistent, no spaces):**

```ts
// Line 69 — from:
deps.log(`[file-tree] Error walking directory: ${err}`);
// To:
const log = deps.log.child("file-tree");
log.warn(`Error walking directory: ${err}`);
```

**Step: Run type check**

Run: `pnpm check`

**Step: Commit**

```
refactor: update handler files to use Logger child loggers
```

---

### Task 6: Update Bridge, SSE, Pipeline, and PTY Files

**Files:**
- Modify: `src/lib/bridges/client-init.ts` — tags: `[ws]`, `[model]`, 7 log calls
- Modify: `src/lib/relay/sse-wiring.ts` — tags: `[sse]`, `[push]`, 15 log calls
- Modify: `src/lib/relay/sse-consumer.ts` — tag: `[sse]`, 1 direct console.log call
- Modify: `src/lib/relay/event-pipeline.ts` — tag: `[pipeline]`, 1 log call
- Modify: `src/lib/relay/event-translator.ts` — tag: `[session]`, 1 log call
- Modify: `src/lib/relay/pty-upstream.ts` — tag: `[pty]`, 2 log calls

**client-init.ts:**

The `ClientInitDeps` interface (line 43) has `log: (...args: unknown[]) => void`. Change to `log: Logger`:

```ts
import type { Logger } from "../logger.js";

// In ClientInitDeps:
log: Logger;
```

Then update calls. This file uses `[ws]` and `[model]` tags, so create children:
```ts
const wsLog = deps.log.child("ws");
const modelLog = deps.log.child("model");
```

**sse-wiring.ts:**

The `SSEWiringDeps` interface (line 68) has `log`. Change type. The file also has `sendPushForEvent` which takes `log` as a parameter — change that signature too.

Create `sseLog` and `pushLog` children.

**sse-consumer.ts:**

This file uses `console.log` directly (line 217). It needs to receive a `log: Logger` parameter or access one. Check how it's called from `sse-wiring.ts` to determine the best injection point. Change:

```ts
// Line 217 — from:
console.log(`   [sse] Malformed event: ${dataStr.slice(0, 120)}`);
// To (after adding log parameter):
log.warn(`Malformed event: ${dataStr.slice(0, 120)}`);
```

**event-pipeline.ts:**

`PipelineDeps.log` (line 112) — change type to `Logger`. Update call at line 142-144:
```ts
// From:
deps.log(`   [pipeline] ${result.route.reason} — ${result.msg.type} (${result.source})`);
// To:
deps.log.info(`${result.route.reason} — ${result.msg.type} (${result.source})`);
```

Note: pipeline already receives a tagged log from relay-stack, so no need to create a child here.

**event-translator.ts:**

The `rebuildTranslatorFromHistory` function takes `log: (...args: unknown[]) => void` as a parameter (line 775). Change to `log: Logger`. Update call at line 788-789.

**pty-upstream.ts:**

`PtyUpstreamDeps.log` (line 24) — change type to `Logger`. Update calls at lines 121, 131.

**Step: Run type check**

Run: `pnpm check`

**Step: Commit**

```
refactor: update bridge, SSE, pipeline, and PTY files to use Logger
```

---

### Task 7: Update Daemon Files

The daemon files use `console.log/warn/error` directly — they don't receive an injected log. We need to create loggers in the daemon.

**Files:**
- Modify: `src/lib/daemon/daemon.ts` — 14 console calls
- Modify: `src/lib/daemon/daemon-projects.ts` — 6 console calls + relay log creation
- Modify: `src/lib/daemon/daemon-lifecycle.ts` — 1 console.error call

**daemon.ts:**

Create a daemon logger at class level or in the constructor:

```ts
import { createLogger, type Logger } from "../logger.js";

// In the Daemon class:
private readonly log: Logger = createLogger("daemon");
```

Then replace all `console.log("[daemon] ...")` with `this.log.info(...)`, etc.

```ts
// Line 339 — from:
console.log(`[daemon] OpenCode not reachable at ${url} — will spawn managed instance`);
// To:
this.log.info(`OpenCode not reachable at ${url} — will spawn managed instance`);

// Line 392 — from:
console.warn("[daemon] Failed to auto-start default instance:", formatErrorDetail(err));
// To:
this.log.warn("Failed to auto-start default instance:", formatErrorDetail(err));
```

**daemon-projects.ts:**

This creates the relay's log function on line 93. Change to pass a proper Logger:

```ts
// Line 93 — from:
log: (...args: unknown[]) => console.log("[relay]", ...args),
// To:
log: createLogger("relay"),
```

Also replace the direct console calls for `[daemon]` and `[discovery]` tags:

```ts
// Create loggers:
const log = createLogger("daemon");
const discoveryLog = createLogger("relay").child("discovery");

// Line 122 — from:
console.error("[daemon] Failed to start relay:", formatErrorDetail(err));
// To:
log.error("Failed to start relay:", formatErrorDetail(err));

// Line 306 — from:
console.log(`[relay]    [discovery] Discovered ${projects.length} project(s)...`);
// To:
discoveryLog.info(`Discovered ${projects.length} project(s)...`);
```

**daemon-lifecycle.ts:**

```ts
// Line 56 — from:
console.error("[daemon] Request error:", err);
// To (add log parameter or import):
```

Check how this function is called — it may need the daemon's logger passed in, or it can create its own.

**Step: Run type check**

Run: `pnpm check`

**Step: Commit**

```
refactor: update daemon files to use Logger
```

---

### Task 8: Update Server and Instance Files

**Files:**
- Modify: `src/lib/server/http-router.ts` — 1 console.error call
- Modify: `src/lib/instance/opencode-client.ts` — 2 console calls

**http-router.ts (line 345):**

This uses `console.error("[router] Request error:", err)`. Either:
- Accept a `Logger` in the router factory/constructor, or
- Create a module-level logger: `const log = createLogger("router");`

Prefer injection if the router is already constructed with config. Otherwise module-level is fine since there's only one router.

**opencode-client.ts (lines 161, 338-339):**

Uses `console.warn` and `console.debug`. Either accept a Logger or create module-level:
```ts
const log = createLogger("opencode-client");

// Line 161 — from:
console.warn("[opencode-client] Dropping malformed message:", rawPayload);
// To:
log.warn("Dropping malformed message:", rawPayload);

// Line 338-339 — from:
console.debug(`[opencode-client] prompt_async body:`, body);
// To:
log.debug("prompt_async body:", body);
```

**Step: Run type check**

Run: `pnpm check`

**Step: Commit**

```
refactor: update server and instance files to use Logger
```

---

### Task 9: Update Test Files

All test files that mock `log` need updating from `log: vi.fn()` or `log: () => {}` to a mock Logger object.

**Files:**
- Modify: `test/unit/relay/event-pipeline.test.ts`
- Modify: `test/unit/regression-question-session-scoping.test.ts`
- Modify: `test/unit/relay/message-poller-manager.test.ts`
- Modify: `test/unit/relay/per-tab-routing-e2e.test.ts`
- Modify: `test/unit/handlers/regression-question-on-session-view.test.ts`
- Modify: `test/unit/relay/message-poller.test.ts`
- Modify: `test/unit/session/session-status-poller.test.ts`
- Modify: `test/unit/session/session-status-poller-augment.test.ts`
- Modify: `test/unit/relay/status-poller-broadcast.test.ts`
- Modify: `test/unit/session/session-manager-processing.test.ts`
- Modify: `test/unit/relay/pty-manager.test.ts`
- Modify: `test/unit/instance/instance-wiring.test.ts`
- Modify: `test/unit/relay/push-notification-done.test.ts`
- Modify: `test/unit/handlers/handlers-instance.test.ts`
- Modify: `test/unit/handlers/handlers-session.test.ts`
- Modify: `test/unit/handlers/handlers-model.test.ts`
- Modify: `test/unit/handlers/message-handlers.test.ts`
- Modify: `test/unit/handlers/handlers-file-tree.test.ts`
- Modify: `test/unit/bridges/client-init.test.ts`
- Modify: `test/unit/daemon/daemon.test.ts`
- Modify: `test/unit/daemon/daemon-projects-wiring.test.ts`

**Step 1: Add a test helper**

Add to `src/lib/logger.ts` (exported for test use):

```ts
/**
 * Create a mock logger for testing. All methods are plain functions
 * that can be wrapped with vi.fn() in tests.
 */
export function createTestLogger(): Logger {
	const logger: Logger = {
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: () => {},
		child: () => createTestLogger(),
	};
	return logger;
}
```

Or, tests can inline a mock:

```ts
import { vi } from "vitest";
import type { Logger } from "../../src/lib/logger.js";

function mockLogger(): Logger {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		child: vi.fn(() => mockLogger()),
	};
}
```

**Step 2: Update each test file**

Replace every `log: vi.fn()` or `log: () => {}` with `log: mockLogger()`.

For tests that assert on log calls (e.g., `expect(log).toHaveBeenCalledWith(...)`), update to assert on the specific level method:

```ts
// From:
expect(deps.log).toHaveBeenCalledWith(expect.stringContaining("[session]"));
// To:
expect(deps.log.child("session").info).toHaveBeenCalledWith(expect.stringContaining("Viewing"));
```

Or if the test just checks that something was logged (not the specific content), use the mock logger and check the appropriate level.

Note: Many tests use `log: vi.fn()` just to silence output and don't assert on log calls. For these, `log: mockLogger()` is a drop-in replacement.

**Step 3: Run all unit tests**

Run: `pnpm test:unit`
Expected: All tests pass

**Step 4: Commit**

```
test: update log mocks to use Logger interface
```

---

### Task 10: Final Verification

**Step 1: Run type check**

Run: `pnpm check`
Expected: No errors

**Step 2: Run linter**

Run: `pnpm lint`
Expected: No errors (or only pre-existing ones)

**Step 3: Run all unit tests**

Run: `pnpm test:unit`
Expected: All pass

**Step 4: Manual smoke test**

Start the relay and verify log output looks correct with aligned columns:
```
[relay] [sse]            Connected to OpenCode event stream
[relay] [status-poller]  INIT busy=[] total=0
[relay] [session]        listSessions: returned 2 sessions
```

**Step 5: Final commit (if any fixups needed)**

```
fix: address any issues found during verification
```
