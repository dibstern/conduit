# Track cost and usage

> Source: https://platform.claude.com/docs/en/agent-sdk/cost-tracking
> Extracted: 2026-03-31

Learn how to track token usage, deduplicate parallel tool calls, and calculate costs.

---

The Claude Agent SDK provides detailed token usage information for each interaction.

## Understand token usage

- **TypeScript** provides per-step token breakdowns on each assistant message, per-model cost via `modelUsage`, and a cumulative total on the result message.
- **Python** provides the accumulated total on the result message (`total_cost_usd` and `usage` dict). Per-step breakdowns are not available.

### Scopes

- **`query()` call:** one invocation producing one result message with total cost
- **Step:** a single request/response cycle within a `query()` call
- **Session:** a series of `query()` calls linked by a session ID

## Get the total cost of a query

```typescript
for await (const message of query({ prompt: "Summarize this project" })) {
  if (message.type === "result") {
    console.log(`Total cost: $${message.total_cost_usd}`);
  }
}
```

```python
async for message in query(prompt="Summarize this project"):
    if isinstance(message, ResultMessage):
        print(f"Total cost: ${message.total_cost_usd or 0}")
```

## Track detailed usage in TypeScript

### Track per-step usage

Parallel tool calls produce multiple assistant messages sharing the same `id`. Always deduplicate by ID:

```typescript
const seenIds = new Set<string>();
let totalInputTokens = 0;
let totalOutputTokens = 0;

for await (const message of query({ prompt: "Summarize this project" })) {
  if (message.type === "assistant") {
    const msgId = message.message.id;
    if (!seenIds.has(msgId)) {
      seenIds.add(msgId);
      totalInputTokens += message.message.usage.input_tokens;
      totalOutputTokens += message.message.usage.output_tokens;
    }
  }
}
```

### Break down usage per model

The result message includes `modelUsage`, a map of model name to per-model token counts and cost:

```typescript
for (const [modelName, usage] of Object.entries(message.modelUsage)) {
  console.log(`${modelName}: $${usage.costUSD.toFixed(4)}`);
  console.log(`  Input tokens: ${usage.inputTokens}`);
  console.log(`  Output tokens: ${usage.outputTokens}`);
  console.log(`  Cache read: ${usage.cacheReadInputTokens}`);
  console.log(`  Cache creation: ${usage.cacheCreationInputTokens}`);
}
```

## Accumulate costs across multiple calls

Each `query()` returns its own `total_cost_usd`. The SDK does not provide a session-level total; accumulate yourself.

## Handle errors, caching, and discrepancies

### Track costs on failed conversations

Both success and error result messages include `usage` and `total_cost_usd`.

### Track cache tokens

The SDK uses prompt caching automatically. Usage includes:
- `cache_creation_input_tokens`: tokens used to create cache entries (higher rate)
- `cache_read_input_tokens`: tokens read from cache (reduced rate)
