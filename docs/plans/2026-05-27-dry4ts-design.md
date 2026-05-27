# dry4ts: Structural Clone Detection for TypeScript

**Date:** 2026-05-27
**Status:** Design (pre-implementation)
**Target package:** `packages/dry4ts` inside conduit, structured so the subtree can move to a standalone repo later.
**Target consumer:** conduit TypeScript / TSX source first, with no production dependency on conduit's runtime modules.

## Scope

A deterministic TypeScript-native clone detector covering the first useful structural DRY slice:

- **Type-1** (exact, modulo whitespace and comments)
- **Type-2** (identical structure with renamed identifiers and changed literals)
- **Type-3** (gapped / near-miss structural clones)

T1/T2/T3 share one extraction, normalization, fingerprinting, and classification pipeline. The first releasable milestone is TS/TSX structural detection, stable JSON output, a conduit profile, and a conduit pilot. Svelte template normalization, semantic skipped-evidence work, and human-oriented text output are follow-up work created from pilot evidence.

## Goals

- **Deterministic.** No LLM calls. Reproducible across runs and machines.
- **Cover Type-1 through Type-3** for TS/TSX in v1.
- **Agent-friendly output.** JSON output, stable ordering, source spans, similarity scores, and deterministic run counts.
- **Single structural IR.** All v1 input lowers to a uniform structural representation; one set of similarity/clustering rules.
- **Fast first value.** Reuse the earlier UBM DRY-tool scope: TypeScript compiler AST, structural fingerprints, a non-blocking pilot sanity check against existing tools if useful, and Svelte only if the first pilot shows frontend coverage is necessary.

## Non-goals (v1)

- Proving semantic equivalence (we report candidates with evidence, not proofs).
- Symbolic execution or SMT solving.
- Cross-language clone detection.
- Svelte template structural detection.
- Runtime semantic probing, trace extraction, and test-corpus validation.
- CI gating (advisory only until thresholds calibrated).

## Repository placement

`dry4ts` lives in `packages/dry4ts` as an internal workspace package, not under `src/lib`. That keeps the tool split-ready:

- Add `packages/*` to `pnpm-workspace.yaml`.
- Add `packages/dry4ts/package.json` with package name `dry4ts`, bin `dry4ts`, and scripts scoped to the package.
- Keep all implementation, fixtures, and tests under `packages/dry4ts`.
- Do not import from conduit's `src/lib/*`. Conduit examples belong in copied fixtures under `packages/dry4ts/test/fixtures/conduit-slice`.
- Root scripts may delegate with `pnpm --filter dry4ts <script>`, but the package should run independently after subtree extraction.
- The conduit profile scans the host repo as input data; it must not depend on private conduit module interfaces.

Package scripts:

```json
{
  "scripts": {
    "check": "tsgo --noEmit",
    "test": "vitest run",
    "test:pbt": "vitest run test/property",
    "lint": "biome check ."
  }
}
```

Package dependencies live in `packages/dry4ts/package.json`. Prefer workspace versions for dependencies conduit already uses (`typescript`, `vitest`, `biome`, `tsgo`) and declare them in the package so the subtree remains split-ready. v1 uses the TypeScript compiler AST, not `@typescript-eslint/parser`. Dependency and lockfile edits are a serial ownership point: the package setup bead owns the initial dependency set, and later dependency changes require a named dependency bead that blocks the feature bead needing it. Do not add `jscpd` as a package dependency in v1; run external overlap checks manually during pilot review only if they are useful.

## Beads execution model

Beads is the durable source of truth for implementing this plan. Do not create markdown TODO lists for implementation state.

Before starting implementation:

```bash
bd prime
bd create --title="Build dry4ts clone detector" --type=epic --priority=1 --spec-id="docs/plans/2026-05-27-dry4ts-design.md" --description="Implement the split-ready dry4ts package using the design doc as the specification."
```

Then create parent beads for major work areas and child beads/checkpoint beads for actual work. A parent bead is metadata only: it is never claimed, never used as a blocker, and never appears in `bd dep add`. Each child bead must include:

- **Behavior:** one observable behavior, written in user/caller terms.
- **Files:** likely create/modify/test paths under `packages/dry4ts`; these are guide rails, not permission to pre-create unused internals.
- **Owner:** whether the bead owns those paths exclusively or must be run serially after another bead.
- **Red command:** one narrow `-t "<acceptance id>"` command and expected failure.
- **Green scope:** the minimal implementation allowed for that bead.
- **Refactor allowance:** what cleanup is allowed after green.
- **Verification:** the narrow command required before closing.

Use dependencies instead of prose ordering. Dependency commands must live in the Beads graph, not only in the plan:

```bash
bd create --title="dry4ts: package setup" --type=task --parent=<epic-id> --priority=1 --spec-id="docs/plans/2026-05-27-dry4ts-design.md"
bd create --title="dry4ts: empty scan emits stable JSON" --type=task --parent=<cli-parent-id> --priority=1 --spec-id="docs/plans/2026-05-27-dry4ts-design.md"
bd create --title="dry4ts: T1 reports byte-identical TS functions" --type=task --parent=<structural-parent-id> --priority=1 --spec-id="docs/plans/2026-05-27-dry4ts-design.md"
bd dep add <cli-json-01-bead> <package-setup-bead>
bd dep add <t1-byte-identical-bead> <cli-json-01-bead>
bd update <bead-id> --claim
```

Initial parent beads:

1. Package setup and CLI contract.
2. Structural TS detection.
3. Conduit pilot and threshold calibration.

Do not create post-v1 Svelte or semantic parent beads during initial implementation. The pilot checkpoint creates concrete follow-up beads only when pilot evidence justifies the added Implementation.

### Normative gates

Create child beads in stages, not as one large backlog. At the start, create only the serial path through `structural-interface-checkpoint`. After `T-OM-01` creates the first real extractor extension path and the checkpoint freezes the Interfaces, extension call sites, and private file ownership, create the Wave 2 parallel extraction beads. After `structural-checkpoint`, create the conduit pilot beads. This keeps stale speculative beads out of Beads and lets each checkpoint turn new knowledge into exact work packets.

Authoritative dependency graph by stage:

```bash
# Replace each placeholder with the actual child/checkpoint bead id after creation.
# Stage A: initial serial path through the structural Interface checkpoint.
bd dep add <cli-json-01-id> <package-setup-id>
bd dep add <profile-conduit-01-id> <cli-json-01-id>
bd dep add <t1-01-id> <cli-json-01-id>
bd dep add <t1-02-id> <t1-01-id>
bd dep add <t1-03-id> <t1-02-id>
bd dep add <t2-01-id> <t1-03-id>
bd dep add <t2-02-id> <t2-01-id>
bd dep add <t2-03a-id> <t2-02-id>
bd dep add <t2-03b-id> <t2-03a-id>
bd dep add <t2-04-id> <t2-03b-id>
bd dep add <t3-ts-01-id> <t2-04-id>
bd dep add <t3-idx-01-id> <t3-ts-01-id>
bd dep add <t-om-01-id> <t3-idx-01-id>
bd dep add <structural-interface-checkpoint-id> <t-om-01-id>

# Stage B: create only after the structural Interface checkpoint closes.
# T3-TS-02 is serial because it may need StructuralCloneDetector changes.
bd dep add <t3-ts-02-id> <structural-interface-checkpoint-id>
bd dep add <t-class-01-id> <t3-ts-02-id>
bd dep add <t-varfn-01-id> <t3-ts-02-id>
bd dep add <t-cb-01-id> <t3-ts-02-id>
bd dep add <t-cb-02-id> <t-cb-01-id>
bd dep add <t-cb-03-id> <t-cb-02-id>
bd dep add <t-cb-04-id> <t-cb-03-id>
bd dep add <structural-checkpoint-id> <t3-ts-02-id>
bd dep add <structural-checkpoint-id> <t-class-01-id>
bd dep add <structural-checkpoint-id> <t-varfn-01-id>
bd dep add <structural-checkpoint-id> <t-cb-04-id>

# Stage C: create only after the structural checkpoint closes.
bd dep add <conduit-snapshot-id> <structural-checkpoint-id>
bd dep add <performance-profile-id> <structural-checkpoint-id>
bd dep add <pilot-checkpoint-id> <conduit-snapshot-id>
bd dep add <pilot-checkpoint-id> <performance-profile-id>
```

Child beads inside a parent should depend only on the immediately required prior behavior. Do not create one dependency chain just because the plan is written top-to-bottom, and do not create a later-stage child bead before its checkpoint has closed. Parallel-ready examples:

- After `CLI-JSON-01`, the conduit profile/effective-profile bead may run in parallel with the first T1 structural bead only if their allowed files are disjoint and the T1 packet explicitly owns any needed `Dry4tsRunner` wiring.
- After `structural-interface-checkpoint`, run `T3-TS-02` serially. Then extraction shape beads may run in parallel only if `T-OM-01` created a real extractor extension path, the checkpoint has frozen exact private file ownership and extension call sites, and each packet forbids shared orchestrator files.
- After the structural checkpoint, conduit snapshot and performance-profile prep may run in parallel.
- Post-v1 Svelte and semantic skipped-evidence work may run in parallel with later analysis only after the pilot checkpoint creates explicit follow-up beads.

Parallel waves:

| Wave | Ready after | Parallel-ready child beads | Serial exclusions |
|---|---|---|---|
| 0 | none | Package setup only | Workspace and lockfile owner; no parallel package edits. |
| 1 | `CLI-JSON-01` | `PROFILE-CONDUIT-01` and `T1-01` if file scopes are disjoint | `ReportWriter` JSON contract is owned by `CLI-JSON-01`; `T1-01` must own any `Dry4tsRunner` wiring it needs unless `CLI-JSON-01` already froze that call site. |
| 2 | `T3-TS-02` after `structural-interface-checkpoint` | `T-CLASS-01`, `T-VARFN-01`, `T-CB-01` | Only if `T-OM-01` created the first real extractor extension path and the checkpoint froze exact extension call sites and private file ownership: `src/extract/ts-class-method-units.ts`, `src/extract/ts-variable-function-units.ts`, and `src/extract/ts-callback-eligibility.ts`. Otherwise these beads are serial. |
| 3 | Structural checkpoint | Deterministic conduit snapshot and performance profile | Pilot checkpoint waits for both. |

Subagent launch checklist:

1. **Wave 0 - serial bootstrap.** Do not launch implementation subagents. The orchestrator or integration owner creates the package setup bead, claims it, edits workspace/package files, verifies, and closes it.
2. **Wave 1 - first parallel chance.** After `CLI-JSON-01` is green and closed, run `bd ready` and launch up to two subagents: one for `PROFILE-CONDUIT-01`, one for `T1-01`. Launch both only when their packet file scopes are disjoint. If either packet needs `src/report/report-writer.ts` or changes the JSON contract, run that bead serially. If `T1-01` needs `src/core/runner.ts`, list it as T1-owned and forbid it for the profile bead.
3. **Stage A serial structural path.** After Wave 1, keep `T1-02` through `structural-interface-checkpoint` serial. These beads shape the core extractor and detector Interfaces; parallel work here creates merge churn faster than it creates value.
4. **Wave 2 - extraction-shape fanout.** After `structural-interface-checkpoint` is closed, run `T3-TS-02` serially. Then launch parallel subagents only for ready beads with exact private file ownership and frozen extension call sites. Preferred fanout is `T-CLASS-01`, `T-VARFN-01`, and `T-CB-01`.
5. **Callback continuation.** `T-CB-02`, `T-CB-03`, and `T-CB-04` stay serial behind `T-CB-01` because they own the same callback eligibility file and acceptance file.
6. **Wave 3 - pilot fanout.** After `structural-checkpoint` closes, launch two subagents: one for deterministic conduit snapshot, one for performance profile. The pilot checkpoint remains serial and integrates both reports before creating follow-up beads.
7. **Post-v1 fanout.** Do not launch Svelte or semantic subagents until the pilot checkpoint creates concrete follow-up beads with examples, allowed files, and dependency edges.

Reusable launch prompt:

```text
You are one of several parallel subagents implementing dry4ts. You are not alone in the codebase; do not stash, revert, or rewrite unrelated work. Work only in the assigned worktree and only on the allowed files below.

Task: implement exactly one Beads child issue using red-green-refactor.
Bead: <id> <title>
Dependencies: confirm these are closed before editing: <dependency ids>
Base branch and commit: <branch>@<sha>
Worktree: .worktrees/dry4ts-<bead-id>
Branch: ds/dry4ts-<bead-id>-<short-slug>
Allowed files: <exact paths>
Forbidden files: <exact shared paths>

TDD loop:
1. Run the Red command and capture the expected failure.
2. Implement the minimum Green scope.
3. Refactor only while green and only inside allowed files.
4. Run the Verification command.

Red command: <single -t command>
Expected failure: <observable failure>
Green scope: <minimal behavior only>
Verification: <full bead command>

Before stopping:
- Add a Beads note with files changed, red failure observed, verification output, unresolved risks, and follow-up beads created.
- If the packet names an optional bulky log artifact, write it to the shared absolute artifact root and include the path in the Beads note.
- Commit the branch and report the commit SHA.
- Do not close the bead; the integration owner closes it after merge verification.

Stop and report immediately if dependencies are not closed, the base branch is stale, an allowed-file list is wrong, package metadata must change, or the implementation needs a forbidden/shared file.
```

Wave-specific prompt additions:

```text
Wave 1 PROFILE-CONDUIT-01: preserve the existing JSON output contract; do not edit ReportWriter unless the packet explicitly owns it.
Wave 1 T1-01: create the first structural path only; do not add T2/T3 behavior before its bead.
Wave 2 extraction shape: add one new comparison-unit shape through the frozen extractor extension point and already-green detector path; do not edit shared orchestrator files.
Wave 2 negative/similarity: run T3-TS-02 serially before launching extraction-shape subagents.
Wave 3 pilot: record evidence only; do not tune thresholds, add MinHash, add Svelte, or add semantic-clone implementation in the pilot bead.
```

Serial ownership points:

- `pnpm-workspace.yaml`, `packages/dry4ts/package.json`, and lockfile changes are owned by package/dependency beads.
- `src/core/runner.ts`, `src/extract/comparison-unit-extractor.ts`, and `src/structural/structural-clone-detector.ts` are shared orchestrator files. They are serial unless a checkpoint bead explicitly freezes their Interface for parallel work.
- `T-OM-01` owns the first real extractor extension path. `src/extract/ts-class-method-units.ts`, `src/extract/ts-variable-function-units.ts`, and `src/extract/ts-callback-eligibility.ts` are private Implementation files that exist only to make Wave 2 parallel-safe. Do not create them before the checkpoint unless the green implementation already needs that Locality. The checkpoint must verify, not create, the shared extractor dispatch call sites that invoke these files; private files without frozen call sites are not enough for parallel work.
- Shared acceptance files should be split by behavior where possible. If two beads must edit the same acceptance file, make the later bead depend on the earlier one.
- Parent beads, checkpoint beads, dependency beads, and integration beads are not parallel implementation work.

### Parallel subagent protocol

Use parallel subagents for child beads when their dependencies are green and their write scopes are disjoint. Do not use parallel subagents for broad parent beads, dependency/lockfile changes, or integration checkpoints.

Each implementation subagent gets one packet:

```text
Bead: <id> <title>
Dependencies confirmed: <bd show output summary>
Base branch and commit: <branch>@<sha>
Worktree: .worktrees/dry4ts-<bead-id>
Branch: ds/dry4ts-<bead-id>-<short-slug>
Allowed files: <exact expected paths>
Forbidden files: <shared files not owned by this bead>
Red command: <single -t command>
Expected failure: <observable failure>
Green scope: <minimal behavior only>
Verification: <full bead command>
Durable handoff: bd update <bead-id> --notes "<files changed; red failure; verification output; commit SHA; risks; follow-ups>"
Optional artifact root: /Users/dstern/.cache/conduit/dry4ts-handoffs/<run-id>/<bead-id>/ for bulky logs only; include paths in Beads notes.
Manifest entry: integration-owned only; subagents must not edit /Users/dstern/.cache/conduit/dry4ts-handoffs/<run-id>/handoff.manifest.json
Commit SHA: <subagent branch sha after green>
Stop and report if: dependency is not green, base branch is stale, an allowed-file list is wrong, package metadata must change, or implementation needs a shared file owned by another open bead.
```

Subagents must work in their assigned worktree, never in the shared main checkout. They must not stash or revert unrelated work. Before handoff they append durable Beads notes with files changed, red failure observed, green verification output, commit SHA, unresolved risks, and follow-up beads created. If logs are too large for notes, they may write optional artifacts under the shared absolute artifact root outside the worktrees and link those paths from the Beads note. Do not rely on ignored `test-results` files to arrive through a git merge. Subagents may create discovered follow-up beads, but they do not close their implementation bead; the integration owner closes it after merge and verification.

An integration agent or human owner merges one green bead branch at a time. For each merge: confirm `bd show <id>` dependencies are closed, merge/rebase the branch onto the integration base, run the bead verification command, read the durable Beads note, update `/Users/dstern/.cache/conduit/dry4ts-handoffs/<run-id>/handoff.manifest.json` if a local run manifest is being kept, close the bead, then run the next checkpoint command when all checkpoint dependencies are merged. If a merge needs files outside the subagent packet, stop and create a follow-up bead instead of expanding the merge in place.

Integration checkpoints:

1. After package setup and CLI contract: verify workspace commands, dependency ownership, empty JSON output, and effective-profile reporting.
2. After structural TS: verify T1/T2/T3 acceptance, additional TS unit shapes, callback eligibility, and file-order determinism.
3. Before pilot close: run conduit-slice regression and performance measurement, then create follow-up beads for Svelte, semantic skipped evidence, threshold, external-tool overlap, or architecture changes.

Implementation agents should claim exactly one child bead, make the smallest maintainable change, run that bead's verification command, append durable Beads handoff notes, and create follow-up beads for discovered work. Integration owners close implementation beads after merged verification.

## Architecture

### One structural pipeline

```
Input files
   ↓
RunProfileResolver (defaults, built-in profiles, effective config)
   ↓
Dry4tsRunner (orchestrates one deterministic scan)
   ↓
ComparisonUnitExtractor (scan, ignore, parse TS/TSX, source spans, NormalNode)
   ↓
StructuralCloneDetector
   ├── Raw-text hash                         (T1 buckets)
   ├── NormalNode hash                       (T2 buckets)
   ├── Structural-signature candidate index  (T3 limiter)
   └── Subtree fingerprints + Jaccard        (T3 candidates)
   ↓
ReportWriter (stable JSON)
```

The v1 pipeline lowers TS/TSX comparison units to a shared structural IR. `NormalNode` is private package Implementation shared by `ComparisonUnitExtractor` and `StructuralCloneDetector`; CLI callers and external package users must never construct it or depend on its raw shape.

```ts
type NormalKind =
  | "function"
  | "block"
  | "statement"
  | "if"
  | "loop"
  | "switch"
  | "try"
  | "call"
  | "member"
  | "binary"
  | "literal"
  | "binding"
  | "type"
  | "unknown";

type NormalRole =
  | "body"
  | "condition"
  | "then"
  | "else"
  | "case"
  | "callee"
  | "argument"
  | "object"
  | "property"
  | "left"
  | "right";

type NormalAttrs = {
  operator?: "arithmetic" | "comparison" | "logical" | "assignment" | "unary" | "unknown";
  declaration?: "function" | "method" | "arrow" | "functionExpression" | "const" | "let" | "var";
  flags?: readonly ("async" | "generator" | "optional" | "computed" | "spread" | "rest")[];
  propertyPolicy?: "preserved" | "erased";
  propertyKey?: string; // only when propertyPolicy is "preserved"
  literalKind?: "string" | "number" | "bigint" | "boolean" | "null" | "regex";
  typeShape?: "none" | "primitive" | "array" | "object" | "function" | "generic" | "union" | "unknown";
};

type NormalNode = Readonly<{
  kind: NormalKind;
  role?: NormalRole;
  attrs?: NormalAttrs;
  children: readonly NormalNode[];
}>;

type ComparisonUnit = Readonly<{
  rawText: string;
  shape: NormalNode;
  kind: "function" | "method" | "objectMethod" | "variableFunction" | "callback";
  span: { file: string; start: number; end: number };
}>;
```

Do not add arbitrary `attrs` keys. Adding a new normalized shape means extending the constrained type, adding the behavior that forced it, and updating deterministic hash-input fixtures. Exact source identifiers and literal values must not enter `NormalNode` when the active normalization policy erases them; preserved property names must be represented only through the explicit property policy path.

TS and TSX lower into `NormalNode` inside `ComparisonUnitExtractor`. Future Svelte work should begin as private `ComparisonUnitExtractor` Implementation that lowers `.svelte` source into the same private IR. Introduce a real Adapter Seam only if both TS and Svelte lowering need separately swappable Adapters or another caller appears.

### Deep modules and seams

Keep the implementation deep around a few stable interfaces:

- **ComparisonUnitExtractor**: turns target paths into comparison units with source spans and private normalized shapes. It owns file scanning, ignore handling, parser selection, TS/TSX AST traversal, callback eligibility, minimum-size filtering, and source-span mapping. TS traversal is private Implementation in v1. Future Svelte lowering should remain private Implementation until there is a real two-Adapter Seam.
- **StructuralCloneDetector**: owns raw hashes, AST hashes, subtree fingerprints, weighted Jaccard, and most-specific classification. Callers should not coordinate those modules themselves.
- **RunProfileResolver**: owns default config, built-in profile loading, CLI override precedence, validation, and effective-config reporting. Other modules receive a resolved run profile; they do not merge flags and profiles themselves.
- **Dry4tsRunner**: owns the deterministic orchestration of one run: resolve inputs, call extractor, call detector, attach stats, and hand the result model to the writer. The CLI should be a thin Adapter over this Module.
- **ReportWriter**: owns stable JSON output, sorting, ids, and source-span formatting.

The interface is the test surface. Unit tests may exercise inner pure functions where useful, but acceptance and regression tests should cross these deep module interfaces.

Module index:

| Module | Interface | Implementation owns | Adapter(s) | Does not own | First behavior test |
|---|---|---|---|---|---|
| `Dry4tsRunner` | Target paths + raw command/profile request in, stable result model out. | Orchestration, deterministic stage ordering, deterministic run counts, error shape, and the programmatic public test surface. | CLI Adapter first. | Parsing, normalization, clone detection rules, JSON rendering, wall-clock performance reporting. | `CLI-JSON-01` through the CLI, then most acceptance tests may use this Interface directly for speed. |
| `ComparisonUnitExtractor` | Target paths + resolved run profile in, comparison units with raw text, opaque normalized shape, unit kind, and source spans out. | File scanning, gitignore/profile ignores, parser selection, TS/TSX traversal, TS AST lowering to private `NormalNode`, callback eligibility, size filtering, source-span mapping. | None in v1; TS traversal is private Implementation. Future Svelte lowering stays private until two real Adapters are justified. | Hashing, similarity, clone classification, output formatting. | `T1-01` through `Dry4tsRunner`; direct Interface tests only after an extraction invariant is hard to diagnose through runner output. |
| `StructuralCloneDetector` | Comparison units in, T1 clusters, T2 pairs, and T3 pair candidates out. | Raw hashes, normalized-node hashes, subtree fingerprints, weighted Jaccard, most-specific classification, candidate counts, cheap candidate limiting. | None in v1; candidate index remains private Implementation until pilot data proves a real Adapter is needed. | Parsing, NormalNode lowering, post-v1 semantic detection, report writing. | `T1-01`, then `T2-01`, then `T3-TS-01` through the same Interface. |
| `RunProfileResolver` | CLI args + built-in profile name in, resolved run profile out. | Defaults, built-in `default` and `conduit` profile config, profile merge order, validation, effective-config reporting. | None in v1; built-in profiles are config, not Adapters. | Clone detection behavior. | `PROFILE-CONDUIT-01` reports deterministic effective profile. |
| `ReportWriter` | Clone result model in, stable JSON bytes out. | Sorting, ids, source-span formatting, similarity rendering, and deterministic stats rendering. | JSON writer only in v1. | Detection, validation, and wall-clock performance reporting. | Empty scan emits stable JSON; T1 result preserves sorted member order. |

Future extension areas:

| Area | First allowed after | First behavior | Notes |
|---|---|---|---|
| Svelte structural lowering | Pilot shows frontend duplication is material. | One `.svelte` source fixture lowers through `ComparisonUnitExtractor` and reports a structural clone via the existing detector. | Private extractor Implementation first; create an Adapter Seam only if TS and Svelte both need swappable Adapters. CSS/style clones are separate follow-up work. |
| Semantic skipped evidence | Pilot finds valuable structural false negatives that look semantically duplicated. | Candidate emits advisory skipped evidence and no validated clone. | Do not name semantic Modules, worker runners, trace analyzers, or test-corpus Interfaces until concrete examples force Locality. |

### Module layout

This is a target map, not a file-creation checklist. Create a file only when the current red behavior or a green refactor needs that locality.

```
packages/dry4ts/
  package.json
  tsconfig.json
  vitest.config.ts
  src/bin/dry4ts.ts
  src/core/
    runner.ts
    run-profile.ts
    types.ts
  src/extract/
    comparison-unit-extractor.ts
    ts-source.ts
  src/report/
    report-writer.ts
  src/structural/
    structural-clone-detector.ts T1/T2/T3 orchestration and most-specific classification
  test/
    unit/
      structural-clone-detector.test.ts
      comparison-unit-extractor.test.ts
      report-writer.test.ts
    property/
      file-order-determinism.test.ts
	    acceptance/
	      cli-json-contract.test.ts
	      profile.test.ts
	      type1.test.ts
	      type2.test.ts
	      type3-ts.test.ts
	      type3-negative.test.ts
	      extract-object-methods.test.ts
	      extract-class-methods.test.ts
	      extract-variable-functions.test.ts
	      callback-eligibility.test.ts
	      performance.test.ts
    regression/
      conduit-fixture.test.ts
    fixtures/
      ts/
      conduit-slice/
```

Private Implementation may later split under `src/extract/`, `src/normalize/`, or `src/structural/` when a green refactor needs Locality. Do not create helper files such as raw-text normalizers, fingerprint bags, similarity calculators, or candidate indexes just because the plan names the concept. Those helpers are not public Modules, not Adapters, and not a separate Seam unless another caller appears.

## Structural detection (T1 / T2 / T3)

T1, T2, and T3 share one extraction and normalization pipeline. The three types are points on a normalization-strength spectrum: same comparison units, same TypeScript compiler AST, same structural IR. The detector classifies each detected pair as the *most specific* type that matches.

### Comparison units

**TS / TSX v1:**
- function declarations (`T1-01` through `T3-IDX-01`)
- object methods (`T-OM-01`, serial, creates the first extractor extension path)
- class methods (`T-CLASS-01`, Wave 2 only after the extension path is frozen)
- arrow / function expressions assigned to variables (`T-VARFN-01`, Wave 2 only after the extension path is frozen)
- inline callback functions that meet the **callback eligibility rule** (`T-CB-01` through `T-CB-04`)

**Callback eligibility rule.** An inline callback (e.g., the lambda passed to `.map(...)`, `.filter(...)`, `pipe(...)`) enters comparison if **any** of:

1. Has `>= N` normalized nodes (profile config `callbackMinNodes`, default 24).
2. Contains any control-flow construct (`if`, `switch`, `try`/`catch`, loops).
3. Body has `≥ 2` statements.

Trivial callbacks (`x => x.foo`, `(a, b) => a - b`, `u => u.active`) fail all three and are excluded. Large single-expression projections like `user => ({ id, name, email, phone })` pass rule 1 and are kept. Small but structurally interesting callbacks like `x => { if (x > 0) return x; return -x; }` pass rule 2.

All units respect profile `minLines` and `minNodes` thresholds; small units don't enter T1/T2/T3 detection regardless of type.

### Raw-text normalization (T1 input)

For each unit:
- Strip line and block comments.
- Collapse runs of whitespace to a single space, preserving string-literal contents.
- Normalize line endings (`\r\n` → `\n`).
- Trim leading/trailing whitespace.

Hash result with sha256. Two units with the same raw hash are **T1 candidates**.

### TypeScript AST normalization (T2 / T3 input)

`ComparisonUnitExtractor` parses with the TypeScript compiler API and lowers each comparison unit to `NormalNode` with these rules.

**Normalize away (replace with tag, drop value):**
- identifiers
- local declaration names
- literal values (string / number / bigint / regex)
- import specifier names

**Preserve:**
- control flow shape (if/else, loops, try/catch, switch arms in order)
- operator kind (binary / unary / logical / assignment)
- call / member / indexing / optional-chain shape
- async / generator flag
- declaration kind (let / const / var) where meaningful
- statement order
- object / array / destructuring positional shape
- type structure lightly (no exact names)
- spread / rest
- **property names** (default: preserve; profile config can flip to erasure)

**Why preserve property names by default.** Domain code where property names carry semantics (`u.email` vs `u.phone`, `event.userId` vs `event.orderId`) generates false positives if names are erased. Default to preserve; revisit after the conduit pilot with real data.

Hash the full `NormalNode` tree with sha256. Two units with the same AST hash are **T2 candidates** (assuming they failed T1 — raw text differed).

### Fingerprints and similarity (T3 input)

For each unit's `NormalNode` tree:

1. Walk recursively; emit a stable hash for every subtree.
2. Collect into a multiset (count matters — two identical subtrees count twice).
3. For `T3-TS-01`, compare the small fixture's eligible units directly so the first Type-3 behavior proves the similarity path before any index can prune it.
4. In `T3-IDX-01`, add conservative candidate buckets using unit kind, normalized parameter count, rough return shape, and normalized node-count bucket.
5. Compare units pairwise via weighted Jaccard within the eligible candidate set.
6. Pairs with `J(A, B) >= threshold` (default from profile) are **T3 candidates**.

The candidate index is deliberately cheap and private to `StructuralCloneDetector`. It must be recall-first: if a bucket rule might drop a legitimate inserted-guard near-miss, make the bucket looser and let Jaccard decide. Do not include exact top-level control-flow shape in v1 buckets; inserted guards and logging branches are normal Type-3 gaps. Do not expose MinHash, indexing strategy, or bucket internals in the public Interface unless the pilot proves a second Adapter is needed.

### Detection algorithm

```
for each unit u:
  rawHashTable[rawHash(u)].add(u)
  astHashTable[astHash(u)].add(u)
  fingerprints[u] = subtreeMultiset(normalize(u))
  candidateIndex[looseStructuralSignature(u)].add(u) # added in T3-IDX-01

T1Clusters  = rawHashTable buckets with size > 1
T2Pairs     = pairs inside astHashTable buckets where raw hashes differ
T3Candidates = pairs within eligible candidate sets, J >= threshold,
               excluding pairs whose raw hash or AST hash already makes them T1 or T2
```

T1 is O(N) hash bucketing. T2 starts with O(N) AST hash buckets, then emits explicit pair entries only for members with different raw hashes. T2 exclusion is pair-specific: a unit may appear in both a T1 cluster and a T2 pair when it has a renamed/literal-changed sibling. Do not drop a whole member merely because it was already present in a T1 result. T3 is O(K^2) over the eligible candidate set; before `T3-IDX-01`, the eligible set may be all units for small fixtures. After `T3-IDX-01`, it is limited by loose candidate-index buckets, with bucket sizes recorded in deterministic stats so the pilot can identify whether MinHash or another limiter is worth adding.

### Classification

Each detected pair is classified as the *most specific* type:

| Match | Classification |
|---|---|
| `rawHash(a) == rawHash(b)` | **T1** |
| `astHash(a) == astHash(b)` && raw differs | **T2** |
| `J(a, b) ≥ threshold` && astHash differs | **T3** |
| `J(a, b) < threshold` | dropped |

## Post-v1 extension candidates

The first release should not implement these. The conduit pilot creates follow-up Beads issues only when it finds examples that justify the added Implementation.

### Svelte structural detection

Start with private Svelte lowering inside `ComparisonUnitExtractor`:

- Script blocks reuse the TS traversal Implementation.
- Template blocks lower to the same `NormalNode` IR.
- The first behavior is one Svelte structural clone through the existing `StructuralCloneDetector` Interface.
- CSS/style clones are a separate follow-up, not part of the first Svelte bead.
- Create a named Adapter when TS and Svelte lowering both need a real swappable Adapter Seam.

### Semantic false-negative evidence

Start with skipped evidence only:

- The pilot names concrete structural false negatives that appear semantically duplicated.
- A follow-up bead may emit advisory skipped evidence for those examples.
- Runtime probing, trace extraction, test-corpus mining, and validated semantic clone output stay unnamed and unimplemented until examples prove they need Locality.

Do not pre-design semantic Modules, worker runners, Effect trace analyzers, or literal evaluators in this plan. The pilot creates the next concrete behavior bead first; Module names come after the deletion test proves they earn their Interface.

## Output format

```json
{
  "type1": [
    {
      "id": "t1-001",
      "kind": "ts",
      "members": [
        { "file": "src/foo.ts", "unit": "isEmpty", "span": { "start": 10, "end": 18 } },
        { "file": "src/bar.ts", "unit": "isEmpty", "span": { "start": 45, "end": 52 } }
      ]
    }
  ],
  "type2": [
    {
      "id": "t2-001",
      "kind": "ts",
      "members": [
        { "file": "src/foo.ts", "unit": "validateUser", "span": { "start": 10, "end": 28 } },
        { "file": "src/bar.ts", "unit": "validateOrder", "span": { "start": 45, "end": 62 } }
      ]
    }
  ],
  "type3": [
    {
      "id": "t3-001",
      "kind": "ts",
      "similarity": 0.92,
      "members": [
        { "file": "src/foo.ts", "unit": "isEmpty", "span": { "start": 10, "end": 18 } },
        { "file": "src/bar.ts", "unit": "hasNoText", "span": { "start": 45, "end": 52 } }
      ]
    }
  ],
  "stats": {
    "filesScanned": 951,
    "unitsCompared": 12453,
    "largestCandidateBucket": 112,
    "type1Clusters": 4,
    "type2Pairs": 9,
    "type3Pairs": 23
  }
}
```

Default JSON must be byte-stable for the same input tree and profile. It may contain deterministic counts and bucket sizes, but it must not contain wall-clock duration, peak memory, timestamps, absolute temp paths, or other volatile runtime measurements. Performance measurements belong in the pilot performance artifact and Beads note, not in the default `ReportWriter` output.

In v1, `type2` and `type3` entries are pair candidates with exactly two members. Do not merge overlapping T2/T3 pairs into connected clusters until pilot output proves that extra Implementation is useful. T1 may remain multi-member hash buckets. A Type-2 pair is emitted only when two members share an AST hash and have different raw hashes; exact pairs inside that AST bucket are still classified as Type-1, but either exact member may also appear in a separate Type-2 pair with a renamed/literal-changed sibling.

## CLI

CLI parsing produces a raw command object; `RunProfileResolver` turns that into a resolved run profile. Merge order is defaults -> built-in profile -> explicit CLI overrides. The detector modules receive only the resolved profile and should not re-read CLI flags, environment variables, or profile files.

```
dry4ts [options] [file-or-directory ...]

Output:
  --format json                 (default: json)
  --json                        Alias for --format json
  --effective-profile           Print the resolved profile and exit

Filtering:
  --profile name                Built-in profile (default | conduit)
  --include extensions          ts,tsx (default: ts,tsx)
  --respect-gitignore           Honor .gitignore (default: on)
  --ignore pattern              Additional ignore pattern (repeatable)
```

Structural thresholds, property-name policy, callback thresholds, and candidate-index sizing live in profiles for v1. Add CLI overrides only after pilot users need them; every new flag expands the Interface callers must learn.

## Conduit profile

```json
{
  "include": ["src/**/*.ts", "src/**/*.tsx"],
  "ignore": [
    "dist", ".worktrees", ".beads", "node_modules", ".svelte-kit", "coverage",
    "packages/dry4ts/dist", "packages/dry4ts/test/fixtures",
    "**/*.d.ts", "**/generated/**"
  ],
  "structural": {
    "minLines": 6,
    "minNodes": 24,
    "callbackMinNodes": 24,
    "erasePropertyNames": false,
    "threshold": 0.84,
    "candidateMaxBucketSize": 250
  },
  "type1": { "enabled": true },
  "type2": { "enabled": true },
  "type3": { "enabled": true }
}
```

The v1 `conduit` profile is production-first. Test fixtures and repeated example setup can be useful later, but they are noisy for the first architecture signal. If pilot review wants test duplication, create a separate `conduit-tests` profile and bead after the production pilot.

## Testing strategy

### Why a layered approach

End-to-end acceptance tests catch caller-visible regressions but cannot localize every normalizer or similarity bug. Since most dry4ts Modules are pure, add focused unit/property tests only after the public behavior is green and the local invariant is worth protecting.

Layered does not mean horizontal. Do not write all tests for a broad slice before implementation. Each Beads issue uses a vertical red-green-refactor loop:

1. Write one failing behavior test through the deepest useful interface.
2. Run the narrow command and confirm the expected failure.
3. Implement only enough code to pass.
4. Run the narrow command again.
5. Refactor while green.
6. Run that bead's verification command and close or update the bead.

### Test layers

| Layer | Purpose |
|---|---|
| **Unit** | Local invariants discovered while making a public behavior green |
| **Property** | File-order determinism at the structural checkpoint; additional properties only after a concrete behavior or bug proves the invariant is worth protecting |
| **Acceptance** | End-to-end smoke for one caller-visible behavior at a time |
| **Regression** | Snapshot vs conduit slice and non-blocking pilot comparisons |

### Local invariant tests

Do not prewrite a unit-test suite from an imagined internal design. A child bead starts with one failing public-interface behavior test. After that test is green, add a local unit test only when the implementation revealed an invariant that would be hard to diagnose through runner output.

Good local invariant tests protect concrete behavior already forced by a green acceptance path: hash-input determinism after `T1-02`, pair-specific T2 overlap after `T2-04`, Jaccard threshold math after `T3-TS-01`, or stable JSON sorting after `CLI-JSON-01`. They are not separate closure criteria, and they must not force helper files or private Modules to exist before the red behavior needs them.

### Property tests

The only v1 property bead is file-order determinism:

- `prop-Pipeline-FileOrderIrrelevant` — permuting input file order produces identical JSON output bytes.

Use fast-check with a fixed seed for that property. Do not pre-create a broader property suite. Create later property beads only after a green behavior or real bug exposes an invariant that an acceptance test cannot localize cheaply.

### Acceptance tests

End-to-end smoke for each v1 behavior.

#### CLI and profile
- `CLI-JSON-01` — Empty fixture directory emits stable JSON.
- `PROFILE-CONDUIT-01` — `--profile conduit --effective-profile` emits deterministic resolved config and includes production TS/TSX only.

#### Type-1
- `T1-01` — Two byte-identical functions in different files reported as T1.
- `T1-02` — Whitespace/comment-only differences still report as T1.
- `T1-03` — Identical code in different positions of the same file reported as T1.

#### Type-2
- `T2-01` — Identical structure with renamed locals reported as T2 (not T1).
- `T2-02` — Identical structure with different literal values reported as T2.
- `T2-03A` — Identical structure with different property names is NOT reported as T2 under default config because property names are preserved.
- `T2-03B` — The same pair reports as T2 when a profile fixture enables `erasePropertyNames`.
- `T2-04` — An AST bucket with an exact T1 pair plus a renamed/literal-changed sibling still reports explicit T2 pairs for the renamed/literal-changed relations; exact pairs are not duplicated as T2 pairs.

#### Type-3 TS
- `T3-TS-01` — Function with the same broad structure plus one inserted early guard clause reports as a T3 pair, not T1/T2.
- `T3-IDX-01` — Candidate-index stats are present and pairwise work is limited to loose structural-signature buckets without dropping the inserted-guard T3 pair.
- `T3-TS-02` — Function with rewritten control flow does NOT match original at J ≥ threshold.

#### Additional TS unit shapes
- `T-OM-01` — Object method clone detected through the first extractor extension path.
- `T-CLASS-01` — Class method clone detected through the frozen extractor extension path.
- `T-VARFN-01` — Arrow/function expression assigned to a variable detected through the frozen extractor extension path.

#### Callback granularity
- `T-CB-01` — Trivial callbacks (`x => x.foo`, `(a,b) => a-b`, `u => u.active`) excluded from comparison (no clone results formed).
- `T-CB-02` — Large single-expression projection (`user => ({ id, name, email, phone, ... })`, ≥ 24 nodes) included in comparison.
- `T-CB-03` — Small callback with control flow (`x => { if (x>0) return x; return -x; }`) included even when below profile `callbackMinNodes`.
- `T-CB-04` — Callback with `>= 2` statements included even when below profile `callbackMinNodes`.

#### Performance & determinism
- `PERF-01` — Conduit pilot records runtime, peak memory, largest buckets, and slowest comparison stages in a performance artifact or Beads note, not in default JSON. It does not judge false positives or create performance follow-up beads. No runtime or memory gate is introduced until the pilot data is reviewed.

### Regression tests

- **Conduit-slice snapshot** — dry4ts output on the copied conduit fixture slice matches a stored JSON snapshot. Updates require explicit `--update` and PR review.
- **External overlap note** — If the pilot owner runs `jscpd` or another existing clone detector outside the package, record any useful overlap/miss examples in the pilot report. This is non-blocking and must not add a v1 package dependency.

### Test infrastructure

- **Runner:** Vitest.
- **Properties:** fast-check only for the file-order determinism bead in v1 (`seed: 0xDEADBEEF`, `numRuns: 100` unless the bead says otherwise).
- **Fixtures:** hand-crafted minimal `.ts` / `.tsx` files under `packages/dry4ts/test/fixtures/<scenario>/`. No parser mocking — fixtures are real source files.
- **No network, no time:** tests run offline and deterministically.
- **Behavior target:** every closed Beads issue has a red/green behavior test or a documented reason it is docs-only.

### Sufficiency analysis

| Failure mode | Acceptance only | Layered |
|---|---|---|
| Normalizer drops wrong AST node | Sometimes, if it surfaces in a fixture | Add a local test only after a green behavior exposes the invariant |
| Hash input instability | No | Add a deterministic hash-input fixture test after the relevant behavior exists |
| Wrong Jaccard weighting | Maybe, if it crosses threshold | Add a similarity unit test after the T3 behavior is green |
| Refactoring breaks T2/T3 detection | No | Add a property bead only after a concrete regression or invariant appears |
| File ordering changes output | No | Yes (file-order-irrelevant property) |
| T1 reported as T2 (or vice versa) | Maybe | Add a focused classification unit test after the behavior exists |

Do not attach numeric confidence or coverage targets. Use acceptance behavior, mutation-worthy invariants, determinism, and pilot evidence as closure signals.

### Bead testing contract

Each implementation child bead ships one vertical behavior slice. Parent beads group related child beads and should never be claimed for implementation. Expected file lists are guide rails, not a command to pre-create modules. If the current red test does not force a file to exist, do not add that file yet.

Child bead closure rules:

- One failing behavior test first, through the CLI JSON contract or one named deep Module Interface.
- One `Red` command with `-t "<single acceptance id>"` for behavior beads. Infrastructure-only setup/dependency beads must say why no behavior red applies.
- Minimal implementation to pass that one behavior.
- Unit tests only after green, when they protect an invariant discovered by the implementation. Property tests are limited to file-order determinism unless a later bead records a concrete invariant.
- Full bead verification after green and refactor.
- Close only after writing durable Beads handoff notes and updating/creating any follow-up Beads issues.

## Example bead templates

The beads below are templates, not a backlog. The normative gates above decide when a real Beads issue is created. Create parent beads for headings, then create child beads stage-by-stage: initial serial path first, Wave 2 extraction beads only after `structural-interface-checkpoint` and `T3-TS-02`, and pilot beads after `structural-checkpoint`. Use `bd dep add` for every dependency in the authoritative graph above. Do not pre-create later-stage children just because their row is documented here.

### Parent - Package setup and CLI contract

| Child bead | Depends on | Owner / files | Red | Expected failure | Green | Verification |
|---|---|---|---|---|---|---|
| Package setup | none | Serial owner of `pnpm-workspace.yaml`, `packages/dry4ts/package.json`, package config, initial lockfile. | No behavior red; setup bead is infrastructure-only. | `pnpm --filter dry4ts check` cannot resolve the package before setup. | Workspace package exists with split-ready scripts and no implementation beyond CLI stub wiring. | `pnpm --filter dry4ts check` |
| `CLI-JSON-01` empty JSON | Package setup | `src/bin/dry4ts.ts`, `src/core/runner.ts`, `src/core/run-profile.ts`, `src/report/report-writer.ts`, `test/acceptance/cli-json-contract.test.ts`. | `pnpm --filter dry4ts test -- test/acceptance/cli-json-contract.test.ts -t "CLI-JSON-01"` | CLI output missing or not stable JSON. | Empty fixture directory emits stable JSON with empty `type1`, `type2`, `type3`, and stats. | `pnpm --filter dry4ts check && pnpm --filter dry4ts test -- test/acceptance/cli-json-contract.test.ts` |
| `PROFILE-CONDUIT-01` effective profile | `CLI-JSON-01` | `src/core/run-profile.ts`, `test/acceptance/profile.test.ts`. | `pnpm --filter dry4ts test -- test/acceptance/profile.test.ts -t "PROFILE-CONDUIT-01"` | Effective profile is missing, unstable, includes tests by default, or includes non-v1 Svelte/semantic settings. | `--profile conduit --effective-profile` reports deterministic production TS/TSX structural config. | `pnpm --filter dry4ts test -- test/acceptance/profile.test.ts` |

### Parent - Structural TS detection

Serial until `structural-interface-checkpoint` because extraction, normalization, and `StructuralCloneDetector` are still taking shape. After that checkpoint, only beads with disjoint allowed files and explicit forbidden shared files may run in parallel.

| Child bead | Depends on | Owner / files | Red | Expected failure | Green | Verification |
|---|---|---|---|---|---|---|
| `T1-01` byte-identical functions | `CLI-JSON-01` | Owner of first structural path: `src/core/runner.ts` if wiring is not already frozen, `src/extract/comparison-unit-extractor.ts`, `src/extract/ts-source.ts`, `src/structural/structural-clone-detector.ts`, `test/acceptance/type1.test.ts`. | `pnpm --filter dry4ts test -- test/acceptance/type1.test.ts -t "T1-01"` | No T1 cluster for identical functions. | TS function extraction, raw hash bucketing, stable JSON T1 cluster. | `pnpm --filter dry4ts test -- test/acceptance/type1.test.ts` |
| `T1-02` whitespace/comments | `T1-01` | Raw-text normalization inside `ComparisonUnitExtractor` or private Implementation extracted after green. | `pnpm --filter dry4ts test -- test/acceptance/type1.test.ts -t "T1-02"` | Whitespace/comment-only changes miss T1. | Comments stripped, whitespace collapsed, string-literal whitespace preserved. | `pnpm --filter dry4ts test -- test/acceptance/type1.test.ts` |
| `T1-03` same-file positions | `T1-02` | Source-span and unit identity mapping. | `pnpm --filter dry4ts test -- test/acceptance/type1.test.ts -t "T1-03"` | Same-file duplicates collapse into one member or lose spans. | Multiple comparison units from one file keep distinct source spans. | `pnpm --filter dry4ts test -- test/acceptance/type1.test.ts` |
| `T2-01` renamed locals | `T1-03` | TypeScript AST normalization through `ComparisonUnitExtractor` and `StructuralCloneDetector`. | `pnpm --filter dry4ts test -- test/acceptance/type2.test.ts -t "T2-01"` | Renamed locals are missed or reported as T1. | TS AST normalization erases local names and reports T2, not T1. | `pnpm --filter dry4ts test -- test/acceptance/type2.test.ts` |
| `T2-02` literal erasure | `T2-01` | TypeScript AST normalization only. | `pnpm --filter dry4ts test -- test/acceptance/type2.test.ts -t "T2-02"` | Literal changes break T2. | Literal values normalize away without hiding operators or control flow. | `pnpm --filter dry4ts test -- test/acceptance/type2.test.ts` |
| `T2-03A` property names preserved by default | `T2-02` | Profile + TS normalization. | `pnpm --filter dry4ts test -- test/acceptance/type2.test.ts -t "T2-03A"` | Different property names report as T2 under default config. | Property names are preserved by default, so this pair is not a clone. | `pnpm --filter dry4ts test -- test/acceptance/type2.test.ts -t "T2-03A"` |
| `T2-03B` property-name erasure profile | `T2-03A` | Profile + TS normalization. | `pnpm --filter dry4ts test -- test/acceptance/type2.test.ts -t "T2-03B"` | `erasePropertyNames` profile fixture still misses T2. | Property names are erased only when profile config enables it. | `pnpm --filter dry4ts test -- test/acceptance/type2.test.ts` |
| `T2-04` pair-specific overlap | `T2-03B` | `StructuralCloneDetector` classification only. | `pnpm --filter dry4ts test -- test/acceptance/type2.test.ts -t "T2-04"` | A T1 pair in an AST bucket hides a renamed/literal-changed sibling, or exact pairs are duplicated as T2. | Exclusion is pair-specific: exact pairs stay T1, renamed/literal-changed relations emit explicit two-member T2 pairs. | `pnpm --filter dry4ts test -- test/acceptance/type2.test.ts` |
| `T3-TS-01` near-miss structural match | `T2-04` | `StructuralCloneDetector` T3 path: fingerprints, similarity, most-specific T3 pair classification. Candidate limiting is all-units or deliberately loose for this small fixture. | `pnpm --filter dry4ts test -- test/acceptance/type3-ts.test.ts -t "T3-TS-01"` | A true near-miss pair is missed or reported as T1/T2. | One function with the same broad structure plus one inserted early guard clause reports as a T3 pair. | `pnpm --filter dry4ts test -- test/acceptance/type3-ts.test.ts -t "T3-TS-01"` |
| `T3-IDX-01` candidate index and stats | `T3-TS-01` | Private candidate index inside `StructuralCloneDetector`; avoid changing extractor. | `pnpm --filter dry4ts test -- test/acceptance/type3-ts.test.ts -t "T3-IDX-01"` | Pairwise work is unbounded, candidate bucket stats are missing, or the inserted-guard pair is pruned. | T3 comparisons run only inside loose structural-signature buckets, report largest candidate bucket stats, and still find the inserted-guard pair. | `pnpm --filter dry4ts test -- test/acceptance/type3-ts.test.ts` |
| `T-OM-01` object methods through extractor extension | `T3-IDX-01` | Serial owner of the first extractor extension path: `src/extract/comparison-unit-extractor.ts`, optional private `src/extract/ts-object-method-units.ts`, `test/acceptance/extract-object-methods.test.ts`. | `pnpm --filter dry4ts test -- test/acceptance/extract-object-methods.test.ts -t "T-OM-01"` | Object method clones are not extracted/reported. | Object methods enter comparison units through a real extractor extension path and report through the existing detector path. | `pnpm --filter dry4ts test -- test/acceptance/extract-object-methods.test.ts` |
| Structural interface checkpoint | `T-OM-01` | Integration owner only; freezes `Dry4tsRunner`, `ComparisonUnitExtractor`, `StructuralCloneDetector`, and `ReportWriter` Interfaces. It verifies exact shared extractor extension call sites and Wave 2 private file ownership; it must not create new feature files or call sites. | No new red test. | Current T1/T2/T3/object-method behavior fails, public Interface shape is still changing, or Wave 2 has no exact extension call sites and private ownership files. | Core interfaces are documented, the first T1/T2/T3/object-method behaviors pass together, and any parallel Wave 2 file ownership/call-site ownership is exact. | `pnpm --filter dry4ts test -- test/acceptance/type1.test.ts test/acceptance/type2.test.ts test/acceptance/type3-ts.test.ts test/acceptance/extract-object-methods.test.ts` |
| `T3-TS-02` rewritten-control-flow negative | Structural interface checkpoint | Serial owner for this bead; `test/acceptance/type3-negative.test.ts`; may edit `src/structural/structural-clone-detector.ts` if red proves classifier/similarity change is needed. | `pnpm --filter dry4ts test -- test/acceptance/type3-negative.test.ts -t "T3-TS-02"` | Materially different control flow is reported as T3. | Pair stays below threshold or is filtered by loose structural signature. | `pnpm --filter dry4ts test -- test/acceptance/type3-negative.test.ts` |
| `T-CLASS-01` class methods | `T3-TS-02` | `src/extract/ts-class-method-units.ts`, `test/acceptance/extract-class-methods.test.ts`; forbidden: `src/extract/comparison-unit-extractor.ts`, `src/structural/structural-clone-detector.ts`, `src/core/runner.ts`. | `pnpm --filter dry4ts test -- test/acceptance/extract-class-methods.test.ts -t "T-CLASS-01"` | Class method clone is not extracted/reported. | Byte-identical class methods enter comparison units through the frozen extractor extension call site and report through the existing T1 path. | `pnpm --filter dry4ts test -- test/acceptance/extract-class-methods.test.ts` |
| `T-VARFN-01` exported const arrows/functions | `T3-TS-02` | `src/extract/ts-variable-function-units.ts`, `test/acceptance/extract-variable-functions.test.ts`; forbidden: `src/extract/comparison-unit-extractor.ts`, `src/structural/structural-clone-detector.ts`, `src/core/runner.ts`. | `pnpm --filter dry4ts test -- test/acceptance/extract-variable-functions.test.ts -t "T-VARFN-01"` | Variable-assigned function clone is not extracted/reported. | Byte-identical arrow/function expressions assigned to variables enter comparison units through the frozen extractor extension call site and report through the existing T1 path. | `pnpm --filter dry4ts test -- test/acceptance/extract-variable-functions.test.ts` |
| `T-CB-01` trivial callbacks excluded | `T3-TS-02` | `src/extract/ts-callback-eligibility.ts`, `test/acceptance/callback-eligibility.test.ts`; forbidden: `src/extract/comparison-unit-extractor.ts`, `src/structural/structural-clone-detector.ts`, `src/core/runner.ts`. | `pnpm --filter dry4ts test -- test/acceptance/callback-eligibility.test.ts -t "T-CB-01"` | Trivial callbacks create noisy clone results. | Trivial callbacks fail eligibility through the frozen extractor extension call site and do not form results. | `pnpm --filter dry4ts test -- test/acceptance/callback-eligibility.test.ts` |
| `T-CB-02` large projection callbacks included | `T-CB-01` | `src/extract/ts-callback-eligibility.ts`, `test/acceptance/callback-eligibility.test.ts`. | `pnpm --filter dry4ts test -- test/acceptance/callback-eligibility.test.ts -t "T-CB-02"` | Large projection callbacks are excluded. | Large single-expression projections enter comparison. | `pnpm --filter dry4ts test -- test/acceptance/callback-eligibility.test.ts` |
| `T-CB-03` control-flow callbacks included | `T-CB-02` | `src/extract/ts-callback-eligibility.ts`, `test/acceptance/callback-eligibility.test.ts`. | `pnpm --filter dry4ts test -- test/acceptance/callback-eligibility.test.ts -t "T-CB-03"` | Small control-flow callbacks are excluded. | Control-flow callbacks enter comparison despite size. | `pnpm --filter dry4ts test -- test/acceptance/callback-eligibility.test.ts` |
| `T-CB-04` multi-statement callbacks included | `T-CB-03` | `src/extract/ts-callback-eligibility.ts`, `test/acceptance/callback-eligibility.test.ts`. | `pnpm --filter dry4ts test -- test/acceptance/callback-eligibility.test.ts -t "T-CB-04"` | Multi-statement callbacks are excluded. | Callbacks with at least two statements enter comparison. | `pnpm --filter dry4ts test -- test/acceptance/callback-eligibility.test.ts` |
| Structural checkpoint | `T3-TS-02`, `T-CLASS-01`, `T-VARFN-01`, `T-CB-04` | Integration owner only; no feature edits. | No new red test. | Any structural acceptance or determinism check fails after merging child branches. | T1/T2/T3 acceptance, extraction-shape acceptance, callback eligibility, and file-order determinism pass on merged branch. | `pnpm --filter dry4ts test -- test/acceptance/type1.test.ts test/acceptance/type2.test.ts test/acceptance/type3-ts.test.ts test/acceptance/extract-class-methods.test.ts test/acceptance/extract-variable-functions.test.ts test/acceptance/callback-eligibility.test.ts test/property/file-order-determinism.test.ts` |

### Parent - Conduit pilot

Pilot work waits for the structural checkpoint. Keep snapshot and measurement separate so agents can run/review them independently. The pilot report is integration-owned; parallel pilot subagents write Beads notes and optional artifacts, not `docs/pilot-conduit.md`.

| Child bead | Depends on | Owner / files | Red | Expected failure | Green | Verification |
|---|---|---|---|---|---|---|
| Deterministic conduit snapshot | Structural checkpoint | `test/regression/conduit-fixture.test.ts`, `test/fixtures/conduit-slice/**`; forbidden: `docs/pilot-conduit.md`. | `pnpm --filter dry4ts test -- test/regression/conduit-fixture.test.ts -t "conduit-slice snapshot"` | Conduit slice output is missing or unstable. | Copied conduit-slice fixture produces stable sorted JSON; findings go in the Beads note or optional artifact. | `pnpm --filter dry4ts test -- test/regression/conduit-fixture.test.ts` |
| Performance profile | Structural checkpoint | `test/acceptance/performance.test.ts`; forbidden: `docs/pilot-conduit.md` and default JSON schema changes. | `pnpm --filter dry4ts test -- test/acceptance/performance.test.ts -t "PERF-01"` | Runtime, memory, bucket, or slow-stage measurements are missing from the performance artifact. | Records runtime, peak memory, largest buckets, and slowest stages in a Beads note or optional artifact only. | `pnpm --filter dry4ts test -- test/acceptance/performance.test.ts` |
| Pilot checkpoint | Snapshot, performance | Integration owner only; owns `docs/pilot-conduit.md`; no feature edits. | No new red test. | Pilot report lacks a decision about Svelte, semantic skipped evidence, thresholds, external overlap, false positives, candidate limiting, MinHash, or architecture follow-ups. | `docs/pilot-conduit.md` integrates the snapshot/performance evidence and creates explicit follow-up Beads issues. | `pnpm --filter dry4ts test -- test/regression/conduit-fixture.test.ts test/acceptance/performance.test.ts` |

### Pilot-created follow-up examples

These are examples the pilot checkpoint may turn into concrete Beads issues. Do not create them during initial implementation, and do not treat the names as promised Modules.

| Follow-up | Trigger | First behavior | First red command | Scope limit |
|---|---|---|---|---|
| Svelte structural lowering | Pilot misses important frontend duplication. | Two Svelte templates with same structure but different text/classes/variable names report T3 through `StructuralCloneDetector`. | `pnpm --filter dry4ts test -- test/acceptance/type3-svelte.test.ts -t "T3-SV-01"` | Private `ComparisonUnitExtractor` lowering first; no CSS/style clone detection; no Adapter Seam unless a second real Adapter exists. |
| Semantic skipped evidence | Pilot finds structural false negatives that are semantically duplicated. | Candidate emits skipped/advisory evidence and no validated clone. | `pnpm --filter dry4ts test -- test/acceptance/semantic-skipped-evidence.test.ts -t "SEM-SKIP-01"` | No worker execution, trace extraction, test-corpus mining, or validated semantic clone output until later evidence beads force those Modules. |

### Deferred polish

- Performance candidate filters beyond the first measured bottleneck.
- Reporters (text, SARIF, markdown, HTML).
- Baseline file support for incremental checks.
- CI integration patterns.
- Documentation site.
- Optional: MCP server for agent integration.

## Future directions (out of v1)

- **Svelte component semantic experiments** — only after Svelte structural lowering has real pilot examples.
- **Semantic clone experiments** — only after skipped-evidence examples prove a deeper Module would add Locality.
- **MCP server** — expose `find_clones`, `explain_pair`, `validate_pair` as agent tools.
- **Configurable normalization strength** — strict / medium / loose modes.
- **Cross-track ranking** — recommend which clone to prefer based on complexity, test signal, and dependents.

## Pilot revisits

- **Svelte coverage.** Add Svelte template normalization only if TS/TSX pilot output misses important frontend duplication.
- **Semantic need.** Add skipped-evidence semantic follow-ups only if pilot false negatives are valuable enough to justify the added complexity.
- **Callback granularity.** Start with `nodes >= 24 OR control-flow OR >= 2 statements`. Revisit if pilot shows trivial-callback noise or missed-clone gaps.
- **Property-name normalization.** Preserve property names by default. Revisit after pilot to evaluate erasure-on-domain-code false-positive rate.
- **Candidate index.** Keep cheap structural-signature buckets in v1. Add MinHash only if pilot bucket stats show pairwise comparison blowups.
- **Overlapping results across types.** Keep separate results per detected type. Revisit if pilot shows the same function repeatedly appearing in overlapping T2/T3 pairs in confusing ways.
