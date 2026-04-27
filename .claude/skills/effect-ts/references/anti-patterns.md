# Effect-TS Anti-Patterns and How to Fix Them

## Error Handling Anti-Patterns

### 1. Using Defects for Expected Errors

```typescript
// WRONG: User not found is expected, not a bug
if (!user) return yield* Effect.die(new Error("User not found"))

// RIGHT: Typed error the caller can handle
if (!user) return yield* Effect.fail(new NotFoundError({ id }))
```

### 2. Swallowing Errors

```typescript
// WRONG: Error information lost
Effect.catchAll(loadConfig, () => Effect.succeed(defaultConfig))

// RIGHT: Log before fallback
pipe(loadConfig,
  Effect.tapError((e) => Effect.log(`Config load failed: ${e}`, { level: "warn" })),
  Effect.catchAll(() => Effect.succeed(defaultConfig))
)
```

### 3. Generic Error Types

```typescript
// WRONG: All errors become "Error"
const process = (data: Data): Effect.Effect<Result, Error> => /* ... */

// RIGHT: Specific error types
type ProcessError = ValidationError | TransformError | SaveError
const process = (data: Data): Effect.Effect<Result, ProcessError> => /* ... */
```

## Layer and Dependency Anti-Patterns

### 4. Providing Layers Inside Business Logic

```typescript
// WRONG: Layer provided mid-workflow
const saved = yield* pipe(saveOrder(validated), Effect.provide(DatabaseLayer))

// RIGHT: Effects declare requirements, layers at composition root
const processOrder = (order: Order) =>
  Effect.gen(function* () {
    const repo = yield* OrderRepository
    const validated = yield* validateOrder(order)
    return yield* repo.save(validated)
  })
// Provide at main.ts: Effect.provide(processOrder(order), AppLayer)
```

### 5. Not Using `accessors: true`

```typescript
// Verbose
const logger = yield* Logger
yield* logger.info("Starting")

// Clean (with accessors: true)
yield* Logger.info("Starting")
```

### 6. Circular Layer Dependencies

```typescript
// WRONG: A needs B, B needs A
// RIGHT: Extract shared concern into a third service
```

## Concurrency Anti-Patterns

### 7. Uncontrolled Parallelism

```typescript
// WRONG: 10,000 items = 10,000 concurrent ops
Effect.all(items.map(processItem), { concurrency: "unbounded" })

// RIGHT: Bounded concurrency
Effect.all(items.map(processItem), { concurrency: 10 })
```

### 8. Forgetting to Join Forked Fibers

```typescript
// WRONG: Fiber errors lost
yield* Effect.fork(backgroundTask)
return "done"

// RIGHT: Join or handle errors explicitly
const fiber = yield* Effect.fork(backgroundTask)
yield* Fiber.join(fiber)

// Or for true fire-and-forget:
yield* Effect.fork(backgroundTask.pipe(
  Effect.catchAll((e) => Effect.log(`Background failed: ${e}`))
))
```

### 9. Not Using Ref for Shared Mutable State

```typescript
// WRONG: Race condition!
let counter = 0
const increment = Effect.sync(() => { counter++ })

// RIGHT: Atomic updates
const counter = yield* Ref.make(0)
yield* Ref.update(counter, (n) => n + 1)
```

## Effect Construction Anti-Patterns

### 10. Using Effect.promise for Rejecting Promises

```typescript
// WRONG: Rejection becomes untyped defect
Effect.promise(() => fetch(url).then(r => r.json()))

// RIGHT: Map rejection to typed error
Effect.tryPromise({
  try: () => fetch(url).then(r => r.json()),
  catch: (e) => new FetchError({ message: String(e) })
})
```

### 11. Heavy Computation in Effect.sync

```typescript
// WRONG: Blocks the fiber runtime
Effect.sync(() => computeExpensiveResult())

// RIGHT: Allow other fibers to run
Effect.async<Result>((resume) => {
  setImmediate(() => resume(Effect.succeed(computeExpensiveResult())))
})
```

## Testing Anti-Patterns

### 12. Testing with Real Dependencies

```typescript
// WRONG: Test hits real database
Effect.provide(program, RealDatabaseLayer)

// RIGHT: Isolated test with mock layer
const TestDb = Layer.succeed(Database, {
  save: (u) => Effect.sync(() => { users.set(u.id, u) }),
  find: (id) => Effect.succeed(users.get(id)),
})
Effect.provide(program, TestDb)
```

## Quick Reference

| Anti-Pattern | Problem | Fix |
|---|---|---|
| `Effect.die` for expected errors | Untyped, can't recover | `Effect.fail` with tagged error |
| `Effect.promise` with rejections | Defects are untyped | `Effect.tryPromise` |
| Providing layers in business logic | Hard to compose/test | Provide at composition root |
| `concurrency: "unbounded"` | Resource exhaustion | Bounded concurrency |
| Closure mutations | Race conditions | `Ref` |
| Fire-and-forget `fork` | Silent failures | Join or handle errors |
| Generic `Error` type | Lost type information | Tagged error union |
| Real deps in tests | Slow, flaky | Test layers |
| `Effect.sync` for heavy work | Blocks runtime | `Effect.async` |
| Swallowing errors silently | Hard to debug | Log before recovery |
