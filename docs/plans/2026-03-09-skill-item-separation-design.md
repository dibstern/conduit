# Skill Item Separation Design

## Problem

Skill tool invocations are currently rendered through the same component pipeline as regular tools (Read, Bash, etc.). They share `ToolItem.svelte` and `ToolGroupItem.svelte`, with Skill-specific branching scattered across both. Skills are categorized as `"explore"` and can be grouped into collapsed "Explored" cards alongside Read/Glob/Grep, burying them inside tool groups.

Skills are fundamentally different from tools in the UI — they're meta-actions that load instructions, not user-facing work. They deserve their own dedicated component and rendering path.

## Decision

**Rendering-only separation (Approach A):** Extract Skill rendering into a dedicated `SkillItem.svelte` component, prevent Skills from being grouped, and route them through a separate branch in the message list rendering loop.

No changes to the data model — Skills remain `ToolMessage` internally. The protocol (OpenCode SSE) treats them identically to other tools, so the separation is purely at the rendering layer.

## Changes

### 1. `group-tools.ts` — Prevent Skill grouping

Add `"Skill"` to the never-grouped list alongside `AskUserQuestion` and `Task`. Skills always render as standalone items.

### 2. New: `SkillItem.svelte` — Dedicated component

Extract the Skill card rendering from `ToolItem.svelte` (lines 453-504) into its own component with:
- Skill name parsing (`input.name`, kebab-case to Title Case)
- Sparkles icon, formatted name display
- Expandable result with `<skill_content>` tag stripping
- Status bullet/icon logic
- Props: `{ message: ToolMessage }`

Visual appearance is identical to current.

### 3. `ToolItem.svelte` — Remove Skill code

Remove `isSkill`, `skillName`, `skillDisplayName` derived values and the `{:else if isSkill}` rendering branch. ToolItem handles only: questions, subagents, generic tools.

### 4. `ToolGroupItem.svelte` — Remove Skill code

Remove `isSkill`, `skillDisplayName`, `skillResult` derived values and Skill-specific template branches. Dead code since Skills are never grouped.

### 5. `MessageList.svelte` — Route Skills to SkillItem

Add a new branch before the generic `tool` check:
```svelte
{:else if msg.type === "tool" && (msg as ToolMessage).name === "Skill"}
  <SkillItem message={msg as ToolMessage} />
```

### 6. `HistoryView.svelte` — Same routing change

Same Skill branch in the history rendering loop for visual parity.

## What stays the same

- Visual appearance of Skills
- Data flow (ToolMessage in store, same WebSocket events)
- Shared types, relay layer, event translation
- All other tool/group rendering
