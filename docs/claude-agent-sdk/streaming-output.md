# Stream responses in real-time

> Source: https://platform.claude.com/docs/en/agent-sdk/streaming-output
> Extracted: 2026-03-31

Get real-time responses from the Agent SDK as text and tool calls stream in

---

By default, the Agent SDK yields complete `AssistantMessage` objects after Claude finishes generating each response. To receive incremental updates as text and tool calls are generated, enable partial message streaming by setting `include_partial_messages` (Python) or `includePartialMessages` (TypeScript) to `true` in your options.

> This page covers output streaming (receiving tokens in real-time). For input modes (how you send messages), see [Streaming Input](./streaming-vs-single-mode.md).

## Enable streaming output

To enable streaming, set `include_partial_messages` (Python) or `includePartialMessages` (TypeScript) to `true` in your options. This causes the SDK to yield `StreamEvent` messages containing raw API events as they arrive, in addition to the usual `AssistantMessage` and `ResultMessage`.

Your code then needs to:
1. Check each message's type to distinguish `StreamEvent` from other message types
2. For `StreamEvent`, extract the `event` field and check its `type`
3. Look for `content_block_delta` events where `delta.type` is `text_delta`, which contain the actual text chunks

```python
from claude_agent_sdk import query, ClaudeAgentOptions
from claude_agent_sdk.types import StreamEvent
import asyncio


async def stream_response():
    options = ClaudeAgentOptions(
        include_partial_messages=True,
        allowed_tools=["Bash", "Read"],
    )

    async for message in query(prompt="List the files in my project", options=options):
        if isinstance(message, StreamEvent):
            event = message.event
            if event.get("type") == "content_block_delta":
                delta = event.get("delta", {})
                if delta.get("type") == "text_delta":
                    print(delta.get("text", ""), end="", flush=True)


asyncio.run(stream_response())
```

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "List the files in my project",
  options: {
    includePartialMessages: true,
    allowedTools: ["Bash", "Read"]
  }
})) {
  if (message.type === "stream_event") {
    const event = message.event;
    if (event.type === "content_block_delta") {
      if (event.delta.type === "text_delta") {
        process.stdout.write(event.delta.text);
      }
    }
  }
}
```

## StreamEvent reference

When partial messages are enabled, you receive raw Claude API streaming events wrapped in an object. The type has different names in each SDK:

- **Python**: `StreamEvent` (import from `claude_agent_sdk.types`)
- **TypeScript**: `SDKPartialAssistantMessage` with `type: 'stream_event'`

Both contain raw Claude API events, not accumulated text. You need to extract and accumulate text deltas yourself.

```python
@dataclass
class StreamEvent:
    uuid: str  # Unique identifier for this event
    session_id: str  # Session identifier
    event: dict[str, Any]  # The raw Claude API stream event
    parent_tool_use_id: str | None  # Parent tool ID if from a subagent
```

```typescript
type SDKPartialAssistantMessage = {
  type: "stream_event";
  event: RawMessageStreamEvent; // From Anthropic SDK
  parent_tool_use_id: string | null;
  uuid: UUID;
  session_id: string;
};
```

The `event` field contains the raw streaming event from the Claude API. Common event types include:

| Event Type | Description |
|:-----------|:------------|
| `message_start` | Start of a new message |
| `content_block_start` | Start of a new content block (text or tool use) |
| `content_block_delta` | Incremental update to content |
| `content_block_stop` | End of a content block |
| `message_delta` | Message-level updates (stop reason, usage) |
| `message_stop` | End of the message |

## Message flow

With partial messages enabled, you receive messages in this order:

```text
StreamEvent (message_start)
StreamEvent (content_block_start) - text block
StreamEvent (content_block_delta) - text chunks...
StreamEvent (content_block_stop)
StreamEvent (content_block_start) - tool_use block
StreamEvent (content_block_delta) - tool input chunks...
StreamEvent (content_block_stop)
StreamEvent (message_delta)
StreamEvent (message_stop)
AssistantMessage - complete message with all content
... tool executes ...
... more streaming events for next turn ...
ResultMessage - final result
```

Without partial messages enabled, you receive all message types except `StreamEvent`. Common types include `SystemMessage` (session initialization), `AssistantMessage` (complete responses), `ResultMessage` (final result), and `CompactBoundaryMessage` (indicates when conversation history was compacted).

## Stream text responses

To display text as it's generated, look for `content_block_delta` events where `delta.type` is `text_delta`.

## Stream tool calls

Tool calls also stream incrementally. You can track when tools start, receive their input as it's generated, and see when they complete. Use three event types:

- `content_block_start`: tool begins
- `content_block_delta` with `input_json_delta`: input chunks arrive
- `content_block_stop`: tool call complete

## Build a streaming UI

Combine text and tool streaming into a cohesive UI by tracking whether the agent is currently executing a tool (using an `in_tool` flag) to show status indicators like `[Using Read...]` while tools run. Text streams normally when not in a tool, and tool completion triggers a "done" message.

## Known limitations

Some SDK features are incompatible with streaming:

- **Extended thinking**: when you explicitly set `max_thinking_tokens` (Python) or `maxThinkingTokens` (TypeScript), `StreamEvent` messages are not emitted. You'll only receive complete messages after each turn. Note that thinking is disabled by default in the SDK, so streaming works unless you enable it.
- **Structured output**: the JSON result appears only in the final `ResultMessage.structured_output`, not as streaming deltas. See [structured outputs](./structured-outputs.md) for details.

## Next steps

- [Interactive vs one-shot queries](./streaming-vs-single-mode.md): choose between input modes for your use case
- [Structured outputs](./structured-outputs.md): get typed JSON responses from the agent
- [Permissions](./permissions.md): control which tools the agent can use
