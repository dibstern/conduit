# Stream Patterns

`Stream<A, E, R>` represents a program that emits zero or more values of type `A`. Streams are lazy, pull-based
sequences that can be infinite. Handle with care.

## Creating Streams

```typescript
import { Stream } from "effect"

// From values
Stream.make(1, 2, 3)
Stream.fromIterable([1, 2, 3])
Stream.empty

// From effects
Stream.fromEffect(fetchUser())
Stream.repeatEffect(Effect.sync(() => Math.random()))  // Infinite

// From async iterable
Stream.fromAsyncIterable(asyncGenerator(), (error) => new StreamError({ cause: error }))

// Unfold (generate sequence)
Stream.unfold(0, (n) => Option.some([n, n + 1]))  // 0, 1, 2, 3, ...

// Paginated API
Stream.paginateEffect(1, (page) =>
  fetchPage(page).pipe(
    Effect.map((data) => [data.items, data.hasMore ? Option.some(page + 1) : Option.none()])
  )
)

// From callbacks
Stream.async<Event, Error>((emit) => {
  const handler = (event: Event) => emit.single(event)
  eventEmitter.on("event", handler)
  return Effect.sync(() => eventEmitter.off("event", handler))
})
```

## Transforming Streams

```typescript
Stream.map(stream, (x) => x * 2)
Stream.filter(stream, (x) => x > 0)
Stream.flatMap(userIds, (id) => Stream.fromEffect(fetchUser(id)))
Stream.tap(stream, (x) => Effect.log(`Processing: ${x}`))
Stream.scan(stream, 0, (acc, x) => acc + x)  // Running totals
Stream.mapEffect(stream, (x) => processAsync(x))
```

## Consuming Streams

```typescript
// Collect all (DANGEROUS for infinite streams)
yield* Stream.runCollect(stream)  // Chunk<A>

// Process each element
yield* Stream.runForEach(stream, (v) => Effect.log(`Got: ${v}`))

// Fold/reduce
yield* Stream.runFold(stream, 0, (acc, n) => acc + n)

// First/last element
yield* Stream.runHead(stream)  // Option<A>
yield* Stream.runLast(stream)

// Drain (side effects only)
yield* Stream.runDrain(stream)

// With Sinks
Stream.run(stream, Sink.sum)
Stream.run(stream, Sink.count)
Stream.run(stream, Sink.take(5))
```

## Bound Consumption (Critical for Safety)

```typescript
// WRONG: Hangs forever on infinite stream
yield* Stream.runCollect(infiniteStream)

// RIGHT: Take first N elements
yield* Stream.runCollect(Stream.take(infiniteStream, 100))

// RIGHT: Take until condition
yield* Stream.runCollect(Stream.takeUntil(stream, (x) => x > 100))

// RIGHT: Take while condition holds
yield* Stream.runCollect(Stream.takeWhile(stream, (x) => x < 100))

// RIGHT: Apply timeout
yield* Stream.runCollect(stream).pipe(Effect.timeout("5 seconds"))
```

## Chunking and Batching

```typescript
Stream.grouped(stream, 100)                          // Chunks of 100
Stream.groupedWithin(stream, 100, "1 second")        // Up to 100 or 1s
Stream.rechunk(stream, 1000)                         // Re-chunk for efficiency
Stream.flattenChunks(chunkedStream)                  // Flatten chunks
```

## Combining Streams

```typescript
Stream.merge(stream1, stream2)                       // Interleaved
Stream.mergeAll([s1, s2, s3], { concurrency: 3 })    // Many, bounded
Stream.concat(first, second)                         // Sequential
Stream.zip(stream1, stream2)                         // Pair-wise
Stream.zipLatest(stream1, stream2)                   // Latest from each
```

## Error Handling

```typescript
Stream.catchAll(stream, (e) => Stream.make(fallback))
Stream.retry(stream, Schedule.exponential("100 millis"))
Stream.mapError(stream, (e) => new WrappedError(e))
Stream.tapError(stream, (e) => Effect.log(`Stream error: ${e}`))
```

## Timing and Rate Control

```typescript
Stream.debounce(stream, "300 millis")
Stream.throttle(stream, { cost: () => 1, units: 10, duration: "1 second" })
Stream.schedule(stream, Schedule.spaced("100 millis"))
Stream.timeout(stream, "5 seconds")
```

## Buffering

```typescript
Stream.buffer(stream, { capacity: 100 })                        // Backpressure
Stream.buffer(stream, { capacity: 100, strategy: "sliding" })   // Drop oldest
Stream.buffer(stream, { capacity: 100, strategy: "dropping" })  // Drop newest
```

## Resource Safety

```typescript
// Bracket pattern
Stream.acquireRelease(acquire, release)

// Scoped stream
Stream.scoped(Effect.acquireRelease(open, close))

// Finalizer
Stream.ensuring(stream, cleanup)
```

## Common Gotchas

1. **Infinite streams**: Always bound consumption with `take`, `takeUntil`, or timeout
2. **Backpressure**: Streams are pull-based; slow consumers automatically apply backpressure
3. **Resource leaks**: Use scoped/bracket patterns for resources
4. **Chunking overhead**: Rechunk for better performance with small items
5. **Error propagation**: Errors terminate the stream; use `catchAll` to recover

## Patterns

### Batched Processing

```typescript
Stream.fromIterable(items).pipe(
  Stream.grouped(batchSize),
  Stream.mapEffect((batch) => processBatch(batch)),
  Stream.runDrain,
)
```

### Rate-Limited API Calls

```typescript
Stream.fromIterable(urls).pipe(
  Stream.mapEffect((url) => fetchUrl(url), { concurrency: 5 }),
  Stream.throttle({ cost: () => 1, units: 10, duration: "1 second" }),
  Stream.runCollect,
)
```

### Event Processing with Windowing

```typescript
events.pipe(
  Stream.groupedWithin(1000, "10 seconds"),
  Stream.mapEffect((batch) => Effect.gen(function* () {
    yield* saveToDatabase(aggregateEvents(Chunk.toArray(batch)))
    yield* Effect.log(`Processed ${batch.length} events`)
  })),
  Stream.runDrain,
)
```
