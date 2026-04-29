# Error Handling in Effect-TS

## The Error Model

Effect distinguishes between two types of failures:

| Type | Description | Tracked | Recovery |
|------|-------------|---------|----------|
| **Expected Errors (Failures)** | Domain errors callers can handle | In type system (`E`) | `catchAll`, `catchTag` |
| **Unexpected Errors (Defects)** | Bugs, invariant violations | Not in type system | `catchAllDefect` (rare) |

### Error Taxonomy

| Category                | Examples                   | Handling                  |
| ----------------------- | -------------------------- | ------------------------- |
| **Expected Rejections** | User cancel, deny          | Graceful exit, no retry   |
| **Domain Errors**       | Validation, business rules | Show to user, don't retry |
| **Defects**             | Bugs, assertions           | Log + alert, investigate  |
| **Interruptions**       | Fiber cancel, timeout      | Cleanup, may retry        |
| **Unknown/Foreign**     | Thrown exceptions          | Normalize at boundary     |

## Creating Typed Errors

### Using Data.TaggedError

```typescript
import { Data, Effect } from "effect"

class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly entityType: string
  readonly id: string
}> {}

class ValidationError extends Data.TaggedError("ValidationError")<{
  readonly field: string
  readonly message: string
}> {}

// Usage
const findUser = (id: string): Effect.Effect<User, NotFoundError> =>
  Effect.gen(function* () {
    const user = yield* db.find(id)
    if (!user) {
      return yield* Effect.fail(new NotFoundError({ entityType: "User", id }))
    }
    return user
  })
```

### Using Schema.TaggedError (Serializable)

```typescript
import { Schema } from "effect"

class ApiError extends Schema.TaggedError<ApiError>()("ApiError", {
  status: Schema.Number,
  message: Schema.String,
  code: Schema.optional(Schema.String),
}) {}

const error = new ApiError({ status: 404, message: "Not found" })
JSON.stringify(error)  // Works — serializable
```

## Failing Effects

```typescript
// With typed error
Effect.fail(new NotFoundError({ entityType: "User", id: "123" }))

// From sync code that may throw
Effect.try({
  try: () => JSON.parse(invalidJson),
  catch: (e) => new ParseError({ message: String(e) })
})

// From promise that may reject
Effect.tryPromise({
  try: () => fetch(url).then(r => r.json()),
  catch: (e) => new NetworkError({ url, status: 500 })
})
```

## Creating Defects

Use defects for unrecoverable errors that indicate bugs:

```typescript
Effect.die(new Error("This should never happen"))
Effect.dieMessage("Invariant violated: x must be positive")
Effect.orDie(mayFailEffect)    // Convert errors to defects
Effect.orDieWith(effect, (e) => new Error(`Critical: ${e.message}`))
```

**When to use defects:** division by zero, array index OOB, assertion failures, unhandled enum cases.

## Error Recovery

### catchTag — Handle Specific Error

```typescript
const program = pipe(
  fetchUser(id),
  Effect.catchTag("NotFoundError", (e) => {
    console.log(`User ${e.id} not found, using default`)
    return Effect.succeed(defaultUser)
  })
)
// Type: Effect<User, NetworkError, R>
// NotFoundError handled, NetworkError still possible
```

### catchTags — Handle Multiple Errors

```typescript
Effect.catchTags(effect, {
  NotFoundError: (e) => Effect.succeed(defaultUser),
  NetworkError: (e) => Effect.retry(fetchUser(id), Schedule.recurs(3)),
  ValidationError: (e) => Effect.fail(new HttpError(400, e.message))
})
```

### catchAll — Handle All Errors

```typescript
Effect.catchAll(effect, (error) => Effect.succeed(fallback))
```

### catchSome — Conditional Recovery

```typescript
Effect.catchSome(effect, (error) => {
  if (error._tag === "NotFoundError" && error.id === "admin") {
    return Option.some(Effect.succeed(adminUser))
  }
  return Option.none()  // Don't handle, propagate
})
```

### Normalize Unknown Errors at Boundary

```typescript
const safeBoundary = Effect.catchAllDefect(effect, (defect) =>
  Effect.fail(new UnknownError({ cause: defect }))
)
```

### Handle Interruptions Separately

```typescript
Effect.onInterrupt(effect, () => Effect.log("Operation cancelled"))

Effect.catchTag(effect, "UserCancelledError", () => Effect.succeed(null))
```

## Converting Errors

```typescript
// To Either
Effect.either(mayFail)  // Effect<Either<E, A>, never, R>

// To Option (errors become None)
Effect.option(mayFail)  // Effect<Option<A>, never, R>

// Transform error type
Effect.mapError(effect, (e) => new HttpError(500, e.message))

// Transform both
Effect.mapBoth(effect, {
  onFailure: (e) => new WrapperError(e),
  onSuccess: (a) => a.toUpperCase()
})
```

## Error Accumulation

```typescript
// Collect ALL errors (not just first)
Effect.all([validateName(input.name), validateEmail(input.email)], { mode: "validate" })

// Partition results
const results = yield* Effect.partition(items.map(processItem), { concurrency: 10 })
// results.left: errors, results.right: successes
```

## Cause: The Full Error Story

```typescript
const withCause = Effect.catchAllCause(effect, (cause) => {
  if (Cause.isFailure(cause)) { /* cause.error — typed error */ }
  if (Cause.isDie(cause)) { /* cause.defect — unknown defect */ }
  if (Cause.isInterrupted(cause)) { /* fiber interrupted */ }
  return Effect.succeed(fallback)
})

// Pretty print for debugging
Cause.pretty(cause)
```

## Retry and Timeout

```typescript
// Retry 3 times
Effect.retry(effect, Schedule.recurs(3))

// Exponential backoff, max 5 attempts
Effect.retry(effect, Schedule.exponential("100 millis").pipe(Schedule.compose(Schedule.recurs(5))))

// Retry only specific errors
Effect.retry(effect, { schedule: Schedule.recurs(3), while: (e) => e._tag === "NetworkError" })

// Timeout
Effect.timeout(effect, "5 seconds")  // Effect<Option<A>, E, R>
Effect.timeoutFail(effect, { duration: "5 seconds", onTimeout: () => new TimeoutError() })
```

## Pattern Matching for Errors

```typescript
import { Match } from "effect"

// Replace chained catchTag with exhaustive match
Effect.catchAll(effect, (error) =>
  Match.value(error).pipe(
    Match.tag("NotFoundError", (e) => Effect.succeed(defaultUser)),
    Match.tag("ValidationError", (e) => Effect.fail(new HttpError(400, e.message))),
    Match.tag("NetworkError", () => Effect.retry(effect, Schedule.recurs(3))),
    Match.exhaustive  // Compile error if case missing
  )
)
```

## Best Practices

1. **Use tagged errors** — `Data.TaggedError` or `Schema.TaggedError`, not plain `Error`
2. **Be specific** — one error type per failure mode, discriminated union for service errors
3. **Defects for bugs only** — never for domain errors
4. **Handle close to source** — translate low-level errors where you have context
5. **Log before recovery** — `Effect.tapError(e => Effect.log(...))` before `catchAll`
