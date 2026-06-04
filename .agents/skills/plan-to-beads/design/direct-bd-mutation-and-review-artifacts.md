# Direct Bd Mutation And Review Artifacts

## Context

`/plan-to-beads` currently treats a generated, plan-specific Beads formula as the main intermediate artifact. The skill normalizes a written plan into an IR, renders TOML under `.beads/generated-formulas/`, validates that TOML with the local validator, runs `bd cook --dry-run`, and only then persists or pours the molecule.

The current reference already leaves a small-plan escape hatch: hydrate role templates directly into `bd create`, `bd update`, and `bd dep add`, then validate Beads metadata after mutation. That escape hatch is directionally right, but it is not yet a full replacement for formulas. A direct mutation path must preserve three properties that formulas currently provide:

- a schema boundary before Beads state changes,
- a review boundary for large generated work graphs,
- a reproducible way to test schema/template changes.

The core question is not whether formulas are useful. They are useful for reusable workflow templates. The question is whether every one-off plan conversion should flow through a formula when the real source of truth is a validated IR and the real destination is Beads state.

## What Formulas Give Us

Formulas give the workflow a concrete, diffable artifact before mutation. A reviewer can inspect the exact role list, titles, types, `needs`, and metadata tables before anything touches the Beads database. `bd cook --dry-run` also exercises Beads's own formula compiler, which catches unresolved variables, invalid formula structure, and proto/pour mistakes.

They also separate generation from mutation. The agent can generate a formula, stop, ask for approval, and avoid accidental task creation. That barrier matters because plan conversions can create dozens of beads and dependencies.

Formulas are a poor fit as the mandatory intermediate for one-off conversions:

- They create two models to maintain: formula TOML and actual Beads issues.
- They make reviewers inspect an implementation detail, not the final mutation plan.
- They require persist/pour mechanics even when the desired result is just concrete issues.
- They blur reusable templates with generated, plan-specific output.
- They make updates to existing beads awkward, because formulas model creation better than idempotent reconciliation.
- They can lag `bd` CLI features such as rich metadata, parent updates, and dependency types.

The strongest argument for formulas is reviewability. The strongest argument against them is that reviewability belongs at the IR and mutation-plan boundary, not necessarily at the formula boundary.

## Direct Mutation Options

| Option | Best Use | Strengths | Weaknesses | Verdict |
| --- | --- | --- | --- | --- |
| Keep formulas | Reusable workflows and current stable path | Proven review surface, `bd cook`, formula ecosystem | Extra model, plan-specific artifact churn, weak update story | Keep as optional export |
| Direct mutation with dry-run plan | Small trusted conversions | Fast, simple, close to final Beads state | Dry-run output may omit exact metadata and transaction order | Good for low-risk use |
| Direct mutation with generated transaction/review artifact | Large or review-gated conversions | Reviews exact create/update/dep ops, supports idempotency | Requires new generator and validator surface | Best default target |
| Direct mutation plus `bd --readonly` preview | Worker safety and accidental-write checks | Blocks writes in preview contexts | Does not by itself simulate rich mutations | Useful guard, not enough alone |
| Checked-in generated review artifacts | Audits, RFCs, and human approval gates | Durable, diffable history of generated intent | Noisy if every conversion commits generated files | Use only when requested |
| JSON patch/diff artifacts | Reviewing changes to existing Beads graphs | Focuses on final state delta | Can be verbose and less readable than an op plan | Useful secondary artifact |
| Schema snapshots and golden tests | Schema/template evolution | Catches regressions without per-plan artifact churn | Does not review a specific generated plan | Required for schema changes |

The best direct path is not "run a pile of shell commands." It is:

1. Parse the source plan into a validated IR.
2. Normalize the IR into a canonical transaction plan.
3. Render a concise human review artifact from that transaction plan.
4. Dry-run the transaction plan.
5. Apply the transaction plan through `bd create`, `bd update`, and `bd dep add`.
6. Query Beads and validate the resulting metadata and dependency graph.

That transaction plan should include stable logical IDs, operation order, preconditions, idempotency rules, parent/child mapping, dependency edges, metadata JSON, expected postconditions, and the exact validation commands to run after mutation.

Today, `bd create --dry-run` and `bd batch --dry-run` help, but they do not cover the whole need. `bd batch` is transactional, but its grammar currently supports only a narrow subset of create/update fields and cannot represent rich plan-to-beads metadata. `bd dep add --file` helps with bulk dependency wiring, but dependency preview and cycle proof still need a separate check. Until the batch surface can carry rich metadata, a direct mutator must either accept sequential application risk or use a Beads API/transaction surface that can apply the whole operation set atomically.

## Reviewability Options

Reviewability has two different audiences.

Schema reviewers need to know whether `/plan-to-beads` still emits valid, complete work packets after a schema or template change. They should review source schema files, validators, example IRs, and golden outputs. They do not need every generated plan artifact checked into the repo.

Plan reviewers need to know what Beads state a specific conversion will create or update. They need a concise transaction review artifact, not necessarily a formula. The artifact should show:

- counts by operation and role,
- root, parent, child, checkpoint, and context bead titles,
- exact dependency edges,
- metadata schema version and template version,
- any update to existing bead IDs,
- unresolved or external references,
- writable file ownership and fanout rules,
- post-apply checks, including `bd dep cycles` and metadata validation.

Tests plus dry-run are enough when the schema is stable, the plan is small, and the operator trusts the converter. They are not enough for large plan conversions, first use of a new schema, changes that update existing beads, or conversions intended for human approval. A dry-run is a safety check; it is not always a review artifact. If the dry-run output does not include full metadata, dependency semantics, idempotency, and postconditions, it cannot replace a generated review artifact.

Checked-in generated artifacts should be the exception. Commit them when the artifact itself is a deliverable, an audit record, or an approval boundary. Do not check in a generated transaction file for every ordinary conversion; that would recreate the formula-churn problem under a different name.

JSON patch or diff artifacts are valuable when reconciling against existing Beads state. They should be derived from canonical before/after state, not handwritten. They are less readable than an operation plan for new graphs, but they are better for updates because they show field-level replacement, metadata movement, and dependency additions/removals.

`bd --readonly` is useful as a guardrail in preview mode. It proves the preview code path did not accidentally call a write operation. It does not prove that a real mutation would succeed unless the preview engine can simulate the same write semantics without writing. For that, use a proper dry-run operation plan, an isolated temporary Beads database, or a future `bd preview` command that evaluates mutations against a read-only snapshot.

## Recommendation

Stop making formulas the required intermediate for one-off `/plan-to-beads` conversions. Keep formula generation as an optional export for reusable workflows and backward compatibility, but make the canonical path:

```text
source plan -> validated IR -> canonical transaction plan -> review artifact -> direct bd mutation -> post-apply validation
```

The canonical transaction plan should be machine-readable JSON. The human review artifact should be Markdown generated from that JSON. This keeps the source of truth structured, lets tests compare stable data, and gives humans a concise diff without forcing them to read generated TOML.

Use three artifact classes:

- Source artifacts: schema docs, renderer code, validators, and examples. These are checked in.
- Golden artifacts: representative IR inputs and expected transaction plans or metadata snapshots. These are checked in for schema changes.
- Plan-run artifacts: generated transaction JSON, Markdown review, and optional post-apply diff. These are ephemeral by default and checked in only when requested or when they serve as an audit deliverable.

The direct mutator should be idempotent. It should use `logicalId` and `planId` metadata to find existing beads, then decide whether each operation is `create`, `update`, `noop`, or `conflict`. It should fail closed on conflicts unless the transaction plan explicitly permits reconciliation.

The direct path should still support a formula export:

```text
validated IR -> formula TOML
```

That export is useful when the user wants a reusable molecule, wants to inspect a familiar TOML shape, or needs compatibility with existing `bd mol pour` flows. It should not be the only path to create concrete Beads work from a plan.

## Migration Path

1. Define a `plan-to-beads.transaction.v1` schema. Include `planId`, `sourcePlan`, schema/template versions, operation list, logical-to-actual ID mapping, preconditions, postconditions, dependency edges, and validation commands.

2. Add a transaction renderer beside the formula renderer. Both renderers should consume the same validated IR. The formula renderer remains for compatibility.

3. Add golden tests for representative IRs: minimal plan, multi-stage plan, existing-bead update, checkpoint fanout, typed context snippets, external refs, and rejection cases.

4. Add a review renderer that emits Markdown from the transaction JSON. Keep it concise: operation summary, role table, dependency table, conflicts, external refs, and validation checklist.

5. Add dry-run modes:
   - `--dry-run=plan` emits the transaction JSON and Markdown review.
   - `--dry-run=bd` calls supported `bd` dry-run/preview surfaces where available and records gaps.
   - `--readonly` runs preview code with Beads writes blocked to catch accidental mutation.

6. Add post-apply validation against real Beads state. Query by `metadata.planToBeads.planId`, validate metadata shape, verify dependencies, run `bd dep cycles`, and compare actual state to transaction postconditions.

7. Make direct mutation the default only after the transaction schema, dry-run, review renderer, idempotency checks, and post-apply validation are in place. Until then, keep formulas as the safer default.

8. Keep a `--formula` or `--export-formula` mode for reusable molecules and compatibility with existing formula review flows.

## Open Questions

- Should the transaction applier use only the `bd` CLI, or should Beads expose a richer transaction API for metadata-heavy graph creation?
- Should `bd batch` grow support for rich `create`, `update --metadata`, parent assignment, notes/design fields, and dependency files so plan-to-beads can apply one transaction atomically?
- What is the exact storage location for ephemeral run artifacts: `.beads/generated-transactions/`, `.agents/skills/plan-to-beads/generated/`, or a caller-provided output directory?
- Should generated plan-run artifacts be ignored by git by default, or should the command require an explicit `--review-artifact` path?
- What is the conflict policy when a `logicalId` already exists but title, type, parent, or metadata differ?
- Should the mutator support deletion/removal operations, or should plan-to-beads only create, update, and add dependencies?
- What minimum dry-run output from `bd` would let us remove formula dry-runs without losing safety?
- How much of the review artifact should be stable across `bd` version changes, especially if Beads changes ID allocation or JSON field ordering?
