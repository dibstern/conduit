# Effect.ts Migration Design

**Date:** 2026-04-23
**Status:** Approved
**Motivation:** Full Effect.ts adoption to make codebase LLM-friendly. Effect's explicit type signatures (`Effect<A, E, R>`) serve as self-documenting contracts — dependencies, errors, and outputs all visible in types without tracing through try/catch or DI wiring.
**Reference architecture:** [pingdotgg/t3code](https://github.com/pingdotgg/t3code)

---

## Migration Strategy: Pain-Point First (Layer by Layer)

Seven migration layers, each self-contained. System stays working after each layer ships. Each layer depends only on layers above it.

```
Layer 1: Schema + Errors (foundation)
   ↓
Layer 2: Resource Lifecycle (Scope replaces AsyncTracker/TrackedService)
   ↓
Layer 3: Concurrency Primitives (Queue/Deferred/PubSub replace manual queues)
   ↓
Layer 4: DI / Service Composition (Layer/Context replace wiring modules)
   ↓
Layer 5: Handler Migration (Effect.gen replaces try/catch handlers)
   ↓
Layer 6: Server & Relay Orchestration (top-level composition)
   ↓
Layer 7: Frontend Transport (WebSocket transport + shared schemas)
```

### Packages Introduced

- Layer 1: `effect`, `@effect/schema`
- Layers 2–5: no new packages (all part of `effect`)
- Layer 6: `@effect/platform` (HTTP server)
- Layer 7: `@effect/schema` on frontend (code-split, lazy-loaded behind WS connection)

### Bundle Strategy

Frontend constraint: first page load under 1.5s. `@effect/schema` loaded async after first render via dynamic import. Critical path uses raw `JSON.parse` + type assertion. Schema validation takes over once loaded. Estimated lazy chunk: ~30-40KB gzipped.

---

## Layer 1: Schema + Errors

### 1a. @effect/schema replaces manual validation

Current manual validation (switch-case, type guards in `ipc-protocol.ts`, `events.ts`, `theme-loader.ts`) becomes declarative Schema definitions.

```typescript
// Before: src/lib/daemon/ipc-protocol.ts
function validateCommand(cmd: { cmd: string }): IPCResponse | null {
  if (!VALID_COMMANDS.has(cmd.cmd)) {
    return { ok: false, error: `Unknown command: ${cmd.cmd}` };
  }
  switch (cmd.cmd) {
    case "add_project":
      if (typeof cmd["directory"] !== "string") { ... }
  }
}

// After
const AddProjectCommand = Schema.Struct({
  cmd: Schema.Literal("add_project"),
  directory: Schema.String.pipe(Schema.nonEmptyString()),
});
const IPCCommand = Schema.Union(AddProjectCommand, RemoveProjectCommand, ...);
const decodeCommand = Schema.decodeUnknownEither(IPCCommand);
```

### 1b. Schema.TaggedErrorClass replaces RelayError hierarchy

Following t3code's pattern (`packages/effect-acp/src/errors.ts`).

```typescript
// Before: src/lib/errors.ts
export class OpenCodeApiError extends RelayError {
  readonly endpoint: string;
  readonly responseStatus: number;
  readonly responseBody: unknown;
}

// After
export class OpenCodeApiError extends Schema.TaggedErrorClass<OpenCodeApiError>()(
  "OpenCodeApiError",
  {
    message: Schema.String,
    endpoint: Schema.String,
    responseStatus: Schema.Number,
    responseBody: Schema.Unknown,
    userVisible: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  },
) {
  toJSON() { ... }       // Transport serialization stays
  toWebSocket() { ... }
}
```

Key decisions:
- Existing `ErrorCode` string union maps to `_tag` discriminants
- Transport serialization methods (`toJSON`, `toWebSocket`, `toMessage`) stay on error classes
- `RelayError` base becomes `Schema.Union` of all error subclasses
- `fromCaught` utility becomes `Effect.catchAll` + `Effect.mapError` at call sites
- Same pattern for `PersistenceError` in `src/lib/persistence/errors.ts`

### 1c. Branded types become Schema brands

```typescript
// Before: src/lib/shared-types.ts
export type RequestId = string & { readonly __brand: "RequestId" };

// After
export const RequestId = Schema.String.pipe(Schema.brand("RequestId"));
export type RequestId = typeof RequestId.Type;
```

### 1d. Discriminated unions become Schema.Union

```typescript
// Before: 20+ variant RelayMessage union (manual)
export type RelayMessage =
  | { type: "delta"; sessionId: string; text: string }
  | { type: "thinking_start"; sessionId: string }
  | ...

// After
const DeltaMessage = Schema.Struct({
  type: Schema.Literal("delta"),
  sessionId: Schema.String,
  text: Schema.String,
});
export const RelayMessage = Schema.Union(DeltaMessage, ThinkingStartMessage, ...);
export type RelayMessage = typeof RelayMessage.Type;
```

### Files affected
- `src/lib/errors.ts` — error hierarchy → Schema.TaggedErrorClass
- `src/lib/persistence/errors.ts` — PersistenceError → Schema.TaggedErrorClass
- `src/lib/shared-types.ts` — RelayMessage, branded types, shared contracts
- `src/lib/daemon/ipc-protocol.ts` — IPC command validation
- `src/lib/persistence/events.ts` — canonical event types + validation
- `src/lib/server/theme-loader.ts` — theme validation

---

## Layer 2: Resource Lifecycle

### 2a. AsyncTracker → Effect Scope

```typescript
// Before: src/lib/daemon/async-tracker.ts
export class AsyncTracker {
  private controller = new AbortController();
  private pending = new Set<Promise<unknown>>();
  private timers = new Set<ReturnType<typeof setInterval>>();
  track<T>(promise: Promise<T>): Promise<T> { ... }
  async drain(): Promise<void> { ... }
}

// After
const trackedFetch = (url: string, init?: RequestInit) =>
  Effect.acquireRelease(
    Effect.tryPromise(() => fetch(url, init)),
    (response) => Effect.sync(() => response.body?.cancel())
  );

const repeating = (fn: () => Effect.Effect<void>, ms: number) =>
  Effect.acquireRelease(
    Effect.sync(() => setInterval(() => Effect.runFork(fn()), ms)),
    (id) => Effect.sync(() => clearInterval(id))
  );
```

### 2b. TrackedService → Effect service with Scope

No base class needed — Scope handles lifecycle automatically. Every class extending `TrackedService` removes the base class and uses Scope.

### 2c. ServiceRegistry → Layer composition

```typescript
// Before: src/lib/daemon/service-registry.ts
export class ServiceRegistry {
  private readonly services = new Set<Drainable>();
  register(service: Drainable): void { ... }
  async drainAll(): Promise<void> { ... }
}

// After: Layer.mergeAll handles startup + shutdown ordering
// Scope.close() drains all services automatically in reverse order
```

### 2d. SqliteClient transactions → Effect-managed

```typescript
// After
const runInTransaction = <A, E>(
  effect: Effect.Effect<A, E>
): Effect.Effect<A, E | PersistenceError> =>
  Effect.acquireUseRelease(
    Effect.sync(() => db.exec("BEGIN")),
    () => effect,
    (_, exit) =>
      Exit.isSuccess(exit)
        ? Effect.sync(() => db.exec("COMMIT"))
        : Effect.sync(() => db.exec("ROLLBACK"))
  );
```

Wins over current code: typed error channel (`E | PersistenceError`), interruption-safe (fiber interruption guarantees rollback), composable nesting (savepoints via `acquireUseRelease` composition, eliminating manual `transactionDepth`/`savepointCounter`).

### 2e. Retry fetch → Effect.retry

```typescript
// Before: src/lib/instance/retry-fetch.ts (35 lines of manual backoff)
// After
const fetchWithRetry = (url: string, init?: RequestInit) =>
  Effect.tryPromise({
    try: () => fetch(url, init),
    catch: (err) => new OpenCodeConnectionError({ message: String(err) }),
  }).pipe(
    Effect.timeout(Duration.seconds(10)),
    Effect.retry(
      Schedule.exponential(Duration.seconds(1)).pipe(
        Schedule.compose(Schedule.recurs(2))
      )
    ),
  );
```

### Files deleted
- `src/lib/daemon/async-tracker.ts`
- `src/lib/daemon/tracked-service.ts`
- `src/lib/daemon/service-registry.ts`
- `src/lib/instance/retry-fetch.ts`

### Files modified
- `src/lib/persistence/sqlite-client.ts` — transaction management
- Every class extending `TrackedService`
- Every call site using `createRetryFetch`

---

## Layer 3: Concurrency Primitives

### 3a. PromptQueue → Effect Queue

```typescript
// Before: src/lib/provider/claude/prompt-queue.ts (79 lines)
// Hand-rolled async iterator with manual promise-based wakeup

// After
const promptQueue = yield* Queue.unbounded<SDKUserMessage>();
// enqueue:  yield* Queue.offer(promptQueue, message)
// consume:  yield* Queue.take(promptQueue)
// close:    yield* Queue.shutdown(promptQueue)
// stream:   Stream.fromQueue(promptQueue)
```

79 lines → 1 line to create, built-in backpressure if switched to `Queue.bounded`.

### 3b. ClientMessageQueue → Effect Queue

Same pattern — manual buffer + waiter arrays replaced.

### 3c. EventEmitter → Effect PubSub

```typescript
// Before
sessionMgr.on("session:created", (session) => { ... });

// After
const sessionEvents = yield* PubSub.unbounded<SessionEvent>();
yield* PubSub.publish(sessionEvents, { _tag: "Created", session });

const sub = yield* PubSub.subscribe(sessionEvents);
yield* Stream.fromQueue(sub).pipe(
  Stream.runForEach((event) => handleSessionEvent(event)),
  Effect.forkScoped,
);
```

Typed event payloads. No more string event names. LLM sees `SessionEvent` union and knows exactly what events exist.

### 3d. Poller gating → Deferred + Ref

```typescript
// Before: src/lib/relay/message-poller.ts — boolean flags, setTimeout chains

// After: t3code CommandGate pattern
const makePollerGate = Effect.gen(function* () {
  const sseActive = yield* Ref.make(true);
  const pollReady = yield* Deferred.make<void>();
  return {
    signalSseSilent: Ref.set(sseActive, false).pipe(
      Effect.flatMap(() => Deferred.succeed(pollReady, undefined))
    ),
    signalSseActive: Ref.set(sseActive, true),
    awaitPollReady: Deferred.await(pollReady),
  };
});
```

### 3e. Idempotency tracking → Cache

```typescript
// Before: manual Set with FIFO eviction in orchestration-engine.ts
// After
const processedCommands = yield* Cache.make({
  lookup: (commandId: string) => Effect.succeed(true),
  capacity: 1000,
  timeToLive: Duration.minutes(5),
});
```

### 3f. Rate limiter → Effect Semaphore

```typescript
const rateLimiter = yield* Effect.makeSemaphore(5);
const rateLimited = <A, E>(effect: Effect.Effect<A, E>) =>
  rateLimiter.withPermits(1)(effect);
```

### Files deleted
- `src/lib/provider/claude/prompt-queue.ts`

### Files modified
- All `EventEmitter` usage → PubSub
- `src/lib/relay/message-poller.ts` → Deferred/Ref gating
- `src/lib/provider/orchestration-engine.ts` → Cache for idempotency
- Rate limiter implementation

---

## Layer 4: DI / Service Composition

### 4a. Context.Tag for every service

```typescript
// Before: 15-field HandlerDeps bag threaded everywhere
export interface HandlerDeps {
  client: OpenCodeAPI;
  sessionMgr: SessionManager;
  wsHandler: WebSocketHandler;
  // ... 15+ fields
}

// After: each service gets a Tag
export class OpenCodeAPI extends Context.Tag("OpenCodeAPI")<
  OpenCodeAPI, OpenCodeAPIShape
>() {}

// Handler pulls only what it needs:
const handleNewSession = (payload: NewSessionPayload) =>
  Effect.gen(function* () {
    const client = yield* OpenCodeAPI;
    const sessions = yield* SessionManager;
    const ws = yield* WebSocketHandler;
  });
```

LLM reads first 3 lines and knows all dependencies. No more tracing through 15-field bags.

### 4b. Layer for each service

```typescript
export const SessionManagerLive = Layer.effect(
  SessionManager,
  Effect.gen(function* () {
    const db = yield* SqliteClient;
    const events = yield* SessionEventsPubSub;
    return makeSessionManager(db, events);
  })
);
```

### 4c. wireHandlerDeps → eliminated

Handler deps wiring module replaced entirely by Layer composition:

```typescript
const HandlerLayer = Layer.mergeAll(
  SessionManagerLive,
  OpenCodeAPILive,
  WebSocketHandlerLive,
  PermissionBridgeLive,
  OrchestrationLive,
  PersistenceLive,
);
```

### 4d. ProjectRelay → Layer

```typescript
export const ProjectRelayLive = Layer.mergeAll(
  WebSocketHandlerLive,
  SSEStreamLive,
  OpenCodeAPILive,
  SessionManagerLive,
  TranslatorLive,
  PermissionBridgeLive,
  OrchestrationLive,
).pipe(
  Layer.provide(PersistenceLive),
  Layer.provide(ServerConfigLive),
);
// stop() is automatic — Scope closes all layers in reverse order
```

### 4e. Configuration → Schema-validated Layer

```typescript
export class ServerConfig extends Context.Tag("ServerConfig")<
  ServerConfig, DaemonConfig
>() {}

export const ServerConfigLive = Layer.effect(
  ServerConfig,
  Effect.gen(function* () {
    const raw = yield* Effect.try(() =>
      readFileSync(join(dir, "daemon.json"), "utf-8")
    );
    return yield* Schema.decodeUnknown(DaemonConfigSchema)(raw);
  })
);
```

### Files deleted
- `src/lib/relay/handler-deps-wiring.ts`

### Files modified
- `src/lib/relay/relay-stack.ts` → Layer composition
- `src/lib/daemon/config-persistence.ts` → Schema + Layer
- Every handler file — remove `deps: HandlerDeps` parameter, use `yield*`
- `src/lib/handlers/types.ts` — MessageHandler type changes

---

## Layer 5: Handler Migration

Mechanical layer. By now errors are Schema-based (L1), resources are Scope-managed (L2), concurrency uses Effect primitives (L3), and services are Tags (L4).

### 5a. Handler signature change

```typescript
// Before
type MessageHandler<P> = (
  payload: P,
  deps: HandlerDeps,
  context?: { sessionId?: string }
) => Promise<void | Record<string, unknown>>;

// After
type MessageHandler<P, E, R> = (
  payload: P,
  context?: { sessionId?: string }
) => Effect.Effect<void | Record<string, unknown>, E, R>;
```

### 5b. Handler body conversion (30+ handlers)

```typescript
// Before
export const handleNewSession: MessageHandler<NewSessionPayload> =
  async (payload, deps) => {
    try {
      const session = await deps.client.createSession(payload);
      deps.sessionMgr.addSession(session);
      deps.wsHandler.broadcast({ type: "session_created", session });
    } catch (err) {
      const relayErr = RelayError.fromCaught(err, "SESSION_CREATE_FAILED");
      deps.wsHandler.broadcast(relayErr.toWebSocket());
      throw relayErr;
    }
  };

// After
export const handleNewSession = (payload: NewSessionPayload) =>
  Effect.gen(function* () {
    const client = yield* OpenCodeAPI;
    const sessions = yield* SessionManager;
    const ws = yield* WebSocketHandler;
    const session = yield* client.createSession(payload);
    yield* sessions.addSession(session);
    yield* ws.broadcast({ type: "session_created", session });
  });
```

No try/catch. Errors propagate through error channel. Transport serialization at dispatch boundary.

### 5c. Dispatch table → Effect-based routing with Schema validation

```typescript
const dispatch = (type: IncomingMessageType, raw: unknown) =>
  Effect.gen(function* () {
    const payload = yield* Schema.decodeUnknown(PayloadSchemas[type])(raw);
    return yield* MESSAGE_HANDLERS[type](payload);
  }).pipe(
    Effect.catchTag("ParseError", (err) =>
      Effect.succeed({ error: { code: "INVALID_PAYLOAD", message: formatSchemaError(err) } })
    ),
    Effect.catchAll((err) => Effect.succeed(err.toJSON())),
  );
```

Error serialization moves to one place. Every handler stays clean.

### Files modified
- `src/lib/handlers/*.ts` — all 30+ handler files
- `src/lib/handlers/index.ts` — dispatch table + error boundary
- `src/lib/handlers/types.ts` — MessageHandler type

---

## Layer 6: Server & Relay Orchestration

### 6a. Relay stack → ManagedRuntime

```typescript
const ProjectRelayLive = Layer.mergeAll(
  OpenCodeAPILive, SessionManagerLive, WebSocketHandlerLive,
  SSEStreamLive, TranslatorLive, PermissionBridgeLive,
  OrchestrationLive, MessagePollerLive,
).pipe(
  Layer.provide(PersistenceLive),
  Layer.provide(ServerConfigLive),
);

const runtime = ManagedRuntime.make(ProjectRelayLive);
// Shutdown: runtime.dispose() drains everything in reverse order
```

### 6b. HTTP router → @effect/platform

Current `RequestRouter` (728 lines) has ~15 duplicated error response blocks, manual CORS headers, inlined auth gate, and hand-rolled body parsing. Migrating to `@effect/platform` HTTP server.

CORS → one middleware. Auth gate → one middleware. Error responses → unified `HttpServerError`. Body parsing → `HttpServerRequest.schemaBodyJson(MySchema)`. Estimated reduction: 728 lines → ~250-300 lines.

```typescript
const httpApp = HttpRouter.empty.pipe(
  HttpRouter.get("/health", healthHandler),
  HttpRouter.post("/auth", authHandler),
  HttpRouter.get("/api/auth/status", authStatusHandler),
  HttpRouter.get("/api/projects", projectsListHandler),
  HttpRouter.delete("/api/projects/:slug", deleteProjectHandler),
  HttpRouter.get("/api/themes", themesHandler),
  HttpRouter.get("/api/setup-info", setupInfoHandler),
  HttpRouter.mount("/api/push", pushRouter),
  HttpRouter.mount("/p", projectRouter),
  HttpRouter.get("/ca/download", caDownloadHandler),
  HttpRouter.get("/info", infoHandler),
  // Static files + SPA fallback
);

const withMiddleware = httpApp.pipe(
  HttpMiddleware.cors({ allowedOrigins: ["*"] }),
  HttpMiddleware.auth(authGate),
);
```

### 6c. WebSocket upgrade → Effect-managed connection lifecycle

```typescript
const handleConnection = (ws: WebSocket) =>
  Effect.acquireRelease(
    Effect.sync(() => registerConnection(ws)),
    (conn) => Effect.sync(() => conn.cleanup())
  ).pipe(
    Effect.flatMap((conn) =>
      Stream.fromEventListener(ws, "message").pipe(
        Stream.mapEffect((msg) => dispatch(conn, msg)),
        Stream.runDrain,
      )
    ),
  );
```

### 6d. CLI entry point → Effect.runFork

```typescript
const main = ProjectRelayLive.pipe(
  Layer.launch,
  Effect.catchAllCause((cause) =>
    Effect.logError("Fatal", Cause.pretty(cause))
  ),
);
Effect.runFork(main);
// SIGTERM/SIGINT handled automatically by Effect runtime
```

### 6e. Orchestration engine → Layer with Queue

```typescript
const OrchestrationLive = Layer.effect(
  Orchestration,
  Effect.gen(function* () {
    const commands = yield* Queue.unbounded<OrchestrationCommand>();
    const processed = yield* Cache.make({ capacity: 1000, timeToLive: Duration.minutes(5) });
    yield* Queue.take(commands).pipe(
      Effect.flatMap((cmd) => dispatchCommand(cmd)),
      Effect.forever,
      Effect.forkScoped,
    );
    return { submit: (cmd) => Queue.offer(commands, cmd) };
  })
);
```

### Files modified
- `src/lib/relay/relay-stack.ts` → Layer composition
- `src/lib/server/http-router.ts` → @effect/platform HttpRouter
- `src/bin/main.ts` → Effect.runFork
- `src/lib/provider/orchestration-engine.ts` → Layer + Queue

---

## Layer 7: Frontend Transport

Effect stays at WebSocket transport boundary. Svelte stores/components remain native.

### 7a. WebSocket transport → Effect-managed connection

```typescript
const makeWsTransport = (url: string) =>
  Effect.acquireRelease(
    Effect.sync(() => new WebSocket(url)),
    (ws) => Effect.sync(() => ws.close())
  ).pipe(
    Effect.flatMap((ws) =>
      Stream.fromEventListener(ws, "message").pipe(
        Stream.map((evt) => JSON.parse(evt.data)),
        Stream.mapEffect((raw) => Schema.decodeUnknown(RelayMessage)(raw)),
      )
    ),
    Effect.retry(
      Schedule.exponential(Duration.seconds(1)).pipe(
        Schedule.compose(Schedule.recurUpTo(Duration.seconds(10)))
      )
    ),
  );
```

### 7b. Message dispatch → Schema-validated

Dispatch gets exhaustive matching via `RelayMessage` Schema.Union (defined in Layer 1).

### 7c. Outbound messages → Schema-encoded

```typescript
const OutboundMessage = Schema.Union(
  Schema.Struct({ type: Schema.Literal("message"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("cancel"), sessionId: Schema.String }),
  ...
);

const wsSend = (msg: typeof OutboundMessage.Type) =>
  Schema.encode(OutboundMessage)(msg).pipe(
    Effect.map(JSON.stringify),
    Effect.flatMap((data) => Effect.sync(() => ws.send(data))),
  );
```

### 7d. ManagedRuntime bridge to Svelte

Following t3code's pattern — one `ManagedRuntime` for transport, results piped into Svelte stores via callbacks:

```typescript
const WsTransportLive = Layer.mergeAll(WebSocketLive, SchemaValidationLive);
const runtime = ManagedRuntime.make(WsTransportLive);

runtime.runPromise(
  Stream.runForEach(messageStream, (msg) =>
    Effect.sync(() => chatStore.dispatch(msg))
  )
);
```

### Bundle strategy
- `@effect/schema` loaded async after first render via dynamic import
- Critical path: raw `JSON.parse` + type assertion for first paint
- Schema validation takes over once loaded (~200ms after paint)
- Estimated lazy chunk: ~30-40KB gzipped

### What stays Svelte-native
- All `$state`, `$derived`, `$effect` reactive patterns
- Component rendering, client-side routing, UI state
- Store mutation (Effect pipes data in, Svelte reactivity distributes)

### Files modified
- `src/lib/frontend/stores/ws.svelte.ts` — Effect-managed connection
- `src/lib/frontend/stores/ws-dispatch.ts` — Schema-validated dispatch
- `src/lib/frontend/stores/ws-send.svelte.ts` — Schema-encoded sends

### Files added
- `src/lib/frontend/transport/runtime.ts` — ManagedRuntime + Svelte bridge
- `src/lib/frontend/transport/schemas.ts` — re-exports shared schemas for tree-shaking
