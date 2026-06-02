# Plan To Beads Templates

These files are generic role templates. They are not plan-specific formulas.

`/plan-to-beads` should parse a plan into an IR, hydrate these snippets, compose a generated formula under `.beads/generated-formulas/`, then validate it with Beads before pouring.

Placeholders use `{{snake_case}}`. Placeholders ending in `_array`, `_table`, `_tables`, or `_object` are pre-rendered TOML fragments.

## Files

- `formula/executable-plan.formula.toml`: full-formula skeleton.
- `roles/*.toml`: role snippets for one Beads issue/step.
- `contracts/*.toml`: reusable metadata table snippets used by role templates.

## Contract Families

- `work-packet.toml`: executable child prompt contract.
- `subagent-launch.toml`: implementation-agent launch packet.
- `handoff-note.toml`: durable Beads handoff note shape.
- `evidence-records.toml`: baselines, verification results, source grounding, inventories, guardrail evidence, and failed attempts.
- `audit-amendment.toml`: audit findings, review runs, dispositions, amendment ledgers, plan edits, and non-actionable findings.
- `progress-history.toml`: progress entries, completed slices, historical status, archive provenance, residual debt, and status overlays.
- `decision-point.toml`: open decisions, blockers, decision options, needed decisions, and conditional branches.
- `acceptance-proof.toml`: acceptance matrices, criteria, scenarios, traces, manual acceptance, and operator smoke contracts.
- `guardrail.toml`: static and boundary guardrails, anti-patterns, allowed exceptions, and change-surface guards.
- `file-operations.toml`: action-aware file touches, ownership maps, change surfaces, commit boundaries, delivery, publication, and release gates.
- `architecture-contracts.toml`: module maps, boundary classifications, protocols, artifacts, config, command catalogs, mapping tables, source authority, reference patterns, and prior art.
- `risk-operational.toml`: risk registers, edge cases, procedures, runbooks, rollback, and manual recovery.
- `cross-plan-relationships.toml`: related plans, prerequisites, blockers, amendments, supersession, and external plan dependencies.
- `executor-policy.toml`: implementation agent skills, modes, tools, worktree policy, handoff policy, and application lifecycle.

Do not commit concrete plan behavior, file paths, commands, or expected failures into these templates.
