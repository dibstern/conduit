# Configuration in Effect-TS

## Basic Config

```typescript
import { Config, Effect } from "effect"

Config.string("API_KEY")        // string
Config.integer("PORT")          // number (integer)
Config.number("RATE")           // number (float)
Config.boolean("DEBUG")         // boolean
Config.date("START_DATE")       // Date (ISO format)
Config.duration("TIMEOUT")      // Duration ("5 seconds", "100ms")
Config.redacted("SECRET_KEY")   // Redacted<string> — masked in logs

// Use in effects
const program = Effect.gen(function* () {
  const port = yield* Config.integer("PORT")
  const key = yield* Config.redacted("API_KEY")
  return { port, apiKey: Redacted.value(key) }
})
```

## Optional and Defaults

```typescript
Config.option(Config.string("API_KEY"))                    // Effect<Option<string>>
Config.withDefault(Config.integer("PORT"), 3000)           // Falls back to 3000
Config.orElse(Config.string("API_URL"), () => Config.string("FALLBACK_URL"))
```

## Validation

```typescript
Config.integer("PORT").pipe(
  Config.validate({
    message: "Port must be between 1 and 65535",
    validation: (p) => p >= 1 && p <= 65535
  })
)

Config.string("LOG_LEVEL").pipe(
  Config.map((s) => s.toLowerCase()),
  Config.validate({
    message: "Invalid log level",
    validation: (s) => ["debug", "info", "warn", "error"].includes(s)
  })
)
```

## Structured Config

```typescript
// Nested with prefix
const dbConfig = Config.nested("DATABASE")(Config.all({
  host: Config.string("HOST"),     // DATABASE_HOST
  port: Config.integer("PORT"),    // DATABASE_PORT
  user: Config.string("USER"),     // DATABASE_USER
}))

// As a service
class AppConfig extends Effect.Service<AppConfig>()("AppConfig", {
  effect: Effect.gen(function* () {
    const server = yield* Config.all({
      host: Config.withDefault(Config.string("HOST"), "0.0.0.0"),
      port: Config.withDefault(Config.integer("PORT"), 3000),
    })
    const database = yield* Config.all({
      url: Config.string("DATABASE_URL"),
      maxConnections: Config.withDefault(Config.integer("DB_MAX_CONN"), 10),
    })
    return { server, database }
  })
}) {}
```

## Config Providers

```typescript
import { ConfigProvider, Layer } from "effect"

// Default reads from process.env

// From a Map (testing)
const testProvider = ConfigProvider.fromMap(
  new Map([["API_KEY", "test-key"], ["PORT", "8080"]])
)
const TestConfig = Layer.setConfigProvider(testProvider)

// From JSON object
ConfigProvider.fromJson({ API_KEY: "test", PORT: 8080, DATABASE: { HOST: "localhost" } })

// Fallback chain
const combinedProvider = ConfigProvider.orElse(
  secretsProvider,
  () => ConfigProvider.orElse(dotEnvProvider, () => ConfigProvider.fromEnv())
)
```

## Schema Integration

```typescript
const AppConfigSchema = Schema.Struct({
  port: Schema.Number.pipe(Schema.between(1, 65535)),
  host: Schema.String,
  logLevel: Schema.Literal("debug", "info", "warn", "error"),
})

const config = Config.all({
  port: Config.integer("PORT"),
  host: Config.string("HOST"),
  logLevel: Config.string("LOG_LEVEL"),
}).pipe(Config.map((c) => Schema.decodeSync(AppConfigSchema)(c)))
```

## Testing with Config

```typescript
const makeTestLayer = (overrides: Record<string, string>) =>
  Layer.setConfigProvider(ConfigProvider.fromMap(new Map(Object.entries(overrides))))

it("should use config", async () => {
  const program = Effect.gen(function* () {
    const url = yield* Config.string("API_URL")
    return url
  }).pipe(Effect.provide(makeTestLayer({ API_URL: "http://test.local" })))

  expect(await Effect.runPromise(program)).toBe("http://test.local")
})
```

## Best Practices

1. **Centralize config** — single source of truth per domain
2. **Use defaults** for optional values — don't require everything
3. **Validate early** — fail at startup, not at runtime
4. **Use `Redacted`** for secrets — prevents log leaks
5. **Config as a service** — `AppConfig` service for easy mocking
