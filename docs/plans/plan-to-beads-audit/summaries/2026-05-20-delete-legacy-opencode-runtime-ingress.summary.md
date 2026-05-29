# Plan-To-Beads Audit Summary: Delete Legacy OpenCode Runtime Ingress

## Source

- Source plan: `docs/plans/2026-05-20-delete-legacy-opencode-runtime-ingress.md`
- Review scope: structure, communicated information types, and fit against formula roles `epic`, `global-contract`, `architecture`, `policy`, `parent`, `child`, `checkpoint`, `fixture`, `pilot`, and `followup-template`, plus contract snippets `work-packet`, `subagent-launch`, and `handoff-note`.

## Plan Structure

- Title plus an executor directive requiring `superpowers:executing-plans`.
- One-sentence goal: delete the temporary sync OpenCode runtime ingress before durable provider orchestration begins.
- Architecture paragraph defining the desired production boundary: `EffectOpenCodeRuntimeIngress` receives OpenCode SSE events, translates them to `ProviderRuntimeEvent` batches, and delegates durable append/projection to `ProviderRuntimeIngestion`.
- Tech stack line naming TypeScript, Effect, Vitest, and SQLite event store/projectors.
- "Why Before Plan 4" rationale list explaining sequencing, boundary risk, and a non-goal around the deeper event-store FK issue.
- Files section with delete/modify/conditional-modify actions.
- Acceptance Criteria Matrix with columns for criterion, proof, and expected assertion.
- Five task sections, each with file scope, numbered steps, code snippets or command blocks, and expected outcomes.
- Done Criteria section with final static checks, focused test expectations, and the Plan 4 prerequisite condition.

## Information Types Communicated

- Plan identity and implementation goal.
- Executor instruction / required implementation workflow.
- Cross-plan sequencing rationale and prerequisite relationship to Plan 4.
- Architecture ownership and forbidden runtime boundaries.
- Tech stack and test/runtime environment.
- File operation inventory, including delete, modify, and conditional modify operations.
- Acceptance criteria expressed as proof method plus expected assertion.
- TDD sequence: add failing guards, port coverage, convert tests, delete API, update related plan, then verify.
- Concrete test snippets and boundary-grep assertions.
- Behavioral requirements for ingress edge cases and reconnect behavior.
- Replacement implementation choices for test construction.
- Verification commands with expected pass/fail status.
- Final done checks and allowed remaining grep hits.

## Fit To Existing Formula Parts

- `epic`: Fits the title and goal cleanly.
- `global-contract`: Fits the scope, non-goal about the event-store FK issue, tech stack, and high-level "delete the shim before Plan 4" constraint.
- `architecture`: Fits the production ingress ownership paragraph and the forbidden direct append/project boundary.
- `policy`: Fits TDD ordering, "port behavior before deleting implementation", "preserve only behaviorful assertions", and required executor-skill guidance.
- `parent`: The five task sections can become stage parents, though some tasks are closer to executable children than broad stages.
- `child`: Individual task steps fit as child work packets when split by behavior, such as static guard tests, effect ingress coverage, projection/integration conversion, API deletion, and plan-doc update.
- `checkpoint`: Fits failing-test confirmation, converted-suite pass checks, no-legacy-import grep, final focused verification, `tsgo --noEmit`, and `git diff --check`.
- `fixture`: Weak fit. The fake `ProviderRuntimeIngestion` and test SQLite persistence are test scaffolds/inputs, not standalone fixture provenance or refresh-policy work.
- `pilot`: No real pilot work appears.
- `followup-template`: No reusable future-work template appears. Plan 4 is referenced as a downstream prerequisite, but not as a template for later child beads.
- `work-packet`: Fits files, goal, constraints, allowed/forbidden paths, red commands, expected failures, green scope, verification, and failure conditions.
- `subagent-launch`: Only partial fit. The top-level executor directive names a required skill, but the plan does not define a launch packet, per-child assignment, or subagent handoff shape.
- `handoff-note`: Weak fit. The plan has done criteria, but no explicit durable handoff-note requirements.

## Gaps / Schema Additions

- Cross-plan relationship metadata: add fields such as `relatedPlans`, `prerequisiteFor`, `updatesPlan`, and `blockedByPlan` so references to Plan 3 and Plan 4 are not flattened into prose.
- File operation manifest: add a structured `fileOperations` contract with `path`, `action`, `condition`, and `reason` to preserve delete/modify/conditional-modify intent outside child prose.
- Acceptance matrix contract: add an `acceptanceCriteria[]` or `acceptance-matrix` snippet with `criterion`, `proof`, and `expectedAssertion`; checkpoint verification commands alone do not preserve the matrix shape.
- Command check list: add repeatable command entries with `phase`, `command`, `expectedStatus`, and `expectedSignal` because this plan contains both expected-red and expected-green checks across multiple tasks.
- Boundary guard schema: add structured static-boundary rules with forbidden imports/symbols, required symbols, path scopes, and allowed exceptions for mapper/ingestion ownership.
- Executor profile: add plan-level or child-level `requiredSkills`, `implementationMode`, and `agentInstructions` fields for directives like `superpowers:executing-plans`.
- Implementation hint / test snippet fields: code snippets in this plan are neither fixtures nor verification commands; optional `testSnippet` or `implementationHint` fields would preserve them without making them normative architecture.

## Notes For Combined Summary

- This plan is mostly compatible with current formula roles if tasks are normalized into smaller child work packets and command blocks become checkpoints.
- The strongest schema pressure comes from preserving matrix-shaped acceptance criteria, cross-plan dependencies, and file operation intent.
- The plan is deletion/refactor oriented, so action-aware file scopes matter more than a generic `allowedFiles` list.
- It contains no meaningful pilot or followup-template content; forcing those roles would add noise.
