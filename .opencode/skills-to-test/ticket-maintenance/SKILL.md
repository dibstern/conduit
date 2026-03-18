---
name: ticket-maintenance
description: Use when you discover something during development that contradicts, extends, or narrows what the originating ticket says - new requirements, constraints, complications, dependency changes, scope reductions, or file list changes
---

# Ticket Maintenance

## Overview

Tickets are living documents — they track what we learned, not just what we planned.

**Core principle:** Every discovery that changes what a ticket means gets captured in that ticket, immediately.

**Violating the letter of this rule is violating the spirit of this rule.**

## When to Use

**Any time you discover something that makes a ticket inaccurate:**

| Discovery | Example |
|-----------|---------|
| New requirement | API needs auth header not mentioned in ticket |
| Constraint | SSE endpoint only supports GET, ticket assumed POST |
| Complication | Feature requires upstream change in another module |
| Dependency change | Ticket says "Depends on: None" but actually needs 1.3 |
| Scope reduction | Planned feature already exists in OpenCode API |
| File changes | Built `lib/bridge.ts` instead of planned `lib/relay.ts` |

**Who applies this skill:**
- **You (controller):** When you notice the drift yourself, or when a subagent reports discoveries
- **Not subagents directly:** Subagents report discoveries in their report; the controller updates the ticket

## The Process

### Step 1: Identify the Ticket

Determine which ticket file in `plans/tickets/` is affected. Match by:
- The ticket you're currently implementing
- The ticket referenced in the plan you're executing
- The ticket whose acceptance criteria you're verifying

### Step 2: Classify the Change

**Append-only** (add to `## Discovered During Implementation`):
- New requirements not in the original spec
- Constraints that affect approach but don't invalidate existing ACs
- Complications that add scope
- Context or rationale for decisions made during implementation

**Inline edit** (modify existing sections directly):
- Acceptance criteria that are factually wrong → fix them
- `**Depends on**:` metadata that's wrong → fix it
- `## Files to Create` list that's wrong → fix it
- `## API Shape` that's wrong → fix it

### Step 3: Update the Ticket

**For append-only changes**, add or extend the `## Discovered During Implementation` section at the end of the ticket (before `## Notes` if it exists, otherwise at the very end):

```markdown
## Discovered During Implementation

- **[Category]:** [What was discovered and why it matters]
- **[Category]:** [What was discovered and why it matters]
```

Categories: `New requirement`, `Constraint`, `Complication`, `Dependency`, `Scope reduction`, `Design decision`

**For inline edits**, modify the existing section directly and add a brief note in `## Discovered During Implementation` explaining what changed:

```markdown
- **Constraint:** Updated AC3 — original assumed POST, but SSE endpoint only supports GET
```

**Keep it lightweight.** One line per discovery. No paragraphs. State what changed and why.

### Step 4: Flag Downstream Impacts

Check: does this discovery affect other tickets?

- Look at tickets that **depend on** the affected ticket
- Look at tickets in the same phase that share files or APIs

If yes, add a note:

```markdown
- **Downstream impact:** This may affect ticket [N.N] — [brief reason]
```

You don't need to update the downstream ticket now. The note ensures it gets caught when that ticket is picked up.

## Red Flags

**Never:**
- Skip a ticket update because "it's a small change"
- Rewrite the entire ticket (preserve original intent, annotate what changed)
- Update tickets with speculative changes ("we might need X") — only document what you've confirmed
- Let a subagent edit ticket files directly (controller does this)

**Always:**
- Update the ticket before stopping to ask for help (so the human sees current state)
- Update the ticket before marking a task complete (so the next task has accurate context)
- Preserve existing sections — append, don't restructure
- Use the exact category labels from this skill

**If you catch yourself thinking:**
- "I'll remember this" — you won't. Write it in the ticket.
- "It's obvious from the code" — tickets are read before code. Write it.
- "This is too minor" — if it contradicts the ticket, it's not minor.
- "I'll update it later" — later doesn't exist. Do it now.

## The Bottom Line

A ticket that doesn't match reality is worse than no ticket — it actively misleads.

See something wrong? Fix the ticket. Now. One line. Move on.

## Integration

**Called by:**
- **executing-plans** — When a blocker or discovery surfaces during batch execution
- **subagent-driven-development** — When subagent questions or reviewer findings reveal ticket drift
- **finishing-a-development-branch** — Final reconciliation before branch completion

**Pairs with:**
- **verification-before-completion** — Verification may reveal that requirements have shifted; update the ticket before claiming completion
