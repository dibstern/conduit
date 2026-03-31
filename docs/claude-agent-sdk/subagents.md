# Subagents in the SDK

> Source: https://platform.claude.com/docs/en/agent-sdk/subagents
> Extracted: 2026-03-31

Define and invoke subagents to isolate context, run tasks in parallel, and apply specialized instructions.

---

Subagents are separate agent instances that your main agent can spawn to handle focused subtasks. Use subagents to isolate context, run multiple analyses in parallel, and apply specialized instructions without bloating the main agent's prompt.

## Overview

Create subagents in three ways:
- **Programmatically**: use `agents` parameter in `query()` options (recommended for SDK)
- **Filesystem-based**: define as markdown files in `.claude/agents/`
- **Built-in general-purpose**: Claude can invoke the built-in `general-purpose` subagent at any time

## Benefits of using subagents

### Context isolation
Each subagent runs in its own fresh conversation. Intermediate tool calls stay inside the subagent; only the final message returns to the parent.

### Parallelization
Multiple subagents can run concurrently.

### Specialized instructions and knowledge
Each subagent can have tailored system prompts.

### Tool restrictions
Subagents can be limited to specific tools.

## Creating subagents

### AgentDefinition configuration

| Field | Type | Required | Description |
|:------|:-----|:---------|:------------|
| `description` | `string` | Yes | When to use this agent |
| `prompt` | `string` | Yes | Agent's system prompt |
| `tools` | `string[]` | No | Allowed tool names. If omitted, inherits all |
| `model` | `'sonnet' \| 'opus' \| 'haiku' \| 'inherit'` | No | Model override |
| `skills` | `string[]` | No | Available skill names |
| `memory` | `'user' \| 'project' \| 'local'` | No | Memory source (Python only) |
| `mcpServers` | `(string \| object)[]` | No | MCP servers by name or inline config |

> Subagents cannot spawn their own subagents. Don't include `Agent` in a subagent's `tools` array.

```typescript
for await (const message of query({
  prompt: "Review the authentication module for security issues",
  options: {
    allowedTools: ["Read", "Grep", "Glob", "Agent"],
    agents: {
      "code-reviewer": {
        description: "Expert code review specialist.",
        prompt: `You are a code review specialist...`,
        tools: ["Read", "Grep", "Glob"],
        model: "sonnet"
      },
      "test-runner": {
        description: "Runs and analyzes test suites.",
        prompt: `You are a test execution specialist...`,
        tools: ["Bash", "Read", "Grep"]
      }
    }
  }
})) {
  if ("result" in message) console.log(message.result);
}
```

## What subagents inherit

| Receives | Does not receive |
|:---|:---|
| Its own system prompt and the Agent tool's prompt | Parent's conversation history or tool results |
| Project CLAUDE.md (loaded via `settingSources`) | Skills (unless listed in `AgentDefinition.skills`) |
| Tool definitions (inherited or subset from `tools`) | Parent's system prompt |

## Invoking subagents

### Automatic invocation
Claude decides based on task and each subagent's `description`.

### Explicit invocation
Mention the subagent by name: `"Use the code-reviewer agent to check the authentication module"`

### Dynamic agent configuration
Use factory functions to create `AgentDefinition` objects based on runtime conditions.

## Resuming subagents

Subagents can be resumed to continue where they left off by capturing the session ID and agent ID, then passing `resume: sessionId` in the second query's options.

## Common tool combinations

| Use case | Tools |
|:---------|:------|
| Read-only analysis | `Read`, `Grep`, `Glob` |
| Test execution | `Bash`, `Read`, `Grep` |
| Code modification | `Read`, `Edit`, `Write`, `Grep`, `Glob` |
| Full access | All tools (omit `tools` field) |

## Troubleshooting

- **Claude not delegating**: Include `Agent` in `allowedTools`, use explicit prompting, write clear descriptions
- **Filesystem agents not loading**: Restart session after creating new agent files
- **Windows long prompt failures**: Keep prompts concise (8191 char limit)
