---
name: plan-to-beads
description: Convert structured implementation plans into Beads-backed executable work graphs with prompt-contract metadata and generated formula templates. Use when the user asks to turn a plan into Beads, create plan-to-beads formulas or molecules, validate Beads work packets, or prepare plans for parallel agent execution.
---

# Plan To Beads

Convert a written implementation plan into Beads issues/molecules where Beads hold the executable work graph and each child bead carries a prompt contract. Shared plan context lives in typed context beads and contract snippets, not duplicated in every child.

## Quick Start

1. Run `bd prime`.
2. Read the plan and extract a plan IR: roles, stable logical ids, dependencies, shared context, typed contract snippets, fixtures, stages, children, checkpoints, pilot work, decisions, guardrails, reviews, progress overlays, and follow-up templates.
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
- **Context beads**: global contract, architecture, policy, fixture, decision, guardrail, review, progress, pilot, and follow-up-template beads. Children read these through `contextRefs`.
- **Parent/stage beads**: feature-level grouping and inherited defaults for a stage.
- **Checkpoint beads**: integration gates, fanout readiness, validation, and subagent launch rules.
- **Child beads**: one executable prompt contract and one TDD behavior.

Use `needs` for execution dependencies that affect readiness. Use `contextRefs`, `inherits`, `provides`, and `typedContractRefs` inside metadata for read-time context and schema wiring.

## Typed Contract Snippets

Use contract snippets when a plan contains reusable context that is not itself executable child work:

- evidence and baselines: `evidenceRun`, `verificationResult`, `baselineSnapshot`, `sourceGrounding`, `inventorySnapshot`, `guardrailEvidence`, `failedAttempt`
- audits and amendments: `auditFinding`, `reviewRun`, `reviewDisposition`, `amendmentLedger`, `planEdit`, `nonActionableFinding`
- progress/history: `progressEntry`, `completedSlice`, `historicalStatus`, `archiveProvenance`, `residualDebt`, `statusOverlay`
- decisions: `openDecision`, `blockerDecision`, `decisionOptions`, `decisionNeeded`, `conditionalBranch`
- acceptance proof: `acceptanceMatrix`, `acceptanceCriterion`, `acceptanceScenario`, `acceptanceTrace`, `manualAcceptance`, `operatorSmoke`
- guardrails: `staticGuardrail`, `boundaryGuard`, `guardrailRegistry`, `antiPattern`, `allowedException`, `changeSurfaceGuard`
- ownership and delivery: `fileOperations`, `fileTouches`, `ownershipMap`, `changeSurface`, `commitBoundary`, `deliverySequence`, `publication`, `releaseGate`
- architecture and provenance: `moduleMap`, `boundaryClassification`, `protocolContract`, `artifactContract`, `configContract`, `commandCatalog`, `mappingTable`, `sourceAuthority`, `referencePattern`, `priorArt`
- risk and operations: `riskRegister`, `edgeCaseRegister`, `operationalProcedure`, `runbook`, `rollbackProcedure`, `manualRecovery`
- cross-plan relationships: `relatedPlans`, `blockedByPlan`, `prerequisitePlans`, `updatesPlan`, `amendsPlan`, `supersedesPlan`, `prerequisiteFor`, `externalPlanDependency`
- executor policy: `executorProfile`, `requiredSkills`, `implementationMode`, `agentInstructions`, `applicationLifecycle`

Prefer attaching these snippets to the smallest durable context bead that owns them. Children should reference them through `contextRefs`, `inputs`, `typedContractRefs`, `acceptanceMatrixRefs`, `guardrailRefs`, or `evidenceRefs`.

## Workflow

1. Normalize the plan into the schema in [REFERENCE.md](REFERENCE.md).
2. Create context beads first: global contract, architecture, policies, decisions, guardrails, reviews, progress overlays, fixtures, and stage parents.
3. Convert each vertical behavior into a `child` bead with `workPacket`.
4. Convert gates and integration handoffs into `checkpoint` beads.
5. Convert evidence, audit, acceptance, risk, file-operation, architecture, and cross-plan material into typed snippets attached to those roles.
6. Keep speculative work as `followup-template` beads unless the plan explicitly says to create executable work now.
7. Generate dependencies from `needs`; do not duplicate the graph only in prose.
8. Run the validation checklist before pouring or marking the plan converted.

## Child Contract Rules

Each executable child must define:

- `goal`
- `inputs`
- `constraints`
- `allowedFiles`
- `forbiddenFiles`
- `redCommand`
- `expectedFailure`
- `expectedRedShape`
- `greenScope`
- `verification`
- `failureConditions`
- `handoff.requiresBeadsNote = true`

If any field cannot be derived from the plan, create a decision/checkpoint bead instead of inventing details. Do not turn historical evidence, audit findings, risk notes, or unresolved decisions into executable child beads.

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
- Every `typedContractRefs`, `acceptanceMatrixRefs`, `guardrailRefs`, `evidenceRefs`, and cross-plan reference either resolves or is explicitly external.
- Every child has the required work packet fields.
- Parallel-ready children have disjoint writable file scopes or an explicit checkpoint-owned merge rule.
- Checkpoints define gate kind, validation commands, fanout rules, frozen interfaces, handoff requirements, and stop/escalation conditions.
- Evidence and progress snippets are marked as historical or requiring reverify; they are not treated as future work unless a child/checkpoint depends on them.

See [REFERENCE.md](REFERENCE.md) for schemas, role mappings, and the full validation checklist.
