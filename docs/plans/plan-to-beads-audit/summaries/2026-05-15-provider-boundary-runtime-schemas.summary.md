# 2026-05-15 Provider Boundary Runtime Schemas Summary

## Source

- Reviewed plan: `docs/plans/2026-05-15-provider-boundary-runtime-schemas.md`
- Plan title: `Provider Boundary Runtime Schemas Plan`
- Date: 2026-05-15
- Status: Ready for implementation
- Formula context reviewed: `.agents/skills/plan-to-beads/SKILL.md` and `.agents/skills/plan-to-beads/REFERENCE.md`

## Plan Structure

The plan is a structured implementation record for adding runtime provider-boundary validation.

It starts with identity and intent: title, date, status, goal, and domain language. It then establishes source authority for Claude, OpenCode, and Effect Schema, including precedence rules between installed SDK type definitions and external docs.

The middle of the plan describes the current system state and the intended target state. It lists file-specific boundary gaps, durable decisions, and a strictness boundary that separates provider envelopes Conduit must validate from provider-owned payloads that should stay opaque.

The implementation section is staged by technical area:

- optional shared decode utility guidance
- OpenCode schema creation
- OpenCode API and gap endpoint wiring
- Claude schema creation
- Claude inbound and outbound decoding
- opaque payload preservation tests
- focused verification commands

The plan closes with rollout order, non-goals, and open follow-ups.

## Information Types Communicated

- Plan metadata: title, date, status, and implementation readiness.
- Goal statement: the behavior change and the safety property the work should provide.
- Domain vocabulary: provider contract, provider envelope, and provider-owned payload.
- Source-of-truth policy: installed SDK types as authority, docs as guides, and explicit precedence when they differ.
- Current-state gap inventory: file-specific places where provider data is trusted, cast, or only partially checked.
- Durable architecture decisions: target module locations, adapter/schema ownership boundaries, and where behavior should remain.
- Runtime validation policy: fail-closed active paths, narrowly preserved fallback paths, and typed provider/API failure surfacing.
- Strictness classification: fields and message envelopes to validate strictly versus nested provider-owned payloads to keep opaque.
- Conditional implementation guidance: add helpers only when repeated callsites justify them; avoid a broad validation framework.
- Provider-specific export inventory: expected Claude and OpenCode schema exports.
- Drift-check expectations: compile-time checks between decoded schema types and installed SDK types, including one-way versus bidirectional checks.
- API shape changes: the desired schema-explicit `OpenCodeAPI.sdk()` signature and gap endpoint decoding shape.
- Error-handling semantics: how network, API, and parse failures should map to existing error types.
- Test scenarios: schema tests, provider failure tests, outbound validation tests, API decode tests, and opaque payload survival tests.
- Verification commands: targeted Vitest and `pnpm check` commands.
- Rollout sequencing: ordered implementation waves with provider-specific review boundaries.
- Non-goals: generation, full provider payload modeling, adapter rewrites, and event-store changes outside narrow failure surfacing.
- Follow-up ideas: validator-hook placement, schema generation revisit, and CI drift guard.
- Code snippets: example type-level drift check and target method signatures.

## Fit To Existing Formula Parts

- `epic`: Fits the title, goal, status, and overall provider-boundary runtime validation objective.
- `global-contract`: Fits the source-of-truth rules, non-goals, domain vocabulary, and high-level scope boundary.
- `architecture`: Fits schema module placement, adapter ownership, API edge wiring, provider-envelope boundaries, and strict versus opaque modeling.
- `policy`: Fits fail-closed behavior, fallback/degrade rules, helper creation rules, test focus, docs/type precedence, and no broad framework guidance.
- `parent`: Fits the major implementation stages: OpenCode schemas, OpenCode wiring, Claude schemas, Claude wiring, opaque payload preservation, and verification.
- `child`: Fits concrete executable tasks inside each stage, such as creating provider schema modules, updating `OpenCodeAPI.sdk()`, decoding Claude stream items, and adding focused tests.
- `checkpoint`: Fits rollout gates, targeted verification commands, provider-by-provider review boundaries, and the point where obsolete schema modules can be removed.
- `fixture`: Weak fit. The plan describes representative payload cases, but it does not define reusable fixture provenance, refresh policy, or fixture ownership.
- `pilot`: Weak fit. The plan has follow-up ideas and evidence-producing checks, but it does not propose a pilot slice that measures whether to expand or reject later work.
- `followup-template`: Fits the Open Follow-Ups section, especially validator-hook placement, generation revisit, and CI drift guard.
- `work-packet`: Fits most implementation subsections because they include goal, target files, constraints, expected behavior, and verification hints.
- `subagent-launch`: Mostly absent. The plan has reviewable stages, but no explicit subagent launch contract, write-set partition, or parallel fanout rule.
- `handoff-note`: Mostly absent. The plan implies durable handoff through rollout order and tests, but it does not define required handoff contents.

## Gaps / Schema Additions

- Add a `source-authority` or structured `sourceAuthority` field. This plan relies on precedence between installed SDK `.d.ts` files, official docs, generated OpenAPI claims, and Effect docs. That information can be squeezed into `global-contract` or `policy`, but it is important enough to model directly.
- Add a `baseline-gap` or `current-state-audit` context shape. The Current Boundary Gaps section is not executable work by itself; it is evidence explaining why the work exists and where implementation must look first.
- Add a `boundary-classification` or `strictness-matrix` shape. The strict-versus-opaque lists are central to preserving provider-owned payloads while validating envelopes. Existing `architecture` and `policy` roles can carry this prose, but children would benefit from structured fields for `strictFields`, `opaqueFields`, and `degradeAllowed`.
- Add explicit drift-check metadata to `work-packet` or `checkpoint`. The plan distinguishes bidirectional checks from one-way checks depending on schema coverage. Current roles do not expose a clear field for type-level compatibility assertions.
- Add conditional decision metadata. Rules such as "add a helper only if two or more callsites need identical parse-error formatting" are not just policy; they are implementation triggers that should survive formula conversion.
- Add structured opaque-payload preservation cases. These are not fixtures in the current sense because the plan names behavior categories rather than concrete fixture files. They should be attachable to children and checkpoints as required preservation cases.
- Add optional `beforeStateFiles` or `gapFiles` metadata. The plan's file-specific gap list differs from `allowedFiles`: it identifies problematic existing boundaries, not necessarily the complete write set.

The existing role set is sufficient for a usable conversion, but these additions would reduce prose loss for provider-boundary and contract-hardening plans.

## Notes For Combined Summary

This plan is contract-heavy rather than task-list-heavy. It communicates authority, boundary semantics, and strictness rules before implementation steps.

Compared with simpler implementation plans, its most important formula stress points are source precedence, baseline gap inventories, strict-versus-opaque classification, and drift-check expectations. These are reusable information types for future plans that harden external API or SDK boundaries.

The current formula roles can represent the plan, but a high-quality conversion would need richer metadata under `global-contract`, `architecture`, `policy`, `work-packet`, and `checkpoint` unless the schema grows the additions listed above.
