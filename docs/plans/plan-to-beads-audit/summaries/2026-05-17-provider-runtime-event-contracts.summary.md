# 2026-05-17 Provider Runtime Event Contracts Summary

## Source

- Reviewed plan: `docs/plans/2026-05-17-provider-runtime-event-contracts.md`
- Formula references inspected: `.agents/skills/plan-to-beads/SKILL.md`, `.agents/skills/plan-to-beads/REFERENCE.md`
- Plan subject: a contracts-only `ProviderRuntimeEvent` schema slice under `src/lib/contracts/providers/`, with focused unit tests and no runtime behavior change.
- Primary deliverables described by the plan:
  - `src/lib/contracts/providers/provider-runtime-event.ts`
  - `test/unit/contracts/providers/provider-runtime-event.test.ts`
  - optional existing provider-contract barrel export only if repo patterns require it

## Plan Structure

The plan is a sequential implementation record with these major layers:

1. Header contract: goal, architecture boundary, tech stack, and required implementation sub-skill.
2. Product/architecture framing: goal, motivation, current runtime shape, t3code lessons, and target architecture.
3. Schema design detail: event base fields, raw source labels, provider refs, event families, value unions, payload examples, drift expectations, and import-purity rules.
4. Hard boundaries: explicit non-goals and forbidden runtime surfaces.
5. Task sequence: five implementation tasks with file ownership, step-by-step instructions, expected red/green behavior, and commands.
6. Verification plan: focused Vitest, `pnpm check`, import-purity greps, and behavior-change guard greps.
7. Acceptance layer: acceptance criteria plus an acceptance proof matrix mapping each criterion to required evidence.
8. Risk and sequencing context: risks, rollout order relative to adjacent provider-runtime work, and follow-up boundaries for later PRs.

## Information Types Communicated

- Plan identity and objective.
- Contract-only scope and non-goals.
- Runtime architecture context and existing event flow.
- Required source reading for implementers.
- Cross-plan alignment requirements, especially raw-source labels shared with the local trace artifact plan.
- External design influence from t3code, with explicit no-copy guidance.
- Target files and allowed/optional file modifications.
- Domain vocabulary for runtime events, raw payloads, provider refs, provider identity, and request/user-input semantics.
- Schema shape requirements, including exported types, exported schemas, and module-scope decoders.
- Validation and compatibility expectations for unknown providers, unknown event types, raw payload opacity, and current `CanonicalEvent` continuity.
- Import-purity and behavior-change constraints.
- TDD task steps, including expected pre-implementation failure.
- Verification commands and command-specific expected outcomes.
- Acceptance criteria and traceable proof requirements.
- Risk register.
- Rollout order across current and future PRs.
- Follow-up PR templates/boundaries for adapter parity, compatibility translation, projector migration, relay/frontend cleanup, and provider identity.

## Fit To Existing Formula Parts

- `epic`: Fits the whole contracts-only `ProviderRuntimeEvent` slice, including the goal, source plan path, and overall acceptance criteria.
- `global-contract`: Fits the plan-wide scope, non-goals, current `CanonicalEvent` continuity, no-runtime-change constraint, and stop/split guidance.
- `architecture`: Fits module ownership, import-purity rules, event base concepts, raw envelope design, provider refs, normalized event families, and provider identity distinction.
- `policy`: Fits TDD expectations, decoder construction rules, no over-modeling guidance, raw payload opacity, provider-label openness, and output/verification discipline.
- `parent`: Fits the task groups as stage beads: tests first, contract module, drift/compatibility tests, optional barrel export, and static proof.
- `child`: Fits most executable task steps because they include concrete files, goals, constraints, commands, expected failure/pass states, and bounded file ownership.
- `checkpoint`: Fits red/green gates, focused test runs, `pnpm check`, import-purity grep, behavior-change guard grep, and final acceptance proof checks.
- `fixture`: Only partially fits. The plan uses sample raw payloads, raw-source literals, and canonical mapping notes as reference examples, but it does not define fixture files or refreshable fixture provenance.
- `pilot`: Mostly not applicable. The plan is not asking for exploratory measurement before deciding work; it is a direct contracts slice.
- `followup-template`: Fits the later PR boundaries and rollout sequence, especially adapter parity, compatibility translator, projector migrations, relay/frontend cleanup, and provider identity.
- `work-packet`: Fits well for Tasks 1-3 and 5, which contain file targets, constraints, commands, expected failures, green scope, verification, and failure conditions.
- `subagent-launch`: Weak fit. The plan includes a required sub-skill instruction, but not a full parallel subagent launch packet or disjoint launch matrix.
- `handoff-note`: Partial fit. The acceptance proof matrix, risks, and follow-up boundaries provide good handoff content, but the plan does not define a durable Beads note requirement per child.

## Gaps / Schema Additions

- `acceptance-proof`: Add a first-class field or snippet for criterion-to-proof traceability. The current `checkpoint` role can hold commands, but the proof matrix is richer than a command list because it maps each acceptance statement to evidence.
- `external-plan-link`: Add a way to model cross-plan dependencies and vocabulary alignment. This plan depends on the provider contract runtime-schema plan landing first and requires raw-source labels to stay aligned with the local trace artifact plan.
- `change-surface-guard`: Add plan-wide guarded surfaces and allowed-diff expectations. Existing `forbiddenFiles` helps children, but this plan also defines repo-area guard greps and expected `git status` shape.
- `conditional-child`: Add support for tasks that execute only if repo state warrants them. Task 4 conditionally modifies an existing barrel only if it exists and is clearly used.
- `compatibility-contract`: Add a schema slot for compatibility/drift expectations that are neither implementation steps nor validation commands, such as unknown provider labels decoding, unknown event types failing, and current canonical runtime contracts remaining active.
- `required-skill-policy`: Add metadata for required implementation skills or execution modes. The current snippets can carry this as prose, but a structured field would preserve it during formula generation.
- `reference-reading`: Add explicit source-reading inputs separate from fixtures. This plan lists architectural docs, prior plans, current code files, and competitor references that inform implementation but are not fixture artifacts.

## Notes For Combined Summary

This plan is a strong example of a contracts-first, TDD-oriented implementation plan. It communicates enough detail to hydrate executable child work packets, especially because it names files, commands, expected failures, non-goals, and verification gates.

The main formula pressure comes from information that is traceability-oriented or cross-plan rather than executable: proof matrices, external plan sequencing, shared vocabulary alignment, guarded change surfaces, and conditional optional work. These can be represented today as prose inside `global-contract`, `architecture`, `policy`, or `checkpoint`, but they would be easier to validate if the formula schema modeled them explicitly.

For combined analysis, compare this plan against other plan summaries for:

- whether proof matrices recur often enough to become a standard snippet;
- whether cross-plan rollout dependencies should be structured separately from Beads `needs`;
- whether plan-wide guard greps should become a reusable checkpoint contract;
- whether conditional tasks need their own child metadata rather than prose;
- whether reference-reading lists should be normalized as inputs, fixtures, or a separate context type.
