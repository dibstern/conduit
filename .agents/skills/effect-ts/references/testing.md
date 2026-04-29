# Testing Effect-TS (Vitest)

Pragmatic guide for writing deterministic tests in Effect-TS codebases using `@effect/vitest` and Vitest.

## The #1 Gotcha: `it.effect` Uses TestClock

`@effect/vitest`'s `it.effect` runs with **TestContext** (including **TestClock**).

- Time starts at **0**
- Time does **not** pass unless you advance it
- Any `Effect.sleep`, `Schedule.spaced`, retry backoff, polling loop will **stall forever** unless you call
  `TestClock.adjust`

Use `it.live` when you truly want wall-clock time.

## Quick Decision Table

| Scenario | Use |
|---|---|
| Uses timeouts/sleeps/retries/polling | `it.effect` + `TestClock.adjust(...)` |
| Needs wall clock / real delays | `it.live` (or `it.scopedLive`) |
| Allocates scoped resources | `it.scoped` / `it.scopedLive` |
| Pure computation, no time | `it.effect` (default) |

## Basic Effect Testing

### Running Effects in Tests

```typescript
import { describe, it, expect } from "vitest"
import { Effect, Exit, Cause, Option } from "effect"

describe("MyService", () => {
  it("should process data", async () => {
    const result = await Effect.runPromise(processData(input))
    expect(result).toEqual(expectedOutput)
  })

  it("should fail with InvalidInput", async () => {
    const exit = await Effect.runPromiseExit(processData(invalidInput))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = Cause.failureOption(exit.cause)
      expect(Option.getOrNull(error)?._tag).toBe("InvalidInputError")
    }
  })
})
```

### Error Assertion Helper

```typescript
const expectFailure = async <A, E>(
  effect: Effect.Effect<A, E>,
  check: (error: E) => void
) => {
  const exit = await Effect.runPromiseExit(effect)
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    const error = Cause.failureOption(exit.cause)
    expect(Option.isSome(error)).toBe(true)
    if (Option.isSome(error)) check(error.value)
  }
}

// Usage
it("should fail with NotFoundError", async () => {
  await expectFailure(findUser("bad-id"), (e) => {
    expect(e._tag).toBe("NotFoundError")
    expect(e.id).toBe("bad-id")
  })
})
```

## Time: Don't Use Date.now() in Effect Code

If production code uses `Date.now()`, it becomes untestable under TestClock. Use Effect's clock:

```typescript
import { Clock, Effect } from "effect"

const program = Effect.gen(function* () {
  const now = yield* Clock.currentTimeMillis
  return now
})
```

## TestClock Patterns

### Replace `Effect.sleep` with `TestClock.adjust`

```typescript
import { TestClock } from "effect"

// In it.effect:
yield* TestClock.adjust("50 millis")  // Instead of Effect.sleep
```

### Testing Retries / Backoff / Scheduled Loops

Fork the effect, advance time, then join:

```typescript
const runWithTime = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  adjust: Parameters<typeof TestClock.adjust>[0] = "1000 millis"
) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.fork(effect)
    yield* TestClock.adjust(adjust)
    return yield* Fiber.join(fiber)
  })
```

Advance _enough_ time for the whole schedule/backoff chain to complete.

## Concurrency Gotcha: fork ≠ "Fiber Has Started"

`Effect.fork` creates and schedules a fiber, but it may not run until later. If you open a gate before fibers reach
the code you're coordinating, your test becomes effectively sequential.

### Deterministic Pattern: `started` Latch + `gate`

```typescript
Effect.gen(function* () {
  let executions = 0
  const started = yield* Deferred.make<void>()
  const gate = yield* Deferred.make<void>()

  const underlying = Effect.gen(function* () {
    executions++
    yield* Deferred.succeed(started, undefined)  // Signal: I'm running
    yield* Deferred.await(gate)                   // Block until gate opens
    return "ok"
  })

  const f1 = yield* Effect.fork(underlying)
  const f2 = yield* Effect.fork(underlying)

  yield* Deferred.await(started)              // Wait for at least one fiber
  yield* Deferred.succeed(gate, undefined)    // Now open the gate

  yield* Fiber.join(f1)
  yield* Fiber.join(f2)
  // Safe to assert overlap / dedup / sharing
})
```

## Streams, Watches, and Background Fibers

Most test "hangs" come from:
- A stream that never ends (`Stream.runCollect(stream)` on infinite stream)
- A watch/polling loop forked and never interrupted
- A scoped resource never finalized because the scope never closes

**Recommendations:**
- Bounded consumption: `Stream.take(stream, n)` / `Stream.takeUntil`
- If you fork a fiber, ensure it is interrupted: `Fiber.interrupt(fiber)` or use `Scope`
- Use `Effect.timeout` / `Effect.timeoutFail` around anything that could block

## Use `it.scoped` for Scoped Resources

If your test uses `Effect.acquireRelease`, `Stream.asyncScoped`, or resourceful Layers, use `it.scoped` / `it.scopedLive`
so finalizers run when the test completes.

## Don't Escape the Test Runtime

Avoid `Effect.runPromise(...)` _inside_ an `it.effect` program — it runs on a different runtime (live clock), defeating
TestClock determinism. Stay inside the Effect you're already running.

## Mocking Services with Test Layers

```typescript
// Test implementation
const UserRepositoryTest = Layer.succeed(UserRepository, {
  findById: (id) =>
    id === "existing" ? Effect.succeed(testUser) : Effect.fail(new NotFoundError({ id })),
  save: () => Effect.void,
})

// Mock factories for configurable behavior
const makeUserRepoMock = (opts: { users?: Map<string, User>; shouldFail?: boolean }) =>
  Layer.succeed(UserRepository, {
    findById: (id) => {
      if (opts.shouldFail) return Effect.fail(new DatabaseError({ message: "Connection failed" }))
      const user = opts.users?.get(id)
      return user ? Effect.succeed(user) : Effect.fail(new NotFoundError({ id }))
    },
    save: (user) => {
      if (opts.shouldFail) return Effect.fail(new DatabaseError({ message: "Connection failed" }))
      opts.users?.set(user.id, user)
      return Effect.void
    },
  })

// Use in tests
it("should handle db failure", async () => {
  const program = getUserById("any").pipe(Effect.provide(makeUserRepoMock({ shouldFail: true })))
  await expectFailure(program, (e) => expect(e._tag).toBe("DatabaseError"))
})
```

## Mocking Config

```typescript
const TestConfig = Layer.setConfigProvider(
  ConfigProvider.fromMap(new Map([["API_KEY", "test"], ["PORT", "3000"]]))
)
```

## Testing Streams

```typescript
it("should transform stream", async () => {
  const result = await Effect.runPromise(
    Stream.fromIterable([1, 2, 3, 4, 5]).pipe(
      Stream.map((n) => n * 2),
      Stream.filter((n) => n > 4),
      Stream.runCollect,
      Effect.map(Chunk.toArray),
    )
  )
  expect(result).toEqual([6, 8, 10])
})
```

## Best Practices

1. **Test behavior through effects, not implementation details** — test outputs, not internal calls
2. **Fresh layers per test** — `makeTestLayer()` in each test for isolated state
3. **Test error paths** — happy path, each error variant, edge cases
4. **Minimal mocks** — only mock what the specific test needs
5. **Keep test setup minimal** — unused methods get `() => Effect.void`
