---
name: plan-to-beads
description: Convert structured implementation plans into Beads-backed executable work graphs with prompt-contract metadata and generated formula templates. Use when the user asks to turn a plan into Beads, create plan-to-beads formulas or molecules, validate Beads work packets, or prepare plans for parallel agent execution.
---

# Plan To Beads

Convert a written implementation plan into Beads issues/molecules where Beads hold the executable work graph and each child bead carries a prompt contract.

## Quick Start

1. Run `bd prime`.
2. Read the plan and extract a plan IR: roles, stable logical ids, dependencies, shared context, fixtures, stages, children, checkpoints, pilot work, and follow-up templates.
3. Hydrate the generic templates in `templates/` from that IR. Do not put plan-specific facts in the source templates.
4. Generate a plan-specific formula under `.beads/generated-formulas/<plan-id>.formula.toml` for review.
5. Validate, then pour only after approval:

```bash
bd cook .beads/generated-formulas/<plan-id>.formula.toml --dry-run
bd mol pour <plan-id>-executable-plan --dry-run
bd dep cycles
```

## Core Model

- **Epic/root molecule**: the whole plan instance.
- **Context beads**: global contract, architecture, policy, fixture, pilot, and follow-up-template beads. Children read these through `contextRefs`.
- **Parent/stage beads**: feature-level grouping and inherited defaults for a stage.
- **Checkpoint beads**: integration gates, fanout readiness, validation, and subagent launch rules.
- **Child beads**: one executable prompt contract and one TDD behavior.

Use `needs` for execution dependencies that affect readiness. Use `contextRefs`, `inherits`, and `provides` inside metadata for read-time context and schema wiring.

## Workflow

1. Normalize the plan into the schema in [REFERENCE.md](REFERENCE.md).
2. Create context beads first: global contract, architecture, policies, fixtures, and stage parents.
3. Convert each vertical behavior into a `child` bead with `workPacket`.
4. Convert gates and integration handoffs into `checkpoint` beads.
5. Keep speculative work as `followup-template` beads unless the plan explicitly says to create executable work now.
6. Generate dependencies from `needs`; do not duplicate the graph only in prose.
7. Run the validation checklist before pouring or marking the plan converted.

## Child Contract Rules

Each executable child must define:

- `goal`
- `inputs`
- `constraints`
- `allowedFiles`
- `forbiddenFiles`
- `redCommand`
- `expectedFailure`
- `greenScope`
- `verification`
- `failureConditions`
- `handoff.requiresBeadsNote = true`

If any field cannot be derived from the plan, create a decision/checkpoint bead instead of inventing details.

## Template Rules

- Source templates under `templates/` are generic and placeholder-only.
- Plan-specific formulas are generated artifacts; put them under `.beads/generated-formulas/` unless the user asks to install a formula in `.beads/formulas/`.
- Template placeholders use `{{snake_case}}`; array/object placeholders represent already-rendered TOML.
- Role templates are snippets; the generator may compose them into a full formula or hydrate directly into `bd create`/`bd update` commands.

## Validation

Before calling the conversion usable:

- The generated formula cooks with no unresolved placeholders.
- Every `logicalId` is unique.
- Every `needs`, `contextRefs`, `inherits`, `provides`, and fixture reference resolves.
- Every child has the required work packet fields.
- Parallel-ready children have disjoint writable file scopes or an explicit checkpoint-owned merge rule.
- Checkpoints define validation commands, fanout rules, and handoff requirements.

See [REFERENCE.md](REFERENCE.md) for schemas, role mappings, and the full validation checklist.
