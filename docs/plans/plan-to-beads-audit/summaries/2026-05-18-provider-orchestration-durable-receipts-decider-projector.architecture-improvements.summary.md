# Source

- Plan reviewed: `docs/plans/2026-05-18-provider-orchestration-durable-receipts-decider-projector.architecture-improvements.md`
- Plan title: `Durable Receipts Architecture Improvements`
- Source type: source-grounded architecture amendment note.
- Review target named by the source: `docs/plans/2026-05-18-provider-orchestration-durable-receipts-decider-projector.md`
- The source explicitly says it does not replace the target plan.

Formula vocabulary considered:

- Roles: `epic`, `global-contract`, `architecture`, `policy`, `parent`, `child`, `checkpoint`, `fixture`, `pilot`, `followup-template`
- Contract snippets: `work-packet`, `subagent-launch`, `handoff-note`

# Plan Structure

The plan is structured as an architecture review sidecar, not as an executable implementation breakdown.

1. Title and target-plan pointer.
2. Source grounding bullets that cite project context, architecture guidance, testing guidance, absent ADR constraints, and current live-state observations.
3. Current architectural friction bullets describing why the target plan is directionally right but still too shallow in module boundaries, command identity, receipt persistence, provider-output ingestion, and session binding ownership.
4. Five deepening opportunities. Each opportunity uses the same local structure:
   - `Files`
   - `Problem`
   - `Solution`
   - `Specific target-plan amendment`
   - `Benefits`
5. A numbered list of concrete edits to fold into the target plan.
6. Risks or uncertainty bullets covering unresolved design decisions, migration concerns, transaction scope, provider-output classification, and readiness conditions.

# Information Types Communicated

- Source provenance and grounding: named context docs, architecture docs, testing docs, ADR absence, and live-code observations.
- Plan relationship metadata: this document is an amendment note for another target plan.
- Architectural diagnosis: current friction, shallow module risks, missing owners, and mismatches between target-plan intent and live behavior.
- Module proposals: proposed module names, interface responsibilities, implementation files, adapters, seams, tests, and deletion-test rationale.
- File-scope signals: existing files, planned files, test files, and static guard targets relevant to each opportunity.
- Phase amendments: proposed insertions or reordering such as Phase 0a, Phase 2b, provider-output convergence gating, and binding read-model cutover.
- Interface and policy invariants: durable command ids for mutating commands, mandatory provider-output ingestion, side effects after durable commit, and forbidden direct imports.
- Acceptance-test ideas: handler-to-orchestration command-id propagation, rollback/commit behavior, recovered provider binding, and static import guards.
- Quality heuristics: depth, leverage, locality, Adapter clarity, and deletion-test value.
- Concrete target-plan edits: the final edit list is plan-maintenance work, not direct implementation work.
- Risks and unresolved decisions: browser retry identity source, projection transaction semantics, migration coverage, Claude output classification, and readiness criteria.

# Fit To Existing Formula Parts

- `epic`: Fits the reviewed source only indirectly. The document could be attached to the target plan's epic as an architecture-review sidecar or amendment source, but it is not itself a complete executable epic.
- `global-contract`: Partially fits source grounding, scope constraints, target-plan relationship, ADR absence, and global invariants such as durable command ids.
- `architecture`: Strong fit. Most of the document is architectural context: module boundaries, seams, Interface versus Implementation ownership, transaction ownership, adapters, read models, and forbidden imports.
- `policy`: Fits cross-cutting rules such as mutating commands requiring durable ids, provider output entering through `ProviderRuntimeIngestion`, static guard expectations, and side-effect ordering.
- `parent`: Partially fits the five deepening opportunities if they become plan stages. The current source does not define stage defaults or inherited child contracts.
- `child`: Weak fit. The document names concrete behavior and tests, but it does not provide complete child `work-packet` fields such as red command, expected failure, green scope, allowed files, forbidden files, and verification.
- `checkpoint`: Partial fit for fanout gates and readiness conditions, especially Phase 0a, Phase 2b, provider-output convergence before side-effect reactor completion, and binding read-model cutover. The source does not consistently provide validation commands or launch rules.
- `fixture`: Minimal fit. The source references provenance and live-state facts, but it does not describe reusable fixtures or refresh policy.
- `pilot`: Partial fit where the plan calls for spikes or decisions, such as command-id source and projection transaction scope. These are decision pilots, not fully specified evidence-collection tasks.
- `followup-template`: Partial fit for target-plan edits and future ADR creation. The edits are templates for changing another plan, not executable implementation tasks.
- `work-packet`: Mostly absent. The source is not detailed enough to hydrate executable child contracts without reading the target plan or making decisions.
- `subagent-launch`: Absent. The source does not define subagent launch packets, ownership splits, or handoff requirements.
- `handoff-note`: Partial fit. The amendment note itself is handoff-like context for the target plan, but it does not use a durable handoff schema.

# Gaps / Schema Additions

- Add a first-class `amendment` or `plan-edit` information type for instructions that change another plan rather than implement code directly. The final numbered list is the clearest example.
- Add structured `source-grounding` or `evidence` metadata for cited docs, live-state observations, absence assertions, and checkout-specific facts. Existing `global-contract` and `architecture` roles can hold this prose, but they do not distinguish evidence from policy or design.
- Add an `architecture-finding` shape for repeated `Files / Problem / Solution / Benefits / deletion test / target-plan amendment` blocks. Mapping each block directly to `architecture` loses the review finding structure.
- Add a `module-map` schema nested under `architecture`: module, Interface owner, implementation files, adapters, tests crossing the seam, and forbidden imports. The source explicitly asks the target plan to add this map.
- Add a `target-plan-amendment` reference field so a formula can represent that the work applies to another plan path and does not replace it.
- Add structured `risk-decision` or `open-question` entries for unresolved architectural choices. Some could become `checkpoint` or `pilot`, but the current roles do not cleanly preserve risks that are not yet executable gates.
- Add a `quality-heuristic` field for depth, leverage, locality, Adapter clarity, and deletion-test rationale. These are evaluation criteria for the plan, not work items.
- Add a way to mark file lists as `affectedFiles` or `reviewedFiles`, distinct from child `allowedFiles`. The source's file lists identify architectural ownership surfaces, not necessarily writable scopes for an agent.

# Notes For Combined Summary

- Treat this source as an architecture sidecar to the target durable-receipts plan.
- The core signal is not a work graph; it is a set of architecture corrections that should be folded into the target plan before Beads conversion.
- The five named opportunities are the main grouping units:
  - Provider Command Identity Module
  - Provider Command Orchestration Module
  - Durable Command Commit Module
  - Mandatory `ProviderRuntimeIngestion` provider-output seam
  - Provider Session Binding Read Model Module
- The strongest formula coverage is `architecture`, `policy`, and `checkpoint`.
- The weakest coverage is executable `child` work packets because the source lacks red/green commands, complete writable scopes, verification commands, and failure conditions.
- The combined audit should call out schema support for architecture review sidecars, target-plan amendments, source-grounding evidence, module maps, and risk decisions.
