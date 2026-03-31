# Agent Skills in the SDK

> Source: https://platform.claude.com/docs/en/agent-sdk/skills
> Extracted: 2026-03-31

Extend Claude with specialized capabilities using Agent Skills in the Claude Agent SDK

---

## Overview

Agent Skills extend Claude with specialized capabilities that Claude autonomously invokes when relevant. Skills are packaged as `SKILL.md` files containing instructions, descriptions, and optional supporting resources.

## How Skills Work with the SDK

1. **Defined as filesystem artifacts**: Created as `SKILL.md` files in `.claude/skills/`
2. **Loaded from filesystem**: You must specify `settingSources` / `setting_sources`
3. **Automatically discovered**: Skill metadata is discovered at startup
4. **Model-invoked**: Claude autonomously chooses when to use them
5. **Enabled via allowed_tools**: Add `"Skill"` to your `allowed_tools`

> **Default behavior**: The SDK does not load filesystem settings by default. To use Skills, configure `settingSources: ['user', 'project']` (TS) or `setting_sources=["user", "project"]` (Python).

## Using Skills with the SDK

```typescript
for await (const message of query({
  prompt: "Help me process this PDF document",
  options: {
    cwd: "/path/to/project",
    settingSources: ["user", "project"],
    allowedTools: ["Skill", "Read", "Write", "Bash"]
  }
})) {
  console.log(message);
}
```

```python
options = ClaudeAgentOptions(
    cwd="/path/to/project",
    setting_sources=["user", "project"],
    allowed_tools=["Skill", "Read", "Write", "Bash"],
)

async for message in query(prompt="Help me process this PDF document", options=options):
    print(message)
```

## Skill Locations

- **Project Skills** (`.claude/skills/`): Shared via git - loaded when `setting_sources` includes `"project"`
- **User Skills** (`~/.claude/skills/`): Personal, all projects - loaded when includes `"user"`
- **Plugin Skills**: Bundled with installed Claude Code plugins

## Creating Skills

Skills are directories containing a `SKILL.md` file with YAML frontmatter and Markdown content.

```bash
.claude/skills/processing-pdfs/
└── SKILL.md
```

## Tool Restrictions

The `allowed-tools` frontmatter in SKILL.md only applies when using Claude Code CLI directly. **It does not apply through the SDK.** Control tool access through `allowedTools` in your query configuration.

## Troubleshooting

### Skills Not Found

Most common issue: check `settingSources` configuration.

```typescript
// Wrong - Skills won't be loaded
const options = { allowedTools: ["Skill"] };

// Correct - Skills will be loaded
const options = {
  settingSources: ["user", "project"],
  allowedTools: ["Skill"]
};
```

### Skill Not Being Used

- Confirm `"Skill"` is in `allowedTools`
- Check the `description` field includes relevant keywords

## Related Documentation

- [Subagents](./subagents.md)
- [Slash Commands](./slash-commands.md)
- [Plugins](./plugins.md)
