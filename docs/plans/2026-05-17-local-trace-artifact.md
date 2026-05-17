# Local Trace Artifact Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Persist completed Effect spans to a bounded local NDJSON trace artifact by default so provider/runtime/orchestration failures have a durable, grep-able diagnostic record without requiring OTLP or another observability stack.

**Architecture:** Keep Conduit's existing pretty/json logs and optional OpenTelemetry export, but add an Effect-native local tracer layer that writes completed span summaries to `<configDir>/logs/server.trace.ndjson`. The trace artifact records span names, timing, parent/trace correlation, bounded attributes, embedded Effect log events, and success/failure exit summaries while keeping provider-owned payloads out of the artifact.

**Tech Stack:** TypeScript, Effect `Tracer` and `Logger.tracerLogger`, scoped Effect Layers, `@effect/platform` `FileSystem`, Vitest, existing daemon Layer composition.

---

## Goal

Build the default local debugging artifact Conduit is missing: every daemon run should produce a local NDJSON trace file containing completed Effect spans. The artifact should be useful with `tail`, `rg`, and `jq`, and it should work before anyone configures Grafana, Tempo, or OTLP.

This is priority #2 after `docs/plans/2026-05-17-provider-contract-runtime-schemas.md` because provider contract decode failures will be much easier to diagnose when the failing provider seam, operation, source label, and bounded schema issue are visible in a durable trace.

The core deliverable is the default local trace artifact. Provider-seam annotations are a follow-up integration task unless the provider contract runtime-schema implementation has already landed in the same worktree. Do not make the trace artifact PR depend on unfinished provider decoder names or error types.

## Motivation

Conduit already has a lot of `Effect.withSpan`, `Effect.annotateLogs`, and `Effect.log*` calls in daemon, relay, server, and provider-facing code. That means the codebase has already paid much of the instrumentation cost.

The current gap is artifact ownership. `src/lib/domain/daemon/Layers/tracing.ts` can wire Effect spans to OpenTelemetry processors, and `src/lib/domain/daemon/Layers/pino-logger-layer.ts` routes Effect logs to Pino, but the default local debugging story still depends on stdout, JSON logs, tests, or optional OTLP setup. That is weaker than t3code's default: completed spans are persisted locally as NDJSON, so a failed provider/runtime/orchestration path leaves a durable trace even when no observability backend is running.

The practical win is high leverage:

- provider schema decode failures can point at the exact runtime seam and operation
- future `ProviderRuntimeEvent` raw-source metadata can be correlated by `traceId`, `spanId`, `sessionId`, `provider`, and compact source labels
- daemon startup, project relay creation, WebSocket routing, status polling, and provider request paths become searchable after the fact
- local failures become inspectable from a file artifact attached to bug reports or copied into a review

## Current Shape

Verify this section against the live checkout before implementing. The shape observed while writing this plan was:

- `docs/agent-guide/architecture.md` says the CLI either runs foreground or controls a long-lived daemon, daemon lifecycle is owned by Effect domain services/layers under `src/lib/domain/daemon/*`, and provider instances are stateless execution engines that stream events into the SQLite event store.
- `docs/agent-guide/testing.md` says the default gate is `pnpm check`, `pnpm lint`, `pnpm test:unit`, with Effect migration guardrails in `test/unit/effect/runtime-boundary-grep.test.ts`.
- `src/lib/domain/daemon/Layers/daemon-layers.ts` composes the daemon foundation layer. `PinoLoggerLive` is already part of Tier 0 foundation.
- `src/lib/domain/daemon/Layers/daemon-main.ts` launches the daemon with `NodeRuntime.runMain(Layer.launch(fullLayer), { disablePrettyLogger: true })`.
- `src/lib/domain/daemon/Layers/tracing.ts` builds an optional OpenTelemetry `NodeSdk` layer with console, OTLP, or injected span processors. It is useful facility/test coverage, but it is not wired as a default local file artifact in `makeDaemonLive`.
- `test/unit/daemon/tracing.test.ts` verifies that `makeTracingLive` can capture spans with an in-memory OpenTelemetry exporter and that disabled/no-exporter modes are no-ops.
- `test/unit/daemon/pino-logger-layer.test.ts` verifies that Effect logs route to Pino and that `Effect.withLogSpan` appears as a log binding.
- `src/lib/env.ts` defines `DEFAULT_CONFIG_DIR` as `CONDUIT_CONFIG_DIR`, then `XDG_CONFIG_HOME/conduit`, then `~/.conduit`.
- `src/lib/domain/daemon/Layers/daemon-foreground.ts` ensures `configDir` exists, passes `configDir` into `makeDaemonLive`, and stores daemon runtime files such as `daemon.pid`, `relay.sock`, and `daemon.json` there.
- The provider schema plan at `docs/plans/2026-05-17-provider-contract-runtime-schemas.md` requires decode failures to carry compact diagnostic context: provider, raw source label, operation/method, and formatted schema issue, without dumping provider payloads.

## t3code Lessons

t3code's better idea is not "use tracing" in the abstract. The useful pattern is:

- logs are human-facing stdout
- completed spans are the durable local source of truth
- local span records are NDJSON so the artifact is grep-able and jq-able
- OTLP remains optional and complementary
- Effect logs emitted inside spans are attached as span events
- trace files are bounded by rotation and flush on scope close
- provider-native event logs can remain separate from the main server trace

Conduit should copy the architecture, not the code. Keep Conduit's existing file layout, `configDir` ownership, daemon Layer composition, and provider opacity rules.

## Target Architecture

### Artifact Location

Default path:

```text
<configDir>/logs/server.trace.ndjson
```

Examples:

```text
~/.conduit/logs/server.trace.ndjson
$CONDUIT_CONFIG_DIR/logs/server.trace.ndjson
```

Add environment overrides in `src/lib/env.ts`:

- `CONDUIT_TRACE_FILE`: absolute or relative path override for the active trace file
- `CONDUIT_TRACE_MAX_BYTES`: per-file rotation size, default `10485760`
- `CONDUIT_TRACE_MAX_FILES`: retained rotated file count, default `10`
- `CONDUIT_TRACE_BATCH_WINDOW_MS`: flush cadence, default `200`
- `CONDUIT_TRACE_ENABLED`: default `true`; `0` disables local file tracing for tests or constrained environments

Resolve a relative `CONDUIT_TRACE_FILE` against `configDir`, not against the process cwd. The trace artifact belongs to daemon runtime state, and cwd changes between CLI, daemon child, tests, and foreground dev mode.

Do not add trace artifact fields to `daemon.json` in this slice. Env + defaults are enough.

### Likely New Files

- Create `src/lib/domain/daemon/Services/local-trace-artifact.ts`
  - pure-ish trace record types
  - attribute/event normalization helpers
  - bounded string/object handling
  - local trace sink interface
  - file sink implementation using `@effect/platform` `FileSystem`
  - local `Tracer.Tracer` implementation or wrapper that writes completed spans
- Create `test/unit/daemon/local-trace-artifact.test.ts`
  - direct sink and tracer behavior tests with a temp or in-memory filesystem

### Likely Modified Files

- Modify `src/lib/env.ts`
  - parse trace env settings alongside existing user-facing env config
- Modify `src/lib/domain/daemon/Layers/tracing.ts`
  - either extend this file into "observability/tracing" ownership, or keep OTLP support here and delegate local artifact pieces to `Services/local-trace-artifact.ts`
  - recommended: preserve `makeTracingLive` API, add `makeLocalTraceArtifactLive`, and optionally add a small `makeDaemonTracingLive` composer
- Modify `src/lib/domain/daemon/Layers/daemon-layers.ts`
  - add local trace artifact Layer to Tier 0 foundation next to `PinoLoggerLive`
  - pass `configDir` into trace config so foreground and daemon modes write under the same runtime config directory
- Modify `src/lib/domain/daemon/Layers/daemon-main.ts` only if the implementation needs `Logger.tracerLogger` or `Tracer.Tracer` to be installed at the outer program layer rather than in `makeDaemonLive`
- Modify `test/unit/daemon/tracing.test.ts` if `tracing.ts` becomes the higher-level observability composer
- Modify `test/unit/daemon/daemon-layers.test.ts` or `test/unit/daemon/full-layer-composition.test.ts` if layer dependency expectations need updating
- Modify `docs/agent-guide/testing.md` only if the team wants the trace file command documented as a new standard diagnostic; this is optional and not required for the implementation slice

### Trace Payload Shape

Each line is one completed span summary:

```json
{
  "type": "effect-span",
  "schemaVersion": 1,
  "service": "conduit-daemon",
  "name": "provider.claude.decodeEnvelope",
  "traceId": "7d0f...",
  "spanId": "a31c...",
  "parentSpanId": "91fe...",
  "startTimeUnixNano": "1790000000000000000",
  "endTimeUnixNano": "1790000000025000000",
  "durationMs": 25,
  "attributes": {
    "component": "provider-runtime",
    "provider": "claude",
    "source": "claude.sdk.message",
    "operation": "sendTurn",
    "sessionId": "ses_abc",
    "turnId": "turn_123"
  },
  "events": [
    {
      "name": "decode.failure",
      "timeUnixNano": "1790000000024000000",
      "attributes": {
        "issueCount": 2,
        "firstIssue": "Expected string at type",
        "payloadShape": "object(keys=type,message,session_id)"
      }
    }
  ],
  "exit": {
    "_tag": "Failure",
    "cause": "ProviderContractDecodeError: claude.sdk.message failed schema decode"
  }
}
```

The exact field names can be adjusted during implementation, but keep these invariants:

- one JSON object per completed span
- stable `schemaVersion`
- correlation fields always present where Effect provides them
- attributes and events are JSON-safe
- `exit._tag` is one of `Success`, `Failure`, or `Interrupted`
- failure causes are summarized, not raw stack dumps with provider payloads

### Payload Bounds and Redaction

The trace artifact must not become a provider payload dump.

Implement a normalization helper with explicit limits:

- drop `undefined`
- stringify `bigint`
- serialize `Date` to ISO strings
- serialize `Error` as `{ name, message }`; include stack only behind a later explicit debug mode, not in this default slice
- detect cycles and write `"[Circular]"`
- cap string attributes, for example 2 KiB per string
- cap array length, for example 50 entries
- cap object keys, for example 50 keys
- cap nesting depth, for example 4
- cap event count per span, for example 100 events
- cap total serialized record bytes before writing, for example 64 KiB; if exceeded, write a truncated diagnostic record with `truncated: true`

Provider-owned payloads are never valid trace attributes. Allowed provider-adjacent attributes are labels and bounded summaries:

- allowed: `provider`, `source`, `operation`, `method`, `sessionId`, `turnId`, `requestId`, `messageType`, `schemaName`, `issueCount`, `firstIssue`, `payloadShape`
- not allowed: raw Claude `SDKMessage`, raw OpenCode event objects, tool input, tool result content, structured output, provider text deltas, full API response bodies

Add tests that intentionally annotate a span with a nested object and verify the trace line contains a bounded shape summary rather than the full value.

### Relationship to Provider Schema Decode Failures

The provider schema plan should annotate decode spans with compact metadata before failing closed. This trace artifact plan should not implement provider schemas, but it should make the trace layer ready for them.

Core acceptance for this plan stops at proving the trace layer safely records bounded annotations and log events. Provider decode-failure annotations have separate follow-up acceptance below and should only be implemented after `docs/plans/2026-05-17-provider-contract-runtime-schemas.md` has landed.

When priority #1 lands, provider decode code should be able to do roughly this at the seam:

```ts
Effect.annotateCurrentSpan({
  component: "provider-runtime",
  provider: "claude",
  source: "claude.sdk.message",
  operation: "sendTurn",
  schemaName: "ClaudeSDKMessageSchema"
});
```

On failure, emit an Effect log or span event with bounded schema information:

```ts
Effect.logWarning("provider envelope decode failed").pipe(
  Effect.annotateLogs({
    issueCount,
    firstIssue,
    payloadShape
  })
);
```

Because `Logger.tracerLogger` should be installed with the local tracer, logs emitted inside the active span should become trace events. That gives the failure a durable local record without exposing provider-owned payloads.

### Relationship to Future ProviderRuntimeEvent Raw-Source Metadata

Future `ProviderRuntimeEvent` raw-source metadata should use the same source label vocabulary as trace attributes:

- `claude.sdk.message`
- `claude.sdk.result`
- `claude.sdk.permission`
- `opencode.sdk.event`
- `opencode.sdk.response`
- `opencode.gap.response`
- `conduit.provider.request`
- `conduit.provider.translator`
- `conduit.provider.runtime`

The trace artifact stores correlation and summaries. Provider runtime events remain the event-store domain record. Do not duplicate raw provider event payloads into `server.trace.ndjson`.

## Non-Goals

- Do not build a trace viewer UI.
- Do not add browser/client tracing in this slice.
- Do not persist metrics locally.
- Do not make OTLP required.
- Do not replace Pino logging or the existing logger API.
- Do not deeply model or persist provider-owned payloads.
- Do not add event-store migrations.
- Do not change provider event schemas unless required to add bounded span annotations after priority #1 lands.
- Do not make the trace file a support bundle format; it is a local debugging primitive.

## Implementation Tasks

### Task 1: Add Trace Record and Normalization Tests

**Files:**

- Create: `test/unit/daemon/local-trace-artifact.test.ts`
- Create: `src/lib/domain/daemon/Services/local-trace-artifact.ts`

**Step 1: Write failing tests for attribute normalization**

Cover:

- plain string/number/boolean/null attributes survive
- `undefined` is dropped
- `bigint` stringifies
- `Date` serializes
- `Error` becomes name/message only
- circular objects do not throw
- deep objects are depth-capped
- long strings are length-capped
- arrays and object key counts are capped
- provider-looking payload keys such as `raw`, `payload`, `message`, `toolInput`, and `toolResult` are not blindly dumped when passed as large nested objects

**Step 2: Run the focused test and confirm failure**

```bash
pnpm vitest run test/unit/daemon/local-trace-artifact.test.ts
```

Expected: module not found or exported helper not found.

**Step 3: Implement the minimal record types and normalizer**

Export:

- `TraceRecord`
- `TraceRecordEvent`
- `TraceRecordExit`
- `TraceAttributeValue`
- `compactTraceAttributes(attributes, options?)`
- `summarizePayloadShape(value)`
- `MAX_TRACE_STRING_LENGTH`
- `MAX_TRACE_DEPTH`
- `MAX_TRACE_ARRAY_LENGTH`
- `MAX_TRACE_OBJECT_KEYS`

Use pure functions first. Keep filesystem and tracer behavior out of this task.

**Step 4: Run the focused test**

```bash
pnpm vitest run test/unit/daemon/local-trace-artifact.test.ts
```

Expected: normalization tests pass.

### Task 2: Add a Bounded NDJSON Trace Sink

**Files:**

- Modify: `src/lib/domain/daemon/Services/local-trace-artifact.ts`
- Modify: `test/unit/daemon/local-trace-artifact.test.ts`

**Step 1: Write failing sink tests**

Cover:

- creates `<configDir>/logs` recursively
- writes one JSON line per pushed record
- flushes buffered records on `flush`
- flushes buffered records on scoped finalizer/close
- rotates when `maxBytes` is exceeded and keeps only `maxFiles`
- serialization failure for one record does not poison later records
- oversized records are truncated or summarized before write

Use `@effect/platform` `FileSystem` where practical so tests can use an in-memory or temp filesystem. If rotation is materially simpler with Node `fs`, keep that implementation isolated and test with temp directories.

**Step 2: Run the focused test and confirm failure**

```bash
pnpm vitest run test/unit/daemon/local-trace-artifact.test.ts
```

Expected: sink exports not found.

**Step 3: Implement the sink**

Export:

- `TraceSinkOptions`
- `TraceSink`
- `makeTraceSink(options)`

Behavior:

- buffer NDJSON strings in memory
- flush every `batchWindowMs` while scoped
- flush when buffer length crosses a small threshold such as 32 records
- use `Effect.withTracerEnabled(false)` around sink internals so writing trace records does not recursively trace itself
- swallow write failures after preserving the current buffer where possible; diagnostics can go to Pino, but do not fail the daemon because tracing failed
- rotate `server.trace.ndjson` to `server.trace.ndjson.1`, then `.2`, up to `maxFiles - 1`

**Step 4: Run the focused test**

```bash
pnpm vitest run test/unit/daemon/local-trace-artifact.test.ts
```

Expected: sink tests pass.

### Task 3: Add the Local Effect Tracer

**Files:**

- Modify: `src/lib/domain/daemon/Services/local-trace-artifact.ts`
- Modify: `test/unit/daemon/local-trace-artifact.test.ts`

**Step 1: Write failing tracer tests**

Cover:

- a completed `Effect.withSpan("alpha")` writes one NDJSON record
- nested spans include parent-child correlation
- span attributes appear in `attributes`
- `Effect.logInfo` inside a span appears as a trace event when `Logger.tracerLogger` is installed
- failed effects write `exit._tag: "Failure"` with bounded cause
- interrupted effects write `exit._tag: "Interrupted"`
- tracer internals do not emit recursive trace records

**Step 2: Run focused test and confirm failure**

```bash
pnpm vitest run test/unit/daemon/local-trace-artifact.test.ts
```

Expected: local tracer exports not found.

**Step 3: Implement the tracer**

Export:

- `spanToTraceRecord(spanLike)`
- `makeLocalFileTracer(options)`
- `makeLocalTraceArtifactLive(options)`

Prefer an Effect `Tracer.Tracer` wrapper that delegates to the native tracer and pushes a record when `span.end(...)` is called. This keeps the artifact tied to completed spans rather than ad hoc log calls.

The layer should provide:

- `Tracer.Tracer`
- Effect log-to-span event wiring using the actual Effect logger API available in this repo

Be careful here: `PinoLoggerLive` already replaces the default logger through `Logger.replace`. Do not assume a pseudo-API such as `Logger.layer([...], { mergeWithExisting: true })` exists or composes correctly. First inspect the installed Effect logger API, then add a test that proves both of these are true in the same program:

- `Effect.logInfo` still reaches Pino
- the same log emitted inside `Effect.withSpan(...)` is also recorded as a trace event

If Pino logging and `Logger.tracerLogger` cannot be composed cleanly in one layer, keep the local file tracer as the default core deliverable, preserve Pino behavior, and document log-to-span events as a follow-up rather than breaking stdout/json logging.

**Step 4: Run focused tests**

```bash
pnpm vitest run test/unit/daemon/local-trace-artifact.test.ts
pnpm vitest run test/unit/daemon/pino-logger-layer.test.ts
```

Expected: local trace tests pass and Pino logger behavior remains intact.

### Task 4: Wire Local Tracing Into Daemon Foundation

**Files:**

- Modify: `src/lib/env.ts`
- Modify: `src/lib/domain/daemon/Layers/tracing.ts`
- Modify: `src/lib/domain/daemon/Layers/daemon-layers.ts`
- Modify: `test/unit/daemon/tracing.test.ts`
- Modify if needed: `test/unit/daemon/daemon-layers.test.ts`
- Modify if needed: `test/unit/daemon/full-layer-composition.test.ts`

**Step 1: Write failing wiring tests**

Add tests that prove:

- default trace config resolves to `<configDir>/logs/server.trace.ndjson`
- `CONDUIT_TRACE_ENABLED=0` disables the local file layer
- env overrides for file path, max bytes, max files, and batch window are parsed and bounded
- `makeDaemonLive` includes local trace artifact wiring by default
- disabling local tracing does not remove `PinoLoggerLive`

Avoid brittle tests that assert exact Layer internals. Prefer running a tiny Effect program through the composed layer and then checking the trace file exists.

**Step 2: Run focused tests and confirm failure**

```bash
pnpm vitest run test/unit/daemon/tracing.test.ts test/unit/daemon/daemon-layers.test.ts test/unit/daemon/full-layer-composition.test.ts
```

Expected: new wiring assertions fail.

**Step 3: Implement trace config parsing**

In `src/lib/env.ts`, add a typed trace config section. Validate numeric env vars defensively:

- invalid numbers fall back to defaults
- `maxBytes` has a minimum such as 64 KiB
- `maxFiles` has a minimum of 1 and reasonable maximum such as 100
- `batchWindowMs` has a minimum such as 10 ms

**Step 4: Compose the daemon tracing layer**

In `src/lib/domain/daemon/Layers/tracing.ts`, expose a daemon-facing factory such as:

```ts
export interface DaemonTracingConfig {
  enabled: boolean;
  traceFilePath: string;
  maxBytes: number;
  maxFiles: number;
  batchWindowMs: number;
  consoleExporter?: boolean;
  otlpEndpoint?: string;
}

export const makeDaemonTracingLive = (config: DaemonTracingConfig) =>
  Layer.mergeAll(
    makeLocalTraceArtifactLive(config),
    makeTracingLive({
      enabled: Boolean(config.consoleExporter || config.otlpEndpoint),
      consoleExporter: config.consoleExporter,
      otlpEndpoint: config.otlpEndpoint
    })
  );
```

The exact composition may differ if `Tracer.Tracer` and OpenTelemetry conflict. If they conflict, choose local artifact as the default and leave OTLP export as an explicit follow-up, because this priority is specifically the local artifact.

**Step 5: Add the layer to `makeDaemonLive`**

In `src/lib/domain/daemon/Layers/daemon-layers.ts`, add the local tracing layer in Tier 0 foundation near `PinoLoggerLive`, using the `configDir` supplied to `makeDaemonLive`.

**Step 6: Run focused tests**

```bash
pnpm vitest run test/unit/daemon/local-trace-artifact.test.ts
pnpm vitest run test/unit/daemon/tracing.test.ts
pnpm vitest run test/unit/daemon/pino-logger-layer.test.ts
pnpm vitest run test/unit/daemon/daemon-layers.test.ts
pnpm vitest run test/unit/daemon/full-layer-composition.test.ts
```

Expected: all pass.

### Follow-Up Task 5: Add Provider-Seam Trace Annotations Where the Schema Plan Needs Them

This task is intentionally outside the core local-trace artifact PR unless priority #1 has already landed. The local trace implementation must not guess provider decoder names, error classes, or adapter file shapes.

**Files:**

- Modify after priority #1 lands: `src/lib/provider/claude/claude-provider-instance.ts`
- Modify after priority #1 lands: `src/lib/instance/opencode-api.ts`
- Modify after priority #1 lands: `src/lib/instance/gap-endpoints.ts`
- Modify after priority #1 lands: `src/lib/domain/provider/Services/opencode-requests.ts`
- Modify tests added by the provider schema plan as needed

**Step 1: Inspect priority #1 implementation**

Before editing provider code, inspect the exact files changed by `docs/plans/2026-05-17-provider-contract-runtime-schemas.md`. Do not guess the final decoder names.

**Step 2: Add compact annotations at provider runtime seams**

Annotate active spans with stable labels, not raw data:

- `component: "provider-runtime"`
- `provider: "claude"` or `"opencode"`
- `source: "claude.sdk.message"`, `"opencode.sdk.response"`, etc.
- `operation: "sendTurn"`, `"sdk"`, `"gapEndpoint"`, or the concrete request name
- `schemaName`
- `sessionId` and `turnId` when already available

**Step 3: Add failure events/logs for decode failures**

On decode failure, emit bounded diagnostic details inside the active span:

- `issueCount`
- `firstIssue`
- `payloadShape`
- `source`
- `operation`

Do not include the raw provider payload or arbitrary nested provider-owned fields.

**Step 4: Run provider schema focused tests**

Use the exact acceptance proof from `docs/plans/2026-05-17-provider-contract-runtime-schemas.md`, especially the checks for bounded diagnostics and provider-owned payload opacity.

### Task 6: Add Operator Smoke Commands

**Files:**

- Modify if desired: `docs/agent-guide/testing.md`
- No code changes required if documentation is deferred.

**Step 1: Verify a local daemon writes spans**

Run a foreground daemon in a temporary config dir. Use the non-watch foreground CLI command so the smoke is deterministic:

```bash
tmpdir="$(mktemp -d)"
CONDUIT_CONFIG_DIR="$tmpdir" pnpm exec tsx src/bin/cli.ts --foreground --restart-daemon
```

In another shell, exercise a basic command or project load, then inspect:

```bash
test -f "$tmpdir/logs/server.trace.ndjson"
tail -n 5 "$tmpdir/logs/server.trace.ndjson"
jq -c 'select(.exit._tag != "Success") | { name, exit, attributes }' "$tmpdir/logs/server.trace.ndjson"
```

Expected:

- trace file exists by default
- records are valid JSON lines
- daemon startup/project/relay spans appear
- failed spans, if any, can be filtered by `exit._tag`

Do not add broad E2E requirements unless the implementation changes browser-visible behavior.

## Test/Verification Plan

Minimum focused gate:

```bash
pnpm vitest run test/unit/daemon/local-trace-artifact.test.ts
pnpm vitest run test/unit/daemon/tracing.test.ts
pnpm vitest run test/unit/daemon/pino-logger-layer.test.ts
pnpm vitest run test/unit/daemon/daemon-layers.test.ts
pnpm vitest run test/unit/daemon/full-layer-composition.test.ts
pnpm exec vitest run test/unit/effect/runtime-boundary-grep.test.ts
pnpm check
```

Default repo gate from `docs/agent-guide/testing.md`:

```bash
pnpm check
pnpm lint
pnpm test:unit
```

Manual smoke:

```bash
tmpdir="$(mktemp -d)"
CONDUIT_CONFIG_DIR="$tmpdir" pnpm exec tsx src/bin/cli.ts --foreground --restart-daemon
```

In another shell while the foreground daemon is running:

```bash
test -f "$tmpdir/logs/server.trace.ndjson"
jq -c '{ name, durationMs, exit, attributes }' "$tmpdir/logs/server.trace.ndjson" | tail
```

Core source greps:

```bash
if rg -n '@anthropic-ai|@opencode|SDKMessage|Claude|OpenCode' src/lib/domain/daemon/Services/local-trace-artifact.ts; then
  echo "local trace artifact must stay provider-SDK agnostic"
  exit 1
fi
rg -n 'withTracerEnabled\\(false\\)|MAX_TRACE_STRING_LENGTH|MAX_TRACE_DEPTH|MAX_TRACE_ARRAY_LENGTH|MAX_TRACE_OBJECT_KEYS|payloadShape|truncated|Circular' src/lib/domain/daemon/Services/local-trace-artifact.ts test/unit/daemon/local-trace-artifact.test.ts
rg -n 'Effect\\.logInfo|Effect\\.withSpan|PinoLoggerLive|tracerLogger' test/unit/daemon/local-trace-artifact.test.ts test/unit/daemon/pino-logger-layer.test.ts test/unit/daemon/tracing.test.ts
```

Expected:

- first grep has no matches; the generic trace artifact does not import or name provider SDKs
- second grep shows the bounding/recursion/shape-summary implementation and tests
- third grep shows composition coverage for spans, logs, Pino behavior, and trace events

Provider-schema integration proof after priority #1, only if Follow-Up Task 5 is implemented:

```bash
rg -n 'provider-runtime|claude\\.sdk\\.message|opencode\\.sdk|schemaName|payloadShape|issueCount' src/lib test/unit
rg -n 'raw provider payload|full provider payload|toolInput|toolResult' test/unit/contracts/providers test/unit/provider test/unit/instance
```

Expected:

- provider seam tests assert compact metadata exists
- tests guard against raw payload dumping
- local trace artifact tests prove the generic trace layer bounds attributes even if a caller passes a bad object

## Core Acceptance Criteria

- A normal daemon/foreground run writes completed Effect spans to `<configDir>/logs/server.trace.ndjson` by default.
- The trace file is NDJSON: one valid JSON object per completed span.
- The artifact includes span name, trace/span IDs, parent span ID when present, start/end times, duration, attributes, events, links if available, and exit status.
- Effect logs emitted inside active spans can appear as span events without suppressing existing Pino stdout/json logging.
- Trace writing is scoped, flushes on shutdown, and does not keep the process alive after daemon shutdown.
- Trace files rotate by size and retain a bounded number of files.
- Trace sink failures do not crash the daemon.
- Attribute/event serialization is bounded for strings, arrays, object keys, depth, cycles, and total record size.
- Provider-owned payloads are not dumped into trace records.
- Local tracing can be disabled with `CONDUIT_TRACE_ENABLED=0`.
- OTLP remains optional and is not required for local diagnostics.
- The default verification path and focused daemon tracing tests pass.

## Follow-Up Provider Integration Acceptance Criteria

Only apply this section if Follow-Up Task 5 is included after the provider contract runtime-schema work has landed.

- Provider schema decode failures record provider/source/operation/schema/issue summaries in the trace artifact.
- Decode-failure trace events include `issueCount`, `firstIssue`, and `payloadShape`.
- Decode-failure trace events do not include raw Claude SDK messages, raw OpenCode events, tool input, tool result content, structured output, or full response bodies.
- Provider source labels match the shared vocabulary in this plan and `docs/plans/2026-05-17-provider-runtime-event-contracts.md`.

## Acceptance Proof Matrix

| Criterion | Required proof |
|---|---|
| Default daemon writes `<configDir>/logs/server.trace.ndjson` | `pnpm vitest run test/unit/daemon/tracing.test.ts test/unit/daemon/daemon-layers.test.ts test/unit/daemon/full-layer-composition.test.ts` plus the foreground smoke command |
| NDJSON one-record-per-completed-span | `pnpm vitest run test/unit/daemon/local-trace-artifact.test.ts`; tests parse each line as JSON and assert one user span yields one trace record |
| Span timing, ids, parent ids, attributes, events, and exit status are recorded | focused tracer tests in `test/unit/daemon/local-trace-artifact.test.ts` |
| Pino logging is preserved while span events are recorded | focused logger/tracer composition test plus `pnpm vitest run test/unit/daemon/pino-logger-layer.test.ts` |
| Scoped flushing and no process hang | sink finalizer tests plus foreground smoke where `Ctrl-C` flushes the trace file |
| Rotation and retention are bounded | sink rotation tests in `test/unit/daemon/local-trace-artifact.test.ts` |
| Sink failures do not crash daemon code | sink failure test that injects a failing filesystem/write and then writes a later record |
| Serialization bounds and cycle handling hold | normalizer tests for strings, arrays, object keys, depth, cycles, and total record size |
| Provider-owned payloads are not dumped | adversarial normalizer tests plus `rg -n '@anthropic-ai|@opencode|SDKMessage|Claude|OpenCode' src/lib/domain/daemon/Services/local-trace-artifact.ts` returning no matches |
| Disable switch works | env parsing/wiring test for `CONDUIT_TRACE_ENABLED=0` and no trace file creation |
| OTLP remains optional | existing `test/unit/daemon/tracing.test.ts` no-exporter/no-op coverage remains green |
| Provider decode-failure summaries, if included | provider-schema focused tests plus the provider integration greps above |

## Risks

- **Tracer composition conflict:** The current OpenTelemetry layer and the new local `Tracer.Tracer` layer may both want to provide tracing. If both cannot be active cleanly, make the local file tracer the default and keep OTLP as explicit opt-in or a follow-up composer.
- **Logger replacement conflict:** `PinoLoggerLive` replaces the default Effect logger. Adding `Logger.tracerLogger` must not remove Pino output. Prove this with tests before wiring into the daemon foundation.
- **Payload leakage:** Span annotations are easy to misuse. The normalizer must bound data defensively, and provider seam tests should assert that raw SDK/provider payloads are not serialized.
- **Recursive tracing:** Sink writes can create spans/logs if implemented through traced effects. Wrap sink internals with `Effect.withTracerEnabled(false)` and test that one user span produces one trace record.
- **I/O overhead:** JSON serialization and file writes happen on every completed span. Use buffering, a short flush window, bounded records, and rotation.
- **Shutdown loss:** Buffered records can be lost if finalizers are not scoped correctly. Add close/finalizer tests and smoke test daemon shutdown.
- **Noisy artifact:** Existing spans may be too broad or too chatty. Do not solve span taxonomy in this slice; add only the artifact and provider seam metadata needed for decode failures.

## Rollout Order

1. Implement pure trace record normalization first. This catches payload leakage and bounding mistakes before any daemon wiring.
2. Implement the NDJSON sink with rotation and scoped flushing.
3. Implement the local Effect tracer and prove logs-inside-spans become events while Pino still receives logs.
4. Wire local tracing into daemon foundation with default `<configDir>/logs/server.trace.ndjson`.
5. Run the focused daemon tracing gate, core source greps, foreground smoke, and the default `pnpm check` gate.
6. Stop the core PR here unless provider contract runtime schemas have already landed.
7. After priority #1 lands, add provider seam annotations and decode failure events using the provider schema plan's decoder names and error types.
8. Run the provider schema acceptance proof plus local trace smoke commands.
9. Only after the local artifact is stable, revisit OTLP composition if the current `makeTracingLive` layer cannot coexist cleanly.
