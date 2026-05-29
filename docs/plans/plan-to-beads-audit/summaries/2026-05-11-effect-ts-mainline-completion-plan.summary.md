# 2026-05-11 Effect.ts Mainline Completion Plan Summary

## Source

- Plan reviewed: `docs/plans/2026-05-11-effect-ts-mainline-completion-plan.md`
- Formula reference reviewed: `.agents/skills/plan-to-beads/SKILL.md`
- Schema reference reviewed: `.agents/skills/plan-to-beads/REFERENCE.md`
- Audit scope: summarize the plan structure, identify the information types it communicates, and compare those information types to the current plan-to-beads formula roles and contract snippets.

## Plan Structure

The plan is a large migration plan with both original implementation phases and later status/ordering overlays.

1. Header contract
   - Codex execution instruction.
   - Goal, target architecture, tech stack, Effect version policy, live progress pointer, and reference docs.

2. Global constraints
   - Migration principles.
   - Non-goals.
   - Guardrail closure summary.
   - Target architecture refresh.

3. Phase sequence
   - Phase 0: baseline, guardrails, and inventory.
   - Phase 0.5: move-only domain organization PR.
   - Phase 0.6: contracts and RPC boundary design.
   - Phase 1: focused anti-pattern fixes, split into Tasks 1.1-1.3.
   - Phase 2: daemon composition root.
   - Phase 3: HTTP and WebSocket routing ownership.
   - Phase 4: hybrid CQRS relay ownership.
   - Phase 5: Effect SQL persistence migration.
   - Phase 6: provider drivers and orchestration.
   - Phase 7: handler service contracts and RPC-over-WS.
   - Phase 8: frontend RPC transport and Effect boundary cleanup.
   - Phase 9: final grep/doc/verification closure.

4. Per-phase details
   - Goal.
   - File scope, usually with operation intent such as modify, create, review, delete, audit, or update.
   - Approach steps.
   - Tests and verification commands.
   - Exit criteria, transition slice ordering, commit shape, or high-risk rules where relevant.
   - Code snippets for high-risk patterns.

5. Post-hoc execution overlay
   - `Completed Implementation Order` supersedes the older phase-number order when conflicts exist.
   - It records the final 14-step implementation order and points current completion state to the live progress doc.

6. Final closure contract
   - `Final Definition Of Done` lists architecture, guardrail, protocol, persistence, provider, runtime, and verification outcomes.

## Information Types Communicated

- Plan identity and high-level objective.
- Execution-mode guidance for Codex and subagent usage.
- External reference documents and progress/evidence surfaces.
- Tech stack and version constraints.
- Global architecture constraints.
- Migration principles and non-goals.
- Current/historical status notes, including closed blockers.
- Target architecture narrative.
- Stage and phase decomposition.
- Mandatory ordering and ordering overrides.
- File scopes with operation intent.
- Implementation approach steps.
- High-risk implementation rules.
- Positive code patterns and forbidden anti-patterns.
- Typed error, Effect runtime, resource-scope, and concurrency policies.
- Test strategy and targeted verification commands.
- Manual smoke checks, route probes, grep gates, and static guards.
- Exit criteria and final definition of done.
- PR, commit, and release sequencing guidance.
- Rollback and data migration safety guidance.
- Follow-up or deferred work, especially Effect v4 and workspace package extraction.

## Fit To Existing Formula Parts

| Formula part | Fit | Plan information that maps well |
| --- | --- | --- |
| `epic` | Strong | Whole migration goal, final definition of done, overall source plan identity. |
| `global-contract` | Strong | Migration principles, non-goals, tech stack, version policy, per-project relay preservation, SQLite source-of-truth rule, WebSocket transport rule. |
| `architecture` | Strong | Target architecture refresh, hybrid relay CQRS shape, daemon composition root, scoped relay ownership, contracts boundary, provider driver shape, persistence ownership. |
| `policy` | Strong | TDD guidance, no Effect v4, no rejectable `Effect.promise`, no unbounded dynamic concurrency, bridge deletion policy, callback boundary policy, Layer/test isolation rules. |
| `parent` | Strong | Each phase or completed-order item can be a parent/stage bead carrying defaults and file ownership. |
| `child` | Medium-strong | Phase 1 tasks and many vertical migration slices can become executable child beads. Larger phases need decomposition before they become child work packets. |
| `checkpoint` | Strong | Baseline gates, route probes, cutover gate, grep gates, phase exit criteria, final verification, command-gate readiness, and full definition of done. |
| `fixture` | Medium | Baseline grep output, behavior smoke checklist, SQLite schema inventory, copied production DB dry-run, and static guard fixtures fit, but often need provenance fields. |
| `pilot` | Medium | Branch-local comparison harness, first RPC read-only method, migration dry-run on copied DB, and route-slice probes are evidence-producing pilots. |
| `followup-template` | Strong | Post-migration Effect v4 evaluation, possible workspace contracts package, later concurrency config tuning, and any deferred semantic PR templates. |
| `work-packet` snippet | Medium-strong | Many tasks include goal, files, approach, tests, verification, and failure rules. The plan does not always provide one behavior per task, red command, expected failure, or concrete allowed/forbidden file scopes. |
| `subagent-launch` snippet | Weak-medium | The header names subagent-driven development and the phase structure implies parallelization points, but the plan does not define explicit subagent launch packets, write sets, or handoff prompts. |
| `handoff-note` snippet | Medium | Live progress and historical evidence docs act as handoff surfaces, but the plan mostly points to them rather than defining per-child handoff-note content. |

## Gaps / Schema Additions

These information types either do not fit cleanly in the current role set or need first-class fields inside existing roles to avoid lossy conversion.

1. Plan status and historical overlay
   - The plan contains `Guardrail Closure` and `Completed Implementation Order`, which update or supersede earlier phase content.
   - Suggested addition: plan-level `status`, `statusDate`, `supersededBy`, `authoritativeOrder`, and `closedBlockers` metadata.

2. Ordering override
   - The completed order explicitly supersedes the phase-number order when conflicts exist.
   - Suggested addition: `execution-order` or `orderOverride` metadata that can distinguish source document order from executable order.

3. Guardrail exception registry
   - Phase 9 has structured grep patterns, allowed locations, reasons, and known non-exceptions.
   - Suggested addition: a `guardrail-registry` contract or checkpoint subtype with `pattern`, `allowedLocations`, `reason`, `knownNonExceptions`, and `expectedResult`.

4. File operation intent
   - The plan distinguishes `modify`, `create`, `review`, `delete`, `audit`, and `update`.
   - Current child packets have `allowedFiles` and `forbiddenFiles`, but those lose operation intent.
   - Suggested addition: `fileIntents` in work packets, keyed by path or glob.

5. High-risk pattern snippets
   - The plan carries concrete code examples and explanatory anti-pattern warnings.
   - Suggested addition: a reusable `risk-pattern` or `implementation-pattern` contract snippet with `patternName`, `useWhen`, `forbiddenAlternative`, `example`, and `reviewRule`.

6. Verification taxonomy
   - The plan separates unit tests, integration tests, full verification, smoke checks, route probes, grep gates, static guards, and data-migration dry-runs.
   - Current `verification` and checkpoint validation can hold commands, but not the intent class.
   - Suggested addition: typed verification entries such as `command`, `staticGrepGate`, `manualSmoke`, `routeProbe`, `dataMigrationDryRun`, and `e2eScenario`.

7. Release and rollback gates
   - Phase 5 includes release sequencing and rollback guidance for forward-only migrations.
   - Suggested addition: `releaseGate` or checkpoint fields for `rolloutStep`, `rollbackPlan`, `backupRequired`, and `observeBeforeConsumerSwitch`.

8. Durable progress/evidence surfaces
   - The plan points to live progress and historical evidence docs with rules about when to load or append them.
   - Suggested addition: `evidenceSurface` metadata that records canonical progress docs, append policy, and stale/historical docs.

9. PR and commit shaping policy
   - Several sections define commit shape, one-boundary-per-PR rules, and slice commit gates.
   - This can live in `policy`, but a structured `changeManagement` field would make conversion less lossy.

## Notes For Combined Summary

- This is not just an implementation plan. It is also a migration charter, architecture decision bundle, guardrail registry, and historical status document.
- If converted to Beads now, the executable graph should follow `Completed Implementation Order`, not the older phase-number order where they conflict.
- The strongest schema pressure comes from status overlays, guardrail exception tables, file operation intent, high-risk code patterns, and verification taxonomy.
- Most gaps can be modeled as metadata or contract snippets layered onto existing roles; the role list itself is mostly adequate.
- The plan is closed as of the later guardrail notes, so any combined audit should distinguish "source plan content" from "currently executable remaining work."
