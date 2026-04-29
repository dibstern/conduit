# Svelte 5 + Effect Integration

Patterns for bridging Effect's runtime with Svelte 5's runes-based reactivity. Replaces React-specific patterns
(effect-atom, hooks) with idiomatic Svelte equivalents.

## ManagedRuntime in Svelte

### Create at App Root

```typescript
// src/lib/runtime.ts
import { ManagedRuntime, Layer } from "effect"

// Compose your app layer
const AppLayer = Layer.mergeAll(
  ConfigLive,
  LoggerLive,
  DatabaseLive,
  // ... all services
)

// Create a single runtime — shared across the app
export const runtime = ManagedRuntime.make(AppLayer)
```

### Cleanup on App Teardown

In server/daemon contexts, dispose the runtime on shutdown:

```typescript
process.on("SIGTERM", async () => {
  await runtime.dispose()
  process.exit(0)
})
```

In SPA contexts, dispose when the app unmounts (rare — usually the page unloads first).

## Running Effects from Svelte Components

### Event Handlers

```typescript
<!-- Component.svelte -->
<script lang="ts">
import { runtime } from "$lib/runtime"
import { createUser } from "$lib/services/user"

let loading = $state(false)
let error = $state<string | null>(null)

async function handleCreate() {
  loading = true
  error = null
  const exit = await runtime.runPromiseExit(createUser({ name: "Alice" }))
  loading = false

  if (exit._tag === "Failure") {
    // Handle typed error
    const cause = exit.cause
    error = Cause.pretty(cause)
  }
}
</script>

<button onclick={handleCreate} disabled={loading}>Create</button>
{#if error}<p class="text-error">{error}</p>{/if}
```

### With Exit Pattern (Recommended)

```typescript
import { Effect, Exit, Cause, Option } from "effect"

// Helper for Svelte handlers
export async function runEffect<A, E>(
  effect: Effect.Effect<A, E>,
): Promise<{ ok: true; value: A } | { ok: false; error: E }> {
  const exit = await runtime.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) {
    return { ok: true, value: exit.value }
  }
  const error = Cause.failureOption(exit.cause)
  if (Option.isSome(error)) {
    return { ok: false, error: error.value }
  }
  // Defect — rethrow
  throw Cause.squash(exit.cause)
}
```

## Svelte Stores Wrapping Effect Services

### Basic Store Pattern

```typescript
// stores/users.svelte.ts
import { runtime } from "$lib/runtime"
import { UserService } from "$lib/services/user"
import type { User } from "$lib/types"

let users = $state<User[]>([])
let loading = $state(false)
let error = $state<string | null>(null)

export async function loadUsers() {
  loading = true
  error = null
  const exit = await runtime.runPromiseExit(UserService.findAll)
  loading = false

  if (Exit.isSuccess(exit)) {
    users = exit.value
  } else {
    error = Cause.pretty(exit.cause)
  }
}

export function getUserStore() {
  return {
    get users() { return users },
    get loading() { return loading },
    get error() { return error },
    loadUsers,
  }
}
```

### Reactive Store with Effect Stream

```typescript
// stores/events.svelte.ts
import { Effect, Stream, Fiber } from "effect"
import { runtime } from "$lib/runtime"

let events = $state<AppEvent[]>([])
let fiber: Fiber.RuntimeFiber<void, never> | null = null

export function startEventStream(sessionId: string) {
  // Run the stream subscription as a background fiber
  const program = Effect.gen(function* () {
    const eventService = yield* EventService
    const stream = eventService.subscribe(sessionId)

    yield* stream.pipe(
      Stream.tap((event) =>
        Effect.sync(() => {
          events = [...events, event]
        })
      ),
      Stream.runDrain,
    )
  })

  // Fork and store the fiber for cleanup
  runtime.runPromise(
    Effect.gen(function* () {
      fiber = yield* Effect.fork(program)
    })
  )
}

export function stopEventStream() {
  if (fiber) {
    runtime.runPromise(Fiber.interrupt(fiber))
    fiber = null
  }
}

export function getEventStore() {
  return {
    get events() { return events },
    startEventStream,
    stopEventStream,
  }
}
```

## $effect() for Lifecycle Integration

### Subscribe on Mount, Cleanup on Unmount

```svelte
<script lang="ts">
import { getEventStore } from "$lib/stores/events.svelte"

const store = getEventStore()

// Start stream when component mounts, stop on unmount
$effect(() => {
  store.startEventStream(sessionId)
  return () => store.stopEventStream()
})
</script>
```

### Derived State from Effect Results

```svelte
<script lang="ts">
import { runtime } from "$lib/runtime"

let userId = $state("user-123")
let user = $state<User | null>(null)

// Re-fetch when userId changes
$effect(() => {
  const id = userId  // Track dependency
  runtime.runPromise(UserService.findById(id)).then(
    (u) => { user = u },
    (err) => { console.error(err) },
  )
})

// Derived from fetched data
let displayName = $derived(user?.name ?? "Loading...")
</script>
```

## Option → Nullable at Template Boundary

Svelte templates expect `T | null | undefined`, not `Option<T>`. Convert at the boundary:

```typescript
import { Option } from "effect"

// In store or component script
const maybeUser: Option.Option<User> = yield* findUser(id)
const user: User | null = Option.getOrNull(maybeUser)

// In template
{#if user}
  <UserProfile {user} />
{:else}
  <p>No user found</p>
{/if}
```

### Schema with Optional Fields for Svelte Props

```typescript
// For props that come from Svelte, accept nullable
// For internal Effect logic, use Option
const fromProp = Option.fromNullable(propValue)   // T | null → Option<T>
const toProp = Option.getOrNull(optionValue)       // Option<T> → T | null
const toTemplate = Option.getOrUndefined(optionValue) // Option<T> → T | undefined
```

## Error Display Patterns

### Tagged Error → User Message

```typescript
import { Match } from "effect"

export const errorToMessage = Match.type<AppError>().pipe(
  Match.tag("NotFoundError", (e) => `${e.entityType} not found`),
  Match.tag("ValidationError", (e) => e.message),
  Match.tag("NetworkError", () => "Connection failed. Please retry."),
  Match.tag("AuthenticationError", () => "Please log in again."),
  Match.orElse(() => "An unexpected error occurred."),
)
```

```svelte
{#if error}
  <div class="text-error">{errorToMessage(error)}</div>
{/if}
```

## Fiber Cancellation Replacing AbortController

The conduit codebase currently uses `AbortSignal` / `AbortController` for cancellation. In Effect, fibers replace this:

```typescript
// BEFORE (current conduit pattern)
const controller = new AbortController()
const result = await fetchWithSignal(url, controller.signal)
// Later: controller.abort()

// AFTER (Effect pattern)
const program = Effect.gen(function* () {
  return yield* fetchEffect(url)
})
const fiber = yield* Effect.fork(program)
// Later:
yield* Fiber.interrupt(fiber)
```

In Svelte components, store the fiber reference and interrupt on cleanup:

```svelte
<script lang="ts">
import { Effect, Fiber } from "effect"

let activeFiber: Fiber.RuntimeFiber<any, any> | null = null

$effect(() => {
  runtime.runPromise(
    Effect.gen(function* () {
      activeFiber = yield* Effect.fork(longRunningEffect)
      yield* Fiber.join(activeFiber)
    })
  )

  return () => {
    if (activeFiber) {
      runtime.runPromise(Fiber.interrupt(activeFiber))
    }
  }
})
</script>
```

## Best Practices

1. **One ManagedRuntime per app** — create at root, pass by import, dispose on shutdown
2. **Convert Option → null at the Svelte boundary** — templates and props expect nullable
3. **Use `$effect()` return for cleanup** — interrupt fibers, cancel subscriptions
4. **Keep Effect logic in stores/services, not components** — components call store functions
5. **Use `runPromiseExit` for error handling** — don't let defects silently disappear
6. **Don't nest `Effect.runPromise` inside `Effect.gen`** — stay in one runtime context
7. **Avoid reactive Effects in hot loops** — batch updates, use streams for high-frequency data
