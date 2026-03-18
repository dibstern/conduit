# Structured Logging Phase 2: Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the console-based logger backend with pino for level filtering, add a VERBOSE level, fix the `(sse)` tag redundancy, and support JSON output in daemon mode.

**Architecture:** pino wrapped behind the existing `Logger` interface. Global log level set via CLI flag (`--log-level`) or env var (`LOG_LEVEL`). Pretty output in foreground mode, JSON in daemon mode. 20 existing `debug()` calls reclassified into `verbose()` or kept as `debug()`.

**Tech Stack:** TypeScript, pino, pino-pretty, Vitest

---

### Task 1: Fix `(sse)` Tag Redundancy

Thread `pipelineLog` into SSE wiring so pipeline routing decisions use `[relay] [pipeline]` instead of `[relay] [sse]`, eliminating the redundant `(sse)` suffix on `[sse]`-tagged messages.

**Files:**
- Modify: `src/lib/relay/sse-wiring.ts:59-89` (SSEWiringDeps interface)
- Modify: `src/lib/relay/sse-wiring.ts:290-296` (applyPipelineResult call)
- Modify: `src/lib/relay/relay-stack.ts:460-477` (wireSSEConsumer call)

**Step 1: Add `pipelineLog` to SSEWiringDeps**

In `src/lib/relay/sse-wiring.ts`, add to the `SSEWiringDeps` interface:

```ts
export interface SSEWiringDeps {
    translator: Translator;
    sessionMgr: SessionManager;
    messageCache: MessageCache;
    pendingUserMessages: PendingUserMessages;
    permissionBridge: PermissionBridge;
    overrides: SessionOverrides;
    toolContentStore: ToolContentStore;
    wsHandler: { ... };
    pushManager?: PushNotificationManager;
    log: Logger;
    pipelineLog: Logger;  // NEW — for pipeline routing decisions
    ...
}
```

**Step 2: Use `pipelineLog` in `applyPipelineResult` call**

In `src/lib/relay/sse-wiring.ts`, around line 290-296, change the `applyPipelineResult` call to use `pipelineLog`:

```ts
// Before:
applyPipelineResult(pipeResult, targetSessionId, {
    toolContentStore,
    overrides,
    messageCache,
    wsHandler,
    log,
});

// After:
applyPipelineResult(pipeResult, targetSessionId, {
    toolContentStore,
    overrides,
    messageCache,
    wsHandler,
    log: pipelineLog,
});
```

Note: `toolContentStore`, `overrides`, `messageCache`, `wsHandler` are destructured from `deps` at the top of `wireSSEConsumer`. `pipelineLog` should also be destructured from `deps`.

**Step 3: Thread `pipelineLog` from relay-stack**

In `src/lib/relay/relay-stack.ts`, around line 460-477, add `pipelineLog` to the deps passed to `wireSSEConsumer`:

```ts
wireSSEConsumer(
    {
        translator,
        sessionMgr,
        messageCache,
        pendingUserMessages,
        permissionBridge,
        overrides,
        toolContentStore,
        wsHandler,
        ...(config.pushManager != null && { pushManager: config.pushManager }),
        log: sseLog,
        pipelineLog,  // NEW
        getSessionStatuses: () => statusPoller.getCurrentStatuses(),
        listPendingQuestions: () => client.listPendingQuestions(),
        statusPoller,
    },
    sseConsumer,
);
```

**Step 4: Update test files that mock SSEWiringDeps**

Search for test files that create `SSEWiringDeps` mocks and add `pipelineLog` to them. The mock can be `createTestLogger()` or a `vi.fn()`-based mock logger.

**Step 5: Run verification**

Run: `pnpm check && pnpm lint && pnpm test:unit`
Expected: All pass

**Step 6: Commit**

```
fix: route pipeline drop logs through pipelineLog to remove redundant (sse) suffix
```

---

### Task 2: Install pino Dependencies

**Step 1: Install pino and pino-pretty**

Run: `pnpm add pino && pnpm add -D pino-pretty`

**Step 2: Verify installation**

Run: `pnpm check`
Expected: No type errors (pino ships its own types; pino-pretty types may need `@types/pino-pretty` — check)

**Step 3: Commit**

```
build: add pino and pino-pretty dependencies
```

---

### Task 3: Add `verbose()` to Logger Interface and Factories

Add the `verbose` method to the Logger interface and all factory functions. This task does NOT change the backend yet — it just extends the interface.

**Files:**
- Modify: `src/lib/logger.ts:10-16` (Logger interface)
- Modify: `src/lib/logger.ts:56-63` (createChildLogger)
- Modify: `src/lib/logger.ts:108-114` (root logger)
- Modify: `src/lib/logger.ts:122-132` (createSilentLogger)
- Modify: `src/lib/logger.ts:138-147` (createTestLogger)
- Modify: `test/unit/logger.test.ts` (add verbose tests)

**Step 1: Write failing tests for `verbose()`**

Add to `test/unit/logger.test.ts`:

```ts
it("verbose maps to console.debug", () => {
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const log = createLogger("test");
    log.verbose("v");
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/logger.test.ts`
Expected: FAIL — `log.verbose is not a function`

**Step 3: Add `verbose()` to Logger interface and implementations**

In `src/lib/logger.ts`:

```ts
export interface Logger {
    debug(...args: unknown[]): void;
    verbose(...args: unknown[]): void;  // NEW
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
    child(tag: string): Logger;
}
```

Add `verbose` to `createChildLogger`, root logger in `createLogger`, `createSilentLogger`, and `createTestLogger`. For now, `verbose` maps to `root.debug` (same as debug — pino will differentiate later).

**Step 4: Run tests**

Run: `pnpm vitest run test/unit/logger.test.ts`
Expected: PASS

**Step 5: Run type check to find all type errors**

Run: `pnpm check`
Expected: May surface errors in tests/mocks that construct Logger objects inline without `verbose`. Fix any that appear.

**Step 6: Commit**

```
feat: add verbose() method to Logger interface
```

---

### Task 4: Rewrite Logger Backend to Use pino

Replace the console-based implementation with pino, keeping the same `Logger` interface.

**Files:**
- Modify: `src/lib/logger.ts` (full rewrite of internals)
- Modify: `test/unit/logger.test.ts` (update tests for pino backend)

**Step 1: Write level filtering tests**

Add to `test/unit/logger.test.ts`:

```ts
import { createLogger, setLogLevel } from "../../src/lib/logger.js";

describe("log level filtering", () => {
    it("filters debug when level is info", () => {
        setLogLevel("info");
        const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
        const log = createLogger("test");
        log.debug("should not appear");
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    it("shows verbose when level is verbose", () => {
        setLogLevel("verbose");
        const log = createLogger("test");
        // verbose should output at verbose level
        // debug should still be filtered
    });
});
```

Note: Exact test approach depends on how pino outputs — may need to capture pino's destination stream rather than spy on console. Adjust accordingly.

**Step 2: Rewrite `logger.ts` internals**

Replace the `RootOutput`/`console.*` delegation with a pino instance:

```ts
import pino from "pino";

const CUSTOM_LEVELS = { verbose: 25 };

let rootPino = pino({
    level: "info",
    customLevels: CUSTOM_LEVELS,
    useOnlyCustomLevels: false,
});

export function setLogLevel(level: LogLevel): void {
    rootPino = pino({ level, customLevels: CUSTOM_LEVELS, useOnlyCustomLevels: false });
}

export function setLogFormat(format: "pretty" | "json"): void {
    // Configure pino transport for pretty or raw JSON
}
```

The `createLogger(tag)` function creates a pino child with `{ component: tag }`:

```ts
export function createLogger(tag: string, parent?: Logger): Logger {
    const pinoChild = rootPino.child({ component: [tag] });
    return wrapPino(pinoChild);
}
```

The `wrapPino` function adapts pino's API to our `Logger` interface:

```ts
function wrapPino(p: pino.Logger): Logger {
    return {
        debug: (...args) => p.debug(formatArgs(args)),
        verbose: (...args) => (p as any).verbose(formatArgs(args)),
        info: (...args) => p.info(formatArgs(args)),
        warn: (...args) => p.warn(formatArgs(args)),
        error: (...args) => p.error(formatArgs(args)),
        child: (childTag) => {
            const components = [...(p.bindings().component || []), childTag];
            return wrapPino(p.child({ component: components }));
        },
    };
}
```

For pretty output, use pino-pretty transport with a custom `messageFormat` that reads the `component` binding and renders `[tag] [subtag]` with column alignment.

**Step 3: Run tests**

Run: `pnpm vitest run test/unit/logger.test.ts`
Expected: PASS — may need to adjust test approach for pino output

**Step 4: Run full verification**

Run: `pnpm check && pnpm test:unit`
Expected: All pass

**Step 5: Commit**

```
feat: replace console-based logger backend with pino
```

---

### Task 5: Add CLI Flags and Env Var Support

**Files:**
- Modify: `src/bin/cli-utils.ts:24-57` (ParsedArgs)
- Modify: `src/bin/cli-utils.ts:61-190` (parseArgs)
- Modify: `src/lib/env.ts:40-51` (ENV)
- Modify: `src/bin/cli-core.ts:96-148` (daemon/foreground commands)
- Modify: `src/lib/daemon/daemon.ts:93-115` (DaemonOptions)
- Modify: `src/lib/daemon/daemon.ts:194-210` (Daemon constructor)

**Step 1: Add LogLevel type and env vars**

In `src/lib/env.ts`, add:

```ts
export type LogLevel = "error" | "warn" | "info" | "verbose" | "debug";
export type LogFormat = "pretty" | "json";

export const ENV = {
    ...existing fields,
    /** Log level (default: info). Set via LOG_LEVEL env var. */
    logLevel: (process.env["LOG_LEVEL"] as LogLevel | undefined) ?? "info",
    /** Log format (default: auto — pretty for foreground, json for daemon). */
    logFormat: process.env["LOG_FORMAT"] as LogFormat | undefined,
};
```

**Step 2: Add to ParsedArgs and parseArgs**

In `src/bin/cli-utils.ts`:

```ts
export interface ParsedArgs {
    ...existing fields,
    logLevel: LogLevel;
    logFormat?: LogFormat;
}
```

In `parseArgs()`, add cases:

```ts
case "--log-level": {
    const val = argv[i + 1];
    const valid = ["error", "warn", "info", "verbose", "debug"];
    if (val && valid.includes(val)) {
        result.logLevel = val as LogLevel;
    }
    i++;
    break;
}

case "--log-format": {
    const val = argv[i + 1];
    if (val === "json" || val === "pretty") {
        result.logFormat = val;
    }
    i++;
    break;
}
```

Default `logLevel` to `ENV.logLevel` in the initial `result` object.

**Step 3: Add to DaemonOptions**

In `src/lib/daemon/daemon.ts`:

```ts
export interface DaemonOptions {
    ...existing fields,
    logLevel?: LogLevel;
    logFormat?: LogFormat;
}
```

In constructor, call `setLogLevel()` and `setLogFormat()`:

```ts
import { setLogLevel, setLogFormat } from "../logger.js";

constructor(options?: DaemonOptions) {
    ...existing code,
    if (options?.logLevel) setLogLevel(options.logLevel);
    if (options?.logFormat) setLogFormat(options.logFormat);
}
```

**Step 4: Thread from CLI to Daemon**

In `src/bin/cli-core.ts`, foreground command (line 132):

```ts
const daemon = new Daemon({
    port: args.port,
    host: args.host,
    opencodeUrl,
    logLevel: args.logLevel,
    logFormat: args.logFormat ?? "pretty",  // foreground defaults to pretty
});
```

In daemon command (line 109), default format to JSON:

```ts
const daemon = new Daemon({
    ...existing options,
    logLevel: args.logLevel,
    logFormat: args.logFormat ?? "json",  // daemon defaults to json
});
```

**Step 5: Update help text**

In `src/bin/cli-utils.ts`, add to the help text:

```
  --log-level <level>    Set log level: error, warn, info (default), verbose, debug
  --log-format <format>  Set output format: pretty (default foreground), json (default daemon)
```

**Step 6: Run verification**

Run: `pnpm check && pnpm lint && pnpm test:unit`
Expected: All pass

**Step 7: Commit**

```
feat: add --log-level and --log-format CLI flags with LOG_LEVEL env var fallback
```

---

### Task 6: Reclassify debug() Calls

Triage all 20 existing `debug()` calls: 8 become `verbose()`, 12 stay `debug()`.

**Files (becomes `verbose()`):**
- `src/lib/relay/sse-wiring.ts:146` — per-event log: `event=${event.type} session=...`
- `src/lib/relay/sse-wiring.ts:257` — `translate skip: ...`
- `src/lib/relay/event-pipeline.ts:163` — dropped event reason: `no viewers...`
- `src/lib/session/session-status-poller.ts:126` — `message-activity CLEARED`
- `src/lib/session/session-manager.ts:110` — `listSessions: directory=...`
- `src/lib/relay/message-poller.ts:590` — `poll skipped — previous poll still running`
- `src/lib/relay/message-poller.ts:597` — `poll skipped — SSE active`

**Files (stays `debug()`):**
- `src/lib/relay/sse-wiring.ts:199` — `question.asked: event received`
- `src/lib/relay/sse-wiring.ts:277` — `Suppressed relay-originated user_message echo`
- `src/lib/relay/sse-wiring.ts:296` — `Routing ask_user to session=...`
- `src/lib/relay/sse-wiring.ts:363` — `listPendingPermissions returned...`
- `src/lib/relay/sse-wiring.ts:416` — `listPendingQuestions returned...`
- `src/lib/bridges/client-init.ts:236` — `listPendingQuestions returned...`
- `src/lib/bridges/client-init.ts:254` — `skipping question...`
- `src/lib/bridges/client-init.ts:262` — `sending ask_user: toolId=...`
- `src/lib/relay/relay-stack.ts:376` — `Skipping poller start...`
- `src/lib/relay/relay-stack.ts:611` — `Suppressed relay-originated user_message echo`
- `src/lib/session/session-status-poller.ts:138` — `SSE idle hint...`
- `src/lib/instance/opencode-client.ts:338` — `prompt_async body:` (also remove `ENV.debug` guard)

**Step 1: Reclassify verbose calls**

For each file listed above under "becomes `verbose()`", change `.debug(` to `.verbose(`:

```ts
// Example — event-pipeline.ts:163
// Before:
deps.log.debug(`${result.route.reason} — ${result.msg.type} (${result.source})`);
// After:
deps.log.verbose(`${result.route.reason} — ${result.msg.type} (${result.source})`);
```

**Step 2: Remove ENV.debug guard**

In `src/lib/instance/opencode-client.ts:337-338`:

```ts
// Before:
if (ENV.debug) {
    log.debug("prompt_async body:", JSON.stringify(body));
}

// After:
log.debug("prompt_async body:", JSON.stringify(body));
```

The pino level filtering now handles suppression.

**Step 3: Run verification**

Run: `pnpm check && pnpm lint && pnpm test:unit`
Expected: All pass

**Step 4: Commit**

```
refactor: reclassify log calls — flow decisions as verbose, raw data as debug
```

---

### Task 7: Update Test Mocks

All test files that construct Logger mocks need `verbose` added.

**Step 1: Find all test files with Logger mocks**

Search for `createTestLogger`, `createSilentLogger`, or inline Logger mocks in `test/` that may be missing `verbose`.

If Task 3 already addressed type errors from `pnpm check`, this task may just be a confirmation pass.

**Step 2: Update any remaining mocks**

Any inline mock like:
```ts
const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
```
needs `verbose: vi.fn()` added.

**Step 3: Run all tests**

Run: `pnpm test:unit`
Expected: All pass

**Step 4: Commit (if changes needed)**

```
test: add verbose to Logger mocks
```

---

### Task 8: Final Verification

**Step 1: Run full check suite**

Run: `pnpm check && pnpm lint && pnpm test:unit`
Expected: All pass, no errors

**Step 2: Manual smoke test**

Start the relay in foreground mode and verify:

```bash
# Default (INFO level, pretty format):
pnpm dev
# Should see lifecycle messages, NOT "no viewers" or "translate skip"

# Verbose level:
LOG_LEVEL=verbose pnpm dev
# Should see flow decisions (no viewers, translate skip)

# Debug level:
LOG_LEVEL=debug pnpm dev
# Should see everything including raw payloads

# JSON format:
LOG_FORMAT=json pnpm dev
# Should see JSON lines instead of pretty output
```

**Step 3: Verify pipeline tag fix**

With verbose level enabled, confirm dropped-event messages show:
```
[relay] [pipeline]        no viewers for session abc — delta (sse)
```
NOT:
```
[relay] [sse]             no viewers for session abc — delta (sse)
```

**Step 4: Commit (if any fixups needed)**

```
fix: address issues found during final verification
```
