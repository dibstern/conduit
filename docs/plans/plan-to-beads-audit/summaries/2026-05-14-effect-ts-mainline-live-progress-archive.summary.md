# 2026-05-14 Effect.ts Mainline Live Progress Archive Summary

## Source

- Source plan reviewed: `docs/plans/2026-05-14-effect-ts-mainline-live-progress-archive.md`.
- Allowed reference files reviewed: `.agents/skills/plan-to-beads/SKILL.md` and `.agents/skills/plan-to-beads/REFERENCE.md`.
- The source is an archive of `docs/plans/2026-05-14-effect-ts-mainline-live-progress.md`, created on 2026-05-14 to keep the live progress file concise.
- Formula roles compared against: `epic`, `global-contract`, `architecture`, `policy`, `parent`, `child`, `checkpoint`, `fixture`, `pilot`, `followup-template`.
- Contract snippets compared against: `work-packet`, `subagent-launch`, `handoff-note`.

## Plan Structure

- The file has one title, one archive provenance note, and a single `## Latest Update` section.
- Inside that section, the content is a chronological progress ledger rather than a nested implementation plan.
- Entries are date-prefixed, mostly `2026-05-14, <slice label>:`, followed by bullets.
- The entry labels act like slice names: Phase 0.5 organization, persistence migration alignment, RPC migration slices, scoped relay ownership cleanup, provider naming cleanup, deferred cleanup, daemon IPC cleanup, and similar.
- Most entries follow a repeated pattern: what changed, what was deleted or retained, what guard coverage was added, and what verification was run.
- Some entries include residual work, reverted attempts, compatibility notes, retry caveats, or production-readiness requirements.
- The archive does not provide executable work packets, dependency graphs, subagent launch packets, or fanout plans. It records completed or partially completed work.

## Information Types Communicated

- Archive provenance: original live file, archive date, and when to consult the archive.
- Temporal progress history: dated slices and short slice labels.
- Completed implementation outcomes: files moved, APIs added, handlers converted, bridges removed, helpers deleted, and naming changed.
- Architectural direction: Effect-owned service graphs, relay-owned runtime boundaries, typed RPC ownership, provider instance naming, scoped finalizers, and daemon IPC ownership.
- Compatibility surfaces: old APIs retained temporarily, internal push events kept, sync helpers left only for direct unit-test wiring, and `pty_input` reclassified as the remaining raw terminal data-plane path.
- Deletion/removal evidence: legacy WS commands, bridge objects, compatibility shims, promise routers, deferred helpers, and adapter-named exports.
- Guardrail evidence: runtime-boundary guards and source guards that prevent specific old patterns from returning.
- Verification evidence: local command names, targeted unit/integration/E2E suites, build/lint/typecheck/diff hygiene checks, and pre-commit hook evidence.
- Fixture or harness details: test helpers, RPC mock frame shapes, accelerated relay harness routing, E2E cleanup seeds, and migration baseline inventory.
- Operational policy: forward-only migration rollback policy, production DB copy dry-run requirement, bounded relay event bus buffer policy, and warning-and-continue behavior.
- Residual debt and follow-up hints: browser transport cutover still open, provider adapter wording cleanup, remaining provider cleanup slices, and harness-specific RPC pass notes.
- Failed or reverted attempt evidence: one attempted harness conversion timed out and was reverted before a later focused routing fix.
- Test-environment caveats: Playwright retries under high parallelism and serial rerun evidence.

## Fit To Existing Formula Parts

| Existing part | Fit |
| --- | --- |
| `epic` | The whole Effect.ts mainline migration could be an epic, but this file is a historical archive, not an executable root plan. |
| `global-contract` | Some global constraints fit here, such as forward-only migration rollback, production DB dry-run requirements, and keeping `/ws` as the push channel while commands move to RPC. |
| `architecture` | Strong fit for cross-cutting ownership decisions: domain organization, runtime boundary cleanup, typed RPC ownership, provider instance naming, and relay/daemon service ownership. |
| `policy` | Partial fit for execution rules and guardrails: no reintroduced runtime bridges, raw terminal data-plane classification, bounded buffer policy, and production readiness requirements. |
| `parent` | Slice clusters can become stage parents, but the archive does not define explicit stage defaults, ownership inheritance, or readiness gates. |
| `child` | Individual dated slices resemble child work items after the fact. They lack required work-packet fields such as red command, expected failure, green scope, allowed files, forbidden files, and failure conditions. |
| `checkpoint` | Verification commands and readiness notes resemble checkpoints, but the file reports completed checks rather than defining future gates, fanout rules, or launch criteria. |
| `fixture` | Migration baseline inventory, test helpers, RPC mock shapes, and harness setup can map to fixtures if provenance and refresh policy are added. |
| `pilot` | The failed/reverted harness conversion and later focused fix have pilot-like evidence, but they were not framed as planned measurement pilots. |
| `followup-template` | Explicit residual notes can seed follow-up templates, but most are lightweight debt notes without enough template fields for future children. |
| `work-packet` | Poor direct fit. The archive gives outcomes and verification, not TDD-oriented executable prompt contracts. |
| `subagent-launch` | No meaningful fit. The archive does not describe parallel agent launch packets, ownership splits, or fanout instructions. |
| `handoff-note` | Partial fit as historical handoff context, but it is not structured as a handoff with current state, required Beads notes, or next owner actions. |

## Gaps / Schema Additions

- Add a `progress-entry` or `completed-slice` record type for timestamped, post-execution ledger entries. Fields should include slice label, outcome summary, touched surfaces, deleted surfaces, retained compatibility surfaces, guard coverage, verification evidence, and residual notes.
- Add a `verification-evidence` contract snippet distinct from `checkpoint`. It should capture commands actually run, status, scope, caveats, retries, and whether the command was local, targeted, full-suite, or pre-commit.
- Add an `archive-provenance` or `source-ledger` record for archive metadata: source file, archive date, live-file relationship, and consult guidance.
- Add a `residual-debt` or `legacy-surface` snippet for intentionally remaining old behavior. This should capture what remains, why, cleanup prerequisite, and whether it should become a future `followup-template`.
- Add a `failed-attempt` or `reverted-change` evidence snippet for attempted work that was backed out. Fields should include attempted slice, failure mode, disposition, later replacement if any, and uncertainty left behind.
- Add a `guardrail-evidence` snippet for assertions that prevent regression. It should capture banned pattern, enforcing test or guard, protected file/surface, and rationale.
- Consider a `baseline-inventory` fixture subtype for migration/schema adoption facts, where the important payload is observed current state plus adoption checks rather than a reusable test fixture.

## Notes For Combined Summary

- Treat this file as representative of a live-progress archive class, not a normal implementation plan.
- The current formula parts are strong for turning planned work into Beads, but they do not cleanly preserve historical execution evidence without inventing missing work-packet fields.
- A combined audit should distinguish planned executable work from completed evidence. Forcing every dated entry into `child` would lose the archive's strongest information: what was actually changed, verified, retained, removed, or reverted.
- The most reusable extraction targets are slice labels, architectural outcomes, residual debt hints, compatibility surfaces, guardrail evidence, and verification evidence.
- Only explicit future work should become `followup-template`; vague residual notes should first land as `residual-debt` records or decision/checkpoint candidates.
