# 2026-05-18 Provider Runtime Event Contracts Summary

## Source

- Source plan: `docs/plans/2026-05-18-provider-runtime-event-contracts.md`
- Plan title: `ProviderRuntimeEvent Contracts-Only Plan`
- Date: 2026-05-18
- Status: Ready after provider-boundary runtime schemas are green
- Scope: contracts-only schema/type/test/doc work for `ProviderRuntimeEvent`; no storage, relay, handler, frontend, provider, or runtime behavior changes.

## Plan Structure

1. Metadata and goal: gives date, readiness status, desired contract artifact, and the no-behavior-change boundary.
2. Agent rules: tells an implementing agent when to stop, when to ask, and which imports or runtime areas are forbidden.
3. Prereqs: names upstream contract files/tests that must exist and pass before this plan starts.
4. Contract shape: defines the new module, exported schemas/types, envelope fields, provider refs, raw-source metadata, event type vocabulary, and opaque payload policy.
5. Implementation patterns: constrains Effect Schema usage, import boundaries, test style, and raw-source handling.
6. File scope: separates files to create, files to modify only if needed, and directories that must not change.
7. Phases: orders the work from spike through TDD, schema implementation, and guardrail proof.
8. Acceptance criteria matrix: pairs each behavioral/contract requirement with a named proof and expected assertion.
9. Scenario acceptance tests: restates the most important proofs as Given/When/Then cases.
10. Guardrail checklist: lists failure modes that must be absent and the command/proof for each.
11. Verification commands: names commands that run the acceptance proofs.
12. Risk, out of scope, unresolved questions, and concrete steps: captures migration hazards, non-goals, recommended decisions, and execution sequence.

## Information Types Communicated

- Plan identity and readiness status.
- Product and architecture intent.
- Explicit non-goals and behavior-change boundaries.
- Upstream prerequisites and stop conditions.
- Agent operating rules.
- Contract schema shape, exported API names, field-level vocabulary, and forbidden fields.
- Provider-specific representability requirements for Claude and OpenCode refs.
- Implementation constraints, import boundaries, and dependency rules.
- Test-authoring guidance and assertion style.
- File ownership: create, maybe modify, and never modify.
- Ordered execution phases and concrete step sequence.
- Acceptance proof matrix with criterion, proof location, and expected assertion.
- Scenario-style acceptance tests.
- Guardrail failure modes with proof commands.
- Verification command list.
- Risks, tradeoffs, and migration hazards.
- Out-of-scope list.
- Open questions with recommended answers.
- Version-control/commit boundary.

## Fit To Existing Formula Parts

- `epic`: fits the plan title, source path, status, overall goal, and contract-only PR boundary.
- `global-contract`: fits scope, non-goals, out-of-scope items, readiness status, and the high-level "no behavior change" rule.
- `architecture`: fits contract shape, provider refs, raw-source metadata policy, event vocabulary, opaque payload treatment, and module/import ownership.
- `policy`: fits agent rules, test style, implementation constraints, no raw SDK payload tunnel, and VCS/commit boundary.
- `parent`: fits the four phases as stage/group beads: contract spike, TDD, schema implementation, and guardrails.
- `child`: fits executable units such as adding failing contract tests, adding the schema module, updating boundary tests if needed, and proving guardrails.
- `checkpoint`: fits prereq validation, stop-if-plan-disagrees review, canonical vocabulary coverage, behavior-import guard, and final verification.
- `fixture`: partially fits canonical event vocabulary comparison fixtures and provider-ref example payloads, though the plan does not name fixture files.
- `pilot`: weak fit. The phase 0 contract spike is evidence-gathering, but it is a prerequisite decision point rather than a migration pilot.
- `followup-template`: fits future work implied by unresolved questions and later Claude/OpenCode translator migrations, but this plan mostly treats those as out of scope.
- `work-packet` snippet: fits child-level goal, inputs, constraints, allowed/forbidden files, red/green commands, verification, and failure conditions.
- `subagent-launch` snippet: low relevance. The plan has agent rules but does not define parallel subagent launch packets.
- `handoff-note` snippet: fits stop conditions, proof requirements, and final verification evidence, but no explicit handoff format is specified.

## Gaps / Schema Additions

- Add a `preflight` or `precondition-checkpoint` role for upstream readiness checks that must pass before work starts. Current `checkpoint` can represent this, but its description leans toward integration/fanout gates after work begins.
- Add an `acceptance-proof-matrix` contract snippet for rows with `criterion`, `proof`, and `expectedAssertion`. This plan communicates acceptance more precisely than the current child `verification` field or checkpoint command list.
- Add a `guardrail` snippet or checkpoint subtype for prohibited outcomes plus proof commands. The guardrail checklist is not just verification; it is a negative contract over imports, diff scope, raw payload fields, and vocabulary drift.
- Add an `open-question` or `decision-option` role for unresolved questions with recommended answers. These are not executable follow-ups yet, and flattening them into `followup-template` would lose the decision state.
- Add a `file-scope` metadata block usable by `global-contract`, `parent`, and `child` roles. This plan distinguishes `create`, `modify if needed`, and `do not modify`, while the child work packet only has `allowedFiles` and `forbiddenFiles`.
- Add an optional `status` and `blockedBy` field on `epic` or `global-contract` for readiness phrases such as "Ready after provider-boundary runtime schemas are green."
- Add an optional `test-style-policy` block under `policy` for assertion-method rules, such as using `Schema.decodeUnknownEither(...)`, `Either.isLeft(...)`, and avoiding parse-error snapshots.

## Notes For Combined Summary

- This plan is highly structured and already close to a Beads execution graph, but it is more proof-oriented than task-oriented.
- The strongest reusable pattern is a contracts-only plan shape: scope boundary, import boundary, schema vocabulary, proof matrix, guardrail checklist, and verification commands.
- The main formula pressure is not missing executable work packets; it is missing first-class representation for proof matrices, preflight gates, guardrails, and unresolved decision records.
- Acceptance criteria and verification commands are intentionally separate in this plan. The combined summary should preserve that distinction.
- The plan uses stop conditions as safety controls. A conversion should not silently turn those into normal tasks without preserving the "stop and ask" behavior.
