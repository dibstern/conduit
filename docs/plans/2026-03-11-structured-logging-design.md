# Structured Logging Design

**Date:** 2026-03-11
**Status:** Approved

## Problem

All relay/handler/session/daemon logging manually embeds indentation and component tags in every log string:

```ts
log(`   [sse] listPendingQuestions returned ${pendingQuestions.length} question(s)`);
```

This is repeated across 25+ files and 110+ call sites. The pattern is:
- 3-space indent (hardcoded in every string)
- `[tag]` component identifier (manually typed)
- No log levels (everything goes through a single `log()` function)
- Inconsistencies (missing indents, mixed indent widths, direct `console.log` bypasses)

## Design

### Logger Interface

New file `src/lib/logger.ts`:

```ts
export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  child(tag: string): Logger;
}
```

### Factory with Column-Aligned Formatting

```ts
export function createLogger(tag: string, parent?: Logger): Logger;
```

- Root loggers format output with column alignment: all tags pad to a fixed width (`TAG_PAD_WIDTH = 17`) so message bodies start at the same column.
- Child loggers prepend their `[tag]` and delegate to the parent.
- The root logger maps levels to `console.log`/`console.warn`/`console.error`/`console.debug`.

Output example:
```
[relay] [sse]            Connected to event stream
[relay] [status-poller]  CHANGED busy=[ses_32b09dcc:busy] total=1
[relay] [session]        listSessions: returned 2 sessions
[relay] [msg-poller]     START session=ses_32b09dcc interval=750ms
```

### Hierarchy

- Daemon creates root: `createLogger('relay')`
- Relay stack creates children per subsystem: `root.child('sse')`, `root.child('session')`, etc.
- Children are passed via dependency injection (existing pattern preserved)

### Type Changes

| Location | Field | Before | After |
|----------|-------|--------|-------|
| `src/lib/types.ts` | `ProjectRelayConfig.log` | `(...args: unknown[]) => void` | `Logger` |
| `src/lib/relay/relay-stack.ts` | `RelayStackConfig.log` | `(...args: unknown[]) => void` | `Logger` |
| `src/lib/handlers/types.ts` | `HandlerDeps.log` | `(...args: unknown[]) => void` | `Logger` |
| Component classes | `this.log` | `(...args: unknown[]) => void` | `Logger` |

Components: `SessionManager`, `MessagePoller`, `MessagePollerManager`, `SessionStatusPoller`, `PtyManager`.

### Call-Site Migration

Mechanical transformation at each call site:

```ts
// Before
log(`   [sse] Connected to OpenCode event stream`);
// After
log.info('Connected to OpenCode event stream');
```

Level mapping:
- `log(...)` -> `log.info(...)` (default)
- `console.warn(...)` -> `log.warn(...)`
- `console.error(...)` -> `log.error(...)`
- Verbose/noisy messages (poll loops, event diffs) -> `log.debug(...)`

### Daemon Integration

```ts
// Before (daemon-projects.ts)
log: (...args: unknown[]) => console.log("[relay]", ...args)

// After
log: createLogger('relay')
```

Daemon's own logs use `createLogger('daemon')`.

## Out of Scope

- CLI terminal logging (`terminal-render.ts`) — stays as-is
- Frontend logging (`.svelte.ts` files) — stays as-is
- Log level filtering at runtime — interface supports it, not implemented now
- Structured/JSON logging — not needed for dev-facing tool
- File output — stays console-only

## Affected Files

~25 files in `src/lib/relay/`, `src/lib/handlers/`, `src/lib/session/`, `src/lib/daemon/`, `src/lib/bridges/`, `src/lib/server/`, `src/lib/instance/`.
