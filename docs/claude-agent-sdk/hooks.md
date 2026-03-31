# Intercept and control agent behavior with hooks

> Source: https://platform.claude.com/docs/en/agent-sdk/hooks
> Extracted: 2026-03-31

Intercept and customize agent behavior at key execution points with hooks

---

Hooks are callback functions that run your code in response to agent events, like a tool being called, a session starting, or execution stopping. With hooks, you can:

- **Block dangerous operations** before they execute
- **Log and audit** every tool call for compliance, debugging, or analytics
- **Transform inputs and outputs** to sanitize data, inject credentials, or redirect file paths
- **Require human approval** for sensitive actions
- **Track session lifecycle** to manage state, clean up resources, or send notifications

## How hooks work

1. An event fires (tool called, session started, etc.)
2. The SDK collects registered hooks for that event type
3. Matchers filter which hooks run
4. Callback functions execute
5. Your callback returns a decision (allow, block, modify, inject context)

## Available hooks

| Hook Event | Python | TypeScript | What triggers it |
|------------|--------|------------|------------------|
| `PreToolUse` | Yes | Yes | Tool call request (can block or modify) |
| `PostToolUse` | Yes | Yes | Tool execution result |
| `PostToolUseFailure` | Yes | Yes | Tool execution failure |
| `UserPromptSubmit` | Yes | Yes | User prompt submission |
| `Stop` | Yes | Yes | Agent execution stop |
| `SubagentStart` | Yes | Yes | Subagent initialization |
| `SubagentStop` | Yes | Yes | Subagent completion |
| `PreCompact` | Yes | Yes | Conversation compaction request |
| `PermissionRequest` | Yes | Yes | Permission dialog would be displayed |
| `SessionStart` | No | Yes | Session initialization |
| `SessionEnd` | No | Yes | Session termination |
| `Notification` | Yes | Yes | Agent status messages |
| `Setup` | No | Yes | Session setup/maintenance |
| `TeammateIdle` | No | Yes | Teammate becomes idle |
| `TaskCompleted` | No | Yes | Background task completes |
| `ConfigChange` | No | Yes | Configuration file changes |
| `WorktreeCreate` | No | Yes | Git worktree created |
| `WorktreeRemove` | No | Yes | Git worktree removed |

## Configure hooks

```typescript
for await (const message of query({
  prompt: "Your prompt",
  options: {
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [myCallback] }]
    }
  }
})) {
  console.log(message);
}
```

```python
options = ClaudeAgentOptions(
    hooks={"PreToolUse": [HookMatcher(matcher="Bash", hooks=[my_callback])]}
)
```

### Matchers

Use matchers to filter when your callbacks fire. The `matcher` field is a regex string matched against the tool name.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `matcher` | `string` | `undefined` | Regex pattern matched against tool name |
| `hooks` | `HookCallback[]` | - | Array of callback functions |
| `timeout` | `number` | `60` | Timeout in seconds |

### Callback functions

#### Inputs

Every hook callback receives three arguments:
- **Input data:** typed object with event details
- **Tool use ID:** correlates `PreToolUse` and `PostToolUse` events
- **Context:** in TypeScript, contains `signal` (`AbortSignal`); in Python, reserved for future use

#### Outputs

- **Top-level fields:** `systemMessage` injects a message into conversation; `continue` determines if agent keeps running
- **`hookSpecificOutput`:** controls the current operation (e.g., `permissionDecision`, `updatedInput`, `additionalContext`)

Return `{}` to allow the operation without changes.

> When multiple hooks apply, **deny** > **ask** > **allow**.

## Examples

### Block a tool

```typescript
const protectEnvFiles: HookCallback = async (input, toolUseID, { signal }) => {
  const preInput = input as PreToolUseHookInput;
  const toolInput = preInput.tool_input as Record<string, unknown>;
  const filePath = toolInput?.file_path as string;
  const fileName = filePath?.split("/").pop();

  if (fileName === ".env") {
    return {
      hookSpecificOutput: {
        hookEventName: preInput.hook_event_name,
        permissionDecision: "deny",
        permissionDecisionReason: "Cannot modify .env files"
      }
    };
  }
  return {};
};
```

### Modify tool input

Return `updatedInput` with modified values and `permissionDecision: 'allow'`.

### Auto-approve specific tools

Return `permissionDecision: 'allow'` for read-only tools like `Read`, `Glob`, `Grep`.

### Chain multiple hooks

Hooks execute in array order. Keep each focused on a single responsibility.

### Forward notifications to Slack

Use `Notification` hooks to receive system notifications and forward to external services.

## Troubleshooting

- **Hook not firing**: Check event name case, matcher pattern, and event type
- **Matcher not filtering**: Matchers only match **tool names**, not file paths
- **Modified input not applied**: `updatedInput` must be inside `hookSpecificOutput` with `permissionDecision: 'allow'`
- **Session hooks not available in Python**: `SessionStart` and `SessionEnd` are TypeScript-only as SDK callbacks

## Related resources

- [Permissions](./permissions.md)
- [Custom tools](./custom-tools.md)
