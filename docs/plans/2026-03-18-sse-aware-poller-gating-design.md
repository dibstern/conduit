# SSE-Aware Monitoring Reducer Design

**Date:** 2026-03-18
**Status:** Draft — design approved, pending implementation plan

## Problem

`MessagePollerManager` enforces `MAX_CONCURRENT_POLLERS = 10` (`message-poller-manager.ts:21`). When a parent session spawns 10+ subagents, the cap is hit, a `POLLER_CAPACITY` error is broadcast to all browser clients, and excess sessions are silently skipped.

The message poller is a **REST fallback** for when SSE doesn't deliver events. Since subagent sessions originate from within the relay, SSE already covers them — the poller is redundant. The cap should not apply to sessions that don't need a poller.

## Approach: Monitoring as a Reducer

Replace the hard numeric cap and scattered event handler state with a **single pure reducer** that tracks per-session monitoring phases and produces all monitoring effects as data. The reducer owns both **poller lifecycle** (start/stop REST pollers) and **session lifecycle** (processing status, done events, push notifications).

1. Each session has a **monitoring phase** — a discriminated union where invalid states are unrepresentable.
2. Every 500ms (the existing status poll cycle), an **evaluation context** is assembled from data sources (status poller, SSE tracker, viewer registry).
3. A **pure transition function** takes `(current phase, context) → (new phase, effects[])`.
4. An **effect executor** applies the returned effects.

This gives us:
- **Invalid states are unrepresentable.** You cannot represent "polling but idle" or "SSE-covered with no SSE data" — those combinations don't exist in the union.
- **Every transition is explicit.** The transition function is the single place where phases change. TypeScript exhaustiveness checking catches missed cases.
- **Testable as a truth table.** The entire monitoring logic is: "given this phase and this context, produce this new phase and these effects." Pure data in, data out.
- **No scattered mutation.** Today, `relay-stack.ts` mutates `pollerManager`, `statusPoller.messageActivityTimestamps`, `sseIdleSessions`, and `overrides` across ~200 lines across three separate event handlers (`changed`, `became_busy`, `became_idle`). With the reducer, all of that collapses to a single `evaluateAll()` call with effects applied in one place.
- **No duplicate done events.** Today, both `became_idle` and `pollerManager.emitDone()` produce done events for the same transition. The reducer produces exactly one `notify-idle` effect per idle transition.

## Design Principles

1. **Signal → Decision → Effect.** Immutable input signals are collected, a pure function produces tagged decisions, a separate effectful layer applies them.
2. **Discriminated unions everywhere.** Phases, effects, SSE coverage, and reasons are all tagged unions with literal discriminants.
3. **Pure functions, no `this`.** Decision logic is free functions over readonly data.
4. **Const-derived types.** Reason literals are derived from `as const` arrays, so the runtime set and the type stay in sync.
5. **Single reducer for all monitoring.** Poller lifecycle (start/stop) and session lifecycle (processing/done/push/notification) are produced by the same transition function. This eliminates coordination bugs between the previously separate `computeStatusTransitions`, `computePollerDecisions`, `became_busy`, and `became_idle` handlers.

---

## Section 1: Session Monitoring Phases

The per-session monitoring phase is a discriminated union on `phase`. Each variant carries exactly the data relevant to that phase — no more, no less.

```typescript
type SessionMonitorPhase =
  | { readonly phase: "idle" }
  | { readonly phase: "busy-grace";       readonly busySince: number }
  | { readonly phase: "busy-sse-covered"; readonly busySince: number; readonly lastSSEAt: number }
  | { readonly phase: "busy-polling";     readonly busySince: number; readonly pollerStartedAt: number }
  | { readonly phase: "busy-capped";      readonly busySince: number; readonly cappedAt: number };
```

### Phase Descriptions

| Phase | Meaning | Poller? | How we got here |
|-------|---------|---------|-----------------|
| `idle` | Session is not busy. No monitoring needed. | No | Status became idle, or initial state. |
| `busy-grace` | Session just became busy. Waiting for SSE to deliver the first event before falling back to a poller. | No | Status became busy, no SSE evidence yet. |
| `busy-sse-covered` | Session is busy and SSE is actively delivering events. No poller needed. | No | SSE event arrived during grace, or SSE was already active when session became busy. |
| `busy-polling` | Session is busy and SSE is not covering it. REST poller is active. | **Yes** | Grace expired without SSE, or SSE went stale/disconnected. |
| `busy-capped` | Session needs a poller but the safety cap prevented it. | No | Safety cap full when `evaluateAll` tried to start a poller. |

### What's Unrepresentable

- "Polling but idle" — impossible, `busy-polling` requires busy status.
- "SSE-covered with no SSE data" — impossible, `busy-sse-covered` requires `lastSSEAt`.
- "Grace period with SSE active" — the transition function moves to `busy-sse-covered` immediately when SSE arrives.
- "Polling when SSE is active" — the transition function moves to `busy-sse-covered` when SSE resumes.
- "Capped but cap has room" — `evaluateAll` promotes `busy-capped` to `busy-polling` when room opens.

---

## Section 2: SSE Coverage

### Per-Session SSE Tracking

A new lightweight component: `SessionSSETracker`. It's a `Map<string, number>` recording the last SSE event timestamp per session ID, populated by the existing `sseConsumer.on("event")` wiring.

```typescript
interface SessionSSETracker {
  /** Record an SSE event for a session. Called from the existing
   *  sseConsumer.on("event") handler in relay-stack.ts. */
  recordEvent(sessionId: string, now: number): void;

  /** Get the last SSE event timestamp for a session (undefined if never seen). */
  getLastEventAt(sessionId: string): number | undefined;

  /** Remove tracking for a deleted session. */
  remove(sessionId: string): void;
}
```

Implementation: a plain `Map<string, number>` behind this interface. No class needed — a closure factory matching the existing `createHealthTracker` pattern.

### SSE Coverage Type

```typescript
type SSECoverage =
  | { readonly kind: "active";       readonly lastEventAt: number }
  | { readonly kind: "stale";        readonly lastEventAt: number }
  | { readonly kind: "never-seen" }
  | { readonly kind: "disconnected" };
```

Derived from two existing sources via a pure function:

```typescript
function deriveSSECoverage(
  globalConnected: boolean,
  lastSessionEventAt: number | undefined,
  now: number,
  activeThresholdMs: number,
): SSECoverage {
  if (!globalConnected)                return { kind: "disconnected" };
  if (lastSessionEventAt === undefined) return { kind: "never-seen" };
  if (now - lastSessionEventAt < activeThresholdMs)
    return { kind: "active", lastEventAt: lastSessionEventAt };
  return { kind: "stale", lastEventAt: lastSessionEventAt };
}
```

- **`globalConnected`**: from `SSEConsumer.getHealth().connected`.
- **`lastSessionEventAt`**: from `SessionSSETracker.getLastEventAt(sessionId)`.
- **`activeThresholdMs`**: configurable, default 5000ms.

---

## Section 3: Evaluation Context

On each status poll cycle (every 500ms), we assemble a context for each session from existing data sources. This is the input to the transition function.

```typescript
interface SessionEvalContext {
  readonly now: number;
  readonly status: SessionStatus;
  readonly sseConnected: boolean;
  readonly lastSSEEventAt: number | undefined;
  readonly isSubagent: boolean;
  readonly hasViewers: boolean;
}
```

Assembly (pure function):

```typescript
function assembleContext(
  sessionId: string,
  status: SessionStatus,
  sseHealth: { connected: boolean },
  sseTracker: SessionSSETracker,
  parentMap: ReadonlyMap<string, string>,
  hasViewers: (sessionId: string) => boolean,
  now: number,
): SessionEvalContext {
  return {
    now,
    status,
    sseConnected: sseHealth.connected,
    lastSSEEventAt: sseTracker.getLastEventAt(sessionId),
    isSubagent: parentMap.has(sessionId),
    hasViewers: hasViewers(sessionId),
  };
}
```

No new data sources — everything comes from components that already exist.

---

## Section 4: Effects

The transition function returns effects as data. Each effect is a discriminated union variant.

```typescript
const POLLER_START_REASONS = [
  "sse-disconnected",
  "sse-stale",
  "no-sse-history",
  "sse-grace-expired",
] as const;
type PollerStartReason = (typeof POLLER_START_REASONS)[number];

const POLLER_STOP_REASONS = [
  "idle-no-viewers",
  "idle-has-viewers",
  "sse-now-covering",
  "session-deleted",
] as const;
type PollerStopReason = (typeof POLLER_STOP_REASONS)[number];

type MonitoringEffect =
  | { readonly effect: "start-poller";  readonly sessionId: string; readonly reason: PollerStartReason }
  | { readonly effect: "stop-poller";   readonly sessionId: string; readonly reason: PollerStopReason }
  | { readonly effect: "notify-busy";   readonly sessionId: string }
  | { readonly effect: "notify-idle";   readonly sessionId: string; readonly isSubagent: boolean };
```

### Effect Descriptions

| Effect | What the executor does |
|--------|----------------------|
| `start-poller` | Fetches seed messages via `client.getMessages()`, calls `pollerManager.startPolling()`. |
| `stop-poller` | Calls `pollerManager.stopPolling()`, `statusPoller.clearMessageActivity()`, `overrides.clearProcessingTimeout()`. |
| `notify-busy` | Sends `{ type: "status", status: "processing" }` to all WebSocket clients viewing the session. |
| `notify-idle` | Creates `{ type: "done", code: 0 }`, runs through `processEvent` + `applyPipelineResult` (handles caching, routing, timeout clearing). If `!isSubagent`: fires push notification. If `!isSubagent` AND pipeline route was `"drop"` (no viewers): broadcasts cross-session `notification_event`. |

### Why `clear-activity` is not a standalone effect

`messageActivityTimestamps` is only populated by `markMessageActivity`, which is only called from the `pollerManager.on("events")` handler. If no poller was running (`busy-grace` or `busy-sse-covered`), no activity was ever marked — clearing is a no-op. If a poller was running (`busy-polling`), the `stop-poller` executor already clears activity. There is no case where a standalone `clear-activity` effect is needed.

### Why `emit-done` is not a poller effect

The current code has `pollerManager.emitDone()` which synthesizes a done event from the message poller, duplicating the done event from `became_idle`. With the reducer, `notify-idle` is the single source of done events. No duplicates.

---

## Section 5: Transition Function

### Per-Session Evaluation (pure)

```typescript
function evaluateSession(
  sessionId: string,
  current: SessionMonitorPhase,
  ctx: SessionEvalContext,
  config: Readonly<PollerGatingConfig>,
): { readonly phase: SessionMonitorPhase; readonly effects: readonly MonitoringEffect[] }
```

### Configuration

```typescript
interface PollerGatingConfig {
  /** How recently SSE must have delivered an event to be "active" (default: 5000ms). */
  readonly sseActiveThresholdMs: number;
  /** How long to wait for SSE before falling back to a poller (default: 3000ms). */
  readonly sseGracePeriodMs: number;
  /** Hard safety cap — circuit breaker, not a design constraint (default: 50). */
  readonly maxPollers: number;
}
```

### Full Transition Table

The function internally derives `sseCoverage` via `deriveSSECoverage(ctx.sseConnected, ctx.lastSSEEventAt, ctx.now, config.sseActiveThresholdMs)`, then branches on `(current.phase, isBusy, sseCoverage.kind)`.

Helper: `isBusy = ctx.status.type === "busy" || ctx.status.type === "retry"`.

#### From `idle`

| Condition | New Phase | Effects | Rationale |
|-----------|-----------|---------|-----------|
| Status idle | `idle` | — | No change. |
| Status busy, SSE active | `busy-sse-covered` | `notify-busy` | SSE evidence already exists, skip grace. |
| Status busy, SSE not active | `busy-grace` | `notify-busy` | Start grace period, wait for SSE. |

#### From `busy-grace`

| Condition | New Phase | Effects | Rationale |
|-----------|-----------|---------|-----------|
| Status idle | `idle` | `notify-idle` | Session done. No poller was started, nothing to stop. |
| SSE active | `busy-sse-covered` | — | SSE arrived during grace. No poller needed. |
| Grace expired, SSE disconnected | `busy-polling` | `start-poller(sse-disconnected)` | SSE is down, must fall back to REST. |
| Grace expired, SSE never-seen | `busy-polling` | `start-poller(no-sse-history)` | Grace elapsed, no SSE history at all. Fall back. |
| Grace expired, SSE stale | `busy-polling` | `start-poller(sse-grace-expired)` | Grace elapsed, SSE was seen before but stopped. Fall back. |
| Grace not expired, SSE not active | `busy-grace` | — | Still waiting. |

"Grace expired" means `ctx.now - current.busySince > config.sseGracePeriodMs`.

#### From `busy-sse-covered`

| Condition | New Phase | Effects | Rationale |
|-----------|-----------|---------|-----------|
| Status idle | `idle` | `notify-idle` | Session done. No poller to stop. |
| SSE disconnected | `busy-polling` | `start-poller(sse-disconnected)` | SSE went down, need fallback. |
| SSE stale | `busy-polling` | `start-poller(sse-stale)` | SSE went silent for this session. |
| SSE active | `busy-sse-covered` | — | Update `lastSSEAt` to latest. |

#### From `busy-polling`

| Condition | New Phase | Effects | Rationale |
|-----------|-----------|---------|-----------|
| Status idle | `idle` | `stop-poller(idle-has-viewers)` or `stop-poller(idle-no-viewers)`, `notify-idle` | Session done. Stop poller, notify. Reason varies by viewer state for logging. |
| SSE active and connected | `busy-sse-covered` | `stop-poller(sse-now-covering)` | SSE resumed, poller no longer needed. |
| Still busy, SSE not active | `busy-polling` | — | Keep polling. |

#### From `busy-capped`

| Condition | New Phase | Effects | Rationale |
|-----------|-----------|---------|-----------|
| Status idle | `idle` | `notify-idle` | Session done. No poller was running, nothing to stop. |
| SSE active | `busy-sse-covered` | — | SSE saves us — no poller needed after all. |
| Still busy, cap has room (checked in `evaluateAll`) | `busy-polling` | `start-poller` | Room opened up, start the poller now. |
| Still busy, cap full | `busy-capped` | — | Stay capped, retry next cycle. |

Note: `busy-capped` transitions for cap room are handled in `evaluateAll` post-processing, not in `evaluateSession`. `evaluateSession` handles idle and SSE-active transitions; if still busy with no SSE, it returns `busy-capped` unchanged. `evaluateAll` then checks for cap room and promotes to `busy-polling`.

### Exhaustiveness

The transition function uses a `switch` on `current.phase` with a `default: never` exhaustiveness check. Within each phase, the `isBusy` and `sseCoverage.kind` checks are structured so TypeScript catches unhandled combinations at compile time.

---

## Section 6: Batch Evaluation and Global State

### Global Monitoring State

```typescript
interface MonitoringState {
  readonly sessions: ReadonlyMap<string, SessionMonitorPhase>;
}
```

### Batch Evaluation (pure)

```typescript
function evaluateAll(
  state: MonitoringState,
  contexts: ReadonlyMap<string, SessionEvalContext>,
  config: Readonly<PollerGatingConfig>,
): { readonly state: MonitoringState; readonly effects: readonly MonitoringEffect[] }
```

Logic:
1. For each session in `contexts`: look up current phase (default `idle`), call `evaluateSession`, collect new phase + effects.
2. For each session in `state.sessions` that is NOT in `contexts` (deleted): if it was in ANY busy phase (`busy-polling`, `busy-grace`, `busy-sse-covered`, `busy-capped`), emit `notify-idle`. If it was `busy-polling`, also emit `stop-poller(session-deleted)`.
3. **Promote `busy-capped` sessions:** for sessions currently in `busy-capped` that stayed `busy-capped` after `evaluateSession`, check if cap has room. If so, emit `start-poller` and transition to `busy-polling`.
4. **Safety cap post-processing:** Count sessions that were `busy-polling` in the PREVIOUS state AND remain `busy-polling` in the new state. Count new `start-poller` effects. Total = existing + new. If > `config.maxPollers`, drop excess new `start-poller` effects. When dropping, set the session phase to `busy-capped` (preserving original `busySince`, setting `cappedAt: ctx.now`). This is a circuit breaker, not a design constraint — under normal operation it should never trigger.
5. Return new `MonitoringState` + collected effects.

### State Initialization

```typescript
function initialMonitoringState(): MonitoringState {
  return { sessions: new Map() };
}
```

All sessions start as `idle` (via the default in `evaluateAll` step 1).

---

## Section 7: Integration with Existing Code

### What Changes

| Component | Before | After |
|-----------|--------|-------|
| `status-transitions.ts` | Exports `computeStatusTransitions`, `computePollerDecisions` | Exports `evaluateSession`, `evaluateAll`, `deriveSSECoverage`, `assembleContext`, and all phase/effect/config types. `computeStatusTransitions`, `StatusTransitions`, `computePollerDecisions`, and `PollerDecision` are deleted. |
| `relay-stack.ts` `changed` handler | Calls `computePollerDecisions`, imperatively starts/stops pollers | Calls `evaluateAll`, then `applyMonitoringEffects`. |
| `relay-stack.ts` `became_busy` handler | Sends `{ type: "status", status: "processing" }` to session viewers | **Deleted.** The `notify-busy` effect from the reducer replaces it. |
| `relay-stack.ts` `became_idle` handler | Creates done event, runs pipeline, fires push/notification | **Deleted.** The `notify-idle` effect from the reducer replaces it. |
| `relay-stack.ts` state | No monitoring state | Holds a `MonitoringState` variable, updated on each poll cycle. |
| `relay-stack.ts` SSE→poller wiring (lines 682-688) | `pollerManager.notifySSEEvent(sid)` | Also calls `sseTracker.recordEvent(sid, Date.now())`. The `notifySSEEvent` call remains — it's an optimization within the poller (suppresses REST calls while SSE is flowing), orthogonal to the reducer's phase transitions. |
| `relay-stack.ts` `session_lifecycle` handler (lines 364-387) | Calls `pollerManager.startPolling` on create, `stopPolling` on delete | On create: no immediate poller start — the reducer will handle it on the next poll cycle (≤500ms). On delete: calls `sseTracker.remove(sid)`, and the deleted session will be cleaned up by `evaluateAll` on the next cycle (emitting `notify-idle` for any busy phase, plus `stop-poller` if it was `busy-polling`). |
| `MessagePollerManager` | Enforces `MAX_CONCURRENT_POLLERS`, emits `capacity_exceeded` | Becomes a **dumb executor**: starts/stops pollers on command, no cap enforcement, no `capacity_exceeded` event. The `startPolling` method always succeeds. |
| `MessagePoller.emitDone` | Called by `pollerManager.emitDone()` from relay-stack | **Removed.** `notify-idle` is the single source of done events. |
| `SessionStatusPoller` | Emits `changed`, `became_busy`, `became_idle`; maintains `previousBusy`; `augmentStatuses` has interleaved async + mutation | Emits **only `changed`**, and emits it on **every poll cycle** (not just when statuses differ). This ensures the reducer is called every 500ms for grace period expiry. `became_busy`/`became_idle` events removed. `previousBusy` field removed. `computeStatusTransitions` call removed from `poll()`. `augmentStatuses` refactored into pure `computeAugmentedStatuses` + async pre-pass + effectful post-pass (Section 9). |
| `PendingUserMessages` | Only `consume()` (atomic check + remove) | Adds read-only `has()` method for pure pre-filter classification. `consume()` stays for effectful removal. |
| `relay-stack.ts` poller event handler | Inline activity marking, echo suppression, notification conditions (~75 lines) | Calls `classifyPollerBatch` (pure pre-filter) + `resolveNotifications` (shared notification policy). See Section 10. |

### Effect Executor

```typescript
function applyMonitoringEffects(
  effects: readonly MonitoringEffect[],
  deps: MonitoringEffectDeps,
): void
```

Where `MonitoringEffectDeps` uses `Pick<>` for testability:

```typescript
interface MonitoringEffectDeps {
  pollerManager: Pick<MessagePollerManager, "startPolling" | "stopPolling">;
  statusPoller: Pick<SessionStatusPoller, "clearMessageActivity">;
  overrides: Pick<SessionOverrides, "clearProcessingTimeout">;
  client: Pick<OpenCodeClient, "getMessages">;
  wsHandler: Pick<WebSocketHandler, "sendToSession" | "broadcast" | "getClientsForSession">;
  pushManager?: Pick<PushNotificationManager, "sendToAll">;
  sendPushForEvent: (pushManager: PushNotificationManager, msg: RelayMessage, log: Logger) => void;
  processEvent: typeof processEvent;
  applyPipelineResult: typeof applyPipelineResult;
  pipelineDeps: PipelineDeps;
  log: Logger;
}
```

The executor is a `switch` on `effect.effect`:

- **`start-poller`**: `client.getMessages(sessionId).then(msgs => pollerManager.startPolling(sessionId, msgs)).catch(err => log.warn(...))`
- **`stop-poller`**: `pollerManager.stopPolling(sessionId)` + `statusPoller.clearMessageActivity(sessionId)` + `overrides.clearProcessingTimeout(sessionId)`
- **`notify-busy`**: `wsHandler.sendToSession(sessionId, { type: "status", status: "processing" })`
- **`notify-idle`**:
  1. Create `{ type: "done", code: 0 }`, run through `processEvent` + `applyPipelineResult` (caching, routing, timeout clearing).
  2. Call `resolveNotifications(doneMsg, route, effect.isSubagent)` — only `done` events from subagents are suppressed; subagent errors still fire push.
  3. If `sendPush`: fire push notification via `sendPushForEvent(pushManager, msg, log)`.
  4. If `broadcastCrossSession` AND pipeline route was `"drop"`: broadcast `{ type: "notification_event", eventType: "done" }` to all clients.

### Updated Wiring in relay-stack.ts (pseudocode)

```typescript
// ── New state ────────────────────────────────────────────────────────────
let monitoringState = initialMonitoringState();
const sseTracker = createSessionSSETracker();

// ── SSE event → track per-session timestamps ─────────────────────────────
sseConsumer.on("event", (event) => {
  const sid = extractSessionId(event);
  if (sid) {
    sseTracker.recordEvent(sid, Date.now());
    pollerManager.notifySSEEvent(sid);   // keep: within-poller REST suppression
  }
});

// ── Session lifecycle → SSE tracker cleanup ──────────────────────────────
sessionMgr.on("session_lifecycle", async (ev) => {
  translator.reset(ev.sessionId);
  if (ev.type === "created") {
    // Rebuild translator history (unchanged)
    await rebuildTranslatorFromHistory(translator, (id) => client.getMessages(id), ev.sessionId, sessionLog);
    // No immediate poller start — reducer handles it on next poll cycle
  } else {
    // Deleted
    sseTracker.remove(ev.sessionId);
    // Reducer will clean up on next evaluateAll cycle
  }
});

// ── Status poller → single reducer → apply effects ──────────────────────
statusPoller.on("changed", async (statuses) => {
  // Session list broadcast (unchanged)
  await sessionMgr.sendDualSessionLists((msg) => wsHandler.broadcast(msg), { statuses });

  // Assemble contexts
  const sseHealth = sseConsumer.getHealth();
  const parentMap = sessionMgr.getSessionParentMap();
  const now = Date.now();
  const contexts = new Map<string, SessionEvalContext>();
  for (const [sessionId, status] of Object.entries(statuses)) {
    if (status) {
      contexts.set(sessionId, assembleContext(
        sessionId, status, sseHealth, sseTracker,
        parentMap, (sid) => registry.hasViewers(sid), now,
      ));
    }
  }

  // Evaluate — pure function, returns new state + effects as data
  const result = evaluateAll(monitoringState, contexts, pollerGatingConfig);
  monitoringState = result.state;

  // Apply effects
  applyMonitoringEffects(result.effects, effectDeps);
});

// ── No more statusPoller.on("became_busy") handler ───────────────────────
// ── No more statusPoller.on("became_idle") handler ───────────────────────
// Both are replaced by notify-busy / notify-idle effects from the reducer.

// ── Config and deps construction ─────────────────────────────────────────
const pollerGatingConfig: PollerGatingConfig = DEFAULT_POLLER_GATING_CONFIG;
const effectDeps: MonitoringEffectDeps = {
  pollerManager, statusPoller, overrides, client, wsHandler,
  pushManager, sendPushForEvent, processEvent, applyPipelineResult,
  pipelineDeps, log: sessionLog,
};

// ── Message poller events (refactored — see Section 10) ──────────────────
pollerManager.on("events", (events, sessionId) => {
  const isSubagent = sessionMgr.getSessionParentMap().has(sessionId);
  const { hasContentActivity } = classifyPollerBatch(events);

  if (hasContentActivity) {
    statusPoller.markMessageActivity(sessionId);
  }

  for (const msg of events) {
    if (pendingUserMessages.consume(sessionId, msg)) {
      continue; // relay echo — skip pipeline processing
    }
    const viewers = wsHandler.getClientsForSession(sessionId);
    const result = processEvent(msg, sessionId, viewers, "message-poller");
    applyPipelineResult(result, sessionId, pipelineDeps);

    // Shared notification policy (same logic as notify-idle executor)
    const notify = resolveNotifications(msg, result.route, isSubagent);
    if (notify.sendPush && pushManager) sendPushForEvent(pushManager, msg, log);
    if (notify.broadcastCrossSession && notify.crossSessionPayload) {
      wsHandler.broadcast(notify.crossSessionPayload);
    }
  }
});
```

---

## Section 8: Testing Strategy

### Unit Tests for `evaluateSession` (table-driven)

Every row in the transition table (Section 5) becomes a test case. Each test is a single assertion on the return value of a pure function — no mocking, no timers, no async.

```typescript
const cases: Array<{
  name: string;
  current: SessionMonitorPhase;
  ctx: SessionEvalContext;
  expectedPhase: SessionMonitorPhase;
  expectedEffects: MonitoringEffect[];
}> = [
  // ── idle transitions ──────────────────────────────────────────────────
  {
    name: "idle + idle status → idle, no effects",
    current: { phase: "idle" },
    ctx: { now: 1000, status: { type: "idle" }, sseConnected: true,
           lastSSEEventAt: undefined, isSubagent: false, hasViewers: false },
    expectedPhase: { phase: "idle" },
    expectedEffects: [],
  },
  {
    name: "idle + busy + SSE active → busy-sse-covered + notify-busy",
    current: { phase: "idle" },
    ctx: { now: 1000, status: { type: "busy" }, sseConnected: true,
           lastSSEEventAt: 900, isSubagent: false, hasViewers: false },
    expectedPhase: { phase: "busy-sse-covered", busySince: 1000, lastSSEAt: 900 },
    expectedEffects: [{ effect: "notify-busy", sessionId: "s1" }],
  },
  {
    name: "idle + busy + no SSE → busy-grace + notify-busy",
    current: { phase: "idle" },
    ctx: { now: 1000, status: { type: "busy" }, sseConnected: true,
           lastSSEEventAt: undefined, isSubagent: false, hasViewers: false },
    expectedPhase: { phase: "busy-grace", busySince: 1000 },
    expectedEffects: [{ effect: "notify-busy", sessionId: "s1" }],
  },
  // ── busy-grace transitions ────────────────────────────────────────────
  {
    name: "busy-grace + idle → idle + notify-idle",
    current: { phase: "busy-grace", busySince: 0 },
    ctx: { now: 1000, status: { type: "idle" }, sseConnected: true,
           lastSSEEventAt: undefined, isSubagent: false, hasViewers: false },
    expectedPhase: { phase: "idle" },
    expectedEffects: [{ effect: "notify-idle", sessionId: "s1", isSubagent: false }],
  },
  {
    name: "busy-grace + SSE arrives → busy-sse-covered, no effects",
    current: { phase: "busy-grace", busySince: 0 },
    ctx: { now: 1000, status: { type: "busy" }, sseConnected: true,
           lastSSEEventAt: 800, isSubagent: false, hasViewers: false },
    expectedPhase: { phase: "busy-sse-covered", busySince: 0, lastSSEAt: 800 },
    expectedEffects: [],
  },
  {
    name: "busy-grace + grace expired + no SSE → busy-polling + start-poller",
    current: { phase: "busy-grace", busySince: 0 },
    ctx: { now: 5000, status: { type: "busy" }, sseConnected: true,
           lastSSEEventAt: undefined, isSubagent: false, hasViewers: false },
    expectedPhase: { phase: "busy-polling", busySince: 0, pollerStartedAt: 5000 },
    expectedEffects: [{ effect: "start-poller", sessionId: "s1", reason: "sse-grace-expired" }],
  },
  // ── busy-polling transitions ──────────────────────────────────────────
  {
    name: "busy-polling + idle → idle + stop-poller + notify-idle",
    current: { phase: "busy-polling", busySince: 0, pollerStartedAt: 100 },
    ctx: { now: 5000, status: { type: "idle" }, sseConnected: true,
           lastSSEEventAt: undefined, isSubagent: false, hasViewers: false },
    expectedPhase: { phase: "idle" },
    expectedEffects: [
      { effect: "stop-poller", sessionId: "s1", reason: "idle-no-viewers" },
      { effect: "notify-idle", sessionId: "s1", isSubagent: false },
    ],
  },
  {
    name: "busy-polling + SSE resumes → busy-sse-covered + stop-poller",
    current: { phase: "busy-polling", busySince: 0, pollerStartedAt: 100 },
    ctx: { now: 5000, status: { type: "busy" }, sseConnected: true,
           lastSSEEventAt: 4900, isSubagent: false, hasViewers: false },
    expectedPhase: { phase: "busy-sse-covered", busySince: 0, lastSSEAt: 4900 },
    expectedEffects: [{ effect: "stop-poller", sessionId: "s1", reason: "sse-now-covering" }],
  },
  // ... one test per transition table row
];
```

### Unit Tests for `evaluateAll`

- **Session appearance:** new session in contexts but not in state → starts as `idle`, evaluate normally.
- **Session disappearance:** session in state but not in contexts → if `busy-polling`, emit `stop-poller(session-deleted)`.
- **Safety cap:** `start-poller` effects exceeding `maxPollers` → excess dropped by priority, warning logged.
- **Steady state:** no transitions → no effects, state unchanged.
- **Mixed transitions:** multiple sessions transitioning simultaneously → effects for each, in deterministic order.

### Unit Tests for `deriveSSECoverage`

- Four cases matching the four `SSECoverage` variants.
- Boundary tests at `activeThresholdMs` exactly.

### Unit Tests for `assembleContext`

- Verify all fields are correctly plumbed from data sources.
- Verify `isSubagent` correctly reflects `parentMap.has(sessionId)`.

### Unit Tests for `computeAugmentedStatuses` (table-driven)

- Subagent propagation: busy child with resolved parent → parent injected as busy.
- Subagent propagation: parent already busy in raw → no double injection.
- Activity injection: fresh timestamp, session not in raw → busy injected.
- Activity injection: expired timestamp → listed in `expiredActivitySessions`, not injected.
- Activity injection: session already in raw → not overwritten.
- SSE idle clearing: busy session in `sseIdleSessions` → listed in `sseIdleClears`.
- Empty inputs → empty result.

### Unit Tests for `resolveNotifications` (table-driven)

- `done` + not subagent + route `"send"` → push yes, broadcast no.
- `done` + not subagent + route `"drop"` → push yes, broadcast yes.
- `done` + subagent + any route → push no, broadcast no.
- `error` + not subagent + route `"drop"` → push yes, broadcast yes with message.
- Non-notifiable type (e.g. `delta`) → push no, broadcast no.

### Unit Tests for `classifyPollerBatch`

- Content-only batch → `hasContentActivity: true`, all events in `eventsToProcess`.
- Result/done-only batch → `hasContentActivity: false`.
- Mixed batch → `hasContentActivity: true`.
- Batch with relay echo → echo removed from `eventsToProcess`, `suppressedCount: 1`.
- Empty batch → `hasContentActivity: false`, empty `eventsToProcess`.

### Integration Tests

- Wire the reducer into a test relay stack with a mock OpenCode server.
- Verify that when 15 subagent sessions start (SSE flowing), zero pollers are created.
- Verify that when SSE disconnects, pollers are created for busy sessions.
- Verify that when SSE reconnects, pollers are stopped.
- Verify the safety cap triggers at `maxPollers`.
- Verify `notify-busy` sends processing status to viewers.
- Verify `notify-idle` sends done through pipeline + push + cross-session notification.
- Verify no duplicate done events (previously `emitDone` + `became_idle` produced two).
- Verify pure status augmentation produces identical results to the old `augmentStatuses`.
- Verify notification behavior is identical between `notify-idle` executor and poller event handler.

---

## Section 9: Pure Status Augmentation

### Problem

`SessionStatusPoller.augmentStatuses()` (`session-status-poller.ts:280-350`) is nominally a computation — it takes raw statuses and returns augmented ones. But it mutates three pieces of instance state during the computation:

1. **`sseIdleSessions`** (line 296): Deletes entries for sessions that are busy in raw statuses.
2. **`childToParentCache`** (lines 312, 321): Writes new entries when the API slow path discovers parent relationships. This includes an **`await`** (line 310), which yields control and allows concurrent mutation of the same maps by `markMessageActivity` and `notifySSEIdle`.
3. **`messageActivityTimestamps`** (line 340): Deletes expired entries during the time-decay sweep.

The `await` inside the computation is the most concerning: between the API call and the cache write, other code paths can mutate `messageActivityTimestamps` and `sseIdleSessions`. The `polling` guard prevents overlapping `poll()` calls, but `markMessageActivity` and `notifySSEIdle` are called from SSE/poller event handlers that run independently.

### Design

Separate the computation into three phases: **resolve**, **compute**, **apply**.

#### Phase 1: Resolve Unknown Parents (async, pre-computation)

```typescript
async function resolveUnknownParents(
  busySessionIds: readonly string[],
  parentMap: ReadonlyMap<string, string>,
  cache: ReadonlyMap<string, string | undefined>,
  client: Pick<OpenCodeClient, "getSession">,
  log: Logger,
): Promise<ReadonlyMap<string, string | undefined>>
```

Returns a merged parent-resolution map (fast path from `parentMap`, cached entries from `cache`, API lookups for unknowns). All async work completes before the pure computation starts. The caller updates `childToParentCache` with the resolved entries.

#### Phase 2: Compute Augmented Statuses (pure, synchronous)

```typescript
interface AugmentInput {
  readonly rawStatuses: Readonly<Record<string, SessionStatus>>;
  readonly resolvedParents: ReadonlyMap<string, string | undefined>;
  readonly activityTimestamps: ReadonlyMap<string, number>;
  readonly sseIdleSessions: ReadonlySet<string>;
  readonly now: number;
  readonly activityTtlMs: number;
}

interface AugmentResult {
  readonly statuses: Record<string, SessionStatus>;
  readonly expiredActivitySessions: readonly string[];   // remove from messageActivityTimestamps
  readonly sseIdleClears: readonly string[];             // remove from sseIdleSessions (busy again)
}

function computeAugmentedStatuses(input: AugmentInput): AugmentResult
```

Pure function. No `this`, no mutation, no async. Takes immutable inputs, returns augmented statuses plus descriptions of the state changes to apply. Fully testable with table-driven tests.

Logic:
1. Shallow-copy `rawStatuses` into `augmented`.
2. For each busy session with a resolved parent that isn't already busy: inject `{ type: "busy" }` for the parent.
3. Collect `sseIdleClears`: busy sessions that are in `sseIdleSessions` (they're busy again, override should be lifted).
4. For each entry in `activityTimestamps`: if expired (`now - timestamp > activityTtlMs`), add to `expiredActivitySessions`. If fresh and session not already in `augmented`, inject `{ type: "busy" }`.
5. Return `{ statuses: augmented, expiredActivitySessions, sseIdleClears }`.

#### Phase 3: Apply State Changes (effectful, post-computation)

```typescript
function applyAugmentSideEffects(
  result: AugmentResult,
  cache: Map<string, string | undefined>,
  resolvedParents: ReadonlyMap<string, string | undefined>,
  activityTimestamps: Map<string, number>,
  sseIdleSessions: Set<string>,
): void
```

Applies the mutations described by the `AugmentResult`:
- Merge `resolvedParents` into `cache` (new API-discovered entries).
- Delete `expiredActivitySessions` from `activityTimestamps`.
- Delete `sseIdleClears` from `sseIdleSessions`.

### What Changes in `SessionStatusPoller`

The `poll()` method currently calls `this.augmentStatuses(raw)` as one async step. After refactoring:

```typescript
private async poll(): Promise<void> {
  // ... fetch raw statuses ...

  // Phase 1: resolve unknown parents (all async work here)
  const busyIds = Object.entries(raw)
    .filter(([, s]) => s.type === "busy" || s.type === "retry")
    .map(([id]) => id);
  const resolvedParents = await resolveUnknownParents(
    busyIds, parentMap, this.childToParentCache, this.client, this.log,
  );

  // Phase 2: pure computation (synchronous, no awaits)
  const augmentResult = computeAugmentedStatuses({
    rawStatuses: raw,
    resolvedParents,
    activityTimestamps: this.messageActivityTimestamps,
    sseIdleSessions: this.sseIdleSessions,
    now: Date.now(),
    activityTtlMs: MESSAGE_ACTIVITY_TTL_MS,
  });

  // Phase 3: apply mutations
  applyAugmentSideEffects(
    augmentResult, this.childToParentCache, resolvedParents,
    this.messageActivityTimestamps, this.sseIdleSessions,
  );

  const current = augmentResult.statuses;
  // ... rest of poll() uses `current` ...
}
```

No `await` after the pure computation starts. No mutation during the computation. The `async` API call is fully resolved before `computeAugmentedStatuses` runs.

### Testing

Table-driven tests for `computeAugmentedStatuses`:
- Subagent propagation: busy child with known parent → parent injected as busy.
- Activity injection: fresh timestamp → busy injected. Expired timestamp → listed in `expiredActivitySessions`.
- SSE idle clearing: busy session in `sseIdleSessions` → listed in `sseIdleClears`.
- Edge cases: parent already busy in raw, activity for session already in raw, empty inputs.

---

## Section 10: Shared Notification Policy & Poller Event Pre-Filter

### Problem: Duplicated Notification Logic

The post-pipeline notification pattern (push + cross-session browser notification) is currently implemented in two places:

1. **`became_idle` handler** (`relay-stack.ts:568-587`): Creates done event → pipeline → push (if not subagent) → broadcast notification_event (if dropped and not subagent).
2. **`pollerManager.on("events")` handler** (`relay-stack.ts:639-667`): Per-event → pipeline → push (if not subagent done) → broadcast notification_event (if dropped and notification-worthy and not subagent).

With the reducer, the `became_idle` handler is replaced by the `notify-idle` effect executor. But the poller event handler still has the same notification logic. Rather than duplicating it a third time, extract a shared pure function.

### Notification Policy (pure)

```typescript
interface NotificationDecision {
  readonly sendPush: boolean;
  readonly broadcastCrossSession: boolean;
  readonly crossSessionPayload?: RelayMessage;
}

function resolveNotifications(
  msg: RelayMessage,
  route: RouteDecision,
  isSubagent: boolean,
): NotificationDecision {
  // Use sendPushForEvent's type coverage (done, error, permission_request, ask_user)
  // rather than isNotificationWorthy (which only covers done, error).
  const isPushWorthy = ["done", "error", "permission_request", "ask_user"].includes(msg.type);

  // For subagent sessions, only suppress `done` notifications.
  // Subagent errors should still fire push notifications.
  if (isSubagent && msg.type === "done") {
    return { sendPush: false, broadcastCrossSession: false };
  }

  return {
    sendPush: isPushWorthy,
    broadcastCrossSession: isPushWorthy && route.action === "drop",
    crossSessionPayload: isPushWorthy && route.action === "drop"
      ? {
          type: "notification_event",
          eventType: msg.type,
          ...(msg.type === "error" && "message" in msg
            ? { message: (msg as { message: string }).message }
            : {}),
        }
      : undefined,
  };
}
```

Both the `notify-idle` effect executor and the poller event handler call this function, ensuring identical notification behavior.

### Poller Event Pre-Filter (pure)

The pre-pipeline logic in the poller event handler (activity marking decision, echo classification) can also be extracted:

```typescript
function classifyPollerBatch(
  events: readonly RelayMessage[],
): { readonly hasContentActivity: boolean }
```

The pre-filter only classifies whether the batch contains content activity (for `markMessageActivity`). Echo suppression stays inline with `consume()` — the existing atomic check+remove pattern. No `has()` method is added to `PendingUserMessages`.

```typescript
// In the poller event handler:
const { hasContentActivity } = classifyPollerBatch(events);

// Apply decisions
if (hasContentActivity) {
  statusPoller.markMessageActivity(sessionId);
}
for (const msg of events) {
  if (pendingUserMessages.consume(sessionId, msg)) {
    continue; // relay echo — skip pipeline processing
  }
  const viewers = wsHandler.getClientsForSession(sessionId);
  const result = processEvent(msg, sessionId, viewers, "message-poller");
  applyPipelineResult(result, sessionId, pipelineDeps);
  // Shared notification policy
  const notify = resolveNotifications(msg, result.route, isSubagent);
  if (notify.sendPush && pushManager) sendPushForEvent(pushManager, msg, log);
  if (notify.broadcastCrossSession && notify.crossSessionPayload) {
    wsHandler.broadcast(notify.crossSessionPayload);
  }
}
```

### What Changes

| Component | Before | After |
|-----------|--------|-------|
| `relay-stack.ts` poller event handler | Inline notification conditions, activity marking, echo suppression | Calls `classifyPollerBatch` (pure) for activity → `consume()` inline for echoes → `resolveNotifications` (pure) for notifications. |
| `notify-idle` effect executor | Would need inline notification logic | Calls `resolveNotifications` (shared). |
| `PendingUserMessages` | Only `consume()` (check + remove) | Unchanged. `consume()` stays — used inline for echo suppression. No `has()` needed. |
| `notification-content.ts` / `isNotificationWorthy` | Called inline in two places | Replaced by `sendPushForEvent` type coverage in `resolveNotifications`. |

### Testing

- `resolveNotifications`: table-driven tests for all `(isNotifiable, isSubagent, route.action)` combinations.
- `classifyPollerBatch`: tests for content-only batches, result/done-only batches, mixed batches, echo suppression, empty batches.

---

## Appendix: What the Reducer Does NOT Own

These concerns remain outside the reducer but are improved as part of this work:

| Concern | Component | Status | Notes |
|---------|-----------|--------|-------|
| Status polling | `SessionStatusPoller` | Stays, simplified | Emits `changed` on every poll cycle (always, not just when statuses differ). `became_busy`/`became_idle` events and `previousBusy` removed. |
| Status augmentation | `SessionStatusPoller.augmentStatuses` | **Refactored (Section 9)** | Separated into pure `computeAugmentedStatuses` + async `resolveUnknownParents` pre-pass + effectful `applyAugmentSideEffects`. Eliminates `await` during computation and interleaved mutation. |
| SSE event consumption | `SSEConsumer` + `sse-wiring.ts` | Stays as-is | Already well-structured. I/O boundary — appropriate design. |
| Event pipeline routing | `processEvent` + `applyPipelineResult` | Stays as-is | Already the gold standard — pure computation + effectful application. |
| Message poller event routing | `pollerManager.on("events")` handler | **Refactored (Section 10)** | Pre-filter extracted to pure `classifyPollerBatch`. Post-pipeline notifications extracted to shared `resolveNotifications`. Both used by poller handler and `notify-idle` executor. |
| Viewer tracking | `SessionRegistry` | Stays as-is | Trivial Map. No changes needed. |
| Within-poller SSE suppression | `MessagePoller.notifySSEEvent` / `isSSEActive` | Stays as-is | Simple timestamp comparison. Orthogonal to reducer's phase-level decisions. |
