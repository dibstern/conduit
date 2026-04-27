# Effect Schema: Validation and Serialization

## Overview

`Schema<Type, Encoded, Requirements>` describes data transformation:

```typescript
Schema<Type, Encoded, Requirements>
//      ^      ^         ^
//      |      |         └── Dependencies for decoding
//      |      └──────────── Wire format (JSON, strings)
//      └─────────────────── Runtime type (business logic)
```

## Basic Schemas

```typescript
import { Schema } from "effect"

// Primitives
Schema.String        // Schema<string, string>
Schema.Number        // Schema<number, number>
Schema.Boolean       // Schema<boolean, boolean>
Schema.Date          // Schema<Date, string> (ISO format)
Schema.BigInt        // Schema<bigint, string>

// Literals
Schema.Literal("pending", "active", "done")  // "pending" | "active" | "done"

// Null/Undefined
Schema.NullOr(Schema.String)       // string | null
Schema.UndefinedOr(Schema.String)  // string | undefined
```

## Structs (Objects)

```typescript
const User = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  email: Schema.String,
  age: Schema.Number,
})

// Infer TypeScript type
type User = Schema.Schema.Type<typeof User>

// Optional fields
const UserWithOptional = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  bio: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.Date, { default: () => new Date() }),
})
```

## Arrays and Records

```typescript
Schema.Array(Schema.String)                          // string[]
Schema.NonEmptyArray(Schema.String)                  // [string, ...string[]]
Schema.Record({ key: Schema.String, value: Schema.Number })  // Record<string, number>
Schema.Tuple(Schema.Number, Schema.Number)           // [number, number]
```

## Unions and Discriminated Unions

```typescript
// Simple union
Schema.Union(Schema.String, Schema.Number)

// Discriminated union (recommended)
const Shape = Schema.Union(
  Schema.Struct({ type: Schema.Literal("circle"), radius: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("rectangle"), width: Schema.Number, height: Schema.Number }),
)

type Shape = Schema.Schema.Type<typeof Shape>
```

## Decoding (Validation)

```typescript
// Throws on failure
Schema.decodeUnknownSync(User)({ name: "John", age: 30 })

// Returns Either
Schema.decodeUnknownEither(User)({ name: "John", age: "30" })

// Returns Effect (typed ParseError)
Schema.decodeUnknown(User)(input)  // Effect<User, ParseError>

// With options
Schema.decodeUnknownSync(User, { errors: "all", onExcessProperty: "error" })(data)
```

## Encoding (Serialization)

```typescript
Schema.encodeSync(User)(user)  // Typed → wire format

// With Date transformation
const Event = Schema.Struct({ name: Schema.String, date: Schema.Date })
Schema.encodeSync(Event)({ name: "Party", date: new Date() })
// → { name: "Party", date: "2024-01-15T..." }
```

## Transformations

```typescript
// Built-in
Schema.NumberFromString   // "42" → 42
Schema.Date               // ISO string → Date
Schema.Trim               // " hello " → "hello"
Schema.Lowercase
Schema.parseJson(Schema.Struct({ foo: Schema.Number }))  // JSON string → parsed

// Custom
const Slug = Schema.transform(Schema.String, Schema.String, {
  decode: (s) => s.toLowerCase().replace(/\s+/g, "-"),
  encode: (s) => s.replace(/-/g, " "),
})

// With validation (can fail)
const PositiveNumber = Schema.transformOrFail(Schema.Number, Schema.Number, {
  decode: (n, _, ast) =>
    n > 0 ? ParseResult.succeed(n) : ParseResult.fail(new ParseResult.Type(ast, n, "Must be positive")),
  encode: ParseResult.succeed,
})
```

## Filters (Refinements)

```typescript
const Email = Schema.String.pipe(
  Schema.pattern(/^[^@]+@[^@]+\.[^@]+$/),
  Schema.brand("Email")
)

const Age = Schema.Number.pipe(Schema.int(), Schema.between(0, 150), Schema.brand("Age"))

const Username = Schema.String.pipe(
  Schema.minLength(3),
  Schema.maxLength(20),
  Schema.pattern(/^[a-z0-9_]+$/),
  Schema.brand("Username")
)
```

## Branded Types

```typescript
const UserId = Schema.String.pipe(Schema.brand("UserId"))
const PostId = Schema.String.pipe(Schema.brand("PostId"))

type UserId = Schema.Schema.Type<typeof UserId>
type PostId = Schema.Schema.Type<typeof PostId>

// TypeScript prevents mixing
const userId: UserId = Schema.decodeSync(UserId)("user-123")
getUser(userId)   // OK
getUser(postId)   // Type error!
```

## Class-Based Schemas

```typescript
class User extends Schema.Class<User>("User")({
  id: Schema.String,
  name: Schema.String,
  email: Schema.String,
}) {
  get displayName() { return `${this.name} <${this.email}>` }
}

const user = new User({ id: "1", name: "John", email: "john@example.com" })
user instanceof User  // true

const decoded = Schema.decodeSync(User)({ id: "1", name: "John", email: "john@example.com" })
decoded instanceof User  // true
```

## Tagged Errors with Schema

```typescript
class NotFoundError extends Schema.TaggedError<NotFoundError>()("NotFoundError", {
  entityType: Schema.String,
  id: Schema.String,
}) {}

const error = new NotFoundError({ entityType: "User", id: "123" })
JSON.stringify(error)  // Works — serializable
```

## Effect Data Types

```typescript
Schema.Option(Schema.Number)   // { _tag: "None" } | { _tag: "Some", value: 42 }
Schema.Either({ left: Schema.String, right: Schema.Number })
Schema.Exit({ success: Schema.Number, failure: Schema.String })
```

## Best Practices

1. **Define schemas at module level** — reusable, not inline
2. **Use brands for domain types** — prevents mixing IDs, ensures nominal typing
3. **Validate at boundaries** — decode external data with `decodeUnknown`, trust internal data
4. **Use `decodeUnknown` for external data** — don't cast first
