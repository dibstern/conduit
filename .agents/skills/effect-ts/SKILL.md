---
name: effect-ts
description: Use when working with Effect-TS patterns, services, layers, schemas, error handling, streams, concurrency, or writing/refactoring code that imports from 'effect'. Also covers Svelte 5 + Effect integration and conduit's ongoing Effect migration.
---

# Effect-TS Expert

Expert guidance for functional programming with the Effect library — typed errors, dependency injection, composability,
concurrency, and testing patterns. Tailored for the conduit codebase (Svelte 5 + Node.js daemon, mid-migration to Effect).

## Prerequisites Check

Before starting any Effect-related work, verify the Effect-TS source code exists at `~/src/personal/.effect`.

**If missing, stop immediately and inform the user.** Clone it before proceeding:

```bash
git clone https://github.com/Effect-TS/effect.git ~/src/personal/.effect
```

## Research Strategy

Effect-TS has many ways to accomplish the same task. Proactively research best practices using the Agent tool to spawn
research agents when working with Effect patterns, especially for moderate to high complexity tasks.

### Research Sources (Priority Order)

1. **Codebase Patterns First** — Examine similar patterns in the current project before implementing. If Effect patterns
   exist in the codebase, follow them for consistency. If no patterns exist, skip this step.

2. **Effect Source Code** — For complex type errors, unclear behavior, or implementation details, examine the Effect
   source at `~/src/personal/.effect/packages/effect/src/`. This contains the core Effect logic and modules.

### When to Research

**HIGH Priority (Always Research):**

- Implementing Services, Layers, or complex dependency injection
- Error handling with multiple error types or complex error hierarchies
- Stream-based operations and reactive patterns
- Resource management with scoped effects and cleanup
- Concurrent/parallel operations and performance-critical code
- Testing patterns, especially unfamiliar test scenarios

**MEDIUM Priority (Research if Complex):**

- Refactoring imperative code (try-catch, promises) to Effect patterns
- Adding new service dependencies or restructuring service layers
- Custom error types or extending existing error hierarchies
- Integrations with external systems (databases, APIs, third-party services)

### Research Approach

- Spawn multiple concurrent agents when investigating multiple related patterns
- Focus on canonical, readable, and maintainable solutions over clever optimizations
- Verify against existing codebase patterns for consistency (if patterns exist)
- When multiple approaches are possible, research to find the most idiomatic Effect-TS solution

## Core Principles

### Error Handling

- Use Effect's typed error system instead of throwing exceptions
- Define descriptive error types with `Data.TaggedError` or `Schema.TaggedError` (serializable)
- Use `Effect.fail`, `Effect.catchTag`, `Effect.catchAll` for error control flow
- Categorize: expected rejections, domain errors, defects, interruptions, unknown/foreign
- See `./references/critical-rules.md` for forbidden patterns
- See `./references/error-handling.md` for comprehensive patterns

### Dependency Injection

- Implement DI using Services and Layers
- Define services with `Context.Tag` or `Effect.Service` (simplified)
- Compose layers with `Layer.merge`, `Layer.provide`, `Layer.provideMerge`
- Provide layers at the composition root, not scattered through business logic
- See `./references/layers.md` for full patterns

### Composability

- Leverage Effect's composability for complex operations
- Use appropriate constructors: `Effect.succeed`, `Effect.fail`, `Effect.tryPromise`, `Effect.try`
- Apply proper resource management with scoped effects
- Chain with `Effect.flatMap`, `Effect.map`, `Effect.tap`

### Code Quality

- Write type-safe code that leverages Effect's type system
- Use `Effect.gen` for readable sequential code (preferred)
- Use `pipe` for simple one-liner transformations
- Prefer `Effect.fn()` for named functions — automatic telemetry and better stack traces
- Implement proper testing patterns using `@effect/vitest`

## Critical Rules

**Read `./references/critical-rules.md` before writing any Effect code.** Key rules:

### INEFFECTIVE: try-catch in Effect.gen

Effect failures are returned as exits, not thrown. `try-catch` inside `Effect.gen` will NOT catch Effect failures.

```typescript
// WRONG — catches nothing
Effect.gen(function* () {
  try { const r = yield* someEffect } catch (e) { /* never runs */ }
})

// RIGHT
Effect.gen(function* () {
  const result = yield* Effect.catchTag(someEffect, "MyError", (e) => Effect.succeed(fallback))
})
```

### AVOID: Type assertions (`as never`, `as any`, `as unknown`)

Fix underlying type issues instead. Occasional assertions for poorly-typed external libraries are acceptable if documented.

### RECOMMENDED: `return yield*` for errors

Makes termination explicit and prevents unreachable-code warnings:

```typescript
Effect.gen(function* () {
  if (bad) {
    return yield* Effect.fail(new MyError({ reason: "bad" }))
  }
  return yield* doWork()
})
```

## Quick Reference

### The Effect Type

```typescript
Effect<Success, Error, Requirements>
//     ^        ^       ^
//     |        |       └── Services/dependencies needed (Context)
//     |        └────────── Typed error channel
//     └─────────────────── Success value type
```

### Creating Effects

```typescript
Effect.succeed(value)           // Wrap success value
Effect.fail(error)              // Create failed effect
Effect.tryPromise(fn)           // Wrap promise-returning function (rejects → typed error)
Effect.try(fn)                  // Wrap synchronous throwing function
Effect.sync(fn)                 // Wrap synchronous non-throwing function
Effect.promise(fn)              // Wrap promise (rejects → defect — prefer tryPromise)
```

### Composing Effects

```typescript
Effect.flatMap(effect, fn)      // Chain effects
Effect.map(effect, fn)          // Transform success value
Effect.tap(effect, fn)          // Side effect without changing value
Effect.all([...effects])        // Run effects (concurrency configurable)
Effect.forEach(items, fn)       // Map over items with effects

// Collect ALL errors (not just first)
Effect.all([e1, e2, e3], { mode: "validate" })

// Partial success handling
Effect.partition([e1, e2, e3])  // Returns [failures, successes]
```

### Error Handling

```typescript
// Define typed errors with Data.TaggedError (preferred)
class UserNotFoundError extends Data.TaggedError("UserNotFoundError")<{
  userId: string
}> {}

// Direct yield of errors in gen (no Effect.fail wrapper needed)
Effect.gen(function* () {
  if (!user) return yield* new UserNotFoundError({ userId })
})

Effect.catchTag(effect, tag, fn) // Handle specific error tag
Effect.catchTags(effect, { ... }) // Handle multiple tags
Effect.catchAll(effect, fn)      // Handle all errors
Effect.result(effect)            // Convert to Exit value
Effect.either(effect)            // Convert to Either<E, A>
Effect.orElse(effect, alt)       // Fallback effect
```

### Error Taxonomy

| Category                | Examples                   | Handling                  |
| ----------------------- | -------------------------- | ------------------------- |
| **Expected Rejections** | User cancel, deny          | Graceful exit, no retry   |
| **Domain Errors**       | Validation, business rules | Show to user, don't retry |
| **Defects**             | Bugs, assertions           | Log + alert, investigate  |
| **Interruptions**       | Fiber cancel, timeout      | Cleanup, may retry        |
| **Unknown/Foreign**     | Thrown exceptions          | Normalize at boundary     |

### Pattern Matching (Match Module)

```typescript
import { Match } from "effect"

// Type-safe exhaustive matching on tagged errors
const handleError = Match.type<AppError>().pipe(
  Match.tag("UserCancelledError", () => null),
  Match.tag("ValidationError", (e) => e.message),
  Match.tag("NetworkError", () => "Connection failed"),
  Match.exhaustive  // Compile error if case missing
)

// Cleaner than chained catchTag
Effect.catchAll(effect, (error) =>
  Match.value(error).pipe(
    Match.tag("A", handleA),
    Match.tag("B", handleB),
    Match.exhaustive
  )
)
```

### Services and Layers

```typescript
// Pattern 1: Context.Tag (implementation provided separately via Layer)
class MyService extends Context.Tag("MyService")<MyService, { ... }>() {}
const MyServiceLive = Layer.succeed(MyService, { ... })

// Pattern 2: Effect.Service (default implementation bundled)
class UserRepo extends Effect.Service<UserRepo>()("UserRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Database
    return { findAll: db.query("SELECT * FROM users") }
  }),
  dependencies: [Database.Default],
  accessors: true  // Auto-generate method accessors
}) {}

// Pattern 3: Context.Reference (defaultable tags — 3.11.0+)
class SpecialNumber extends Context.Reference<SpecialNumber>()(
  "SpecialNumber",
  { defaultValue: () => 2048 }
) {}
```

### Generator Pattern

```typescript
// Effect.gen — recommended for sequential code
Effect.gen(function* () {
  const a = yield* effectA
  const b = yield* effectB
  return result
})

// Effect.fn — automatic tracing/telemetry (preferred for named functions)
const fetchUser = Effect.fn("fetchUser")(function* (id: string) {
  const db = yield* Database
  return yield* db.query(id)
})
```

### Running Effects

```typescript
Effect.runSync(effect)           // Sync, throws on async/error
Effect.runPromise(effect)        // Returns Promise<A>
Effect.runPromiseExit(effect)    // Returns Promise<Exit<A, E>>

// Production (with runtime)
const runtime = ManagedRuntime.make(AppLayer)
await runtime.runPromise(effect)
await runtime.dispose()          // Cleanup
```

### Resource Management

```typescript
Effect.acquireUseRelease(acquire, use, release)
Effect.scoped(effect)
Effect.addFinalizer(cleanup)
```

### Duration

Effect accepts human-readable duration strings anywhere a `DurationInput` is expected:

```typescript
Duration.toMillis("5 minutes")    // 300000
Duration.toMillis("100 millis")   // 100
// Units: nanos, micros, millis, seconds, minutes, hours, days, weeks
```

### Scheduling

```typescript
Effect.retry(effect, Schedule.exponential("100 millis"))
Effect.repeat(effect, Schedule.fixed("1 second"))
Schedule.compose(s1, s2)
```

### Concurrency

```typescript
Effect.fork(effect)              // Run in background fiber
Fiber.join(fiber)                // Wait for result
Fiber.interrupt(fiber)           // Cancel fiber
Effect.race(e1, e2)              // First to complete wins
Effect.all([...], { concurrency: 5 })  // Bounded parallel
```

### Configuration

```typescript
const port = Config.integer("PORT")
const host = Config.withDefault(Config.string("HOST"), "localhost")
const secret = Config.redacted("API_KEY")   // Masked in logs
const db = Config.nested("DATABASE")(Config.all({ host: Config.string("HOST"), port: Config.integer("PORT") }))
```

### State Management

```typescript
Ref.make(initial)                // Mutable reference (atomic)
Ref.get(ref) / Ref.set(ref, v)
Queue.bounded<T>(n)              // Producer/consumer
Deferred.make<E, A>()            // One-shot signal
Effect.makeSemaphore(n)          // Concurrency limiter
```

### Array Operations

```typescript
import { Array as Arr, Order } from "effect"

Arr.sort([3, 1, 2], Order.number)                    // [1, 2, 3]
Arr.sortWith(users, (u) => u.age, Order.number)       // Sort by field
Arr.sortBy(users, Order.mapInput(Order.number, (u: User) => u.age))  // Multi-criteria
```

### Deprecations

- `BigDecimal.fromNumber` → use `BigDecimal.unsafeFromNumber` (3.11.0+)
- `Schema.annotations()` now removes previously set identifier annotations (3.17.10)

## Conduit Migration Conventions

Conduit is mid-migration to Effect. Read `docs/plans/2026-04-23-effect-ts-migration-plan.md` for the full roadmap.

### Migration Layers (in order)

1. **Schema + Errors** — branded types, error hierarchy, RelayMessage union
2. **Resources** — SQLite lifecycle, connection pool
3. **Concurrency** — AbortSignal → Effect.interrupt, fiber supervision
4. **Dependency Injection** — ServiceRegistry → Layers
5. **Handlers** — request handlers as Effects
6. **Server** — HTTP/WS server as Effect program
7. **Frontend** — Svelte stores bridging to Effect runtime

### Key Mappings

| Current Pattern | Effect Replacement |
|---|---|
| `AbortSignal` / `AbortController` | `Fiber.interrupt` / `Effect.scoped` |
| `try-catch` + `async/await` | `Effect.gen` + typed errors |
| `RelayError` class hierarchy | `Schema.TaggedError` union |
| `ServiceRegistry` + constructor injection | `Context.Tag` / `Effect.Service` + Layers |
| `Promise.all()` / `Promise.allSettled()` | `Effect.all()` with concurrency options |
| `TrackedService` lifecycle | `Layer.scoped` with `acquireRelease` |
| pino structured logging | `Effect.log` + custom logger layer |

### Testing

Conduit uses Vitest with multiple config variants. When testing Effect code:

- Default unit tests: `pnpm test:unit`
- Run specific: `pnpm vitest run <path>`
- Use `@effect/vitest` for `it.effect`, `it.scoped`, `it.live`
- TestClock is active in `it.effect` — advance with `TestClock.adjust()`
- See `./references/testing.md` for comprehensive patterns

### Verification Path

```bash
pnpm check          # tsgo type checking
pnpm lint           # biome
pnpm test:unit      # unit tests
```

## Reference Files

Read these when working on specific topics:

- **`./references/critical-rules.md`** — Forbidden patterns and mandatory conventions
- **`./references/error-handling.md`** — Typed errors, defects, recovery, retry, timeout
- **`./references/schema.md`** — Validation, encoding/decoding, branded types, class schemas
- **`./references/layers.md`** — Dependency injection, service composition, Layer construction
- **`./references/concurrency.md`** — Fibers, synchronization primitives, interruption
- **`./references/streams.md`** — Stream creation, transformation, consumption, backpressure
- **`./references/testing.md`** — TestClock, test layers, mocking, `@effect/vitest` patterns
- **`./references/anti-patterns.md`** — Common mistakes and how to fix them
- **`./references/option-null.md`** — Option vs null boundary patterns
- **`./references/config.md`** — Configuration management, env vars, secrets
- **`./references/svelte-effect.md`** — Svelte 5 + Effect integration patterns
- **`./references/conduit-migration.md`** — Conduit-specific migration patterns and mappings
