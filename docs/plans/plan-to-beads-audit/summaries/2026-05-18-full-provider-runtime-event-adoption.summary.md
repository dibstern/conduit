# 2026-05-18 Full Provider Runtime Event Adoption

## Source

- Plan reviewed: `docs/plans/2026-05-18-full-provider-runtime-event-adoption.md`
- Title: `Full ProviderRuntimeEvent Adoption Plan`
- Date: 2026-05-18
- Status: ready after provider-boundary schemas and `ProviderRuntimeEvent` contracts are green
- Scope of this summary: structure, information types, and fit against the current plan-to-beads formula parts.

## Plan Structure

The plan is a broad provider-runtime migration plan. It is organized as a sequence of scoped contracts and execution aids rather than only as implementation steps.

- `Goal`: checklist of desired end state and sequencing.
- `Architecture Decision`: durable boundary rules for runtime events, domain events, storage, projectors, relay, and diagnostics.
- `Agent Rules`: stop conditions, ask-before-editing rules, TDD expectations, and plan-vs-code conflict handling.
- `t3code Patterns To Use`: borrowed implementation patterns and architectural precedents.
- `Code Patterns`: repo-local coding rules for Effect services, workers, decoders, translators, errors, traces, and fixtures.
- `Prereqs`: preflight checks and stop conditions.
- `Out Of Scope`: explicit exclusions.
- `Files`: create, modify, do-not-modify, and documentation targets.
- `Phases`: six-stage migration from spike through conditional provider-instance identity gate.
- `Scenario-First Acceptance Tests`: behavior-level Given/When/Then coverage.
- `Acceptance Criteria Matrix`: criteria paired with proof type and expected assertion.
- `Guardrail Checklist`: residual implementation states that must be removed or reclassified.
- `Verification Commands`: targeted and broad commands to prove completion.
- `Risk`: high-risk areas and tradeoffs.
- `Edge Cases`: known runtime and replay cases to preserve.
- `Unresolved Questions`: open decisions with recommended defaults.
- `Concrete Steps`: numbered execution sequence.

## Information Types Communicated

- Plan identity and readiness state.
- Target end state and explicit non-goals.
- Cross-cutting architecture contract.
- Execution policy for agents and stop conditions.
- Imported reference patterns from a comparable system.
- Repo-specific coding constraints.
- Prerequisite gates.
- File ownership and forbidden file boundaries.
- Phase ordering and conditional phase gates.
- Behavior scenarios for TDD.
- Acceptance criteria with proof expectations.
- Completion guardrails and negative-state checks.
- Verification command inventory.
- Risk and tradeoff register.
- Edge-case inventory.
- Open decision list with recommended defaults.
- Concrete execution order.

## Fit To Existing Formula Parts

| Plan information type | Best current formula part | Fit |
| --- | --- | --- |
| Plan identity, title, source, overall objective | `epic` | Good fit. |
| Goal and out-of-scope sections | `global-contract` | Good fit. |
| Architecture Decision and durable storage boundary | `architecture` | Good fit. |
| Agent Rules, Code Patterns, t3code Patterns | `policy` plus `architecture` | Good fit, though t3code provenance may need metadata. |
| Prereqs | `checkpoint` | Good fit as a preflight gate. |
| Files list | `parent` defaults, `child` work packets, `architecture` constraints | Partial fit. It must be split into stage/file ownership and child-level `allowedFiles`/`forbiddenFiles`. |
| Phases | `parent` for stages, `checkpoint` for gates, `pilot` for Phase 0 and Phase 5 evidence | Good fit. |
| Scenario-first acceptance tests | `child` with `work-packet` fields, or `fixture` plus `child` where fixture corpus is central | Good fit when each scenario becomes one behavior contract. |
| Acceptance Criteria Matrix | `checkpoint` and child `verification` metadata | Partial fit. Current roles do not model criterion/proof/assertion rows directly. |
| Guardrail Checklist | `checkpoint` validation and policy constraints | Partial fit. Current roles do not model residual forbidden states as first-class completion blockers. |
| Verification Commands | `checkpoint` validation or child `verification` | Good fit. |
| Risk and tradeoff register | `architecture`, `policy`, child `failureConditions` | Partial fit. Current roles can preserve some mitigation rules, but not the register shape. |
| Edge Cases | `child` scenarios, fixtures, or parent inherited test scope | Good fit if decomposed into executable behaviors. |
| Unresolved Questions | `checkpoint`, `architecture`, or `followup-template` | Partial fit. Current parts do not distinguish unresolved decision points from settled decisions. |
| Concrete Steps | `parent`, `child`, and `checkpoint` dependency graph | Good fit, but partly duplicates the phase section. |
| Handoff expectations | `handoff-note` snippet | Good fit, though the source plan does not provide detailed handoff text. |
| Subagent launch rules | `subagent-launch` snippet | Weak source fit. The plan has agent rules but no explicit subagent packet shape. |

## Gaps / Schema Additions

1. First-class acceptance criteria matrix.
   - The matrix carries `criterion`, `proof`, and `expected assertion` as structured evidence requirements.
   - Existing `checkpoint` and child `verification` fields can store this as prose, but the current formula parts do not preserve the row structure cleanly.
   - Suggested addition: `acceptanceCriteria` metadata on `epic`, `parent`, `checkpoint`, and/or `child`, with rows containing `criterion`, `proof`, `expectedAssertion`, and optional `ownerLogicalId`.

2. Guardrail or negative-state checklist.
   - The guardrail section records forbidden residual code states and required proof that they are gone or reclassified.
   - Existing checkpoints can run commands, but the schema lacks a clear place for anti-patterns, grep/static proof targets, and completion-blocker semantics.
   - Suggested addition: either a `guardrail` role or `completionGuardrails` metadata with `forbiddenState`, `proof`, `scope`, and `resolutionPolicy`.

3. Open decision points.
   - The unresolved questions are not architecture decisions yet; they are pending choices with recommended defaults.
   - Mapping them directly to `architecture` would falsely imply they are settled.
   - Suggested addition: `decisionPoints` metadata or an `open-decision`/`decision-checkpoint` role with `question`, `recommendedDefault`, `blockingPhase`, and `resolutionRequiredBefore`.

4. Risk and tradeoff register.
   - The risk section communicates severity, rationale, and mitigation/proof expectations.
   - Current fields can scatter this into policies, failure conditions, or checkpoint verification, but that loses the register form.
   - Suggested addition: `riskRegister` metadata at `epic` or `parent` level with `risk`, `severity`, `mitigation`, `proof`, and `acceptedTradeoff`.

5. Provenance for borrowed patterns.
   - The t3code section distinguishes imported precedent from local policy.
   - Current `policy` and `architecture` roles can carry the rules but not their source/provenance.
   - Suggested addition: optional `provenance` fields on policy and architecture entries, for example `sourceSystem`, `pattern`, and `adaptationNotes`.

## Notes For Combined Summary

This plan is a strong stress case for migration-plan conversion because it mixes execution graph material with governance material. The current formula parts cover the executable path well: epic, global contract, architecture, policy, parents, children, checkpoints, fixtures, pilots, and follow-up templates can represent most of the work.

The weak fit is not the phase/child decomposition. The weak fit is preserving structured evidence and governance data without flattening it into prose. A combined audit should consider schema support for acceptance matrices, guardrail checklists, open decisions, risk registers, and provenance-bearing pattern references.
