# 2026-05-18 Provider Orchestration Durable Receipts Decider Projector TDD Improvements Summary

## Source

- Reviewed plan: `docs/plans/2026-05-18-provider-orchestration-durable-receipts-decider-projector.tdd-improvements.md`
- The file is an execution-style amendment to `docs/plans/2026-05-18-provider-orchestration-durable-receipts-decider-projector.md`.
- The amendment keeps the source plan intact but changes execution into one RED-GREEN vertical tracer bullet at a time.

## Plan Structure

- Header and source link: identifies the plan as a TDD-improvement overlay for the original durable receipts, decider, and projector plan.
- Execution thesis: states that the scenario list is a behavior backlog, not a batch of tests to write before implementation.
- Source-grounded constraints: records domain definitions, testing guidance, public seams, and current implementation facts that should shape execution.
- Behavior-first interfaces to test: names the public API or service boundary that should prove each behavior and which internals should not be mocked or asserted.
- Vertical slice order: ten ordered slices, each usually containing RED instructions, a proof command, expected RED shape, GREEN implementation guidance, and refactor proof.
- Anti-patterns: lists execution mistakes to avoid, especially horizontal test writing, repository-only proof, broad suites, static guards before behavior, sleeps/timers, and internal assertions.
- Risks and uncertainty: captures unresolved design questions and areas where the first failing behavior should drive schema or implementation expansion.

## Information Types Communicated

- Plan amendment relationship: this document modifies execution style for another plan rather than standing alone as the canonical feature design.
- Global execution policy: one scenario at a time, do not start the next RED until the current slice is GREEN, and refactor only while tests pass.
- Domain constraints: distinguishes runtime traces from durable truth and preserves the SQLite event store as source of truth.
- Testing policy: prefers smallest useful Vitest surfaces, behavior-first proof, real SQLite at persistence boundaries, focused commands, and broad checks only at phase boundaries.
- Public seam inventory: lists current service tags, handlers, repositories, and domain entrypoints that are acceptable test and integration seams.
- Current-state observations: records known implementation limitations such as session FK coupling, ingestion pre-seeding, narrow receipt schema, and in-memory idempotency state.
- Boundary and mocking rules: specifies what to fake, what not to mock, and where provider/runtime boundaries are allowed.
- Ordered TDD work packets: gives per-slice RED, proof command, expected failure, GREEN scope, and refactor proof.
- Negative execution guidance: describes anti-patterns and forbidden shortcuts that should become policy or failure conditions.
- Open decisions and spikes: flags crash policy, duplicate return shape, receipt schema expansion, FK migration risk, projector assumptions, reactor idempotency, and relay-command reuse.

## Fit To Existing Formula Parts

- `epic`: fits the amendment as the root conversion unit if the formula preserves that it amends another source plan.
- `global-contract`: fits source scope, non-goals, event-store source-of-truth language, and the instruction to execute vertically rather than as a test batch.
- `architecture`: fits public seam inventory, desired event log/projection/ingestion ownership, decider/projector/reactor boundaries, and forbidden production bypasses.
- `policy`: fits TDD sequencing, smallest-test-surface guidance, mocking rules, static-guard timing, anti-patterns, and broad-suite limits.
- `parent`: fits grouping the ten vertical slices into stages or feature areas, especially where one numbered slice contains more than one behavior.
- `child`: fits each executable RED-GREEN behavior when normalized to one behavior per child bead.
- `checkpoint`: fits phase gates such as "do not start next RED until current slice is GREEN", migration/handler fanout gates, cleanup guard timing, and broader validation boundaries.
- `fixture`: partially fits real SQLite setup, fake provider instances, forced write failures, `Deferred` gates, and projection-failure setup, though the plan does not define named fixture assets.
- `pilot`: fits unresolved recovery-policy spikes and duplicate-return-shape evidence gathering before broad handler migration.
- `followup-template`: fits unresolved or deferred behavior families, especially handler migration beyond prompt/send turn and later schema expansion driven by failing behavior.
- `work-packet` snippet: fits RED command, expected failure, GREEN scope, allowed/forbidden test boundaries, verification, and failure conditions.
- `subagent-launch` snippet: fits little of this plan directly; the file emphasizes serial TDD execution rather than parallel launch.
- `handoff-note` snippet: fits per-slice evidence handoff after GREEN/refactor proof, but the plan does not define an explicit handoff format.

## Gaps / Schema Additions

- Add an amendment/source relationship field, for example `amendsPlan` or `sourcePlanRole`, so a formula can preserve that this file is an execution overlay for another plan.
- Add a baseline/current-state fact type, or explicit `baselineObservations`, for volatile facts about existing code that are neither desired architecture nor durable policy.
- Add first-class TDD lifecycle fields beyond the current single `verification`, especially `proofCommand`, `expectedRedShape`, `greenScope`, and `refactorProof`.
- Add normalization guidance for numbered slices that contain multiple independent RED tests. They should either expand into multiple `child` beads under one `parent`, or the schema should reject multi-behavior children.
- Add an `open-decision` or `spike` role, or clarify when to use `pilot` versus `checkpoint`, for unresolved questions that must be decided before broad execution.
- Add fields for boundary doubles and forbidden mocks, since this plan communicates "fake only this boundary" and "do not mock these internals" as core acceptance information.
- Add explicit anti-pattern/failure-condition support at policy and child levels, so negative execution guidance is not lost in prose.
- Add per-child handoff evidence fields for RED output, GREEN output, refactor proof, and remaining risk; the existing handoff-note snippet can carry this, but the required shape is not explicit.

## Notes For Combined Summary

- This plan is mostly a TDD execution policy plus ordered child work packets, not a complete architecture design by itself.
- The most important schema pressure comes from preserving RED/GREEN/refactor semantics and source-plan amendment semantics.
- Existing formula parts can represent most content if the converter normalizes aggressively, but it should avoid turning grouped or unresolved items into executable child beads too early.
- Combined analysis should compare this file against other plans for recurring needs: source-plan overlays, baseline observations, explicit expected RED shape, boundary-double policy, and open-decision/spike roles.
