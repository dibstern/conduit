# Plan To Beads Reference

## Purpose

`/plan-to-beads` turns a structured implementation plan into a Beads-backed work graph. The source templates are generic. A generated plan-specific formula or direct `bd` mutation hydrates placeholders from a plan IR.

## Plan IR

The converter should build this IR before rendering templates:

```json
{
  "planId": "short-stable-id",
  "planTitle": "Human title",
  "sourcePlan": "docs/plans/example.md",
  "typedContracts": [
    {
      "logicalId": "trace-artifact-contract",
      "kind": "artifactContract",
      "ownerLogicalId": "architecture-core",
      "provides": ["trace-artifact-contract"],
      "metadata": {}
    }
  ],
  "roles": [
    {
      "role": "child",
      "logicalId": "stage-behavior-01",
      "title": "Concrete behavior title",
      "needs": ["fixture-basic"],
      "contextRefs": ["global-contract", "architecture-core"],
      "inherits": ["stage-parent"],
      "typedContractRefs": ["trace-artifact-contract"],
      "metadata": {}
    }
  ]
}
```

Use the IR as the only source for plan-specific values. Do not edit the generic templates with concrete behavior names, file paths, expected failures, or commands.

## Hooking Shared Context Into Children

Every role exposes context through `provides`; children consume it through `contextRefs` or `inherits`.

| Source role | Child hook | Meaning |
| --- | --- | --- |
| `global-contract` | `contextRefs` | Scope, non-goals, repo/package boundary, global constraints |
| `architecture` | `contextRefs`, `typedContractRefs` | Module ownership, public/private interfaces, forbidden seams, artifact/config/protocol contracts |
| `policy` | `contextRefs`, `typedContractRefs` | TDD rules, output policy, profile policy, subagent rules, executor policy |
| `fixture` | `inputs` plus `contextRefs` | Fixture provenance, refresh policy, expected signal |
| `decision` | `needs` plus `contextRefs` | Open, blocker, conditional, or selected decisions that control execution |
| `guardrail` | `contextRefs` plus `guardrailRefs` | Static or behavioral negative-state contracts and proof obligations |
| `review` | `contextRefs` plus `evidenceRefs` | Audit findings, amendment ledgers, review runs, and dispositions |
| `progress` | `contextRefs` plus `evidenceRefs` | Historical status, completed slices, archive provenance, residual debt |
| `parent` | `inherits` | Stage defaults, owner files, shared forbidden files |
| `checkpoint` | `needs` and `contextRefs` | Fanout gate, integration validation, frozen extension points |
| `pilot` | `needs` and `contextRefs` | Measurement evidence that creates or rejects follow-up work |
| `followup-template` | `contextRefs` | Schema for later child beads, not executable work by default |

`needs` gates readiness. `contextRefs` tells an agent what to read. `inherits` merges defaults into the child prompt contract. `typedContractRefs` points at typed snippets inside context beads. `provides` names data that later beads may reference.

## Typed Context Attachment Rules

Use the smallest durable owner that matches the information.

| Information | Preferred owner | Child hook |
| --- | --- | --- |
| Scope, non-goals, global forbidden work | `global-contract` | `contextRefs` |
| Module maps, interface contracts, artifact/config/protocol shape, prior art | `architecture` | `contextRefs`, `typedContractRefs` |
| TDD, subagent, executor, profile, validation policy | `policy` | `contextRefs`, `typedContractRefs` |
| Source fixture provenance and refresh rules | `fixture` | `inputs`, `contextRefs` |
| Red/green implementation of one behavior | `child` | direct `workPacket` |
| Acceptance proof matrix and integration gates | `checkpoint` | `needs`, `acceptanceMatrixRefs`, `contextRefs` |
| Runtime smoke, measurements, exploratory evidence | `pilot` | `needs`, `evidenceRefs`, `contextRefs` |
| Historical command output, baseline, failed attempt | owner of the observed context, often `progress`, `pilot`, or `checkpoint` | `evidenceRefs` |
| Audit findings and plan amendments | `review` | `evidenceRefs`, `contextRefs` |
| Unresolved branch or blocker decision | `decision` | `needs`, `contextRefs` |
| Forbidden state or static proof obligation | `guardrail` | `guardrailRefs`, `contextRefs` |
| Completed work and archive overlays | `progress` | `evidenceRefs`, `contextRefs` |
| Future conditional work | `followup-template` | `contextRefs`, promoted later into child beads |

Do not duplicate large snippets into every child. A child should carry only its own executable prompt contract plus references to the context snippets it must obey.

## Role To Type Mapping

Use these defaults unless the repository has stricter conventions:

| Role | Beads type | Why |
| --- | --- | --- |
| `epic` | `epic` or molecule root | Whole plan instance |
| `global-contract` | `decision` | Durable scope and non-goals |
| `architecture` | `decision` | Cross-cutting design contract |
| `policy` | `decision` | Cross-cutting execution rules |
| `decision` | `decision` | Unresolved, blocker, conditional, or selected decision |
| `guardrail` | `chore` | Negative-state contract and proof obligation |
| `review` | `task` | Audit/review/amendment sidecar |
| `progress` | `chore` | Historical progress and archive context |
| `parent` | `feature` | Deliverable stage or feature group |
| `child` | `task` | One executable implementation contract |
| `checkpoint` | `task` or `gate` | Validation and fanout readiness |
| `fixture` | `chore` | Mechanical/provenance work |
| `pilot` | `task` | Evidence collection with validation |
| `followup-template` | `chore` | Non-executable template for later work |

`parent` should usually be a `feature`, not a `task`, because it groups behavior and carries stage defaults. Use `chore` for non-product mechanical work such as fixture manifests, validation sweeps, export/sync, or template maintenance.

## Version Control

- Commit generic source templates in `.agents/skills/plan-to-beads/templates/`.
- Generate plan-specific formulas in `.beads/generated-formulas/<plan-id>.formula.toml` for review.
- Install a generated formula into `.beads/formulas/` only when the user wants a reusable formula name.
- Store molecule instances and runtime status in Beads/Dolt; `.beads/*.jsonl` are passive exports.
- Include `contractVersion = "plan-to-beads.v2"` and `templateVersion` in rendered metadata.

## Rendering Strategy

Preferred path:

1. Parse the plan into IR.
2. Validate IR completeness.
3. Compose `templates/formula/executable-plan.formula.toml` with role snippets from `templates/roles/`.
4. Replace every placeholder.
5. Write a plan-specific generated formula.
6. `bd cook` and `bd mol pour --dry-run`.

Small-plan fallback:

1. Hydrate role templates directly into `bd create`, `bd update`, and `bd dep add`.
2. Query Beads after mutation.
3. Run the same schema validation against Beads metadata.

## Template Layers

- `templates/formula/`: outer formula shape and common vars.
- `templates/roles/`: one Beads issue/step per role.
- `templates/contracts/`: reusable metadata snippets for child work packets, subagent launch packets, durable handoff notes, and typed shared context.

The converter may inline contract snippets into role snippets, or render role snippets directly when the role already contains the needed fields. The generated formula is the first artifact that must be valid TOML.

## Typed Contract Snippet Library

The contract snippets are reusable TOML fragments. They should be attached to role metadata, then referenced by `logicalId`.

| Snippet family | Typical snippets | Usual owners |
| --- | --- | --- |
| `evidence-records` | `evidenceRun`, `verificationResult`, `baselineSnapshot`, `sourceGrounding`, `inventorySnapshot`, `guardrailEvidence`, `failedAttempt` | `checkpoint`, `pilot`, `review`, `progress`, `child` handoff |
| `audit-amendment` | `auditFinding`, `reviewRun`, `reviewDisposition`, `amendmentLedger`, `planEdit`, `nonActionableFinding` | `review` |
| `progress-history` | `progressEntry`, `completedSlice`, `historicalStatus`, `archiveProvenance`, `residualDebt`, `statusOverlay` | `progress`, `epic`, `parent` |
| `decision-point` | `openDecision`, `blockerDecision`, `decisionOptions`, `decisionNeeded`, `conditionalBranch` | `decision`, `checkpoint` |
| `acceptance-proof` | `acceptanceMatrix`, `acceptanceCriterion`, `acceptanceScenario`, `acceptanceTrace`, `manualAcceptance`, `operatorSmoke` | `checkpoint`, `pilot`, `child` |
| `guardrail` | `staticGuardrail`, `boundaryGuard`, `guardrailRegistry`, `antiPattern`, `allowedException`, `changeSurfaceGuard` | `guardrail`, `policy`, `checkpoint` |
| `file-operations` | `fileOperations`, `fileTouches`, `ownershipMap`, `changeSurface`, `commitBoundary`, `deliverySequence`, `publication`, `releaseGate` | `child`, `parent`, `checkpoint` |
| `architecture-contracts` | `moduleMap`, `boundaryClassification`, `protocolContract`, `artifactContract`, `configContract`, `commandCatalog`, `mappingTable`, `sourceAuthority`, `referencePattern`, `priorArt` | `architecture`, `global-contract` |
| `risk-operational` | `riskRegister`, `edgeCaseRegister`, `operationalProcedure`, `runbook`, `rollbackProcedure`, `manualRecovery` | `policy`, `checkpoint`, `pilot` |
| `cross-plan-relationships` | `relatedPlans`, `blockedByPlan`, `prerequisitePlans`, `updatesPlan`, `amendsPlan`, `supersedesPlan`, `prerequisiteFor`, `externalPlanDependency` | `epic`, `global-contract`, `decision`, `followup-template` |
| `executor-policy` | `executorProfile`, `requiredSkills`, `implementationMode`, `agentInstructions`, `applicationLifecycle` | `policy`, `parent`, `checkpoint` |

Use new top-level roles only when the information needs independent lifecycle or status. Otherwise attach the snippet to an existing role.

## Child Work Packet Extensions

In addition to the required core fields, child beads may carry:

- `orderedSteps`
- `fileTouches`
- `expectedBefore`
- `expectedAfter`
- `expectedRedShape`
- `refactorProof`
- `proofCommand`
- `implementationSketches`
- `codeContracts`
- `inlineFixtures`
- `conditionalValidation`
- `commitBoundary`
- `requiredSkills`
- `boundaryDoubles`
- `forbiddenMocks`
- `handoffEvidence`
- `acceptanceMatrixRefs`
- `guardrailRefs`
- `evidenceRefs`
- `riskRefs`
- `externalPlanRefs`

Keep these fields specific to the child. Shared material should live in context beads and be referenced.

## Checkpoint Extensions

Checkpoints may represent pre-edit readiness, fanout, integration, completion, publication, or release gates. Add:

- `gateKind`
- `preconditions`
- `validationCatalogRefs`
- `acceptanceMatrixRefs`
- `manualAcceptance`
- `guardrailRefs`
- `fanoutRules`
- `frozenInterfaces`
- `mergeOwner`
- `commitScope`
- `escalationCriteria`
- `stopConditions`
- `conditionalBranches`
- `releaseGate`

## Validation Checklist

Before pouring:

- Generated TOML has no unresolved `{{...}}` placeholders.
- `bd cook <generated-formula> --dry-run` succeeds.
- Dry-run pour shows the expected root, context beads, parents, checkpoints, and children.
- All `logicalId` values are unique.
- All `needs`, `contextRefs`, `inherits`, `provides`, fixture refs, and follow-up template refs resolve.
- All child beads contain required `workPacket` fields.
- `redCommand` targets exactly one behavior; broader commands live in `verification`.
- `allowedFiles` and `forbiddenFiles` are concrete after hydration.
- Typed child refs resolve: `typedContractRefs`, `acceptanceMatrixRefs`, `guardrailRefs`, `evidenceRefs`, `riskRefs`, and `externalPlanRefs`.
- Evidence, progress, and audit snippets are not converted into child beads unless the plan states executable future work.
- Acceptance criteria remain separate from validation commands.
- File operation intent is preserved, not flattened to paths only.
- Cross-plan relationships are represented even when they cannot become internal `needs`.
- Unresolved decisions are `decision` roles or checkpoint stop conditions, not settled implementation tasks.
- Parallel waves have disjoint write ownership or checkpoint-owned merge rules.
- Checkpoints define validation commands, fanout rules, subagent launch packet shape, and handoff requirements.
- Fixture beads preserve source provenance and refresh policy.

After pouring:

```bash
bd dep cycles
bd list --has-metadata-key planToBeads --json
bd ready
```

## Placeholder Rules

Use `{{snake_case}}` placeholders. Array and object placeholders represent already-rendered TOML fragments, not quoted strings.

Examples:

- `{{plan_id}}` renders as a scalar string fragment when quoted.
- `{{needs_array}}` renders as a TOML array, for example `["global-contract"]`.
- `{{work_packet_table}}` renders as nested TOML fields.

The source snippets may not be valid standalone TOML before hydration. The generated formula must be valid TOML.
