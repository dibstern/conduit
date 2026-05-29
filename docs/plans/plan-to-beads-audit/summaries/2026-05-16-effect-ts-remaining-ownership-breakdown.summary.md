# Plan-to-Beads Audit Summary: Remaining Effect Ownership Migration

## Source

- Source plan: `docs/plans/2026-05-16-effect-ts-remaining-ownership-breakdown.md`
- Plan type: migration inventory plus detailed implementation plan for remaining Effect ownership work.
- Formula context reviewed: `.agents/skills/plan-to-beads/SKILL.md` and `.agents/skills/plan-to-beads/REFERENCE.md`.
- Current formula roles considered: `epic`, `global-contract`, `architecture`, `policy`, `parent`, `child`, `checkpoint`, `fixture`, `pilot`, `followup-template`.
- Current contract snippets considered: `work-packet`, `subagent-launch`, `handoff-note`.

## Plan Structure

The plan opens with a compact execution contract: goal, architecture guardrails, tech stack, and status definitions for `Effect-returning`, `Effect-compatible`, and `Effect-owned`.

It then records audit provenance: branch, cwd, date, related docs read, and static audit commands used to find remaining runtime ownership gaps.

The next section classifies boundaries into accepted external Promise/callback boundaries and explicit non-targets. This prevents formula generation from treating every callback, timer, class, or Promise as executable migration work.

The core body is an eight-part migration inventory. Each domain slice has a priority, file list, current shape, target shape, test plan, and exit criteria. The slices cover Claude provider ownership, provider orchestration, OpenCode stream/poller/PTY/WebSocket shells, persistence cleanup, relay startup, daemon lifecycle, HTTP/WebSocket/frontend boundaries, and legacy class classification.

After the inventory, the plan gives a recommended execution order across the migration slices. It then zooms into the Claude slice with seven task-level implementation steps, including files to create or modify, tests to update, and step-by-step behavior changes.

The plan closes with static guard updates, validation strategy, and open questions that need architectural decisions before some later slices can become precise work packets.

## Information Types Communicated

- Goal, scope, and non-goals for the remaining migration.
- Migration maturity taxonomy: Effect-returning, Effect-compatible, Effect-owned.
- Audit provenance: live checkout facts, docs consulted, and grep commands used.
- Boundary exception registry: accepted external adapters and non-target areas.
- Domain migration inventory: priority, files, current shape, target shape, tests, and exit criteria.
- Architecture direction: desired Effect services, Layer ownership, scoped resources, `Ref`, `Queue`, `Deferred`, `FiberMap`, `Stream`, typed errors, and public Promise boundaries.
- Execution sequence: recommended ordering and prerequisite relationship to the provider schema boundary plan.
- Detailed child work for the Claude provider slice.
- Static guard rules for preventing regressions after each migration.
- Validation commands by risk level.
- Open architectural questions and decision points.
- Legacy classification policy for deciding delete, test fixture only, external adapter, or still production.

## Fit To Existing Formula Parts

- `epic`: fits the whole "Remaining Effect Ownership Migration" plan.
- `global-contract`: fits the goal, scope, closed May 15 guardrails, accepted boundaries, explicit non-targets, and public Promise boundary rules.
- `architecture`: fits the target ownership model and per-domain target shapes.
- `policy`: fits migration rules such as leaving Svelte UI state alone, avoiding broad grep bans, preserving behavior before deleting legacy code, and validating by narrow slice.
- `parent`: fits each of the eight inventory domains as stage or feature group beads.
- `child`: fits the seven Claude slice tasks most directly. Other inventory slices would need decomposition before becoming child beads.
- `checkpoint`: fits provider schema boundary readiness, phase exit criteria, static guard updates, and validation gates.
- `fixture`: partially fits audit commands and suggested deletion-audit commands, but only if interpreted as evidence-producing command fixtures rather than test fixtures.
- `pilot`: weak fit. The plan suggests representative migrations and "first add wiring tests" patterns, but it does not define a formal pilot experiment with measurement criteria.
- `followup-template`: fits later migration slices and legacy-class classification outcomes when the plan does not yet provide executable child packets.
- `work-packet`: fits the Claude task sections partially, but most tasks lack complete generated-contract fields such as `allowedFiles`, `forbiddenFiles`, `redCommand`, `expectedFailure`, and explicit failure conditions.
- `subagent-launch`: mostly absent. The plan has an implementation note for Claude to use `executing-plans`, but it does not define subagent ownership, launch packet shape, disjoint write sets, or handoff requirements.
- `handoff-note`: partially supported by exit criteria and validation strategy, but no explicit durable handoff note schema is present.

## Gaps / Schema Additions

- Add an `audit-evidence` or `provenance` role for branch/cwd/date, docs read, grep commands, and source observations. `fixture` can carry command provenance, but it is awkward for audit facts that are not reusable fixtures.
- Add a `boundary-exception` role or metadata block for accepted external adapters and non-targets. These are durable constraints that should be preserved and guarded, not executable work.
- Add an `inventory-item` or `assessment` role for current-state findings. The eight migration sections combine observation and planned work; forcing all of that into `parent` loses the difference between "what exists now" and "what should be executed."
- Add a `taxonomy` or `definition` context role for plan-local vocabulary such as Effect-returning, Effect-compatible, and Effect-owned. This could be folded into `global-contract`, but it is distinct from scope and non-goals.
- Add a `guard` role or checkpoint subtype for static regression rules. Guards are more specific than validation commands because they name forbidden patterns and allowed exception locations.
- Add a `decision-needed` role for open questions. These are not ordinary checkpoints because they require human or architectural resolution before work can be made executable.
- Add explicit support for `external-plan-dependency` metadata. This plan depends on `docs/plans/2026-05-15-provider-boundary-runtime-schemas.md`, which is neither a fixture nor a child task inside this plan.

## Notes For Combined Summary

This plan is a strong stress test for plan-to-beads because it is not only an implementation checklist. It mixes durable architecture constraints, audit evidence, migration inventory, task packets, validation gates, and unresolved decisions.

The current formula can represent the executable Claude slice reasonably well after hydration, but the broader eight-slice inventory needs more schema vocabulary to avoid flattening assessment, policy, boundary exceptions, and pending decisions into generic parent or checkpoint beads.

For combined analysis, treat this file as evidence that plan-to-beads needs first-class support for non-executable planning context. The most important additions are `audit-evidence`, `boundary-exception`, `inventory-item`, `guard`, and `decision-needed`.
