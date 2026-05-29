---
name: plan-to-beads
description: Convert implementation plans into executable Beads formulas and molecules with machine-readable prompt-contract metadata. Use when the user asks to convert a plan/spec/design into Beads, create an executable beads plan, define work packets, or prepare parallel agent work from a plan.
---

# Plan To Beads

Turn a written plan into a persistent Beads molecule where Beads, not the prose doc, become the executable work graph.

## Quick Start

1. Run `bd prime`.
2. Read the plan and any repo-local formula at `.beads/formulas/plan-to-beads-executable-plan.formula.toml`.
3. Produce or update a TOML formula with global, parent/stage, policy, architecture, fixture, checkpoint, pilot, and child steps. Use `needs` for execution dependencies and `contextRefs` / `inherits` / `provides` in `steps.metadata.planToBeads` for read-time context.
4. Validate before pouring:

```bash
bd cook .beads/formulas/plan-to-beads-executable-plan.formula.toml --dry-run
bd cook .beads/formulas/plan-to-beads-executable-plan.formula.toml --mode=runtime --var plan_id=<id> --var plan_title="<title>"
bd mol pour plan-to-beads-executable-plan --dry-run --var plan_id=<id> --var plan_title="<title>"
```

5. After user approval, pour the molecule and run graph checks:

```bash
bd mol pour plan-to-beads-executable-plan --var plan_id=<id> --var plan_title="<title>" --var source_plan=<path>
bd dep cycles
bd list --has-metadata-key planToBeads --json
```

Important: verify runtime `bd cook` output. If `{{vars}}` remain inside nested metadata, create a plan-specific formula with concrete metadata values or patch metadata after pour with `bd update --metadata`; do not pour placeholder work packets.

## Core Model

- **Formula**: version-controlled TOML template in `.beads/formulas/`.
- **Molecule**: persistent Beads instance created by `bd mol pour`; use this for implementation work.
- **Wisp**: ephemeral workflow; do not use for durable implementation plans.
- **Child bead**: one executable prompt contract.
- **Context bead**: shared information a child reads, not a readiness dependency unless listed in `needs`.

Use two different links:

- `needs`: execution ordering. Becomes Beads dependency gating and affects `bd ready`.
- `contextRefs`: read-time context. Used by agents to build the prompt packet; does not imply execution blocking.

## Role Mapping

Use these issue types unless repo convention says otherwise:

- `feature`: parent/stage beads that group deliverable work.
- `task`: executable child beads, checkpoints, pilots, and integration steps.
- `decision`: architecture, policy, scope, and design-context beads.
- `chore`: validation, fixture refresh, export/sync, and other mechanical work.
- `human` or `gate`: approval or async coordination steps when the formula needs a real gate.

The molecule root created by `bd mol pour` is the plan instance. If creating issues manually, use an `epic` root.

## Workflow

1. Extract stable logical ids from the plan. Create ids if missing.
2. Move global scope/non-goals/repo constraints into a `global-contract` decision bead.
3. Move shared Module/Interface/ownership rules into `architecture` decision beads.
4. Move TDD, validation, output, profile, parallel, and subagent rules into `policy` beads.
5. Move fixture provenance and refresh policy into `fixture` beads.
6. Convert each vertical behavior into a `child` bead with a `workPacket`.
7. Convert integration/fanout gates into `checkpoint` beads.
8. Convert measurement-only work into `pilot` beads.
9. Keep optional future work as `followup-template` metadata unless it should become real backlog now.

Do not duplicate whole-plan context into every child. Children reference context with `contextRefs` and inherit parent defaults with `inherits`.

## Required Child Fields

Every child bead metadata must include `goal`, `allowedFiles`, `forbiddenFiles`, `redCommand`, `expectedFailure`, `greenScope`, `verification`, `failureConditions`, and `handoff.requiresBeadsNote = true`.

If any required field cannot be filled from the plan, create a `decision` or `human` gate bead instead of inventing details.

## Validation Checklist

Before calling the conversion usable:

- Formula cooks in compile and runtime mode.
- Cooked metadata contains no unresolved `{{vars}}`.
- Dry-run pour shows the expected graph.
- Every `logicalId` is unique.
- Every `needs`, `contextRefs`, `inherits`, `provides`, and fixture ref resolves.
- Every child has required work-packet fields.
- Parallel-ready children have disjoint allowed file ownership.
- Checkpoints list validation commands and fanout rules.
- Optional/future work is not executable unless explicitly marked for creation.

## Reference

For TOML snippets and metadata schemas, see [REFERENCE.md](REFERENCE.md).
