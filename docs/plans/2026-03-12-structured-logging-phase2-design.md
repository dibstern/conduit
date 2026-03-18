# Structured Logging Phase 2: Level Filtering & pino Backend

**Date:** 2026-03-12
**Status:** Approved
**Builds on:** `2026-03-11-structured-logging-design.md` (Phase 1 — Logger interface)

## Problem

Phase 1 created the `Logger` interface with `debug/info/warn/error/child` and column-aligned output. However:

1. **No level filtering** — all `debug()` calls always output to `console.debug`. There is no way to suppress verbose logs at runtime. This causes massive noise in normal operation.
2. **Redundant source annotations** — SSE wiring passes `sseLog` (`[relay] [sse]`) to `applyPipelineResult()`, which appends `(sse)` to dropped-event messages. The `[sse]` tag and `(sse)` suffix are redundant.
3. **No production-friendly output** — all output is pretty-printed for terminal. Daemon mode would benefit from JSON for machine parsing and log aggregation.
4. **Missing VERBOSE level** — current `debug()` conflates flow-decision logs ("no viewers for session", "translate skip") with deep-tracing logs (raw payloads, state dumps).

## Design

### 1. Library Choice

Replace the custom console-based backend with **pino** (production dependency) and **pino-pretty** (dev dependency), wrapped behind the existing `Logger` interface.

**Why pino:**
- Built-in level filtering with custom levels
- JSON output by default (production-friendly)
- Transport system for pretty/JSON switching
- Fast, low overhead
- Child loggers with bindings (maps to our tag hierarchy)

### 2. Log Levels

5 levels using pino's numeric scale:

| Level    | Numeric | Used for                                              |
|----------|---------|-------------------------------------------------------|
| ERROR    | 50      | Failures, crashes, unrecoverable                      |
| WARN     | 40      | Degraded operation, recoverable issues                |
| INFO     | 30      | Lifecycle events (connect, disconnect, session create) |
| VERBOSE  | 25      | Flow decisions (no viewers, translate skip, routing)   |
| DEBUG    | 20      | Raw payloads, state dumps, deep tracing               |

Default level: **INFO** (hides VERBOSE and DEBUG in normal operation).

### 3. Logger Interface

Add `verbose()` to the existing interface:

```ts
export interface Logger {
    debug(...args: unknown[]): void;
    verbose(...args: unknown[]): void;   // NEW
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
    child(tag: string): Logger;
}
```

### 4. Architecture

pino is an implementation detail — wrapped behind the `Logger` interface:

- `createLogger(tag)` creates a root pino instance with custom VERBOSE level, wraps it in `Logger`
- `.child(tag)` calls pino's `.child({ component: tag })`, tracks tag chain for pretty formatting
- `createSilentLogger()` and `createTestLogger()` get `verbose: noop` added
- No call site outside `logger.ts` imports or references pino

### 5. Output Modes

**Foreground/dev** (pretty format):
- Custom pino-pretty formatter preserving `[tag] [subtag]` column-aligned format
- Colorized level indicators
- Human-readable timestamps (or no timestamps, matching current behavior)

**Daemon/production** (JSON format):
- Raw pino JSON: `{"level":30,"component":["relay","sse"],"msg":"Connected","time":1710000000000}`
- Machine parseable, grep-friendly
- Written to stdout (captured by daemon log infrastructure)

### 6. Configuration

**CLI flag** (takes precedence):
```
opencode-relay foreground --log-level=verbose
opencode-relay start --log-level=debug
```

**Environment variable** (fallback):
```
LOG_LEVEL=verbose opencode-relay foreground
```

**Format override** (optional):
```
opencode-relay foreground --log-format=json
```

**Defaults:**
- `foreground` → pretty format, INFO level
- `start` (daemon) → JSON format, INFO level

### 7. Fix `(sse)` Redundancy

The root cause: `sse-wiring.ts:290-296` passes `sseLog` (`[relay] [sse]`) to `applyPipelineResult()`, which appends `(sse)` as the event source.

**Fix:** Add `pipelineLog: Logger` to `SSEWiringDeps`. Thread `pipelineLog` from `relay-stack.ts`. SSE wiring uses:
- `log` (sseLog) for SSE-specific messages (translate skip, event flow)
- `pipelineLog` for pipeline routing decisions (no viewers, no session ID)

Result: `[relay] [pipeline] no viewers for session abc — delta (sse)` — tag and suffix provide different information.

### 8. Call Reclassification

All existing `debug()` calls get triaged:

**Becomes `verbose()`** (flow decisions):
- `event-pipeline.ts:143` — dropped event reasons
- `sse-wiring.ts:231` — translate skip messages
- `sse-wiring.ts:271` — ask_user routing details
- SSE consumer connection details
- Status/message poller tick details

**Stays `debug()`** (raw data, deep tracing):
- `opencode-client.ts:337` — full prompt body dump
- Future raw payload logging

**Stays `info()`** — lifecycle, notable events
**Stays `warn()`** — degraded operation, recoverable failures
**Stays `error()`** — crashes, unrecoverable failures

The `ENV.debug` guard in `opencode-client.ts:337` is removed — replaced by pino's level filtering.

## Affected Files

- `src/lib/logger.ts` — rewrite backend to pino wrapper
- `src/lib/relay/sse-wiring.ts` — add pipelineLog dep, fix redundancy
- `src/lib/relay/relay-stack.ts` — thread pipelineLog, update CLI config
- `src/lib/relay/event-pipeline.ts` — reclassify debug→verbose
- `src/bin/cli-core.ts` — add --log-level and --log-format flags
- `src/lib/instance/opencode-client.ts` — remove ENV.debug guard
- All files using `debug()` — triage into verbose() or keep as debug()
- All test files using createTestLogger/createSilentLogger — add verbose noop
- `package.json` — add pino, pino-pretty deps
