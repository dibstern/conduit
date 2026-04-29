# Dependency Injection with Layers

## Overview

```
Layer<Out, Error, In>
        ^    ^     ^
        |    |     └── Dependencies required to build
        |    └──────── Errors during construction
        └───────────── Services provided
```

## Defining Services

### Context.Tag Pattern

```typescript
import { Context, Effect, Layer } from "effect"

// 1. Define service interface with Tag
class UserRepository extends Context.Tag("UserRepository")<
  UserRepository,
  {
    readonly findById: (id: string) => Effect.Effect<User, NotFoundError>
    readonly save: (user: User) => Effect.Effect<void, DatabaseError>
  }
>() {}

// 2. Use in effects — service becomes requirement
const getUser = (id: string) => Effect.gen(function* () {
  const repo = yield* UserRepository
  return yield* repo.findById(id)
})
// Type: Effect<User, NotFoundError, UserRepository>

// 3. Create live implementation
const UserRepositoryLive = Layer.succeed(UserRepository, {
  findById: (id) => /* ... */,
  save: (user) => /* ... */,
})
```

### Effect.Service Pattern (Simplified)

```typescript
class Logger extends Effect.Service<Logger>()("Logger", {
  accessors: true,  // Enables Logger.info(), Logger.error()
  sync: () => ({
    info: (msg: string) => console.log(`[INFO] ${msg}`),
    error: (msg: string) => console.error(`[ERROR] ${msg}`),
  })
}) {}

Logger.info("Hello")  // Effect<void, never, Logger>
```

### Effect.Service with Dependencies

```typescript
class Database extends Effect.Service<Database>()("Database", {
  effect: Effect.gen(function* () {
    const config = yield* Config
    const pool = yield* Effect.tryPromise(() => createPool(config.dbUrl))
    return { query: (sql: string) => Effect.tryPromise(() => pool.query(sql)) }
  }),
  dependencies: [Config.Default]
}) {}

// Database.Default includes Config.Default automatically
// Use Database.DefaultWithoutDependencies when deps provided separately
```

### Scoped Services (with Cleanup)

```typescript
class ConnectionPool extends Effect.Service<ConnectionPool>()("ConnectionPool", {
  scoped: Effect.gen(function* () {
    const config = yield* Config
    const pool = yield* Effect.tryPromise(() => createPool(config.dbUrl))
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => pool.end()).pipe(Effect.tap(() => Effect.log("Pool closed")))
    )
    return { pool }
  }),
  dependencies: [Config.Default]
}) {}
```

### Effect.Service with Parameters (3.16.0+)

```typescript
class ConfiguredApi extends Effect.Service<ConfiguredApi>()("ConfiguredApi", {
  effect: (config: { baseUrl: string }) =>
    Effect.succeed({ fetch: (path: string) => `${config.baseUrl}/${path}` })
}) {}
```

### Context.Reference (Defaultable Tags — 3.11.0+)

```typescript
class SpecialNumber extends Context.Reference<SpecialNumber>()(
  "SpecialNumber",
  { defaultValue: () => 2048 }
) {}
// No Layer required if default value suffices
```

## Layer Construction

```typescript
Layer.succeed(Tag, implementation)           // From sync value
Layer.effect(Tag, effect)                    // From Effect
Layer.scoped(Tag, scopedEffect)              // With cleanup
Layer.function(Tag, DepTag, fn)              // From function
```

## Layer Composition

```typescript
// Merge independent layers
const BaseLayer = Layer.merge(ConfigLive, LoggerLive)
// Type: Layer<Config | Logger, never, never>

// Provide dependencies
const DbWithConfig = Layer.provide(DatabaseLive, ConfigLive)
// Type: Layer<Database, DbError, never>

// Provide + keep dependency in output
const AppLayer = Layer.provideMerge(DatabaseLive, ConfigLive)
// Type: Layer<Database | Config, DbError, never>

// Full application layer
const AppLayer = pipe(
  Layer.merge(ConfigLive, LoggerLive),
  Layer.provideMerge(DatabaseLive),
  Layer.provideMerge(Layer.merge(UserRepositoryLive, PostRepositoryLive)),
  Layer.provideMerge(Layer.merge(UserServiceLive, PostServiceLive)),
)
```

## Providing Layers

```typescript
Effect.provide(program, AppLayer)                          // Provide full layer
Effect.provideService(program, Config, { dbUrl: "..." })   // Quick single service

// Production runtime
const runtime = ManagedRuntime.make(AppLayer)
await runtime.runPromise(program)
await runtime.dispose()
```

## Layer Memoization

Layers are automatically memoized by reference — same layer instance constructed once even if used multiple times.

```typescript
// Force fresh construction
const FreshDbLayer = Layer.fresh(DatabaseLive)
```

## Testing with Layers

```typescript
// Test implementation
const UserRepositoryTest = Layer.succeed(UserRepository, {
  findById: (id) =>
    id === "existing"
      ? Effect.succeed(testUser)
      : Effect.fail(new NotFoundError({ id })),
  save: () => Effect.void,
})

// Mock config provider
const TestConfig = Layer.setConfigProvider(
  ConfigProvider.fromMap(new Map([["API_KEY", "test"], ["PORT", "3000"]]))
)

// Compose test layer
const TestLayer = Layer.merge(UserRepositoryTest, TestConfig)
const result = await Effect.runPromise(Effect.provide(program, TestLayer))
```

## Best Practices

1. **One service per concern** — focused interfaces, not god services
2. **Provide at composition root** — not scattered through business logic
3. **Use `accessors: true`** for frequently used services
4. **Use `scoped`** for services that need cleanup (connections, pools, files)
5. **Avoid circular dependencies** — extract shared concern into a third service
