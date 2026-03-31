# Give Claude custom tools

> Source: https://platform.claude.com/docs/en/agent-sdk/custom-tools
> Extracted: 2026-03-31

Define custom tools with the Claude Agent SDK's in-process MCP server so Claude can call your functions, hit your APIs, and perform domain-specific operations.

---

Custom tools extend the Agent SDK by letting you define your own functions that Claude can call during a conversation. Using the SDK's in-process MCP server, you can give Claude access to databases, external APIs, domain-specific logic, or any other capability your application needs.

## Quick reference

| If you want to... | Do this |
|:-------------------|:--------|
| Define a tool | Use `@tool` (Python) or `tool()` (TypeScript) with a name, description, schema, and handler |
| Register a tool with Claude | Wrap in `create_sdk_mcp_server` / `createSdkMcpServer` and pass to `mcpServers` in `query()` |
| Pre-approve a tool | Add to your allowed tools |
| Remove a built-in tool from Claude's context | Pass a `tools` array listing only the built-ins you want |
| Let Claude call tools in parallel | Set `readOnlyHint: true` on tools with no side effects |
| Handle errors without stopping the loop | Return `isError: true` instead of throwing |
| Return images or files | Use `image` or `resource` blocks in the content array |
| Scale to many tools | Use [tool search](./tool-search.md) to load tools on demand |

## Create a custom tool

A tool is defined by four parts:

- **Name:** a unique identifier Claude uses to call the tool
- **Description:** what the tool does. Claude reads this to decide when to call it
- **Input schema:** the arguments Claude must provide (Zod schema in TypeScript, dict in Python)
- **Handler:** the async function that runs when Claude calls the tool

### Weather tool example

```typescript
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const getTemperature = tool(
  "get_temperature",
  "Get the current temperature at a location",
  {
    latitude: z.number().describe("Latitude coordinate"),
    longitude: z.number().describe("Longitude coordinate")
  },
  async (args) => {
    const response = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${args.latitude}&longitude=${args.longitude}&current=temperature_2m&temperature_unit=fahrenheit`
    );
    const data: any = await response.json();
    return {
      content: [{ type: "text", text: `Temperature: ${data.current.temperature_2m}°F` }]
    };
  }
);

const weatherServer = createSdkMcpServer({
  name: "weather",
  version: "1.0.0",
  tools: [getTemperature]
});
```

```python
from typing import Any
import httpx
from claude_agent_sdk import tool, create_sdk_mcp_server

@tool(
    "get_temperature",
    "Get the current temperature at a location",
    {"latitude": float, "longitude": float},
)
async def get_temperature(args: dict[str, Any]) -> dict[str, Any]:
    async with httpx.AsyncClient() as client:
        response = await client.get(
            "https://api.open-meteo.com/v1/forecast",
            params={
                "latitude": args["latitude"],
                "longitude": args["longitude"],
                "current": "temperature_2m",
                "temperature_unit": "fahrenheit",
            },
        )
        data = response.json()
    return {
        "content": [
            {"type": "text", "text": f"Temperature: {data['current']['temperature_2m']}°F"}
        ]
    }

weather_server = create_sdk_mcp_server(
    name="weather", version="1.0.0", tools=[get_temperature],
)
```

### Call a custom tool

Pass the MCP server to `query` via `mcpServers`. The key becomes the `{server_name}` segment in `mcp__{server_name}__{tool_name}`. List that name in `allowedTools` so the tool runs without a permission prompt.

### Add tool annotations

Tool annotations are optional metadata describing how a tool behaves:

| Field | Default | Meaning |
| :--- | :--- | :--- |
| `readOnlyHint` | `false` | Tool does not modify its environment. Controls parallel execution. |
| `destructiveHint` | `true` | Tool may perform destructive updates. |
| `idempotentHint` | `false` | Repeated calls have no additional effect. |
| `openWorldHint` | `true` | Tool reaches systems outside your process. |

## Control tool access

### Tool name format

Pattern: `mcp__{server_name}__{tool_name}`

### Configure allowed tools

| Option | Layer | Effect |
|:-------|:------|:-------|
| `tools: ["Read", "Grep"]` | Availability | Only listed built-ins are in Claude's context |
| `tools: []` | Availability | All built-ins removed. Claude can only use MCP tools |
| allowed tools | Permission | Listed tools run without permission prompt |
| disallowed tools | Permission | Every call to a listed tool is denied |

## Handle errors

| What happens | Result |
|:-------------|:-------|
| Handler throws uncaught exception | Agent loop stops |
| Handler returns `isError: true` | Agent loop continues, Claude sees the error |

## Return images and resources

### Images

An image block carries the image bytes inline, encoded as base64.

### Resources

A resource block embeds content identified by a URI.

## Next steps

- [Tool search](./tool-search.md) for scaling to many tools
- [Connect MCP servers](./mcp.md) for external servers
- [Configure permissions](./permissions.md) for controlling tool access
