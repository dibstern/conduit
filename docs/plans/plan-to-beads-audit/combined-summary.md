# Plan-To-Beads Historical Plan Audit

## Source

This audit reviewed 24 historical `docs/plans/` files with one subagent per plan. Each subagent produced a per-plan summary under:

`docs/plans/plan-to-beads-audit/summaries/`

The goal was to identify what kinds of planning information occur in real conduit plans and which parts do not fit cleanly into the current `/plan-to-beads` formula parts:

- Roles: `epic`, `global-contract`, `architecture`, `policy`, `parent`, `child`, `checkpoint`, `fixture`, `pilot`, `followup-template`
- Contract snippets: `work-packet`, `subagent-launch`, `handoff-note`

## High-Level Result

The current role set is strong enough for ordinary implementation plans. Most executable work can be represented as:

- `epic` for the plan instance
- `global-contract` for scope, non-goals, package/repo boundaries, and prerequisites
- `architecture` for module contracts, seams, data flow, and ownership rules
- `policy` for TDD, Beads, subagent, guard, and execution rules
- `parent` for phases, waves, and feature groups
- `child` for one vertical TDD behavior
- `checkpoint` for readiness, fanout, integration, and completion gates
- `fixture` for durable fixture provenance
- `pilot` for evidence-gathering probes
- `followup-template` for non-executable future work

The recurring weak fit is not the work graph itself. The weak fit is structured context around the work: evidence, audit findings, amendments, decisions, acceptance proof matrices, guardrails, status history, file-operation intent, and cross-plan relationships. Those should be added as reusable metadata/snippet shapes before adding many new top-level bead roles.

## Plan Shapes Found

The reviewed plans fall into several repeatable shapes.

1. Executable TDD implementation plans
   - Examples: daemon bind fix, Claude subagent streaming, Claude materialization, automatic titles, local trace artifact, provider runtime contracts.
   - Usually fit current roles well.
   - Need richer child/checkpoint metadata for ordered steps, expected RED/GREEN shapes, file operation intent, commit boundaries, and manual acceptance.

2. Migration and architecture plans
   - Examples: Effect-TS mainline completion, provider runtime adoption, durable receipts decider/projector.
   - Fit `epic`, `global-contract`, `architecture`, `policy`, `parent`, `child`, and `checkpoint`.
   - Need structured support for module maps, command taxonomies, guardrails, risk registers, acceptance matrices, and blocker decisions.

3. Live progress and archive documents
   - Examples: Effect-TS live progress and archive.
   - Do not convert cleanly into child work packets because much of the content is already-executed evidence.
   - Need progress/evidence records, verification results, historical status, archive provenance, residual debt, and reverted-attempt records.

4. Audit and amendment sidecars
   - Examples: daemon bind audit, audit R2, durable receipts architecture and TDD improvement sidecars.
   - Not normal executable work graphs.
   - Need audit-finding, review-run, amendment-ledger, plan-edit, source-grounding, and review-disposition schema.

5. Contract-hardening plans
   - Examples: provider boundary/runtime schemas, provider contract runtime schemas, provider runtime event contracts.
   - Fit the broad roles, but the important content is proof-oriented and boundary-oriented.
   - Need source authority, boundary classification, drift checks, compatibility contracts, opaque payload preservation, and test-style policy.

6. Deletion/refactor plans
   - Example: delete legacy OpenCode runtime ingress.
   - Need action-aware file scopes and boundary guard schemas.
   - Generic `allowedFiles` is too lossy for delete/modify/conditional-modify intent.

## Recommended Schema Additions

### 1. Evidence Records

Add reusable evidence snippets that can attach to `epic`, `parent`, `child`, `checkpoint`, `pilot`, `audit`, and `progress` records.

Suggested snippets:

- `evidenceRun`
- `verificationResult`
- `baselineSnapshot`
- `sourceGrounding`
- `inventorySnapshot`
- `guardrailEvidence`
- `failedAttempt`

Typical fields:

- `kind`
- `source`
- `cwd`
- `command`
- `environment`
- `expected`
- `actual`
- `exitCode`
- `classification`
- `logPath`
- `evidenceRefs`
- `caveats`
- `rerunOf`
- `observedAt`
- `staleAfter`
- `reverifyRequired`

Why: many plans preserve command output, grep evidence, source-state observations, failed historical commands, and corrected commands. Forcing this into `verification` loses whether the command is required future work, completed evidence, baseline proof, or historical correction.

### 2. Audit And Amendment Records

Add first-class support for review/audit artifacts. Prefer snippets plus one optional role.

Candidate role:

- `review` or `audit`

Suggested snippets:

- `auditFinding`
- `reviewRun`
- `reviewDisposition`
- `amendmentLedger`
- `planEdit`
- `nonActionableFinding`

Typical fields:

- `findingId`
- `severity`
- `sourcePlan`
- `sourceTaskRefs`
- `evidenceRefs`
- `problem`
- `impact`
- `requiredAmendment`
- `disposition`
- `appliedStatus`
- `amendsPlan`
- `targetPlanPath`
- `doesNotReplaceTarget`
- `auditor`
- `reviewMode`
- `coverage`
- `rerunInstructions`

Why: several plans are review sidecars rather than implementation plans. They should not become fake child work packets, but their findings and amendments must remain durable and queryable.

### 3. Status, Progress, And Historical Overlay

Add status/history fields at the `epic`, `parent`, and evidence layer.

Suggested snippets:

- `progressEntry`
- `completedSlice`
- `historicalStatus`
- `archiveProvenance`
- `residualDebt`
- `statusOverlay`

Typical fields:

- `status`
- `statusDate`
- `sourceDate`
- `completedAt`
- `completedBy`
- `authoritativeOrder`
- `supersedes`
- `supersededBy`
- `closedBlockers`
- `appendPolicy`
- `liveProgressPath`
- `archivePath`
- `residualRisk`
- `remainingDebt`
- `cleanupPrerequisite`

Why: progress plans and closed migration plans contain information about what happened, what was retained, what was reverted, what superseded earlier instructions, and which ordering is authoritative.

### 4. Decision Points

Add decision metadata rather than overloading `checkpoint`, `pilot`, or `architecture`.

Candidate role:

- `decision`

Suggested snippets:

- `openDecision`
- `blockerDecision`
- `decisionOptions`
- `decisionNeeded`
- `conditionalBranch`

Typical fields:

- `question`
- `status`
- `recommendedDefault`
- `options`
- `selectedOption`
- `rationale`
- `tradeoffs`
- `blockingScope`
- `requiredBefore`
- `proofRequired`
- `defaultIfUnanswered`
- `followupTrigger`
- `externalDecisionOwner`

Why: Phase 0 blocker decisions, unresolved questions, "if too broad" branches, and "stop and ask" conditions recur. They are not implementation children and should not be marked executable until resolved.

### 5. Acceptance Proof And Scenarios

Add structured acceptance proof instead of flattening proof matrices into checkpoint prose.

Suggested snippets:

- `acceptanceMatrix`
- `acceptanceCriterion`
- `acceptanceScenario`
- `acceptanceTrace`
- `manualAcceptance`
- `operatorSmoke`

Typical fields:

- `criterion`
- `proof`
- `expectedAssertion`
- `ownerLogicalId`
- `given`
- `when`
- `then`
- `tracePath`
- `prerequisites`
- `manualSteps`
- `expectedObservableResult`
- `evidenceToRecord`

Why: many plans separate acceptance criteria from verification commands. The matrix row shape is important because it explains why commands and tests exist.

### 6. Guardrails And Negative-State Contracts

Add a guardrail role or reusable snippets.

Candidate role:

- `guardrail`

Suggested snippets:

- `staticGuardrail`
- `boundaryGuard`
- `guardrailRegistry`
- `antiPattern`
- `allowedException`
- `changeSurfaceGuard`

Typical fields:

- `forbiddenState`
- `forbiddenPattern`
- `requiredPattern`
- `scope`
- `allowedLocations`
- `knownNonExceptions`
- `proofCommand`
- `expectedResult`
- `resolutionPolicy`
- `completionBlocksUntilResolved`
- `reclassificationRule`

Why: guardrails are not just validation commands. They encode negative contracts: imports that must not exist, legacy code that must disappear, allowed exceptions, and grep/static proof obligations.

### 7. File Operations, Ownership, And VCS Boundaries

Extend `workPacket.allowedFiles`/`forbiddenFiles` with typed file ownership and delivery metadata.

Suggested snippets:

- `fileOperations`
- `fileTouches`
- `ownershipMap`
- `changeSurface`
- `commitBoundary`
- `deliverySequence`
- `publication`
- `releaseGate`

Typical fields:

- `path`
- `operation`: `create`, `modify`, `delete`, `modifyIfNeeded`, `readOnly`, `test`, `fixture`, `review`
- `reason`
- `ownerLogicalId`
- `sharedOwner`
- `forbiddenTo`
- `condition`
- `commitMessage`
- `gitAddPaths`
- `commitCondition`
- `rollbackPlan`
- `backupRequired`
- `observeBeforeConsumerSwitch`
- `prCreation`

Why: deletion/refactor and migration plans rely on exact action intent. `allowedFiles` alone cannot distinguish "delete this", "read this", "create only when forced", "modify only if existing barrel is used", and "owned by integration checkpoint".

### 8. Architecture Contracts And Provenance

Strengthen architecture metadata for plans that define boundaries, modules, protocols, and borrowed patterns.

Suggested snippets:

- `moduleMap`
- `boundaryClassification`
- `protocolContract`
- `artifactContract`
- `configContract`
- `commandCatalog`
- `mappingTable`
- `sourceAuthority`
- `referencePattern`
- `priorArt`

Typical fields:

- `module`
- `interfaceOwner`
- `implementationFiles`
- `adapterPolicy`
- `doesNotOwn`
- `deletionTest`
- `strictFields`
- `opaqueFields`
- `degradeAllowed`
- `schemaVersion`
- `fieldRules`
- `sourceSystem`
- `sourceCommit`
- `adaptationNotes`
- `authorityOrder`
- `compatibilityExpectation`

Why: several plans encode interface boundaries and source-of-truth precedence. This is more precise than generic architecture prose and should be readable by child beads.

### 9. Risk, Edge, And Operational Procedure

Add typed operational and risk metadata.

Suggested snippets:

- `riskRegister`
- `edgeCaseRegister`
- `operationalProcedure`
- `runbook`
- `rollbackProcedure`
- `manualRecovery`

Typical fields:

- `risk`
- `severity`
- `mitigation`
- `proof`
- `acceptedTradeoff`
- `edgeCase`
- `expectedBehavior`
- `procedureSteps`
- `environmentPrereqs`
- `stopConditions`
- `recoverySteps`

Why: risk and operational runbook sections recur and should stay visible to implementers without becoming fake child tasks.

### 10. Cross-Plan Relationships

Add structured plan relationship fields.

Suggested fields:

- `relatedPlans`
- `blockedByPlan`
- `prerequisitePlans`
- `updatesPlan`
- `amendsPlan`
- `supersedesPlan`
- `prerequisiteFor`
- `externalPlanDependency`

Typical nested fields:

- `path`
- `relationship`
- `condition`
- `blockingUntil`
- `doNotGuess`
- `statusKnownAtConversion`

Why: historical plans frequently depend on other plans landing first, amend another plan, or declare a future follow-up plan. Beads `needs` can model dependencies inside one generated graph, but not external plan relationships unless the converter invents placeholder beads.

### 11. Executor And Harness Policy

Keep implementation-agent execution separate from product-domain subagents.

Suggested snippets:

- `executorProfile`
- `requiredSkills`
- `implementationMode`
- `agentInstructions`
- `applicationLifecycle`

Typical fields:

- `requiredSkills`
- `requiredCommands`
- `forbiddenTools`
- `implementationMode`
- `worktreePolicy`
- `handoffPolicy`
- `applicationDomain`
- `doNotConfuseWithSubagentLaunch`

Why: some plans mention Claude/provider subagents inside the product, while `/plan-to-beads` also has a `subagent-launch` snippet for implementation agents. Those must stay distinct.

## Role Changes Recommended

Do not add a large number of top-level bead roles. Prefer the current role set plus a small number of optional context roles.

Recommended new top-level roles:

1. `decision`
   - For unresolved, blocker, or conditional decisions that control execution.

2. `guardrail`
   - For static or behavioral negative-state contracts that block completion.

3. `review`
   - For audit/review/amendment sidecars that are not implementation work.

Optional, if progress archives must be converted losslessly:

4. `progress`
   - For historical status, completed slices, verification results, and live/archive ledgers.

Everything else can be a metadata contract snippet attached to existing roles.

## Child Work-Packet Additions

Add these fields to the child schema:

- `orderedSteps`
- `fileTouches`
- `expectedBefore`
- `expectedAfter`
- `expectedRedShape`
- `greenScope`
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
- `failureConditions`
- `handoffEvidence`

The current `goal`, `inputs`, `constraints`, `allowedFiles`, `forbiddenFiles`, `redCommand`, `expectedFailure`, `greenScope`, `verification`, and `failureConditions` are still the right core. These additions preserve recurring implementation details without turning every note into a new bead.

## Checkpoint Additions

Add these checkpoint fields:

- `gateKind`: `preflight`, `decision`, `fanout`, `integration`, `completion`, `publication`, `release`
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

Checkpoints should be able to represent pre-edit readiness, integration gates, publication gates, and completion guardrails without pretending all of them are the same kind of validation command.

## Formula Conversion Guidance

When `/plan-to-beads` converts these plans, it should follow these rules.

1. Do not convert evidence logs into executable child beads.
2. Do not convert audit findings into implementation tasks without their target plan context.
3. Preserve acceptance criteria separately from verification commands.
4. Preserve file operation intent, not only file paths.
5. Preserve cross-plan dependencies as plan relationships even when they cannot become internal Beads `needs`.
6. Preserve unresolved decisions as `decision` or checkpoint-gated work, not as settled architecture.
7. Preserve guardrails as negative contracts with proof obligations.
8. Preserve historical status overlays so outdated phase order does not become executable order.
9. Prefer snippets attached to existing roles before adding new role types.
10. Only hydrate `child` beads when the plan provides one behavior, red command, expected failure, green scope, file scope, and verification path, or when those fields can be derived without inventing design.

## Per-Plan Coverage

All requested plans have a corresponding summary file:

- `2026-05-11-effect-ts-mainline-completion-plan.summary.md`
- `2026-05-11-effect-ts-mainline-completion-progress.summary.md`
- `2026-05-11-fix-daemon-effect-server-bind-audit-r2.summary.md`
- `2026-05-11-fix-daemon-effect-server-bind-audit.summary.md`
- `2026-05-11-fix-daemon-effect-server-bind.summary.md`
- `2026-05-12-claude-sdk-agent-access-second-pass.summary.md`
- `2026-05-14-effect-ts-mainline-live-progress-archive.summary.md`
- `2026-05-14-effect-ts-mainline-live-progress.summary.md`
- `2026-05-15-claude-subagent-live-child-streaming-design.summary.md`
- `2026-05-15-claude-subagent-live-child-streaming.summary.md`
- `2026-05-15-claude-subagent-materialization.summary.md`
- `2026-05-15-provider-boundary-runtime-schemas.summary.md`
- `2026-05-16-effect-ts-remaining-ownership-breakdown.summary.md`
- `2026-05-17-claude-session-automatic-titles.summary.md`
- `2026-05-17-local-trace-artifact.summary.md`
- `2026-05-17-provider-contract-runtime-schemas.summary.md`
- `2026-05-17-provider-runtime-event-contracts.summary.md`
- `2026-05-18-claude-provider-runtime-turn-module.summary.md`
- `2026-05-18-full-provider-runtime-event-adoption.summary.md`
- `2026-05-18-provider-orchestration-durable-receipts-decider-projector.architecture-improvements.summary.md`
- `2026-05-18-provider-orchestration-durable-receipts-decider-projector.summary.md`
- `2026-05-18-provider-orchestration-durable-receipts-decider-projector.tdd-improvements.summary.md`
- `2026-05-18-provider-runtime-event-contracts.summary.md`
- `2026-05-20-delete-legacy-opencode-runtime-ingress.summary.md`

## Bottom Line

The `/plan-to-beads` template should keep the existing execution roles, then add a richer library of typed contract snippets. The most important additions are:

1. `acceptanceMatrix`
2. `evidenceRun` / `verificationResult`
3. `auditFinding` / `amendmentLedger`
4. `decision` / `blockerDecision`
5. `guardrail`
6. `fileOperations` / `ownershipMap`
7. `progressEntry` / `historicalStatus`
8. `moduleMap` / `boundaryClassification`
9. `riskRegister`
10. `crossPlanRelationship`

Those additions let Beads store the full planning substance without turning every piece of context into noisy executable work.
