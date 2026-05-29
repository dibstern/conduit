# 2026-05-17 Local Trace Artifact Plan Summary

## Source

- Source plan: `docs/plans/2026-05-17-local-trace-artifact.md`
- Formula vocabulary consulted: `.agents/skills/plan-to-beads/SKILL.md` and `.agents/skills/plan-to-beads/REFERENCE.md`
- Plan goal: add a default bounded local NDJSON trace artifact for completed Effect spans at `<configDir>/logs/server.trace.ndjson`, without requiring OTLP or leaking provider-owned payloads.

## Plan Structure

The plan is organized as an implementation record with both executive context and execution detail:

1. Front matter for implementers: required execution sub-skill, concise goal, architecture, and tech stack.
2. Goal and motivation: why the artifact matters, why it follows the provider contract runtime-schema plan, and what must stay out of scope.
3. Current shape: live-checkout observations about daemon layers, logging, tracing, env config, tests, and provider schema dependencies, with an explicit reverify warning.
4. Prior-art lessons: t3code-derived principles to copy architecturally without copying code.
5. Target architecture: artifact path, env overrides, new/modified files, trace record JSON shape, bounds/redaction rules, provider-schema relationship, and future raw-source metadata vocabulary.
6. Non-goals: explicit exclusions around UI, browser tracing, metrics, OTLP requirements, provider payload modeling, migrations, and support-bundle scope.
7. Implementation tasks: TDD-style task slices for normalization, sink, tracer, daemon wiring, conditional provider-seam annotations, and operator smoke commands.
8. Verification: focused test commands, default gates, smoke commands, source greps, core acceptance criteria, follow-up acceptance, and an acceptance proof matrix.
9. Risk and sequencing: a risk register and rollout order that preserve the core trace artifact PR boundary before provider integration or OTLP composition work.

## Information Types Communicated

- Plan identity, priority, goal, core deliverable, and implementation boundary.
- Architectural contract for daemon-local tracing, Effect tracer/logger composition, existing Pino/OTLP coexistence, and file ownership.
- Time-sensitive baseline snapshot of the current repo, tests, and surrounding plans.
- Cross-project/prior-art lessons from t3code, including which ideas to copy and which implementation details not to copy.
- Runtime configuration contract: env var names, defaults, path resolution, numeric bounds, and disable switch.
- File ownership expectations for new source files, modified daemon/env/layer files, and optional docs/tests.
- Trace artifact data contract: NDJSON shape, stable schema version, span correlation fields, events, links if available, and exit summary.
- Serialization, redaction, and provider-opacity policy: allowed provider-adjacent labels, forbidden raw payload classes, normalization limits, and adversarial tests.
- Cross-plan dependency rules: provider decode annotations are conditional on the provider contract runtime-schema plan landing first.
- Shared source-label vocabulary for future trace attributes and provider runtime event metadata.
- TDD work packets with files, failing tests, expected failures, exported APIs, minimal implementation scope, and green verification commands.
- Integration checkpoints for focused tests, Pino preservation, daemon wiring, source greps, smoke commands, and default repo gates.
- Manual/operator smoke runbook for foreground daemon verification with a temp config directory.
- Acceptance criteria and proof matrix linking each criterion to required evidence.
- Risks and mitigations around tracer composition, logger replacement, payload leakage, recursive tracing, I/O overhead, shutdown loss, and noisy spans.
- Rollout sequencing and stop points, including when to defer provider-seam annotations and OTLP composition.

## Fit To Existing Formula Parts

- `epic`: the whole local trace artifact implementation plan fits cleanly as the root plan instance.
- `global-contract`: goal, priority, non-goals, default artifact location, provider-opacity boundary, and "do not depend on unfinished provider schemas" belong here.
- `architecture`: target architecture, daemon layer composition, Effect tracer/logger constraints, trace payload shape, provider event-store relationship, and t3code-derived architectural principles mostly fit here.
- `policy`: serialization bounds, redaction rules, provider-owned payload exclusions, env parsing rules, TDD expectations, source grep rules, and "inspect installed Effect API before assuming composition" fit strongly.
- `parent`: each numbered task can be a stage parent, especially normalization, sink, tracer, daemon wiring, provider follow-up, and operator smoke.
- `child`: individual red/green implementation steps can become child work packets with concrete files, commands, expected failures, exports, and verification.
- `checkpoint`: focused test gates after each task, acceptance proof matrix rows, rollout stop points, source greps, and "stop core PR here unless priority #1 has landed" fit as gates.
- `fixture`: temp config directories, in-memory/temp filesystem setup, adversarial payload examples, and source-grep fixtures can be represented as fixture context, though the plan does not name them as durable fixtures.
- `pilot`: foreground daemon smoke verification and operator inspection commands fit the pilot role as evidence-gathering work.
- `followup-template`: provider-seam annotations after the provider schema plan lands, optional testing-doc updates, and later OTLP composition are non-core follow-up templates.
- `work-packet`: the implementation tasks contain enough detail for child contracts: goal, inputs, allowed files, forbidden/provider-opaque constraints, red commands, expected failures, green scope, and verification.
- `subagent-launch`: the top "For Claude" execution directive, rollout order, and checkpoints can seed launch instructions, but the plan does not include a reusable launch packet beyond the required sub-skill instruction.
- `handoff-note`: risks, acceptance matrix, rollout order, and smoke commands contain handoff material, but the plan does not explicitly structure a handoff note.

## Gaps / Schema Additions

- `baseline-snapshot` role: the Current Shape section is time-sensitive observed state with an explicit "verify against live checkout" warning. It should not be treated as durable architecture. Useful fields: `observedFiles`, `observedBehaviors`, `reverifyRequired`, `driftRisk`, and `supersededBy`.
- `prior-art` or `reference-pattern` role: the t3code lessons communicate provenance, adopted principles, and "copy architecture, not code." This is not quite architecture owned by this repo and should preserve source/provenance separately.
- `artifact-contract` or `data-contract` snippet: the trace JSON example, schemaVersion invariant, field requirements, redaction/bounds, and NDJSON line discipline are more specific than generic architecture. Children need to consume this as a stable data contract.
- `config-contract` snippet: env var defaults, path resolution rules, disable behavior, and numeric bounds are a reusable runtime configuration contract that several children reference.
- `external-plan-dependency` metadata: Follow-Up Task 5 depends on `docs/plans/2026-05-17-provider-contract-runtime-schemas.md` landing first. A normal internal `needs` edge cannot resolve this unless the converter invents an internal placeholder. The schema should allow external plan references with `condition`, `blockingUntil`, and `doNotGuess` guidance.
- `acceptance-proof-matrix` snippet: the matrix is not just a checkpoint command list; it maps product criteria to proof obligations. Preserving this as structured traceability would make generated Beads easier to audit.
- `risk-register` role or metadata block: the Risks section contains implementation hazards and mitigation policy that should be visible to child agents and checkpoints without being flattened into prose.
- `runbook` or `operator-smoke` snippet: manual foreground daemon verification has setup, concurrent-shell assumptions, inspection commands, and expected evidence. It can be modeled as `pilot`, but a runbook contract would better preserve operator steps and environment setup.

## Notes For Combined Summary

- This plan is a strong candidate for conversion because most child-level work packets are already TDD-shaped and include files, red commands, expected failures, green commands, and acceptance proof.
- The largest conversion risk is overloading `architecture` and `checkpoint` with too many distinct information types. Baseline observations, data contracts, config contracts, risks, and traceability matrices are semantically different and should remain separately addressable.
- The plan has an explicit core/follow-up boundary: the local trace artifact is the core PR; provider-seam annotations are conditional; OTLP composition can be revisited later if tracer composition conflicts.
- Provider payload opacity is a cross-cutting contract, not a single child task. It should be available to every child that touches normalization, trace events, provider-adjacent metadata, tests, or source greps.
- The plan's acceptance proof matrix should become the primary combined-summary evidence map for this source because it already links criteria to commands and test locations.
