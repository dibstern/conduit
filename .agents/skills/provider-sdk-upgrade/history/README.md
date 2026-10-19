# Using HISTORY.md

`HISTORY.md` in this directory is an append-only ledger of failures actually
observed while this skill was in use, and the fix chosen for each. It exists so
that edits to the skill are grounded in evidence rather than speculation.

## Before editing the skill

Read `HISTORY.md` first. It tells you which lines of the skill exist as fixes —
deleting or weakening one reintroduces the failure it cured — and which
failures have already been addressed, so you don't re-fix them differently.

Evidence gates strong prose: a prohibition, a named loophole with its rebuttal,
or emphasis concentrated on one rule belongs in the skill only when it can cite
an entry here. With no entry to cite, state the positive behaviour and stop.

## When to add an entry

Append an entry only when an actual failure was observed in a real run — the
agent did the wrong thing with this skill loaded. Refactors, style passes, and
improvements you merely expect to help change the skill without touching the
ledger; git history records those.

Insert new entries at the top of the ledger (newest first); never edit or remove existing entries. Include a verbatim excerpt of what the agent did or said wherever
possible — the excerpt is what future edits are judged against, and failure
observations are model-relative, so always record the context fields.

## Entry format

```markdown
## YYYY-MM-DD — <one-line issue name>

- **Observed**: what the agent actually did; verbatim excerpt if available
- **Context**: harness (claude-code / codex / …), model, effort level
- **Diagnosis**: root cause — which failure mode, which line failed to bind
- **Resolution**: the edit made to the skill, and why that lever
```
