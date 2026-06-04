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
      "targetField": "artifact_contracts_array_of_tables",
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
      "contextUse": [
        {
          "ref": "architecture-core",
          "phase": "before-edit",
          "required": true,
          "reason": "Module boundaries constrain the patch",
          "failureIfMissing": "Stop and create a decision bead"
        }
      ],
      "metadata": {}
    }
  ]
}
```

Use the IR as the only source for plan-specific values. Do not edit the generic templates with concrete behavior names, file paths, expected failures, or commands.

Top-level `typedContracts` are optional convenience input. During rendering, each one is attached to the role named by `ownerLogicalId`; `targetField` may name the destination placeholder explicitly. If `targetField` is omitted, the renderer supports common snippet kinds such as `artifactContract`, `protocolContract`, `moduleMap`, `auditFinding`, `progressEntry`, `evidenceRun`, and `sourceGrounding`. The renderer also adds the contract's `provides` values to the owner role so child `typedContractRefs` resolve.

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
| `acceptance-pipeline` | `needs`, `contextRefs`, `acceptanceMatrixRefs` | Optional generated acceptance and acceptance-mutation proof layer |

`needs` gates readiness. `contextRefs` tells an agent what to read. `inherits` merges defaults into the child prompt contract. `typedContractRefs` points at typed snippets inside context beads. `provides` declares named data that later beads may reference.

`contextUse` adds timing and failure behavior to context references. Use it when an agent must know whether to read a context bead before editing, during implementation, during verification, during handoff, or only when blocked.

For child beads, the canonical home is `workPacket.inputContract.contextUse`. Do not also render `contextUse` into the child `planToBeads` metadata table. For non-child roles, role-level `contextUse` is acceptable when that role directly consumes context.

```toml
[[contextUse]]
ref = "{{context_ref}}"
phase = "before-edit" # before-edit|during-edit|verification|handoff|if-blocked
required = true
reason = "{{why_this_context_is_needed}}"
failureIfMissing = "{{what_agent_should_do_if_missing}}"
```

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
| Generated acceptance or mutation proof | `acceptance-pipeline` | `needs`, `contextRefs`, `acceptanceMatrixRefs` |

Do not duplicate large snippets into every child. A child should carry only its own executable prompt contract plus references to the context snippets it must obey.

Use a separate bead when the item has lifecycle, dependencies, readiness, ownership, or closure. Use a typed snippet when it is read-only context attached to the smallest durable owner. For example, an unresolved architecture decision is a `decision` bead; a resolved decision inside a stage is a snippet. A fixture refresh task is a bead; fixture provenance is a snippet.

## Canonical Ownership

Use these owners to keep the schema MECE. Similarly named snippets should be aliases or views, not separate sources of truth.

| Concept | Canonical owner | Aliases or views |
| --- | --- | --- |
| Expected product behavior | `acceptanceMatrix` | `acceptanceCriteria`, `manualAcceptance`, `operatorSmoke` |
| Observed command/run evidence | `evidenceRun` | `verificationResult`, `guardrailEvidence`, `failedAttempt` |
| Allowed, forbidden, and read-only paths | `changeSurface` | child `allowedFiles`, child `forbiddenFiles` |
| Intended file action | `fileOperations` | none |
| Actual handoff changes | `fileTouches` | none |
| Parallel file ownership | `ownershipMap` | parent defaults, checkpoint merge contract |
| Cross-plan relationship | `crossPlanRelationship` | `blockedByPlan`, `amendsPlan`, `supersedesPlan`, `relatedPlans` |
| Agent execution contract | child `workPacket` subcontracts | legacy flat child fields |
| Integration/fanout gate | checkpoint subcontracts | legacy flat checkpoint fields |
| APS product-behavior proof | `acceptance-pipeline` role | acceptance matrix refs on children/checkpoints |

When a plan contains a resolved fact, attach it as a typed snippet to the smallest durable owner. When it contains work with status, dependencies, ownership, or closure, create a bead.

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
| `acceptance-pipeline` | `task` | Optional generated acceptance or mutation proof layer |

`parent` should usually be a `feature`, not a `task`, because it groups behavior and carries stage defaults. Use `chore` for non-product mechanical work such as fixture manifests, validation sweeps, export/sync, or template maintenance.

## Version Control

- Commit generic source templates in `.agents/skills/plan-to-beads/templates/`.
- Generate plan-specific formulas in `.beads/generated-formulas/<plan-id>.formula.toml` for review.
- Install a generated formula into `.beads/formulas/` only when the user wants a reusable formula name.
- Do not call `bd mol pour` directly against `.beads/generated-formulas/`; `pour` needs a persisted proto or a formula on the Beads search path.
- Store molecule instances and runtime status in Beads/Dolt; `.beads/*.jsonl` are passive exports.
- Include `contractVersion = "plan-to-beads.v3"` and `templateVersion` in rendered metadata.
- Treat existing `plan-to-beads.v2` flat child and checkpoint fields as compatibility input. Generators should normalize them into v3 subcontracts before rendering new formulas.

## Rendering Strategy

Preferred path:

1. Parse the plan into IR.
2. Validate IR completeness.
3. Run `node .agents/skills/plan-to-beads/scripts/render-plan-to-beads.cjs <plan-ir.json> <generated-formula>`.
4. Run `node .agents/skills/plan-to-beads/scripts/validate-plan-to-beads.cjs <generated-formula>`.
5. Run `bd cook <generated-formula> --dry-run`.
6. After approval, run `bd cook <generated-formula> --persist --force`, then `bd mol pour <formula-id> --dry-run`.

Small-plan fallback:

1. Hydrate role templates directly into `bd create`, `bd update`, and `bd dep add`.
2. Query Beads after mutation.
3. Run the same schema validation against Beads metadata.

## Template Layers

- `templates/formula/`: outer formula shape and common vars.
- `templates/roles/`: one Beads issue/step per role.
- `templates/contracts/`: reusable metadata snippets for child work packets, subagent launch packets, durable handoff notes, and typed shared context.

The converter may inline contract snippets into role snippets, or render role snippets directly when the role already contains the needed fields. The generated formula is the first artifact that must be valid TOML.

`scripts/render-plan-to-beads.cjs` is the deterministic placeholder hydrator. It expects a plan IR with top-level plan fields and `roles` entries. Each role may provide values directly or under `metadata`/`values`; missing arrays render as `[]`, missing tables as `{}`, booleans as `false`, integers as `0`, and strings as empty strings.

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
| `cross-plan-relationships` | `crossPlanRelationship`, `relatedPlans`, `blockedByPlan`, `prerequisitePlans`, `updatesPlan`, `amendsPlan`, `supersedesPlan`, `prerequisiteFor`, `externalPlanDependency` | `epic`, `global-contract`, `decision`, `followup-template` |
| `executor-policy` | `executorProfile`, `requiredSkills`, `implementationMode`, `agentInstructions`, `applicationLifecycle` | `policy`, `parent`, `checkpoint` |
| `context-use` | `contextUse` | any role that references context |
| `acceptance-pipeline` | `gherkinFeatureContract`, `jsonIrContract`, `acceptanceGeneratorContract`, `stepHandlerContract`, `runnerAdapterContract`, `mutationContract`, `mutationReportContract` | `acceptance-pipeline`, `checkpoint` |

Use new top-level roles only when the information needs independent lifecycle or status. Otherwise attach the snippet to an existing role.

## Child Work Packet Shape

Each executable child is a durable prompt contract. New formulas should render these subcontracts instead of flat fields:

| Subcontract | Owns |
| --- | --- |
| `goalContract` | goal, expected outcome, non-goals, behavior id |
| `inputContract` | source plan, inputs, context refs, `contextUse`, fixtures, baselines, evidence, external plans |
| `constraintContract` | allowed/forbidden/read-only files, guardrails, risks, skills, tools, doubles, mocks |
| `executionContract` | ordered steps, green scope, implementation limits, sketches, code contracts, inline fixtures |
| `validationContract` | red command, expected failure, expected red shape, verification, acceptance refs, proof command |
| `outputContract` | output shape, patch shape, file touches, file-operation refs, commit boundary, evidence to record |
| `failureContract` | failure conditions, stop conditions, blocker decisions, follow-up templates, escalation |
| `handoffContract` | Beads note requirement, commit SHA requirement, artifact root, close owner, notes schema |

Compatibility mapping from v2:

| v2 field | v3 home |
| --- | --- |
| `goal` | `goalContract.goal` |
| `inputs`, `contextRefs`, `inherits`, `typedContractRefs` | `inputContract` |
| `constraints`, `allowedFiles`, `forbiddenFiles`, `requiredSkills`, `boundaryDoubles`, `forbiddenMocks` | `constraintContract` |
| `orderedSteps`, `greenScope`, `implementationSketches`, `codeContracts`, `inlineFixtures`, `expectedBefore`, `expectedAfter` | `executionContract` |
| `redCommand`, `expectedFailure`, `expectedRedShape`, `verification`, `acceptanceCriteria`, `acceptanceMatrixRefs`, `proofCommand`, `conditionalValidation` | `validationContract` |
| `outputShape`, `fileTouches`, `commitBoundary`, `handoffEvidence` | `outputContract` |
| `failureConditions` | `failureContract` |
| `handoff` | `handoffContract` |

## Checkpoint Shape

Checkpoints may represent pre-edit readiness, fanout, integration, completion, publication, or release gates. New formulas should render these subcontracts:

| Subcontract | Owns |
| --- | --- |
| `gateContract` | gate kind, target, preconditions, closed dependencies, blocking behavior, guardrails, release gate |
| `fanoutContract` | parallel launch rules, subagent checklist, frozen extension points, allowed/blocked child refs |
| `mergeContract` | merge owner, commit scope, ownership-map refs, handoff validation, conflict policy |
| `validationContract` | validation commands, validation catalog refs, acceptance matrix refs, manual acceptance, evidence |
| `escalationContract` | escalation criteria, stop conditions, conditional branches, decision refs |

## Acceptance Pipeline Shape

Use `acceptance-pipeline` only when the plan requires generated acceptance tests, a JSON acceptance IR, or acceptance mutation. It is not a default child bead. It records the product-behavior proof layer that checkpoints or children can depend on.

| Subcontract | Owns |
| --- | --- |
| `gherkinFeatureContract` | feature paths, supported and unsupported Gherkin subset, scenario/examples policy |
| `jsonIrContract` | generated IR paths, schema ref, canonical fields, deterministic ordering |
| `acceptanceGeneratorContract` | generator command, generated test paths, source-feature isolation, determinism proof |
| `stepHandlerContract` | handler paths, matching policy, world-state policy, unsupported-step behavior |
| `runnerAdapterContract` | normal acceptance command and success/failure/infrastructure shapes |
| `mutationContract` | acceptance mutation command, scope, threshold, result shape, differential policy |
| `mutationReportContract` | JSON/text report paths, survived policy, error policy |

## Validation Checklist

Before pouring:

- Generated TOML has no unresolved `{{...}}` placeholders.
- `node .agents/skills/plan-to-beads/scripts/validate-plan-to-beads.cjs <generated-formula>` passes.
- `bd cook <generated-formula> --dry-run` succeeds.
- Dry-run pour shows the expected root, context beads, parents, checkpoints, and children.
- All `logicalId` values are unique.
- All `needs`, `contextRefs`, `inherits`, fixture refs, and follow-up template refs resolve.
- `provides` values are unique declarations and become valid reference targets.
- All required `contextUse` refs resolve and state phase, reason, and failure behavior.
- All child beads contain required v3 `workPacket` subcontracts.
- Child executable fields are non-empty: `goal`, `expectedOutcome`, `behaviorId`, `sourcePlan`, `greenScope`, `redCommand`, `expectedFailure`, `verification`, `outputShape`, `patchShape`, either `allowedFiles` or `changeSurfaceRef`, and at least one failure/stop/blocker condition.
- Child `contextUse` appears only under `workPacket.inputContract`.
- `redCommand` targets exactly one behavior; broader commands live in `verification`.
- `allowedFiles` and `forbiddenFiles` are concrete after hydration.
- Child file scope is normalized into `constraintContract`; shared file ownership is normalized into `ownershipMap` or checkpoint `mergeContract`.
- Typed child refs resolve: `typedContractRefs`, `acceptanceMatrixRefs`, `guardrailRefs`, `evidenceRefs`, `riskRefs`, and `externalPlanRefs`.
- `verificationResult` snippets either reference an `evidenceRun` or are normalized into one by the generator.
- Cross-plan aliases normalize into `crossPlanRelationship` records before validation.
- Evidence, progress, and audit snippets are not converted into child beads unless the plan states executable future work.
- Acceptance criteria remain separate from validation commands.
- File operation intent is preserved, not flattened to paths only.
- Cross-plan relationships are represented even when they cannot become internal `needs`.
- Unresolved decisions are `decision` roles or checkpoint stop conditions, not settled implementation tasks.
- Parallel waves have disjoint write ownership or checkpoint-owned merge rules.
- Checkpoints define gate, fanout, merge, validation, and escalation contracts.
- Acceptance-pipeline beads, when present, define normal acceptance and mutation commands plus expected result shapes.
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
