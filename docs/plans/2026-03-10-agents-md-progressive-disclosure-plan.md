# AGENTS.md Progressive Disclosure Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Convert the repository's root AGENTS.md into a shorter hybrid onboarding document and move deeper architecture and testing guidance into `docs/agent-guide/`.

**Architecture:** Keep only universally relevant context in AGENTS.md, then route deeper, conditional guidance into focused Markdown files that the agent reads only when the task warrants it.

**Tech Stack:** Markdown documentation, npm scripts, existing `docs/plans/` design archive.

---

### Task 1: Add focused agent-guide docs

**Files:**
- Create: `docs/agent-guide/architecture.md`
- Create: `docs/agent-guide/testing.md`

**Step 1:** Write the deeper architecture guide with subsystem boundaries, per-project relay composition, and request/event flow.

**Step 2:** Write the testing guide with a default verification path plus targeted command selection by change type.

### Task 2: Trim the root AGENTS.md

**Files:**
- Modify: `AGENTS.md`

**Step 1:** Replace the long architecture and test sections with a short hybrid onboarding doc.

**Step 2:** Add explicit rules for when to read `docs/agent-guide/architecture.md`, `docs/agent-guide/testing.md`, and `docs/plans/`.

### Task 3: Verify the new documentation shape

**Files:**
- Verify: `AGENTS.md`
- Verify: `docs/agent-guide/architecture.md`
- Verify: `docs/agent-guide/testing.md`

**Step 1:** Check Markdown diagnostics for the changed files.

**Step 2:** Re-measure AGENTS.md line count and byte size to confirm the reduction.