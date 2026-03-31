# Claude Agent SDK — Guides Summary

Extracted: 2026-03-31
Source: https://platform.claude.com/docs/en/agent-sdk/

## Streaming Input vs Single Message

Two input modes:
- **Streaming Input (Recommended)**: Persistent interactive session via async generator. Supports image uploads, queued messages, interruption, hooks, real-time feedback.
- **Single Message**: One-shot queries using `query({ prompt: "string" })`. No image attachments, hooks, or dynamic queueing. Use `continue: true` for follow-ups.

## Streaming Output

Enable with `includePartialMessages: true`. Yields `SDKPartialAssistantMessage` (type: `"stream_event"`) with raw Claude API events: `message_start`, `content_block_start`, `content_block_delta` (text_delta, input_json_delta), `content_block_stop`, `message_delta`, `message_stop`.

## Agent Loop

1. Receive prompt -> 2. Claude evaluates -> 3. Execute tools -> 4. Repeat -> 5. Return result.
Each full cycle = one turn. `maxTurns` caps tool-use round trips. `maxBudgetUsd` caps cost.
Result subtypes: `success`, `error_max_turns`, `error_max_budget_usd`, `error_during_execution`, `error_max_structured_output_retries`.

## Custom Tools

Define with `tool()` helper + Zod schema, wrap in `createSdkMcpServer()`, pass via `mcpServers` option:
```typescript
const myTool = tool("name", "description", { param: z.string() }, async (args) => {
  return { content: [{ type: "text", text: "result" }] };
});
const server = createSdkMcpServer({ name: "my-server", tools: [myTool] });
// Use: mcpServers: { "my-server": server }, allowedTools: ["mcp__my-server__name"]
```

## Hosting

SDK runs as long-lived process, NOT stateless. Patterns:
1. **Ephemeral**: New container per task, destroy when done
2. **Long-running**: Persistent containers, multiple processes
3. **Hybrid**: Ephemeral with session resume
4. **Single container**: Multiple SDK processes in one container

Requirements: 1 CPU, 1GiB RAM, 5GiB disk, outbound HTTPS to api.anthropic.com.

## Cost Tracking

- `ResultMessage.total_cost_usd` — authoritative per-query cost
- Deduplicate parallel tool calls by `message.message.id`
- `modelUsage` (TS only) — per-model breakdown
- Cache tokens tracked separately: `cache_creation_input_tokens`, `cache_read_input_tokens`

## File Checkpointing

Enable with `enableFileCheckpointing: true`. Tracks Write/Edit/NotebookEdit changes. Capture `UserMessage.uuid` as checkpoint, call `query.rewindFiles(checkpointId)` to restore. Requires `extraArgs: { 'replay-user-messages': null }`.

## Structured Outputs

Pass `outputFormat: { type: "json_schema", schema }` to `query()`. Result in `ResultMessage.structured_output`. Supports Zod schemas via `z.toJSONSchema()`.

## Plugins

Load from filesystem via `plugins: [{ type: "local", path: "./my-plugin" }]`. Must have `.claude-plugin/plugin.json`. Skills namespaced as `plugin-name:skill-name`.

## Tool Search

Enabled by default. Scales to 10,000 tools. Withholds tool definitions from context, discovers 3-5 relevant tools per search. Configure with `ENABLE_TOOL_SEARCH` env var: `true` (default), `auto`, `auto:N`, `false`.

## V2 Preview (Unstable)

Simplified interface: `createSession()` + `send()`/`stream()`:
```typescript
await using session = unstable_v2_createSession({ model: "claude-opus-4-6" });
await session.send("Hello!");
for await (const msg of session.stream()) { /* ... */ }
```
Not all V1 features available yet.

## Migration from Claude Code SDK

Package renamed: `@anthropic-ai/claude-code` -> `@anthropic-ai/claude-agent-sdk`
Type renamed: `ClaudeCodeOptions` -> `ClaudeAgentOptions`
Breaking: No system prompt by default, no filesystem settings by default.
