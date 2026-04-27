# Conduit Effect-TS Migration Patterns

Patterns specific to the conduit codebase's migration from imperative TypeScript to Effect.

**Full migration plan:** `docs/plans/2026-04-23-effect-ts-migration-plan.md`
**Design doc:** `docs/plans/2026-04-23-effect-ts-migration-design.md`

## Migration Order

Each layer is a self-contained PR. The system stays working after each task.

1. **Schema + Errors** — branded types → Schema brands, error hierarchy → Schema.TaggedError, RelayMessage → Schema.Union
2. **Resources** — SQLite lifecycle with acquireRelease, connection pooling
3. **Concurrency** — AbortSignal → fiber interruption, event pipeline as Streams
4. **Dependency Injection** — ServiceRegistry → Layers, composition root
5. **Handlers** — request handlers as Effects with typed error channels
6. **Server** — HTTP/WS server startup as Effect program
7. **Frontend** — Svelte stores bridging to ManagedRuntime

## Error Hierarchy Migration

### Current → Effect

```typescript
// BEFORE: Class hierarchy with manual codes
class RelayError extends Error {
  code: ErrorCode
  statusCode: number
  userVisible: boolean
  context: Record<string, unknown>
  toJSON() { ... }
  toWebSocket() { ... }
}
class OpenCodeApiError extends RelayError { ... }

// AFTER: Schema.TaggedError with discriminated union
class OpenCodeApiError extends Schema.TaggedError<OpenCodeApiError>()(
  "OpenCodeApiError",
  {
    message: Schema.String,
    endpoint: Schema.String,
    responseStatus: Schema.Number,
    responseBody: Schema.Unknown,
    userVisible: Schema.optionalWith(Schema.Boolean, { default: () => false }),
    context: Schema.optionalWith(
      Schema.Record({ key: Schema.String, value: Schema.Unknown }),
      { default: () => ({}) },
    ),
  },
) {
  get statusCode() { return this.responseStatus >= 400 ? this.responseStatus : 502 }
  toJSON() { return { error: { code: this._tag, message: this.message } } }
  toWebSocket() { return { type: "error" as const, code: this._tag, message: this.message, statusCode: this.statusCode } }
}

type RelayError =
  | OpenCodeConnectionError
  | OpenCodeApiError
  | SSEConnectionError
  | WebSocketError
  | AuthenticationError
  | ConfigurationError
```

**Wire format:** Use `_tag` names (`"OpenCodeApiError"`) as the wire code. Update all `error.code === "OPENCODE_API_ERROR"` checks to use new names.

### Constructor Migration

```typescript
// BEFORE: Positional args
new PersistenceError("WRITE_FAILED", "Write failed", { table: "events" })

// AFTER: Props object
new PersistenceError({ code: "WRITE_FAILED", message: "Write failed", context: { table: "events" } })
```

## Branded Types Migration

```typescript
// BEFORE: Manual brand pattern
type RequestId = string & { __brand: "RequestId" }
const rid = someString as RequestId

// AFTER: Schema brand
const RequestId = Schema.String.pipe(Schema.brand("RequestId"))
type RequestId = typeof RequestId.Type

// Construction sites
const rid = Schema.decodeSync(RequestId)(someString)  // With runtime validation
const rid = someString as typeof RequestId.Type         // Zero-validation cast (hot paths)
```

## AbortSignal → Effect Interruption

### Current Daemon Pattern

```typescript
// BEFORE: AbortSignal threading
async function startRelay(signal: AbortSignal): Promise<ProjectRelay> {
  const client = await createClient(signal)
  signal.addEventListener("abort", () => client.close())
  return relay
}
```

### Effect Equivalent

```typescript
// AFTER: Scoped resource with automatic cleanup
const startRelay = Effect.fn("startRelay")(function* () {
  const client = yield* Effect.acquireRelease(
    createClientEffect,
    (client) => Effect.sync(() => client.close()),
  )
  return yield* buildRelay(client)
})

// Caller controls lifetime via scope
const program = Effect.scoped(startRelay)
// Or fork as fiber and interrupt later
const fiber = yield* Effect.fork(Effect.scoped(startRelay))
yield* Fiber.interrupt(fiber) // Triggers cleanup
```

## ServiceRegistry → Layers

### Current DI Pattern

```typescript
// BEFORE: Manual registry
class ServiceRegistry {
  private services = new Map<string, unknown>()
  register<T>(name: string, service: T): void { ... }
  get<T>(name: string): T { ... }
}

const registry = new ServiceRegistry()
registry.register("persistence", new PersistenceLayer(db))
registry.register("opencode", new OpenCodeClient(config))
```

### Effect Equivalent

```typescript
// AFTER: Typed services with Layer composition
class Persistence extends Effect.Service<Persistence>()("Persistence", {
  scoped: Effect.gen(function* () {
    const config = yield* AppConfig
    const db = yield* Effect.acquireRelease(
      Effect.tryPromise(() => openDatabase(config.dbPath)),
      (db) => Effect.sync(() => db.close()),
    )
    return { query: (sql: string) => Effect.tryPromise(() => db.all(sql)) }
  }),
  dependencies: [AppConfig.Default],
}) {}

class OpenCodeClient extends Effect.Service<OpenCodeClient>()("OpenCodeClient", {
  effect: Effect.gen(function* () {
    const config = yield* AppConfig
    return { /* ... */ }
  }),
  dependencies: [AppConfig.Default],
}) {}

// Composition root
const AppLayer = Layer.mergeAll(
  AppConfig.Default,
  Persistence.Default,
  OpenCodeClient.Default,
)

const runtime = ManagedRuntime.make(AppLayer)
```

## Event Store → Effect Stream

### Current SSE Pipeline

```typescript
// BEFORE: EventEmitter + callback chain
sseConsumer.on("event", (raw) => {
  const event = translateEvent(raw)
  eventStore.append(event)
  projectors.forEach(p => p.process(event))
})
```

### Effect Stream Equivalent

```typescript
// AFTER: Stream pipeline with backpressure
const eventPipeline = Effect.fn("eventPipeline")(function* (sseStream: Stream.Stream<RawSSEEvent, SSEConnectionError>) {
  const store = yield* EventStore
  const projectors = yield* ProjectorRegistry

  yield* sseStream.pipe(
    Stream.map(translateEvent),
    Stream.tap((event) => store.append(event)),
    Stream.tap((event) =>
      Effect.forEach(projectors.all, (p) => p.process(event), { concurrency: "unbounded" })
    ),
    Stream.runDrain,
  )
})
```

## Projector Pattern

Projectors materialize views from the event log. In Effect, model them as services:

```typescript
class SessionProjector extends Effect.Service<SessionProjector>()("SessionProjector", {
  effect: Effect.gen(function* () {
    const persistence = yield* Persistence
    return {
      process: (event: AppEvent) => Effect.gen(function* () {
        if (event.type === "session_start") {
          yield* persistence.query(`INSERT INTO sessions ...`)
        }
      }),
    }
  }),
  dependencies: [Persistence.Default],
}) {}
```

## Logging Migration

Conduit uses pino with structured logging. Migrate to Effect's logger:

```typescript
// BEFORE
import { logger } from "$lib/logger"
logger.info({ sessionId, event: "connected" }, "SSE connected")

// AFTER — use Effect.log with annotations
yield* Effect.log("SSE connected").pipe(
  Effect.annotateLogs({ sessionId, event: "connected" }),
)

// Custom logger layer that outputs pino-compatible JSON
const PinoLogger = Logger.make(({ message, annotations, logLevel }) => {
  const entry = { level: logLevel.label.toLowerCase(), msg: message, ...annotations }
  process.stdout.write(JSON.stringify(entry) + "\n")
})
```

## Compiler Note

This project uses `tsgo` (TypeScript native preview). If `pnpm check` fails after installing Effect due to `tsgo`
incompatibility with Effect's type-level machinery, temporarily switch the `check` script to use `tsc` and file a
tsgo issue.

## Reference Architecture

[pingdotgg/t3code](https://github.com/pingdotgg/t3code) — similar event-driven relay, already Effect-native. Useful
for pattern validation.
