# 2026-05-18 Claude Provider Runtime Turn Module Plan Summary

## Source

- Source plan: `docs/plans/2026-05-18-claude-provider-runtime-turn-module.md`
- Plan title: "Claude Provider Runtime And Provider Turn Module Plan"
- Date: 2026-05-18
- Status in plan: Ready after `ProviderRuntimeEvent` contracts-only PR
- Scope of this review: exactly this one plan file, plus the current `plan-to-beads` skill/reference files for formula-role context.

## Plan Structure

The plan is a checklist-oriented implementation plan. Its major sections are:

- Goal: four top-level outcomes for making Claude execution Effect-owned, extracting provider-turn policy, and using `ProviderRuntimeEvent` as pre-storage/test vocabulary.
- Agent Rules: behavioral rules for the implementer, including stop conditions, TDD, and avoiding bulk rewrites.
- Prereqs: required merged work and baseline test commands that must pass before editing.
- Target Shape: desired runtime/service architecture and ownership boundaries.
- Implementation Patterns: Effect-TS coding rules, lifecycle rules, test patterns, and forbidden Promise/timer patterns.
- Provider Turn Module Scope: explicit policy split between `prompt.ts` and the new provider-turn module.
- Files: create/modify/test file inventory.
- Phases: seven ordered implementation phases from spike through guardrails and integration.
- Acceptance Criteria: a table mapping each criterion to a named proof and exact expected assertion.
- Scenario Acceptance Tests: Given/When/Then behavior tests for risky slices.
- TDD Process: red-green loop instructions.
- Guardrail Checklist: static and behavioral checks that must be removed, reclassified, or proven before completion.
- Verification Commands: commands that run proofs, explicitly separated from acceptance criteria.
- Risk: high-risk areas, tradeoffs, and mitigation guidance.
- Out Of Scope: non-goals and protected surfaces.
- Unresolved Questions: open decisions with recommended answers.
- Concrete Steps: ordered execution checklist ending with focused commit guidance.

## Information Types Communicated

- Plan metadata: title, date, readiness status, and dependency on a prior contracts-only PR.
- Strategic objectives: what must become true by the end of the work.
- Implementer policy: stop conditions, TDD discipline, small-slice execution, and expected communication when reality diverges.
- Preconditions: required repository state and baseline tests before implementation starts.
- Architecture target: service ownership, Effect runtime ownership, lifecycle primitives, facade boundaries, and storage/relay/frontend non-changes.
- Coding standards: required Effect APIs, forbidden coordination patterns, error modeling, logging/spans, and test utilities.
- Module boundary contract: what moves out of `prompt.ts`, what stays, and which provider behaviors must remain unchanged.
- File scope: likely created files, modified files, optional wiring files, and test locations.
- Execution sequencing: phase order and spike-before-integration gating.
- Acceptance proof matrix: criterion, named proof, and exact assertion.
- Scenario specifications: Given/When/Then behavior narratives for risky runtime and provider-turn cases.
- Completion guardrails: grep/static checks and suite checks that prove old ownership or forbidden patterns are gone.
- Verification commands: concrete commands, including optional live Claude E2E.
- Risk register: high-risk areas, tradeoffs, and mitigation instructions.
- Non-goals: work explicitly excluded from the change.
- Decision log candidates: unresolved questions paired with recommended answers.
- Final execution checklist: concrete ordered steps and commit expectation.

## Fit To Existing Formula Parts

| Current part | Fit for this plan |
| --- | --- |
| `epic` | Fits the whole plan instance: the Claude runtime/provider-turn migration. It should carry source path, date, status, plan goal summary, and non-goal summary. |
| `global-contract` | Fits Goal, Prereqs, Out Of Scope, and the invariant that storage/relay/frontend behavior must not change. Also fits the "validation is not acceptance" global rule. |
| `architecture` | Fits Target Shape, Implementation Patterns that define module ownership, Provider Turn Module Scope, and the `ProviderRuntimeEvent` boundary. |
| `policy` | Fits Agent Rules, TDD Process, stop conditions, forbidden broad rewrites, SDK Promise-boundary policy, and verification-vs-acceptance discipline. |
| `parent` | Fits the Phases. Each phase can become a parent grouping defaults, owned files, inherited constraints, and expected proof style. |
| `child` | Fits individual executable behavior slices, especially rows in Acceptance Criteria and Scenario Acceptance Tests. Each child can carry one work packet with goal, file scope, failing proof, implementation scope, and verification. |
| `checkpoint` | Fits Prereqs, the Phase 0 spike gate, fanout readiness after core runtime shape is proven, guardrail completion checks, and final verification. |
| `fixture` | Fits fake SDK stream fixtures and ProviderRuntimeEvent fixture/vocabulary examples. The plan explicitly calls for blocking streams, malformed items, result messages, stream errors, abort, and subagent events. |
| `pilot` | Fits Phase 0: prove runtime service, thin facade, and fake SDK stream/finalization semantics before broad integration. |
| `followup-template` | Fits unresolved-question outcomes and optional/live-Claude work that should not become executable until a decision or environment is available. |
| `work-packet` snippet | Fits acceptance rows and scenarios, but should preserve the named proof and exact expected assertion, not just a command. |
| `subagent-launch` snippet | Weak fit. The plan has phase ordering and possible parallelizable areas, but no explicit subagent assignment, disjoint write-set launch packet, or agent handoff instructions. |
| `handoff-note` snippet | Partial fit. The plan requires reporting exact failures and preserving proof evidence, but does not define a durable handoff-note shape beyond the TDD/guardrail expectations. |

## Gaps / Schema Additions

- Acceptance proof matrix: the current `child` and `work-packet` fields can hold proof commands and verification, but the plan's table has first-class `criterion`, `proof`, and `expected assertion` columns. Add structured fields such as `acceptanceCriterion`, `proofName`, and `expectedAssertion`, or add an `acceptance-proof` contract snippet.
- Scenario contract: Given/When/Then narratives fit inside a child goal or inputs, but lossy conversion would blur trigger, action, and expected outcome. Add a structured `scenario` block with `given`, `when`, and `then` fields.
- Guardrail checklist: these are not normal verification commands. They are negative-state/static-retirement checks that must be removed, reclassified, or proven before completion. Add a `guardrail` role or a `staticGuardrail` contract snippet with fields for forbidden pattern, proof command, allowed exceptions, and completion condition.
- Decision question: Unresolved Questions include recommended answers and behavior-preservation defaults. They can be forced into checkpoints or followup templates, but a `decision-point` role would better preserve question, recommendation, blocking scope, and default if unanswered.
- Risk/tradeoff register: Risks and tradeoffs can be scattered across policy, architecture, checkpoints, or pilots. Add optional `risks` metadata to epic/parent/checkpoint, or a `risk-register` context role, to keep mitigation instructions visible to child agents.
- File inventory provenance: Existing `allowedFiles` and `forbiddenFiles` cover child write scopes, but this plan also communicates create/modify/optional/test inventories at plan level. Add parent-level `fileInventory` fields for `create`, `modify`, `modifyIfNeeded`, and `tests`.
- Baseline/precondition evidence: Prereqs fit checkpoint, but the current schema should distinguish pre-edit baseline checks from post-change verification. Add checkpoint metadata such as `gateKind = "preflight" | "fanout" | "completion"`.

## Notes For Combined Summary

- This plan is high signal for schema work because it separates acceptance criteria from verification commands more explicitly than many implementation plans.
- The existing formula parts cover the broad shape, but several information types would be lossy unless the converter preserves proof matrices, scenario structure, guardrails, decisions, and risks as structured metadata.
- A good conversion would likely create one epic, several context beads, phase parents, a Phase 0 pilot/checkpoint, child beads driven by acceptance criteria/scenarios, fixture beads for fake SDK streams, guardrail checkpoints, and decision/follow-up beads for unresolved questions.
- The plan does not provide enough information for direct `subagent-launch` snippets without adding ownership, branch/worktree expectations, disjoint write sets, and handoff requirements during conversion.
