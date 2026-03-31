# Slash Commands in the SDK

> Source: https://platform.claude.com/docs/en/agent-sdk/slash-commands
> Extracted: 2026-03-31

Learn how to use slash commands to control Claude Code sessions through the SDK

---

Slash commands provide a way to control Claude Code sessions with special commands that start with `/`. These commands can be sent through the SDK to perform actions like clearing conversation history, compacting messages, or getting help.

## Discovering Available Slash Commands

Available slash commands appear in the system initialization message:

```typescript
for await (const message of query({
  prompt: "Hello Claude",
  options: { maxTurns: 1 }
})) {
  if (message.type === "system" && message.subtype === "init") {
    console.log("Available slash commands:", message.slash_commands);
  }
}
```

## Sending Slash Commands

Send slash commands by including them in your prompt string:

```typescript
for await (const message of query({
  prompt: "/compact",
  options: { maxTurns: 1 }
})) {
  if (message.type === "result") {
    console.log("Command executed:", message.result);
  }
}
```

## Common Slash Commands

### `/compact` - Compact Conversation History

Reduces conversation history size by summarizing older messages while preserving important context.

### `/clear` - Clear Conversation

Starts a fresh conversation by clearing all previous history.

## Creating Custom Slash Commands

> The `.claude/commands/` directory is the legacy format. The recommended format is `.claude/skills/<name>/SKILL.md`. See [Skills](./skills.md) for the current format.

### File Locations

- **Project commands**: `.claude/commands/` (legacy; prefer `.claude/skills/`)
- **Personal commands**: `~/.claude/commands/` (legacy; prefer `~/.claude/skills/`)

### File Format

Each custom command is a markdown file where:
- The filename (without `.md`) becomes the command name
- The file content defines what the command does
- Optional YAML frontmatter provides configuration

#### Basic Example

Create `.claude/commands/refactor.md`:
```markdown
Refactor the selected code to improve readability and maintainability.
Focus on clean code principles and best practices.
```

#### With Frontmatter

```markdown
---
allowed-tools: Read, Grep, Glob
description: Run security vulnerability scan
model: claude-opus-4-6
---

Analyze the codebase for security vulnerabilities including:
- SQL injection risks
- XSS vulnerabilities
- Exposed credentials
```

### Advanced Features

#### Arguments and Placeholders

```markdown
---
argument-hint: [issue-number] [priority]
description: Fix a GitHub issue
---

Fix issue #$1 with priority $2.
```

Use: `/fix-issue 123 high`

#### Bash Command Execution

Include bash output with `!` backtick syntax:
```markdown
## Context
- Current status: !`git status`
- Current diff: !`git diff HEAD`
```

#### File References

Include file contents using `@` prefix:
```markdown
Review the following:
- Package config: @package.json
- TypeScript config: @tsconfig.json
```

### Organization with Namespacing

Organize commands in subdirectories for structure.

## See Also

- [Skills](./skills.md)
- [Subagents](./subagents.md)
