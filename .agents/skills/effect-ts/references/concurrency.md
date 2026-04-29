# Concurrency in Effect-TS

## Fibers: Lightweight Virtual Threads

Fibers are Effect's unit of concurrency — green threads managed by the runtime.

- **Lightweight:** Thousands can run concurrently (no OS thread per fiber)
- **Cooperative:** Yield at await points, not preemptively interrupted
- **Interruptible:** Can be cancelled cleanly with resource cleanup
- **Supervised:** Child fibers attached to parent scope by default

## Forking Fibers

```typescript
// Supervised (default) — interrupted when parent completes
const fiber = yield* Effect.fork(longTask)

// Daemon — outlives parent scope
const fiber = yield* Effect.forkDaemon(backgroundTask)

// Scope-attached — interrupted when scope closes
const fiber = yield* Effect.forkScoped(task)
```

## Fiber Operations

```typescript
const fiber = yield* Effect.fork(computation)

Fiber.join(fiber)       // Wait for result (propagates errors)
Fiber.await(fiber)      // Get Exit (success or failure)
Fiber.interrupt(fiber)  // Cancel (runs cleanup/finalizers)
Fiber.poll(fiber)       // Non-blocking check: Option<Exit>
```

## Parallel Execution

### Effect.all

```typescript
// Parallel by default
const [user, posts, settings] = yield* Effect.all([
  fetchUser(id), fetchPosts(id), fetchSettings(id),
])

// With concurrency limit
yield* Effect.all(tasks, { concurrency: 5 })

// Sequential
yield* Effect.all(tasks, { concurrency: 1 })

// Unbounded (careful — can exhaust resources)
yield* Effect.all(tasks, { concurrency: "unbounded" })

// Options
Effect.all(effects, {
  concurrency: 10,
  mode: "validate",  // Collect ALL errors, not just first
  discard: true,     // Don't collect results (void)
})
```

### Other Parallel Combinators

```typescript
// Map items with effects
yield* Effect.forEach(userIds, (id) => fetchUser(id), { concurrency: 10 })

// First to complete wins, others interrupted
yield* Effect.race(fetchFromCacheA, fetchFromCacheB, fetchFromDatabase)

// Race array
yield* Effect.raceAll([task1, task2, task3])
```

## Synchronization Primitives

### Ref (Atomic Reference)

```typescript
const counter = yield* Ref.make(0)
const value = yield* Ref.get(counter)
yield* Ref.set(counter, 10)
yield* Ref.update(counter, (n) => n + 1)
const old = yield* Ref.getAndUpdate(counter, (n) => n * 2)
yield* Ref.modify(counter, (n) => [n * 2, n + 1])  // Returns n*2, sets n+1
```

### SynchronizedRef (Effectful Updates)

```typescript
const cache = yield* SynchronizedRef.make<Map<string, User>>(new Map())

// Only one effectful update runs at a time
yield* SynchronizedRef.updateEffect(cache, (map) =>
  Effect.gen(function* () {
    const user = yield* fetchUser(id)
    return new Map(map).set(id, user)
  })
)
```

### Queue

```typescript
Queue.bounded<T>(100)     // Blocks offer when full
Queue.unbounded<T>()      // Never blocks offer
Queue.dropping<T>(100)    // Drops oldest when full
Queue.sliding<T>(100)     // Drops newest when full

yield* Queue.offer(queue, 42)
yield* Queue.offerAll(queue, [1, 2, 3])
const item = yield* Queue.take(queue)       // Blocks if empty
const items = yield* Queue.takeAll(queue)   // Take all available
const maybe = yield* Queue.poll(queue)      // Non-blocking: Option<T>
yield* Queue.shutdown(queue)
```

### Deferred (One-Shot Signal)

```typescript
const deferred = yield* Deferred.make<string, Error>()
// Waiter:
const value = yield* Deferred.await(deferred)
// Signaler:
yield* Deferred.succeed(deferred, "done")
// Or: yield* Deferred.fail(deferred, new Error("oops"))
```

### Semaphore

```typescript
const sem = yield* Effect.makeSemaphore(3)
yield* sem.withPermits(1)(expensiveOperation)  // Acquire, run, release
```

## Interruption

```typescript
// Uninterruptible region
const critical = Effect.uninterruptible(Effect.gen(function* () {
  yield* step1()
  yield* step2()  // Won't be interrupted mid-execution
}))

// Interruptible inside uninterruptible
Effect.uninterruptible(Effect.gen(function* () {
  yield* criticalSetup()
  yield* Effect.interruptible(interruptibleWork)
  yield* criticalCleanup()
}))

// Handle interruption
yield* Effect.addFinalizer((exit) => {
  if (Exit.isInterrupted(exit)) return Effect.log("Was interrupted!")
  return Effect.void
})

// Disconnect from parent's interruption
yield* Effect.fork(Effect.disconnect(backgroundTask))
```

## Patterns

### Worker Pool

```typescript
const workerPool = (tasks: Effect<void>[], poolSize: number) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<Effect<void>>()
    yield* Queue.offerAll(queue, tasks)
    const workers = Array.from({ length: poolSize }, () =>
      Effect.gen(function* () {
        while (true) {
          const task = yield* Queue.take(queue)
          yield* task
        }
      })
    )
    yield* Effect.all(workers, { concurrency: "unbounded" })
  })
```

### Timeout with Fallback

```typescript
const withFallback = Effect.gen(function* () {
  const fiber = yield* Effect.fork(primary)
  const result = yield* Fiber.await(fiber).pipe(Effect.timeout("5 seconds"))
  if (Option.isNone(result)) {
    yield* Fiber.interrupt(fiber)
    return yield* fallback
  }
  return Exit.isSuccess(result.value) ? result.value.value : yield* Effect.failCause(result.value.cause)
})
```
