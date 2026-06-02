# Provider Contract Runtime Schemas Plan Summary

## Source

- Reviewed plan file: `docs/plans/2026-05-17-provider-contract-runtime-schemas.md`
- Formula reference consulted: `.agents/skills/plan-to-beads/SKILL.md`
- Formula reference consulted: `.agents/skills/plan-to-beads/REFERENCE.md`
- Current formula roles considered: `epic`, `global-contract`, `architecture`, `policy`, `parent`, `child`, `checkpoint`, `fixture`, `pilot`, `followup-template`
- Current contract snippets considered: `work-packet`, `subagent-launch`, `handoff-note`

## Plan Structure

The plan is structured as an implementation record for a provider-contract runtime-schema slice.

1. Front matter by prose, not YAML:
   - title
   - implementation instruction to use an executing-plans skill
   - goal
   - architecture summary
   - tech stack

2. Preconditions:
   - prior plan dependency
   - required architecture reading
   - SDK type definition sources
   - explicit exclusions for this slice

3. Reference points:
   - three `t3code` patterns to copy: schema-only contracts, module-scope decoders, and compact raw-source diagnostics

4. Acceptance criteria:
   - boundary-decoding requirements for OpenCode SDK responses, OpenCode gap endpoints, Claude inbound stream messages, and Claude outbound SDK data
   - provider-owned payload opacity requirements
   - fail-closed error behavior
   - static schema compiler hoisting
   - bounded diagnostics
   - Claude `SDKMessage` drift guard

5. Acceptance proof checklist:
   - ten numbered proof sections
   - each section contains commands, expected results, and what the command proves
   - the final gate combines focused unit suites and `pnpm check`

6. Eight implementation tasks:
   - each task has an explicit file set
   - most tasks follow red-green sequencing with failing tests first, implementation steps, targeted validation, and a suggested commit
   - tasks cover test harness, OpenCode schemas, Claude schemas, OpenCode SDK edge decoding, OpenCode gap endpoint decoding, Claude inbound decoding, Claude outbound validation, and final cleanup

7. Non-goals and review checklist:
   - scope exclusions
   - qualitative review rubric for contracts, adapters, opacity, fail-closed behavior, drift guard, and diagnostics

8. Post-slice follow-up:
   - a deferred `ProviderRuntimeEvent` model plan
   - t3code model inventory
   - rationale for keeping it separate
   - proposed Conduit scope by subsystem
   - event mapping table
   - suggested follow-up PR sequence
   - future acceptance proof gates

## Information Types Communicated

- Goal and slice boundary.
- Architectural ownership and module placement.
- External/local source-of-truth references.
- Preconditions and readiness assumptions.
- Scope exclusions and non-goals.
- Cross-cutting policies: fail closed, keep provider-owned payloads opaque, do not deeply model payloads, keep diagnostics bounded, avoid broad validation framework work.
- Performance guardrails: hoist Effect Schema compilers out of hot paths.
- Type-safety invariants and SDK drift guards.
- Acceptance criteria as behavior-level requirements.
- Acceptance proof commands with expected results and proof rationale.
- Concrete file ownership for each task.
- Test-first implementation steps with expected red and green outcomes.
- Public exports and schema names to create.
- Runtime error behavior and diagnostic content.
- Dependency/order information through task numbering and preconditions.
- Cleanup/deletion criteria for old schema modules.
- Commit boundaries and suggested commit messages.
- Manual review checklist.
- Deferred follow-up architecture and migration scope.
- Future event vocabulary mapping.
- Future PR sequencing and migration strategy.

## Fit To Existing Formula Parts

- `epic`: fits the title, goal, architecture summary, tech stack, and overall provider-contract runtime-schema slice.
- `global-contract`: fits preconditions, non-goals, broad acceptance criteria, provider-owned payload opacity, fail-closed behavior, and the rule that this slice must not become a general validation framework.
- `architecture`: fits the contract-module placement, adapter boundary rules, module-scope decoder pattern, provider-runtime seam, t3code reference points, and the deferred ProviderRuntimeEvent architecture notes.
- `policy`: fits TDD sequencing, no full E2E by default, bounded diagnostics, opacity rules, hot-path compiler hoisting, SDK drift enforcement, and the implementation/review rules.
- `parent`: fits the eight task headings if each task is treated as a stage or feature group. Some tasks are too large to be a single executable child because they bundle tests, schema design, implementation, validation, and commit instructions.
- `child`: fits individual task steps that express one behavior with files, constraints, a red command, expected failure, green scope, and verification.
- `checkpoint`: fits the acceptance proof checklist, Task 8, final focused gate, cleanup checks, drift guard gate, and manual review checklist.
- `fixture`: only partially fits. The plan names representative Claude/OpenCode envelope cases, but it does not define durable fixture files, fixture provenance, or refresh policy.
- `pilot`: no strong fit. The plan does not ask for evidence collection to decide whether to create or reject follow-up work.
- `followup-template`: fits the post-slice ProviderRuntimeEvent section, especially the future plan name, proposed scope, PR sequence, and future acceptance proof gates.
- `work-packet`: fits most implementation task steps, especially where the plan gives files, goal, commands, expected red/green results, constraints, and verification.
- `subagent-launch`: weak fit. The plan has one implementation instruction to use an executing-plans skill, but it does not define subagent launch packets, ownership slices, or parallel fanout rules.
- `handoff-note`: partial fit. Suggested commits, proof commands, and review checklist provide handoff-like evidence, but the plan does not define durable Beads notes or explicit handoff requirements.

## Gaps / Schema Additions

- Add an `acceptance-proof` or richer checkpoint proof schema. The checklist communicates `command`, `expected`, and `proves` as first-class evidence. A generic `checkpoint` can hold this, but the current formula parts do not make the evidence relationship explicit.
- Add `preconditions` or `readiness-gate` metadata. The plan depends on a prior plan, architecture docs, and installed SDK type definitions before implementation can start.
- Add `reference-point` metadata. The t3code section is not just architecture; it records provenance and specific patterns to copy from an external/local codebase.
- Add `manual-review-rubric` metadata or checkpoint fields. The review checklist is qualitative and not fully represented by validation commands.
- Add `commit-boundary` metadata. The plan communicates suggested atomic commits and exact commit messages, which are not represented by the current roles or contract snippets.
- Add `invariant` or `drift-guard` metadata. SDK discriminant coverage and compiler-hoisting checks are persistent invariants that cut across work packets and checkpoints.
- Add `mapping-table` support for architecture decisions. The follow-up event-model section includes a current-to-future event vocabulary table that should survive conversion as structured data.
- Add `deferred-epic-template` support or allow nested `followup-template` stages. The post-slice section is effectively a future multi-PR implementation plan, not just a simple follow-up issue template.
- Add optional `source-anchors` fields. The plan uses exact file paths and line anchors to identify current behavior; these are more precise than broad `allowedFiles`.

## Notes For Combined Summary

- This plan is richer than a linear task list. It combines implementation instructions, acceptance evidence, architecture constraints, review criteria, and a deferred migration plan.
- The current formula can represent the main executable work if tasks are split into smaller child work packets and the acceptance proof checklist becomes checkpoints.
- The largest schema pressure comes from evidence and provenance: `command / expected / proves`, preconditions, external reference points, commit boundaries, and manual review rubrics.
- The post-slice follow-up should probably become a `followup-template` with nested future-stage metadata, or a deferred epic template, rather than executable work in the current conversion.
- No current information naturally requires `pilot`; no durable fixture bead exists unless the representative provider envelope cases are turned into fixture artifacts.
