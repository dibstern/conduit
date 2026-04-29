# Option vs Null Patterns

## The Rule

Use `Option<T>` for Effect domain logic. Use `T | null` only at external boundaries.

## When to Use Option<T>

- Internal Effect computations
- Domain models where absence has meaning
- Function returns that may not produce a value
- Chain operations that may fail to produce a value

## When to Use T | null

- Svelte state/props (runes expect nullable primitives)
- Svelte template conditionals (`{#if value}`)
- JSON serialization (Option doesn't serialize to JSON)
- External API responses
- Database query results
- localStorage/sessionStorage values

## Boundary Normalization

```typescript
import { Option } from "effect"

// Incoming: null → Option (at API/storage boundary)
const fromApi = Option.fromNullable(response.data)
const fromStorage = Option.fromNullable(localStorage.getItem("key"))

// Outgoing: Option → null (for Svelte/JSON)
const toSvelte = Option.getOrNull(maybeValue)
const toJson = Option.getOrUndefined(maybeValue)
```

## Common Patterns

```typescript
Option.map(maybeUser, (user) => user.name)
Option.flatMap(maybeUser, (user) => Option.fromNullable(user.profile))
Option.getOrElse(maybeValue, () => defaultValue)

if (Option.isSome(maybeValue)) {
  console.log(maybeValue.value)  // Safe access
}
```

## Avoid Option<Option<T>> Creep

```typescript
// WRONG: Nested options from repeated normalization
Option.fromNullable(Option.fromNullable(x))

// RIGHT: Normalize once at the boundary
Option.fromNullable(x)

// Flatten if you end up with nested
Option.flatten(nestedOption)
```

## Schema Decoding

```typescript
import { Schema } from "effect"

// Optional field with Option type (internal)
const UserSchema = Schema.Struct({
  name: Schema.String,
  nickname: Schema.optionalWith(Schema.String, { as: "Option" })
})
// nickname: Option<string>

// Optional field with null (for JSON/Svelte compat)
const ApiUserSchema = Schema.Struct({
  name: Schema.String,
  nickname: Schema.NullOr(Schema.String)
})
// nickname: string | null
```

## Svelte Integration

```typescript
// In stores/services — convert at the Svelte boundary
const program = Effect.gen(function* () {
  const maybeUser = yield* findUser(id)  // Option<User>
  return Option.getOrNull(maybeUser)      // User | null for Svelte
})
```

```svelte
<!-- In template — use standard Svelte conditionals -->
{#if user}
  <UserProfile {user} />
{:else}
  <p>No user found</p>
{/if}
```
