# Connect to external tools with MCP

> Source: https://platform.claude.com/docs/en/agent-sdk/mcp
> Extracted: 2026-03-31

Configure MCP servers to extend your agent with external tools. Covers transport types, tool search for large tool sets, authentication, and error handling.

---

The [Model Context Protocol (MCP)](https://modelcontextprotocol.io/docs/getting-started/intro) is an open standard for connecting AI agents to external tools and data sources. With MCP, your agent can query databases, integrate with APIs like Slack and GitHub, and connect to other services without writing custom tool implementations.

MCP servers can run as local processes, connect over HTTP, or execute directly within your SDK application.

## Quickstart

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Use the docs MCP server to explain what hooks are in Claude Code",
  options: {
    mcpServers: {
      "claude-code-docs": {
        type: "http",
        url: "https://code.claude.com/docs/mcp"
      }
    },
    allowedTools: ["mcp__claude-code-docs__*"]
  }
})) {
  if (message.type === "result" && message.subtype === "success") {
    console.log(message.result);
  }
}
```

## Add an MCP server

### In code

Pass MCP servers directly in the `mcpServers` option.

### From a config file

Create a `.mcp.json` file at your project root. The SDK loads this automatically:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/projects"]
    }
  }
}
```

## Allow MCP tools

MCP tools require explicit permission before Claude can use them. Without permission, Claude will see that tools are available but won't be able to call them.

### Tool naming convention

MCP tools follow the naming pattern `mcp__<server-name>__<tool-name>`. For example, a GitHub server named `"github"` with a `list_issues` tool becomes `mcp__github__list_issues`.

### Grant access with allowedTools

```typescript
allowedTools: [
  "mcp__github__*",           // All tools from the github server
  "mcp__db__query",           // Only the query tool from db server
  "mcp__slack__send_message"  // Only send_message from slack server
]
```

Wildcards (`*`) let you allow all tools from a server without listing each one individually.

> **Prefer `allowedTools` over permission modes for MCP access.** `permissionMode: "acceptEdits"` does not auto-approve MCP tools. `permissionMode: "bypassPermissions"` does auto-approve MCP tools but also disables all other safety prompts. A wildcard in `allowedTools` grants exactly the MCP server you want and nothing more.

## Transport types

### stdio servers

Local processes that communicate via stdin/stdout. Use this for MCP servers you run on the same machine.

### HTTP/SSE servers

Use HTTP or SSE for cloud-hosted MCP servers and remote APIs. Use `"type": "sse"` or `"type": "http"`.

### SDK MCP servers

Define custom tools directly in your application code instead of running a separate server process. See the [custom tools guide](./custom-tools.md).

## MCP tool search

When you have many MCP tools configured, tool definitions can consume a significant portion of your context window. Tool search solves this by withholding tool definitions from context and loading only the ones Claude needs for each turn.

Tool search is enabled by default. See [Tool search](./tool-search.md) for configuration options.

## Authentication

### Pass credentials via environment variables

Use the `env` field to pass API keys, tokens, and other credentials to the MCP server.

### HTTP headers for remote servers

For HTTP and SSE servers, pass authentication headers directly in the server configuration.

### OAuth2 authentication

The SDK doesn't handle OAuth flows automatically, but you can pass access tokens via headers after completing the OAuth flow in your application.

## Error handling

The SDK emits a `system` message with subtype `init` at the start of each query. This message includes the connection status for each MCP server. Check the `status` field to detect connection failures.

## Troubleshooting

### Server shows "failed" status

Common causes:
- **Missing environment variables**
- **Server not installed**
- **Invalid connection string**
- **Network issues**

### Tools not being called

Check that you've granted permission with `allowedTools`.

### Connection timeouts

The MCP SDK has a default timeout of 60 seconds for server connections.

## Related resources

- [Custom tools guide](./custom-tools.md)
- [Permissions](./permissions.md)
- [MCP server directory](https://github.com/modelcontextprotocol/servers)
