# 2026-05-12 Claude SDK Agent Access Second Pass - Plan-To-Beads Audit Summary

## Source

- Source plan: `docs/plans/2026-05-12-claude-sdk-agent-access-second-pass.md`
- Plan title: `Claude SDK Agent Access - Second-Pass Improvement Plan`
- Stated branch: `ds/claude-sdk-agent-access-fixes`
- Purpose: follow-up plan for six residual concerns after two earlier Claude SDK agent-access fix plans. The source says the earlier plans deliver the working fix and that this pass closes non-blocking residual issues before branch merge.

## Plan Structure

1. Framing paragraph
   - Names two companion plans.
   - States that the base implementation already fixes four audit findings.
   - Defines this plan as additional commits on the same branch.

2. Verified baseline table
   - Section title: `What's already correct (do not touch)`.
   - Lists audit items, code locations, and status/rationale.
   - Communicates protected boundaries and evidence for work that should not be changed.

3. Residual issue inventory
   - Table of six issues with issue number, code area, priority, and problem shape.
   - Covers permission bridge indirection, transcript data leakage, synthetic serializer tests, transcript size, generic error code, and Claude capability cache invalidation.

4. Six improvement sections
   - Each improvement has a named problem, rationale, fix shape, and tests or verification notes.
   - Improvement 1 includes two implementation options and a recommendation.
   - Improvements 2, 4, 5, and 6 include concrete TypeScript sketches.
   - Improvement 3 includes a required investigation step before finalizing the test/fix.

5. Explicit non-goals
   - Lists Effect migration, cache Layer migration, subagent lifecycle rework, and OpenCode-side changes as out of scope.

6. Execution order
   - Provides recommended single-PR sequence, one commit per improvement.
   - Explains dependency/review ordering.

7. Verification and smoke gates
   - Defines per-commit commands, full test gate before merge, and manual smoke steps for Claude sessions, agent switching, permission prompts, and `agent_list` model annotations.

## Information Types Communicated

- Source lineage and branch/landing constraints.
- Verified baseline evidence with code references and protected "do not touch" areas.
- Residual issue inventory with priorities, locations, and short problem statements.
- Current behavior explanations, including one call-flow diagram for permission resolution.
- Concrete failure examples and data-integrity hazards.
- Recommended fix shapes, including TypeScript snippets and API shape changes.
- Alternative implementation options and recommendation rationale.
- Test updates, new test cases, expected assertions, and where tests should live.
- Investigation task for discovering real persisted message-part shapes.
- Runtime guardrail policy for transcript truncation, logging, and user-visible status events.
- Typed contract/API change for `TurnErrorCode`.
- Cache invalidation design, optional production hook points, and deliberately excluded watcher behavior.
- Non-goals and architectural boundaries.
- Commit choreography, review sequencing, verification commands, and manual smoke scenarios.

## Fit To Existing Formula Parts

- `epic`: Fits the whole second-pass improvement plan. The plan has a clear title, branch, source lineage, and merge-before-landing objective.
- `global-contract`: Fits branch constraints, explicit non-goals, "do not touch" boundaries, and provider scope. It would also carry the rule that work lands as additional commits on `ds/claude-sdk-agent-access-fixes`.
- `architecture`: Fits cross-cutting design contracts around Claude adapter ownership, permission resolution, event sinks, transcript serialization, provider error codes, and capability cache ownership.
- `policy`: Fits TDD expectations, per-commit verification gates, no Effect migration in this pass, no filesystem watcher, and review sequencing preferences.
- `parent`: Fits each improvement section as a grouping unit when the section contains multiple implementation/test tasks. It also fits broader groupings such as transcript safety, permission simplification, and capability refresh.
- `child`: Fits most concrete implementation/test tasks, especially Improvements 2, 4, 5, and 6. Several sections already provide enough goal, target files, constraints, and verification hints to seed child work packets, but they do not fully specify all required child contract fields.
- `checkpoint`: Fits per-commit verification, full pre-merge test gate, manual smoke, and Improvement 3's investigation gate before serializer allowlists are finalized.
- `fixture`: Fits synthetic history fixtures, real `MessageWithParts[]` row fixtures, and possible live SQLite evidence for message part types.
- `pilot`: Fits the Improvement 3 discovery step and manual smoke that proves real-data agent-switch behavior, because both gather evidence before or after implementation.
- `followup-template`: Fits optional reload/SIGHUP hook wiring if not executed in this pass, and future cache invalidation callers. Most other work is executable now, not template-only.
- `work-packet` contract snippet: Partially fits. The plan supplies goals, inputs, constraints, target files, expected tests, and verification commands, but it does not consistently provide `allowedFiles`, `forbiddenFiles`, `redCommand`, `expectedFailure`, `greenScope`, `failureConditions`, or Beads handoff requirements.
- `subagent-launch` contract snippet: Mostly absent. The plan has ordered work and validation gates, but no explicit parallel subagent launch packets, write-set ownership, or fanout instructions.
- `handoff-note` contract snippet: Mostly absent. The plan names verification and smoke evidence, but it does not define durable handoff note content, required Beads note fields, or closeout metadata.

## Gaps / Schema Additions

1. Baseline evidence / protected-area matrix
   - The `What's already correct` table is more specific than a generic `global-contract`.
   - Suggested addition: a `baseline-evidence` role or contract snippet with fields for audit item, evidence refs, status, rationale, and protected boundary.

2. Residual issue inventory
   - The residual issue table is a triage artifact, not yet a work graph.
   - Suggested addition: an `issue-inventory` snippet or parent metadata fields for source location, priority, residual risk, and originating audit finding.

3. Alternatives and recommendation rationale
   - Improvement 1's Option A/Option B discussion is a decision record embedded inside implementation work.
   - Suggested addition: a `decision-options` snippet usable from `architecture`, `policy`, or `child` metadata with options, recommendation, tradeoffs, and rejected conditions.

4. Implementation sketches
   - The plan includes concrete TypeScript examples that are useful but not the same as executable acceptance criteria.
   - Suggested addition: an optional `implementationSketch` field on `work-packet`, marked advisory/non-authoritative so agents preserve intent without treating sketches as exact patches.

5. Investigation gates
   - Improvement 3 requires discovering real `MessagePartRow.type` values before committing to an allowlist.
   - Existing `pilot` can represent this, but it would benefit from explicit fields such as `question`, `evidenceSources`, `decisionOutput`, and `unblocks`.

6. Commit choreography
   - The execution order communicates review isolation, dependency sequencing, and possible folding of trivial work.
   - Suggested addition: a `commit-plan` or `delivery-sequence` snippet with commit grouping, order rationale, fold/standalone guidance, and verification after each commit.

7. Manual smoke acceptance
   - Manual smoke steps fit under `checkpoint`, but they are not command verification.
   - Suggested addition: a `manualAcceptance` field on checkpoints with prerequisites, steps, expected observable result, and evidence to record.

8. Non-goal evidence
   - The explicit "not doing" list includes rationale tied to existing commits and separate plans.
   - Existing `global-contract` can store non-goals, but schema should preserve `reason` and `alternateTrackingPlan` fields when non-goals cite external plans.

## Notes For Combined Summary

- This plan is not just a task breakdown. It mixes post-review evidence, residual risk triage, implementation design, tests, sequencing, and merge readiness.
- The strongest schema gap is baseline/review evidence: current formula parts can store "do not touch" as contract prose, but they do not preserve the audit table as structured evidence.
- The second strongest gap is decision/options capture. At least one implementation item depends on preserving why a minimum-diff option is recommended over a cleaner deletion.
- Current formula roles are adequate for converting the executable improvements, but child work-packet hydration would need additional derivation for strict fields like allowed/forbidden files, red commands, expected failures, and failure conditions.
- The plan has no meaningful subagent-launch content. A converter should not invent parallel fanout unless a later combined summary adds disjoint write sets and launch packets.
