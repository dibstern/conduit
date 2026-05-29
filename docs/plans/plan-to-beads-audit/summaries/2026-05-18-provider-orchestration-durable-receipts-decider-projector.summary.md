# Source

- Plan reviewed: `docs/plans/2026-05-18-provider-orchestration-durable-receipts-decider-projector.md`
- Plan title: Provider Orchestration Durable Receipts And Decider-Projector Plan
- Plan date: 2026-05-18
- Plan status: ready after full `ProviderRuntimeEvent` adoption and legacy OpenCode runtime ingress deletion, unless duplicate browser submission/retry bugs become urgent.
- Formula references reviewed: `.agents/skills/plan-to-beads/SKILL.md` and `.agents/skills/plan-to-beads/REFERENCE.md`

# Plan Structure

The plan is a dense executable migration plan with front-loaded global context and later execution detail.

1. Metadata and goal: states date, readiness status, review inputs, t3code comparison provenance, execution model, and top-level migration goals.
2. Agent and execution rules: defines stop conditions, Beads usage, TDD discipline, Phase 0 decision gating, subagent constraints, and parent-agent responsibilities.
3. Pattern guidance: separates t3code patterns to use from patterns not to copy, then adds repo-local Effect, test, fingerprinting, receipt, reactor, and module-design rules.
4. Scope framing: records prereqs, out of scope items, command scope, files/write-set map, and an architecture module map.
5. Execution sequence: describes phases, Phase 0 hard decisions, TDD vertical slice order, parallel stream gates, wave ownership, Beads protocol, and concrete steps.
6. Verification and acceptance: provides scenario-first acceptance tests, an acceptance criteria matrix, focused validation commands, and cleanup/static guardrails.
7. Risk and edge treatment: lists high-risk areas, tradeoffs, edge cases, blocker decisions, and non-blocker follow-up decisions.

# Information Types Communicated

- Plan identity and provenance: title, date, status, source plan path, review inputs, external t3code commit/context references.
- Goal and scope: desired outcomes, preserved behavior, hard boundaries between durable command work and `ProviderRuntimeEvent` work.
- Execution policy: TDD rules, Beads ownership, subagent rules, stop conditions, parent integration duties, handoff expectations.
- Architectural contract: durable receipts, decider/projector/read-model/reactor shape, event-log independence, provider output ingress path, deterministic id/time seams.
- Pattern catalog: positive and negative patterns from t3code, local code-style rules, module deletion-test rules, anti-patterns to avoid.
- Prereqs and non-goals: readiness gates, dependency on the legacy ingress deletion plan, explicit exclusions.
- File and ownership model: candidate create/modify files, when a file earns its keep, owned files per stream, forbidden files, shared-interface boundaries.
- Phase model: ordered phases, Wave 0 contract artifact, Wave 1-4 stream sequencing, fanout gates, cleanup phase.
- Decision backlog: Phase 0 blocker decisions with recommended defaults, non-blocker decisions, and follow-up candidates.
- Work packets: numbered TDD slices with behavior, representative examples, focused command, and expected RED condition.
- Command semantics: mutating command list, idempotency behavior, fingerprint fields, duplicate/retry/reconnect rules.
- Parallel execution plan: gates, Beads child titles, dependency requirements, validation commands, disjoint write sets, subagent prompt template.
- Tracker protocol: concrete `bd` create/update/dep commands, parent/child issue flow, session-close protocol.
- Acceptance model: scenario-first tests and a criterion/proof/assertion matrix.
- Guardrails and cleanup criteria: residual anti-pattern checklist and static/behavioral proof expectations.
- Verification catalog: focused per-slice commands plus broader final checks.
- Risk, tradeoff, and edge-case inventory: failure modes, crash windows, idempotency hazards, retry/diagnostics risks, and race conditions.

# Fit To Existing Formula Parts

- `epic`: fits the whole plan instance, including title, status, source path, goals, and high-level execution model.
- `global-contract`: fits top-level goals, prereqs, out of scope, command scope, durable-command vs runtime-event boundary, and source-of-truth rules.
- `architecture`: fits t3code-derived architecture guidance, code patterns, architecture module map, durable event/read-model/reactor contracts, and provider-output ingress ownership.
- `policy`: fits Agent Rules, TDD discipline, Beads ownership, subagent rules, deterministic testing rules, guardrail policy, and diagnostics/recovery non-authoritativeness.
- `parent`: fits phases and waves as grouping beads, especially Phase 0, Wave 0, Wave 1 A/B/D, Wave 2 C, Wave 3 E, and Wave 4 handler migration.
- `child`: fits the numbered TDD vertical slices and executable stream tasks where each has one behavior, command, expected RED, file scope, and validation.
- `checkpoint`: fits prereq gates, Phase 0 gate, Gates A-G/F2, Wave 0 contract review, phase-boundary validation, fanout readiness, and cleanup guards.
- `fixture`: partially fits fake provider, SQLite DB, deterministic `Clock`/ID services, tombstone examples, and fake provider runtime input, but the plan does not define fixture manifests in a structured way.
- `pilot`: partially fits focused Phase 0 proofs/spikes and optional diagnostics/backoff visibility proof, but many of these are blocker decisions rather than measurement pilots.
- `followup-template`: fits non-blocker decisions, optional diagnostics by default, receipt retention tuning, reconnect freshness, command snapshot performance work, and any follow-up created when a current RED test does not require implementation.
- `work-packet` snippet: fits numbered TDD slices well because each slice usually includes goal/behavior, constraints, focused command, expected failure, and implied verification.
- `subagent-launch` snippet: fits the explicit subagent prompt template and the parallel execution stream table.
- `handoff-note` snippet: fits the subagent return contract, Beads update text, and session-close protocol.

# Gaps / Schema Additions

- Add a `decision` or `blocker-decision` role. Phase 0 hard decisions are neither ordinary child work nor static policy. They need fields for question, recommended default, proof required, chosen policy, affected interfaces, blocking gates, and Beads decision issue.
- Add a `scenario-set` or `acceptance-scenario` contract. The scenario-first tests are behavior specifications that span multiple children and checkpoints. Mapping each scenario directly to a child would overproduce work items and lose cross-cutting acceptance intent.
- Add an `acceptance-matrix` role or contract snippet. The criterion/proof/assertion table is a cross-plan validation surface, not just one checkpoint. It should preserve traceability from criterion to proof command and expected assertion.
- Add a `guardrail` role or contract snippet. The cleanup checklist is an anti-regression inventory of forbidden residual code and proof requirements. It is more specific than general policy and broader than a single checkpoint.
- Add an `ownership-map` contract snippet. The file/write-set map and parallel stream table carry owned files, forbidden files, "create only when forced" rules, shared contracts, and disjointness constraints. Child `allowedFiles`/`forbiddenFiles` cover part of this, but not the conditional ownership and deletion-test semantics.
- Add a `validation-catalog` role or contract snippet. The Verification Commands section is a reusable command bank with phase/surface conditions. Individual child `verification` fields can reference it, but the catalog itself needs a typed home.
- Add external-review provenance metadata. The plan records review inputs and exact t3code checkout context. `sourcePlan` captures the local plan but not comparison source, commit range, or extracted pattern provenance.
- Add `risk-register` and `edge-case-register` metadata. Risks and edge cases can inform children and checkpoints, but they are not work packets by themselves. Keeping them typed would help later summaries preserve why gates and tests exist.
- Add a command/domain taxonomy field. The Command Scope section classifies mutating commands, non-durable commands, fingerprint inputs, and reconnect semantics. This could live in `global-contract`, but a typed `commandCatalog` would make generated children and guardrails more reliable.

# Notes For Combined Summary

- This plan is already close to a Beads execution graph. The main conversion problem is not finding work, but preserving the plan's typed intent without flattening decision records, scenarios, guardrails, and ownership constraints into generic tasks.
- The strongest current fits are `epic`, `global-contract`, `architecture`, `policy`, `parent`, `child`, `checkpoint`, `followup-template`, `work-packet`, and `subagent-launch`.
- The weakest fits are Phase 0 blocker decisions, scenario-first acceptance tests, acceptance matrix rows, guardrail checklist items, risk/edge-case inventories, and conditional file ownership rules.
- Combined summaries should avoid counting every scenario, guardrail, edge case, and verification command as a separate executable child. Many are cross-cutting evidence or constraints for existing children/checkpoints.
- The most valuable schema additions for this plan family are `blocker-decision`, `acceptance-matrix`, `guardrail`, `ownership-map`, and `validation-catalog`.
