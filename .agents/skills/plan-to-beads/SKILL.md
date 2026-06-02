---
name: plan-to-beads
description: Convert structured implementation plans into Beads-backed executable work graphs with prompt-contract metadata and generated formula templates. Use when the user asks to turn a plan into Beads, create plan-to-beads formulas or molecules, validate Beads work packets, or prepare plans for parallel agent execution.
---

# Plan To Beads

Convert a written implementation plan into Beads issues/molecules where Beads hold the executable work graph and each child bead carries a prompt contract. Shared plan context lives in typed context beads, timed context refs, and contract snippets, not duplicated in every child.

## Quick Start

1. Run `bd prime`.
2. Read the plan and extract a plan IR: roles, stable logical ids, dependencies, shared context, `contextUse`, typed contract snippets, fixtures, stages, children, checkpoints, optional acceptance-pipeline work, pilot work, decisions, guardrails, reviews, progress overlays, and follow-up templates.
3. Hydrate the generic templates in `templates/` from that IR. Prefer `scripts/render-plan-to-beads.cjs`; do not put plan-specific facts in the source templates.
4. Generate a plan-specific formula under `.beads/generated-formulas/<plan-id>.formula.toml` for review.
5. Validate the generated formula:

```bash
node .agents/skills/plan-to-beads/scripts/render-plan-to-beads.cjs <plan-ir.json> .beads/generated-formulas/<plan-id>.formula.toml
node .agents/skills/plan-to-beads/scripts/validate-plan-to-beads.cjs .beads/generated-formulas/<plan-id>.formula.toml
bd cook .beads/generated-formulas/<plan-id>.formula.toml --dry-run
```

6. Pour only after approval. Persist the generated formula as a proto first, or install it into `.beads/formulas/` if the user wants a reusable formula:

```bash
bd cook .beads/generated-formulas/<plan-id>.formula.toml --persist --force
bd mol pour <plan-id>-executable-plan --dry-run
bd dep cycles
```

## Core Model

- **Epic/root molecule**: the whole plan instance.
- **Context beads**: global contract, architecture, policy, fixture, decision, guardrail, review, progress, pilot, and follow-up-template beads. Children read these through `contextRefs`.
- **Parent/stage beads**: feature-level grouping and inherited defaults for a stage.
- **Checkpoint beads**: integration gates, fanout readiness, validation, and subagent launch rules.
- **Child beads**: one executable prompt contract and one TDD behavior.
- **Acceptance-pipeline beads**: optional product-behavior proof layers for plans that require generated acceptance tests or acceptance mutation.

Use `needs` for execution dependencies that affect readiness. Use `contextRefs`, `inherits`, `provides`, and `typedContractRefs` inside metadata for read-time context and schema wiring. Use `contextUse` when the role must say exactly when an agent reads a context bead: `before-edit`, `during-edit`, `verification`, `handoff`, or `if-blocked`.

Use snippets when a plan contains reusable context that is not itself executable child work. Attach snippets to the smallest durable context bead that owns them, then reference them from children through `contextRefs`, `inputs`, `typedContractRefs`, `acceptanceMatrixRefs`, `guardrailRefs`, or `evidenceRefs`. See [REFERENCE.md](REFERENCE.md) for the snippet library.

## Workflow

1. Normalize the plan into the schema in [REFERENCE.md](REFERENCE.md).
2. Create context beads first: global contract, architecture, policies, decisions, guardrails, reviews, progress overlays, fixtures, and stage parents.
3. Convert each vertical behavior into a `child` bead with a `workPacket` split into `goalContract`, `inputContract`, `constraintContract`, `executionContract`, `validationContract`, `outputContract`, `failureContract`, and `handoffContract`.
4. Convert gates and integration handoffs into `checkpoint` beads split into `gateContract`, `fanoutContract`, `mergeContract`, `validationContract`, and `escalationContract`.
5. Convert evidence, audit, acceptance, risk, file-operation, architecture, and cross-plan material into typed snippets attached to those roles.
6. Create `acceptance-pipeline` beads only when the plan explicitly wants generated acceptance tests, a JSON acceptance IR, or acceptance mutation proof.
7. Keep speculative work as `followup-template` beads unless the plan explicitly says to create executable work now.
8. Generate dependencies from `needs`; do not duplicate the graph only in prose.
9. Run the validator and validation checklist before pouring or marking the plan converted.

## Child Contract Rules

Each executable child must define these prompt-contract subcontracts:

- `goalContract`: `goal`, `expectedOutcome`, `nonGoals`, and the behavior id.
- `inputContract`: `inputs`, `contextRefs`, child `contextUse`, fixtures, baselines, evidence, and external plans.
- `constraintContract`: allowed, forbidden, and read-only files; guardrails; required skills; tools; mock policy.
- `executionContract`: ordered steps, `greenScope`, implementation limits, fixtures, and code contracts.
- `validationContract`: `redCommand`, `expectedFailure`, `expectedRedShape`, verification, acceptance refs, and proof command.
- `outputContract`: output shape, patch shape, file touches, commit boundary, and evidence to record.
- `failureContract`: failure conditions, stop conditions, blocker decisions, and follow-up template refs.
- `handoffContract`: `requiresBeadsNote = true` plus artifact and close-owner rules.

If any field cannot be derived from the plan, create a decision/checkpoint bead instead of inventing details. Do not turn historical evidence, audit findings, risk notes, or unresolved decisions into executable child beads.

## Template Rules

- Source templates under `templates/` are generic and placeholder-only.
- Plan-specific formulas are generated artifacts; put them under `.beads/generated-formulas/` unless the user asks to install a formula in `.beads/formulas/`.
- Template placeholders use `{{snake_case}}`; array/object placeholders represent already-rendered TOML.
- Role templates are snippets; the generator may compose them into a full formula or hydrate directly into `bd create`/`bd update` commands.
- Child `contextUse` has one canonical home: `workPacket.inputContract.contextUse`.

## Validation

Before calling the conversion usable:

- `node .agents/skills/plan-to-beads/scripts/validate-plan-to-beads.cjs <generated-formula>` passes.
- The generated formula cooks with no unresolved placeholders.
- Every `logicalId` is unique.
- Every `needs`, `contextRefs`, `inherits`, `provides`, and fixture reference resolves.
- Every required `contextUse` ref resolves and has a phase, reason, and failure behavior.
- Every `typedContractRefs`, `acceptanceMatrixRefs`, `guardrailRefs`, `evidenceRefs`, and cross-plan reference either resolves or is explicitly external.
- Every child has the required work-packet subcontracts.
- Parallel-ready children have disjoint writable file scopes or an explicit checkpoint-owned merge rule.
- Checkpoints define gate, fanout, merge, validation, and escalation contracts.
- Acceptance-pipeline beads, when present, define normal acceptance and mutation contracts.
- Evidence and progress snippets are marked as historical or requiring reverify; they are not treated as future work unless a child/checkpoint depends on them.

See [EXAMPLES.md](EXAMPLES.md) for a minimal conversion and [REFERENCE.md](REFERENCE.md) for schemas, role mappings, and the full validation checklist.
