# Plugins in the SDK

> Source: https://platform.claude.com/docs/en/agent-sdk/plugins
> Extracted: 2026-03-31

Load custom plugins to extend Claude Code with commands, agents, skills, and hooks through the Agent SDK

---

Plugins allow you to extend Claude Code with custom functionality that can be shared across projects. Through the Agent SDK, you can programmatically load plugins from local directories.

## What are plugins?

Plugins are packages of Claude Code extensions that can include:
- **Skills**: Model-invoked capabilities (can also be invoked with `/skill-name`)
- **Agents**: Specialized subagents
- **Hooks**: Event handlers
- **MCP servers**: External tool integrations

> The `commands/` directory is legacy. Use `skills/` for new plugins.

## Loading plugins

```typescript
for await (const message of query({
  prompt: "Hello",
  options: {
    plugins: [
      { type: "local", path: "./my-plugin" },
      { type: "local", path: "/absolute/path/to/another-plugin" }
    ]
  }
})) {
  // Plugin features are now available
}
```

```python
async for message in query(
    prompt="Hello",
    options={
        "plugins": [
            {"type": "local", "path": "./my-plugin"},
            {"type": "local", "path": "/absolute/path/to/another-plugin"},
        ]
    },
):
    pass
```

### Path specifications

- **Relative paths**: Resolved relative to current working directory
- **Absolute paths**: Full file system paths

> The path should point to the plugin root directory (containing `.claude-plugin/plugin.json`).

## Verifying plugin installation

Plugins appear in the system initialization message:

```typescript
if (message.type === "system" && message.subtype === "init") {
  console.log("Plugins:", message.plugins);
  console.log("Commands:", message.slash_commands);
}
```

## Using plugin skills

Skills from plugins are namespaced: `plugin-name:skill-name`.

```typescript
for await (const message of query({
  prompt: "/my-plugin:greet",
  options: {
    plugins: [{ type: "local", path: "./my-plugin" }]
  }
})) {
  // Claude executes the custom greeting skill
}
```

## Plugin structure reference

```text
my-plugin/
├── .claude-plugin/
│   └── plugin.json          # Required: plugin manifest
├── skills/                   # Agent Skills
│   └── my-skill/
│       └── SKILL.md
├── commands/                 # Legacy: use skills/ instead
│   └── custom-cmd.md
├── agents/                   # Custom agents
│   └── specialist.md
├── hooks/                    # Event handlers
│   └── hooks.json
└── .mcp.json                # MCP server definitions
```

## Troubleshooting

### Plugin not loading
- Check path points to plugin root (containing `.claude-plugin/`)
- Validate `plugin.json` syntax
- Check file permissions

### Skills not appearing
- Use namespace: `plugin-name:skill-name`
- Check init message for the skill
- Ensure `SKILL.md` exists in `skills/<name>/`

## See also

- [Slash Commands](./slash-commands.md)
- [Subagents](./subagents.md)
- [Skills](./skills.md)
