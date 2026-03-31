# TypeScript SDK V2 interface (preview)

> Source: https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview
> Extracted: 2026-03-31

Preview of the simplified V2 TypeScript Agent SDK, with session-based send/stream patterns for multi-turn conversations.

---

> **Warning:** The V2 interface is an **unstable preview**. APIs may change before becoming stable. Some features like session forking are only available in V1.

The V2 Claude Agent TypeScript SDK removes the need for async generators and yield coordination. Each turn is a separate `send()`/`stream()` cycle. The API surface reduces to three concepts:

- `createSession()` / `resumeSession()`: Start or continue a conversation
- `session.send()`: Send a message
- `session.stream()`: Get the response

## Installation

```bash
npm install @anthropic-ai/claude-agent-sdk
```

## Quick start

### One-shot prompt

```typescript
import { unstable_v2_prompt } from "@anthropic-ai/claude-agent-sdk";

const result = await unstable_v2_prompt("What is 2 + 2?", {
  model: "claude-opus-4-6"
});
if (result.subtype === "success") {
  console.log(result.result);
}
```

### Basic session

```typescript
import { unstable_v2_createSession } from "@anthropic-ai/claude-agent-sdk";

await using session = unstable_v2_createSession({
  model: "claude-opus-4-6"
});

await session.send("Hello!");
for await (const msg of session.stream()) {
  if (msg.type === "assistant") {
    const text = msg.message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    console.log(text);
  }
}
```

### Multi-turn conversation

Sessions persist context across multiple exchanges. Call `send()` again on the same session:

```typescript
await using session = unstable_v2_createSession({
  model: "claude-opus-4-6"
});

// Turn 1
await session.send("What is 5 + 3?");
for await (const msg of session.stream()) {
  if (msg.type === "assistant") {
    const text = msg.message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    console.log(text);
  }
}

// Turn 2
await session.send("Multiply that by 2");
for await (const msg of session.stream()) {
  if (msg.type === "assistant") {
    const text = msg.message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    console.log(text);
  }
}
```

### Session resume

Resume a previous session using a stored session ID:

```typescript
import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
} from "@anthropic-ai/claude-agent-sdk";

// Create initial session
const session = unstable_v2_createSession({ model: "claude-opus-4-6" });
await session.send("Remember this number: 42");

let sessionId: string | undefined;
for await (const msg of session.stream()) {
  sessionId = msg.session_id;
}
session.close();

// Later: resume the session
await using resumedSession = unstable_v2_resumeSession(sessionId!, {
  model: "claude-opus-4-6"
});

await resumedSession.send("What number did I ask you to remember?");
for await (const msg of resumedSession.stream()) {
  // Claude remembers "42" from the previous session
}
```

### Cleanup

Sessions can be closed manually or automatically using `await using` (TypeScript 5.2+):

```typescript
// Automatic cleanup (TypeScript 5.2+)
await using session = unstable_v2_createSession({ model: "claude-opus-4-6" });

// Manual cleanup
const session = unstable_v2_createSession({ model: "claude-opus-4-6" });
// ... use the session ...
session.close();
```

## API reference

### `unstable_v2_createSession(options)`

Creates a new session for multi-turn conversations.

### `unstable_v2_resumeSession(sessionId, options)`

Resumes an existing session by ID.

### `unstable_v2_prompt(prompt, options)`

One-shot convenience function for single-turn queries. Returns `Promise<SDKResultMessage>`.

### SDKSession interface

```typescript
interface SDKSession {
  readonly sessionId: string;
  send(message: string | SDKUserMessage): Promise<void>;
  stream(): AsyncGenerator<SDKMessage, void>;
  close(): void;
}
```

## Feature availability

Not all V1 features are available in V2 yet:
- Session forking (`forkSession` option)
- Some advanced streaming input patterns

## Feedback

Report issues at [GitHub Issues](https://github.com/anthropics/claude-code/issues).
