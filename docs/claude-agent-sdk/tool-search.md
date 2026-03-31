# Scale to many tools with tool search

> Source: https://platform.claude.com/docs/en/agent-sdk/tool-search
> Extracted: 2026-03-31

Scale your agent to thousands of tools by discovering and loading only what's needed, on demand.

---

Tool search enables your agent to work with hundreds or thousands of tools by dynamically discovering and loading them on demand. Instead of loading all tool definitions into the context window upfront, the agent searches your tool catalog and loads only the tools it needs.

This approach solves two challenges as tool libraries scale:

- **Context efficiency:** Tool definitions can consume large portions of the context window (50 tools can use 10-20K tokens), leaving less room for actual work.
- **Tool selection accuracy:** Tool selection accuracy degrades with more than 30-50 tools loaded at once.

Tool search is enabled by default.

## How tool search works

When tool search is active, tool definitions are withheld from the context window. The agent receives a summary of available tools and searches for relevant ones when the task requires a capability not already loaded. The 3-5 most relevant tools are loaded into context, where they stay available for subsequent turns.

Tool search adds one extra round-trip the first time Claude discovers a tool (the search step), but for large tool sets this is offset by smaller context on every turn. With fewer than ~10 tools, loading everything upfront is typically faster.

> Tool search requires Claude Sonnet 4 or later, or Claude Opus 4 or later. Haiku models do not support tool search.

## Configure tool search

By default, tool search is always on. You can change this with the `ENABLE_TOOL_SEARCH` environment variable:

| Value | Behavior |
|:------|:---------|
| (unset) | Tool search is always on. Tool definitions are never loaded into context. Default. |
| `true` | Same as unset. |
| `auto` | Checks combined token count of all tool definitions against model's context window. If >10%, tool search activates. |
| `auto:N` | Same as `auto` with a custom percentage. `auto:5` activates when definitions exceed 5% of context. |
| `false` | Tool search is off. All tool definitions are loaded into context on every turn. |

Set the value in the `env` option on `query()`:

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Find and run the appropriate database query",
  options: {
    mcpServers: {
      "enterprise-tools": {
        type: "http",
        url: "https://tools.example.com/mcp"
      }
    },
    allowedTools: ["mcp__enterprise-tools__*"],
    env: {
      ENABLE_TOOL_SEARCH: "auto:5"
    }
  }
})) {
  if (message.type === "result" && message.subtype === "success") {
    console.log(message.result);
  }
}
```

## Optimize tool discovery

The search mechanism matches queries against tool names and descriptions. Names like `search_slack_messages` surface for a wider range of requests than `query_slack`. Descriptions with specific keywords match more queries than generic ones.

You can also add a system prompt section listing available tool categories:

```text
You can search for tools to interact with Slack, GitHub, and Jira.
```

## Limits

- **Maximum tools:** 10,000 tools in your catalog
- **Search results:** Returns 3-5 most relevant tools per search
- **Model support:** Claude Sonnet 4+, Claude Opus 4+ (no Haiku)

## Related documentation

- [Connect MCP servers](./mcp.md)
- [Custom tools](./custom-tools.md)
