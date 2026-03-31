# Modifying system prompts

> Source: https://platform.claude.com/docs/en/agent-sdk/modifying-system-prompts
> Extracted: 2026-03-31

Learn how to customize Claude's behavior by modifying system prompts using three approaches.

---

System prompts define Claude's behavior, capabilities, and response style. The Claude Agent SDK provides three ways to customize system prompts: using output styles, appending to Claude Code's prompt, or using a fully custom prompt.

> **Default behavior:** The Agent SDK uses a **minimal system prompt** by default. It contains only essential tool instructions but omits Claude Code's coding guidelines, response style, and project context. To include the full Claude Code system prompt, specify `systemPrompt: { preset: "claude_code" }` (TS) or `system_prompt={"type": "preset", "preset": "claude_code"}` (Python).

## Methods of modification

### Method 1: CLAUDE.md files (project-level instructions)

CLAUDE.md files provide project-specific context and instructions that are automatically read by the Agent SDK when it runs in a directory.

**Location and discovery:**
- **Project-level:** `CLAUDE.md` or `.claude/CLAUDE.md` in your working directory
- **User-level:** `~/.claude/CLAUDE.md` for global instructions

**IMPORTANT:** The SDK only reads CLAUDE.md files when you explicitly configure `settingSources` / `setting_sources`:
- Include `'project'` to load project-level CLAUDE.md
- Include `'user'` to load user-level CLAUDE.md

```typescript
for await (const message of query({
  prompt: "Add a new React component for user profiles",
  options: {
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: ["project"]  // Required to load CLAUDE.md
  }
})) {
  messages.push(message);
}
```

### Method 2: Output styles (persistent configurations)

Output styles are saved configurations stored as markdown files in `~/.claude/output-styles/` or `.claude/output-styles/`. Activate via `/output-style [style-name]`.

### Method 3: Using `systemPrompt` with append

Add custom instructions while preserving all built-in functionality:

```typescript
for await (const message of query({
  prompt: "Help me write a Python function to calculate fibonacci numbers",
  options: {
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: "Always include detailed docstrings and type hints in Python code."
    }
  }
})) {
  messages.push(message);
}
```

### Method 4: Custom system prompts

Replace the default entirely with your own instructions:

```typescript
const customPrompt = `You are a Python coding specialist.
Follow these guidelines:
- Write clean, well-documented code
- Use type hints for all functions
- Include comprehensive docstrings`;

for await (const message of query({
  prompt: "Create a data processing pipeline",
  options: { systemPrompt: customPrompt }
})) {
  messages.push(message);
}
```

## Comparison of all four approaches

| Feature | CLAUDE.md | Output Styles | `systemPrompt` with append | Custom `systemPrompt` |
|---------|-----------|---------------|----------------------------|----------------------|
| **Persistence** | Per-project file | Saved as files | Session only | Session only |
| **Reusability** | Per-project | Across projects | Code duplication | Code duplication |
| **Default tools** | Preserved | Preserved | Preserved | Lost (unless included) |
| **Built-in safety** | Maintained | Maintained | Maintained | Must be added |
| **Customization level** | Additions only | Replace default | Additions only | Complete control |
| **Version control** | With project | Yes | With code | With code |
