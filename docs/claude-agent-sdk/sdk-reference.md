# Claude Agent SDK Reference (TypeScript)

Build AI agents using Claude as a library. The agent autonomously reads files, runs commands, edits code, searches the web, etc. Same tools and agent loop that power Claude Code.

**Key difference from OpenCode SDK**: This is NOT a REST client. It spawns a Claude Code process and manages an agentic loop with built-in tool execution.

## Install

```bash
npm install @anthropic-ai/claude-agent-sdk
```

## Auth

Set `ANTHROPIC_API_KEY` environment variable. Also supports:
- Amazon Bedrock: `CLAUDE_CODE_USE_BEDROCK=1`
- Google Vertex AI: `CLAUDE_CODE_USE_VERTEX=1`
- Microsoft Azure: `CLAUDE_CODE_USE_FOUNDRY=1`

**IMPORTANT**: Anthropic does NOT allow third-party developers to offer claude.ai login or rate limits unless previously approved. Use API key auth.

## Core Function: `query()`

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Find and fix the bug in auth.py",
  options: { allowedTools: ["Read", "Edit", "Bash"] }
})) {
  console.log(message);
}
```

Returns `Query` object extending `AsyncGenerator<SDKMessage, void>`.

## Key Options

| Option | Type | Description |
|--------|------|-------------|
| `allowedTools` | `string[]` | Tools to auto-approve |
| `disallowedTools` | `string[]` | Tools to always deny |
| `permissionMode` | `PermissionMode` | `"default"`, `"acceptEdits"`, `"bypassPermissions"`, `"plan"`, `"dontAsk"` |
| `canUseTool` | `CanUseTool` | Custom permission callback |
| `model` | `string` | Claude model to use |
| `cwd` | `string` | Working directory (default: `process.cwd()`) |
| `env` | `Record<string, string>` | Environment variables |
| `systemPrompt` | `string \| { type: 'preset', preset: 'claude_code', append?: string }` | System prompt |
| `resume` | `string` | Session ID to resume |
| `continue` | `boolean` | Continue most recent session |
| `forkSession` | `boolean` | Fork when resuming |
| `maxTurns` | `number` | Max agentic turns |
| `maxBudgetUsd` | `number` | Budget cap |
| `agents` | `Record<string, AgentDefinition>` | Subagent definitions |
| `mcpServers` | `Record<string, McpServerConfig>` | MCP server configs |
| `hooks` | `Partial<Record<HookEvent, HookCallbackMatcher[]>>` | Hook callbacks |
| `settingSources` | `SettingSource[]` | `["user", "project", "local"]` — defaults to `[]` |
| `persistSession` | `boolean` | Default `true`; set `false` for ephemeral |
| `includePartialMessages` | `boolean` | Include streaming partial messages |
| `abortController` | `AbortController` | For cancellation |
| `effort` | `'low' \| 'medium' \| 'high' \| 'max'` | Thinking depth |
| `thinking` | `ThinkingConfig` | Thinking/reasoning config |

## Query Object Methods

```typescript
interface Query extends AsyncGenerator<SDKMessage, void> {
  interrupt(): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model?: string): Promise<void>;
  initializationResult(): Promise<SDKControlInitializeResponse>;
  supportedCommands(): Promise<SlashCommand[]>;
  supportedModels(): Promise<ModelInfo[]>;
  supportedAgents(): Promise<AgentInfo[]>;
  mcpServerStatus(): Promise<McpServerStatus[]>;
  accountInfo(): Promise<AccountInfo>;
  streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>;
  close(): void;
}
```

## Message Types

Union type `SDKMessage`:
- `SDKAssistantMessage` — `{ type: "assistant", uuid, session_id, message: BetaMessage, parent_tool_use_id }`
- `SDKUserMessage` — `{ type: "user", uuid?, session_id, message: MessageParam }`
- `SDKResultMessage` — `{ type: "result", subtype: "success" | "error_*", session_id, result, total_cost_usd, usage }`
- `SDKSystemMessage` — `{ type: "system", subtype: "init", session_id, tools, model, mcp_servers }`
- `SDKPartialAssistantMessage` — `{ type: "stream_event", event: BetaRawMessageStreamEvent }`
- Plus: `SDKStatusMessage`, `SDKHookStartedMessage`, `SDKToolProgressMessage`, `SDKTaskNotificationMessage`, etc.

## Built-in Tools

| Tool | Description |
|------|-------------|
| `Read` | Read files |
| `Write` | Create files |
| `Edit` | Edit files (string replacement) |
| `Bash` | Run terminal commands |
| `Glob` | Find files by pattern |
| `Grep` | Search file contents |
| `WebSearch` | Search the web |
| `WebFetch` | Fetch web pages |
| `Agent` | Spawn subagents |
| `AskUserQuestion` | Ask user clarifying questions |
| `TodoWrite` | Manage task lists |

## Subagents

```typescript
agents: {
  "code-reviewer": {
    description: "Expert code reviewer",
    prompt: "Analyze code quality...",
    tools: ["Read", "Glob", "Grep"],
    model: "sonnet"  // or "opus", "haiku", "inherit"
  }
}
```

## Sessions

- Sessions persist to `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`
- Resume: `options: { resume: sessionId }`
- Continue most recent: `options: { continue: true }`
- Fork: `options: { resume: sessionId, forkSession: true }`
- Ephemeral: `options: { persistSession: false }`

## Session Management Functions

```typescript
import { listSessions, getSessionMessages, getSessionInfo, renameSession, tagSession } from "@anthropic-ai/claude-agent-sdk";

const sessions = await listSessions({ dir: "/path/to/project", limit: 10 });
const messages = await getSessionMessages(sessionId, { dir, limit, offset });
```

## Hooks

Available events: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PermissionRequest`, `SessionStart`, `SessionEnd`, `Notification`, `UserPromptSubmit`, `Setup`, `TeammateIdle`, `TaskCompleted`, `ConfigChange`, `WorktreeCreate`, `WorktreeRemove`.

```typescript
hooks: {
  PreToolUse: [{ matcher: "Write|Edit", hooks: [myCallback] }]
}
```

Callbacks return `{ hookSpecificOutput: { permissionDecision: "allow"|"deny"|"ask", ... } }`.

## MCP Servers

```typescript
mcpServers: {
  github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: "..." } },
  remote: { type: "http", url: "https://api.example.com/mcp", headers: { Authorization: "Bearer ..." } },
  inline: { type: "sdk", name: "my-server", instance: mcpServerInstance }
}
```

## Permission Modes

| Mode | Description |
|------|-------------|
| `default` | No auto-approvals; unmatched tools trigger `canUseTool` |
| `dontAsk` | Deny if not pre-approved (no prompting) |
| `acceptEdits` | Auto-approve file edits |
| `bypassPermissions` | Approve everything (use with caution) |
| `plan` | No tool execution |

## Key Architectural Differences from OpenCode SDK

1. **Process-based**: Spawns a Claude Code child process, not a REST client
2. **Agentic loop**: Tools execute automatically in a loop until task is complete
3. **Streaming**: Messages arrive via async generator, not REST responses
4. **Auth**: Uses `ANTHROPIC_API_KEY` directly, not HTTP Basic Auth to a server
5. **Sessions**: File-based JSONL transcripts, not server-managed sessions
6. **No server**: Doesn't need a running server — IS the runtime
