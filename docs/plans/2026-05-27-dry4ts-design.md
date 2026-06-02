# dry4ts: Structural and Semantic Clone Detection for TypeScript and Svelte

**Date:** 2026-05-27
**Status:** Design (pre-implementation)
**Target package:** `packages/dry4ts` inside conduit, structured so the subtree can move to a standalone repo later.
**Target consumer:** conduit TypeScript / TSX / Svelte source first, with no production dependency on conduit's runtime modules.

## Scope

A deterministic TypeScript/Svelte clone detector covering structural and advisory semantic DRY signals:

- **Type-1** (exact, modulo whitespace and comments)
- **Type-2** (identical structure with renamed identifiers and changed literals)
- **Type-3** (gapped / near-miss structural clones)
- **Svelte structural clones** (script and template structure lowered into the same structural pipeline)
- **Semantic evidence** (advisory evidence for structurally missed but likely duplicated behavior)

T1/T2/T3, Svelte structural detection, and semantic evidence share one extraction, normalization, fingerprinting, classification, and reporting pipeline. The implementation is staged for dependency control: TS/TSX structural detection creates the core pipeline; Svelte lowering extends extraction; semantic evidence extends candidate explanation; the conduit pilot validates the full planned scope. Svelte and semantic work are planned tracks, not pilot-discretion follow-ups.

## Goals

- **Deterministic.** No LLM calls. Reproducible across runs and machines.
- **Cover Type-1 through Type-3** for TS/TSX and Svelte source.
- **Emit semantic evidence without pretending to prove equivalence.**
- **Agent-friendly output.** JSON output, stable ordering, source spans, T3 similarity scores, and deterministic run counts.
- **Single structural IR.** TS/TSX and Svelte script/template input lowers to a uniform structural representation; one set of similarity/clustering rules.
- **Fast first value without deferral.** Implement the smallest TS structural path first, then add Svelte and semantic tracks as concrete staged beads using the same public result model.

## Non-goals

- Proving semantic equivalence (we report candidates with evidence, not proofs).
- Symbolic execution or SMT solving.
- Cross-language clone detection outside TypeScript/TSX and Svelte.
- Inline callback clone detection.
- CSS/style clone detection.
- Runtime behavior probing in the mandatory full-scope path. Probes are optional post-pilot work and must remain opt-in, sandboxed, and skipped by default when safety cannot be established.
- CI gating (advisory only until thresholds calibrated).

## Repository placement

`dry4ts` lives in `packages/dry4ts` as an internal workspace package, not under `src/lib`. That keeps the tool split-ready:

- Add a `packages:` section with `packages/*` to `pnpm-workspace.yaml` while preserving the existing `allowBuilds` settings.
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

Package dependencies live in `packages/dry4ts/package.json`. Prefer workspace versions for dependencies conduit already uses (`typescript`, `svelte`, `vitest`, `@biomejs/biome`, and `@typescript/native-preview` only if the package needs native checking) and declare them in the package so the subtree remains split-ready. TS/TSX lowering uses the TypeScript compiler AST, not `@typescript-eslint/parser`. Svelte lowering uses `svelte/compiler` through the dry4ts package dependency, not conduit's app internals. Dependency and lockfile edits are a serial ownership point: the package setup bead owns the initial dependency set, and later dependency changes require a named dependency bead that blocks the feature bead needing it. Do not add `jscpd` as a package dependency; run external overlap checks manually during pilot review only if they are useful.

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
3. Svelte structural detection.
4. Semantic evidence.
5. Conduit structural signal and full-scope pilot.

Create Svelte and semantic parent beads during initial planning, but create their child beads only when the dependency graph below reaches their stage. Parent beads are metadata only; child beads remain the executable units of work.

### Normative gates

Create child beads in stages, not as one large backlog. At the start, create only the serial path through `structural-interface-checkpoint`. After that checkpoint, continue structural extraction work serially unless a green refactor has already produced disjoint files with stable call sites. Do not create a hypothetical extractor Seam just to make subagents parallel. After `structural-checkpoint`, run the structural-only conduit snapshot before creating extension children; this gives threshold and unit-granularity feedback before the highest-uncertainty Svelte and semantic tracks start. Then create the extension contract children, close the extension contract checkpoint, and create Svelte and semantic children. The final pilot waits for both planned tracks. This keeps speculative beads out of Beads while still making Svelte and semantic work part of this plan.

Authoritative dependency graph by stage:

```bash
# Replace each placeholder with the actual child/checkpoint bead id after creation.
# Stage A: initial serial path through the structural Interface checkpoint.
bd dep add <cli-json-01-id> <package-setup-id>
bd dep add <profile-conduit-01-id> <cli-json-01-id>
bd dep add <t1-01-id> <cli-json-01-id>
bd dep add <report-nonempty-01-id> <t1-01-id>
bd dep add <prop-fileorder-01-id> <report-nonempty-01-id>
bd dep add <t1-02-id> <prop-fileorder-01-id>
bd dep add <t1-04-id> <t1-02-id>
bd dep add <t1-03-id> <t1-04-id>
bd dep add <t2-01-id> <t1-03-id>
bd dep add <t2-02-id> <t2-01-id>
bd dep add <t2-03a-id> <t2-02-id>
bd dep add <t2-03b-id> <t2-03a-id>
bd dep add <t2-04-id> <t2-03b-id>
bd dep add <t3-ts-01-id> <t2-04-id>
bd dep add <t3-ts-02-id> <t3-ts-01-id>
bd dep add <t3-stats-01-id> <t3-ts-02-id>
bd dep add <t3-idx-01-id> <t3-stats-01-id>
bd dep add <t-om-01-id> <t3-idx-01-id>
bd dep add <structural-interface-checkpoint-id> <t-om-01-id>

# Stage B: create only after the structural Interface checkpoint closes.
bd dep add <t-class-01-id> <structural-interface-checkpoint-id>
bd dep add <t-varfn-01-id> <t-class-01-id>
bd dep add <structural-checkpoint-id> <profile-conduit-01-id>
bd dep add <structural-checkpoint-id> <t-varfn-01-id>

# Stage C: create only after the structural checkpoint closes.
bd dep add <structural-conduit-snapshot-id> <structural-checkpoint-id>
bd dep add <ext-profile-01-id> <structural-conduit-snapshot-id>
bd dep add <ext-result-01-id> <ext-profile-01-id>
bd dep add <ext-semantic-slot-01-id> <ext-result-01-id>
bd dep add <ext-semantic-json-01-id> <ext-semantic-slot-01-id>
bd dep add <ext-compatibility-01-id> <ext-semantic-json-01-id>
bd dep add <extension-contract-checkpoint-id> <ext-compatibility-01-id>

# Stage D: create after the extension contract checkpoint closes.
bd dep add <sv-script-01-id> <extension-contract-checkpoint-id>
bd dep add <sv-template-01-id> <sv-script-01-id>
bd dep add <sv-template-02-id> <sv-template-01-id>
bd dep add <sv-block-01-id> <sv-template-02-id>
bd dep add <sv-snippet-01-id> <sv-block-01-id>
bd dep add <sv-rune-props-01-id> <sv-snippet-01-id>
bd dep add <sv-rune-state-01-id> <sv-rune-props-01-id>
bd dep add <sv-rune-derived-01-id> <sv-rune-state-01-id>
bd dep add <sv-rune-effect-01-id> <sv-rune-derived-01-id>
bd dep add <sv-attr-static-01-id> <sv-rune-effect-01-id>
bd dep add <sv-directive-event-01-id> <sv-attr-static-01-id>
bd dep add <svelte-checkpoint-id> <sv-directive-event-01-id>

bd dep add <sem-lit-01-id> <extension-contract-checkpoint-id>
bd dep add <sem-independent-01-id> <sem-lit-01-id>
bd dep add <sem-lit-02-id> <sem-independent-01-id>
bd dep add <sem-effect-01-id> <sem-lit-02-id>
bd dep add <sem-effect-02-id> <sem-effect-01-id>
bd dep add <semantic-checkpoint-id> <sem-effect-02-id>
bd dep add <sem-svelte-lit-01-id> <semantic-checkpoint-id>
bd dep add <sem-svelte-lit-01-id> <svelte-checkpoint-id>

# Stage E: create only after Svelte checkpoint and Svelte semantic integration close.
bd dep add <full-scope-checkpoint-id> <svelte-checkpoint-id>
bd dep add <full-scope-checkpoint-id> <sem-svelte-lit-01-id>
bd dep add <conduit-snapshot-id> <full-scope-checkpoint-id>
bd dep add <performance-profile-id> <full-scope-checkpoint-id>
bd dep add <pilot-checkpoint-id> <conduit-snapshot-id>
bd dep add <pilot-checkpoint-id> <performance-profile-id>
```

Child beads inside a parent should depend only on the immediately required prior behavior. Do not create one dependency chain just because the plan is written top-to-bottom, and do not create a later-stage child bead before its checkpoint has closed. Parallel-ready examples:

- After `CLI-JSON-01`, the conduit profile/effective-profile bead may run in parallel with the first T1 structural bead only if their allowed files are disjoint and the T1 packet explicitly owns any needed `Dry4tsRunner` wiring.
- After `T1-01`, run the non-empty JSON report bead, then the file-order determinism bead before adding more extraction behavior. Stable serialized output is cheap to prove early and prevents later subagents from building on unstable JSON.
- After `structural-interface-checkpoint`, keep `T-CLASS-01` and `T-VARFN-01` serial by default. Create a parallel extraction fanout only if a prior green refactor already produced disjoint private files and frozen call sites for the exact shapes being delegated.
- After the structural checkpoint, run the structural-only conduit snapshot before extension work. If it reveals obvious threshold or unit-granularity breakage, create a follow-up bead before starting Svelte or semantic work rather than carrying bad assumptions forward.
- After the extension contract checkpoint, the Svelte structural chain and semantic evidence chain may run in parallel only if the contract has frozen result-model/report-writer/profile ownership, installed the no-op semantic detector call site in the runner, and provided the `UnitCompatibility` facts semantic selection needs. Svelte owns extraction lowering; semantic owns semantic analysis and any source re-inspection it needs. If either chain needs shared runner/report/profile/compatibility changes not granted in its packet, stop and create a serial integration bead.
- After `full-scope-checkpoint`, conduit snapshot and performance-profile prep may run in parallel.

Parallel waves:

| Wave | Ready after | Parallel-ready child beads | Serial exclusions |
|---|---|---|---|
| 0 | none | Package setup only | Workspace and lockfile owner; no parallel package edits. |
| 1 | `CLI-JSON-01` | `PROFILE-CONDUIT-01` and `T1-01` if file scopes are disjoint | `ReportWriter` JSON contract is owned by `CLI-JSON-01`; `PROFILE-CONDUIT-01` may own CLI parsing for `--effective-profile`; `T1-01` should assert runner result data and avoid `ReportWriter` edits unless the packet explicitly owns them. |
| 2 | `structural-interface-checkpoint` | None by default | `T-CLASS-01` and `T-VARFN-01` are serial unless a previous green refactor has already produced disjoint private files and frozen call sites. |
| 3 | Extension contract checkpoint | Svelte structural chain and semantic evidence chain | The contract owns shared output/profile wiring, non-empty semantic JSON rendering, compatibility facts, and the semantic runner call site; Svelte packets must not edit semantic files, and semantic packets must not edit Svelte lowering files. `SEM-SVELTE-LIT-01` is serial after both checkpoints. |
| 4 | Full-scope checkpoint | Deterministic conduit snapshot and performance profile | Pilot checkpoint waits for both. |

Subagent launch checklist:

1. **Wave 0 - serial bootstrap.** Do not launch implementation subagents. The orchestrator or integration owner creates the package setup bead, claims it, edits workspace/package files, verifies, and closes it.
2. **Wave 1 - first parallel chance.** After `CLI-JSON-01` is green and closed, run `bd ready` and launch up to two subagents: one for `PROFILE-CONDUIT-01`, one for `T1-01`. Launch both only when their packet file scopes are disjoint. If either packet needs `src/report/report-writer.ts`, changes the JSON contract, or both need `src/core/runner.ts`, run those beads serially. If `PROFILE-CONDUIT-01` needs `src/bin/dry4ts.ts` for `--effective-profile`, list it as profile-owned.
3. **Stage A serial structural path.** After Wave 1, run `REPORT-NONEMPTY-01`, then `PROP-FILEORDER-01`, then keep `T1-02` through `structural-interface-checkpoint` serial. These beads shape the core extractor and detector Interfaces; parallel work here creates merge churn faster than it creates value.
4. **Stage B - serial structural hardening.** After `structural-interface-checkpoint` is closed, run `T-CLASS-01` and `T-VARFN-01` serially. Do not launch extraction-shape subagents unless the checkpoint records exact disjoint files and frozen call sites created by already-green implementation.
5. **Structural pilot feedback.** After `structural-checkpoint` is closed, run `STRUCTURAL-CONDUIT-SNAPSHOT-01` serially. Do not tune thresholds in that bead; use its Beads note to catch obvious unit-granularity or threshold mistakes before Svelte and semantic work builds on them.
6. **Extension contract.** After the structural snapshot is closed, run `EXT-PROFILE-01`, `EXT-RESULT-01`, `EXT-SEMANTIC-SLOT-01`, `EXT-SEMANTIC-JSON-01`, `EXT-COMPATIBILITY-01`, and the extension contract checkpoint serially. These beads own the shared profile/result-model/report-writer slots, non-empty semantic JSON shape, `UnitCompatibility` facts, plus the no-op semantic detector runner call site for `.svelte` inputs and semantic evidence so later Svelte and semantic subagents do not fight over public JSON shape.
7. **Wave 3 - Svelte and semantic fanout.** After the extension contract checkpoint is green and closed, launch up to two subagents: one for the next ready Svelte structural bead, one for the next ready semantic evidence bead. Keep each chain serial internally. Do not run two Svelte beads or two semantic beads at the same time unless a prior checkpoint records exact disjoint private files and frozen call sites for that chain.
8. **Svelte semantic integration.** After both Svelte checkpoint and semantic checkpoint close, run `SEM-SVELTE-LIT-01` serially. It is the first bead allowed to combine Svelte comparison units with semantic source inspection.
9. **Wave 4 - pilot fanout.** After `full-scope-checkpoint` closes, launch two subagents: one for deterministic conduit snapshot, one for performance profile. The pilot checkpoint remains serial and integrates both reports.

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

Orchestrator preflight before launching any subagent:

```bash
bd show <bead-id>
bd list --status=in_progress
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD
git worktree add .worktrees/dry4ts-<bead-id> -b ds/dry4ts-<bead-id>-<short-slug> HEAD
```

Then materialize the packet's allowed and forbidden file lists as absolute paths. Compare the allowed list with files owned by any open/in-progress bead in the same wave. If the intersection is non-empty, do not launch in parallel; either run serially or create a serial integration bead. The packet pasted to the subagent must include the exact worktree path, branch, base commit, allowed files, forbidden files, Red command, expected failure, Green scope, and Verification command.

Wave-specific prompt additions:

```text
Wave 1 PROFILE-CONDUIT-01: preserve the existing JSON output contract; do not edit ReportWriter unless the packet explicitly owns it.
Wave 1 T1-01: create the first structural path only; do not add T2/T3 behavior before its bead.
Stage B structural hardening: keep extraction-shape work serial unless the checkpoint packet already records exact disjoint files and frozen call sites. Do not create a Seam only for parallelism.
Wave 3 Svelte: lower exactly one Svelte source behavior at a time through ComparisonUnitExtractor; do not add semantic evidence or callback behavior.
Wave 3 semantic: add exactly one advisory/skip evidence behavior at a time through SemanticEvidenceDetector using the no-op runner call site from EXT-SEMANTIC-SLOT-01 and compatibility facts from EXT-COMPATIBILITY-01; do not edit ReportWriter, shared result types, Svelte lowering, or require the extractor to emit semantic facts.
Svelte semantic integration: use existing Svelte comparison units and semantic private parsing; do not edit Svelte lowering.
Wave 4 pilot: record evidence only; do not tune thresholds, add MinHash, or add new detection tracks in the pilot bead.
```

Serial ownership points:

- `pnpm-workspace.yaml`, `packages/dry4ts/package.json`, and lockfile changes are owned by package/dependency beads.
- `src/core/runner.ts`, `src/extract/comparison-unit-extractor.ts`, and `src/structural/structural-clone-detector.ts` are shared orchestrator files. They are serial unless a checkpoint bead explicitly records a real Interface and exact disjoint ownership created by prior green behavior.
- Do not split `ComparisonUnitExtractor` into per-shape files solely for subagent parallelism. A split is allowed only when the green implementation needs that Locality. The checkpoint may verify existing call sites; it must not create feature files or call sites.
- `src/report/report-writer.ts`, `src/core/types.ts`, `src/core/run-profile.ts`, compatibility extraction, and semantic call-site wiring in `src/core/runner.ts` are shared public-shape files. `EXT-PROFILE-01`, `EXT-RESULT-01`, `EXT-SEMANTIC-SLOT-01`, `EXT-SEMANTIC-JSON-01`, and `EXT-COMPATIBILITY-01` own their Svelte/semantic output additions, semantic JSON rendering, compatibility facts, and no-op `SemanticEvidenceDetector` call site. Later Svelte/semantic beads may edit them only when their packet explicitly says so.
- Svelte implementation files live under `src/extract/` and tests under `test/acceptance/svelte-*.test.ts`; semantic implementation files live under `src/semantic/` and tests under `test/acceptance/semantic-*.test.ts`. Keep those write scopes disjoint during Wave 3. Semantic beads inspect source through comparison-unit raw text/spans or their own private parsing, not extractor-emitted semantic facts.
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
Durable handoff: bd update <bead-id> --append-notes "<files changed; red failure; verification output; commit SHA; risks; follow-ups>"
Optional artifact root: /Users/dstern/.cache/conduit/dry4ts-handoffs/<run-id>/<bead-id>/ for bulky logs only; include paths in Beads notes.
Commit SHA: <subagent branch sha after green>
Stop and report if: dependency is not green, base branch is stale, an allowed-file list is wrong, package metadata must change, or implementation needs a shared file owned by another open bead.
```

Subagents must work in their assigned worktree, never in the shared main checkout. They must not stash or revert unrelated work. Before handoff they append durable Beads notes with files changed, red failure observed, green verification output, commit SHA, unresolved risks, and follow-up beads created. If logs are too large for notes, they may write optional artifacts under the shared absolute artifact root outside the worktrees and link those paths from the Beads note. Do not rely on ignored `test-results` files to arrive through a git merge. Do not maintain a separate manifest unless a later integration bead explicitly creates one; Beads notes plus linked bulky artifacts are the handoff Interface for this plan. Subagents may create discovered follow-up beads, but they do not close their implementation bead; the integration owner closes it after merge and verification.

An integration agent or human owner merges one green bead branch at a time. For each merge: confirm `bd show <id>` dependencies are closed, merge/rebase the branch onto the integration base, run the bead verification command, read the durable Beads note, close the bead, then run the next checkpoint command when all checkpoint dependencies are merged. If a merge needs files outside the subagent packet, stop and create a follow-up bead instead of expanding the merge in place.

Integration checkpoints:

1. After package setup and CLI contract: verify workspace commands, dependency ownership, empty JSON output, and effective-profile reporting.
2. After structural TS: verify T1/T2/T3 acceptance, additional TS unit shapes, non-empty JSON serialization, and file-order determinism.
3. After early structural conduit signal: verify the production-first structural-only snapshot is stable and record threshold/unit-granularity observations before extension work.
4. After extension contract: verify `.svelte` include/profile settings, Svelte result discriminants, semantic evidence output slots, non-empty semantic JSON rendering, `UnitCompatibility` facts, and stable empty output shape before parallel Svelte/semantic work begins.
5. After Svelte and semantic tracks: verify Svelte acceptance, semantic acceptance, Svelte semantic integration, structural acceptance, and file-order determinism together.
6. Before pilot close: run conduit-slice regression and performance measurement, then create follow-up beads only for threshold tuning, external-tool overlap, callback comparison, MinHash, or architecture changes discovered by the full planned scope.

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
ComparisonUnitExtractor (scan, ignore, parse TS/TSX/Svelte, source spans, NormalNode)
   ↓
StructuralCloneDetector
   ├── Raw-text hash                         (T1 buckets)
   ├── NormalNode hash                       (T2 buckets)
   ├── Structural-signature candidate index  (T3 limiter)
   └── Subtree fingerprints + Jaccard        (T3 candidates)
   ↓
SemanticEvidenceDetector
├── Literal/static-expression evidence
├── Effect yield-trace evidence
└── Source-only advisory/skipped evidence
   ↓
ReportWriter (stable JSON)
```

The pipeline lowers TS/TSX and Svelte comparison units to a shared structural IR. `NormalNode` is private package Implementation shared by `ComparisonUnitExtractor` and `StructuralCloneDetector`; CLI callers and external package users must never construct it or depend on its raw shape. `UnitCompatibility` is also package-internal: it carries coarse structural facts that semantic candidate selection may use without reading `NormalNode`. Semantic evidence does not travel through the extractor Interface. `SemanticEvidenceDetector` inspects comparison-unit raw text/spans and does any private parsing it needs, which keeps semantic taxonomy local to the semantic Module and keeps Svelte extraction parallel-safe. The shape below is a starting constraint, not a command to implement every kind, trait, or compatibility fact up front.

```ts
type NormalKind =
  | "function"
  | "statement"
  | "branch"
  | "loop"
  | "call"
  | "member"
  | "operator"
  | "literal"
  | "binding"
  | "type"
  | "unknown";

type NormalRole =
  | "body"
  | "condition"
  | "then"
  | "else"
  | "callee"
  | "argument"
  | "object"
  | "property"
  | "left"
  | "right";

type NormalTrait =
  | { tag: "operator"; kind: "arithmetic" | "comparison" | "logical" | "assignment" | "unary" | "unknown" }
  | { tag: "declaration"; kind: "function" | "method" | "arrow" | "functionExpression" | "const" | "let" | "var" }
  | { tag: "flag"; kind: "async" | "generator" | "optional" | "computed" | "spread" | "rest" }
  | { tag: "property"; policy: "erased" }
  | { tag: "property"; policy: "preserved"; key: string }
  | { tag: "literal"; kind: "string" | "number" | "bigint" | "boolean" | "null" | "regex" }
  | { tag: "type"; shape: "none" | "primitive" | "array" | "object" | "function" | "generic" | "union" | "unknown" };

type NormalNode = Readonly<{
  kind: NormalKind;
  role?: NormalRole;
  traits?: readonly NormalTrait[];
  children: readonly NormalNode[];
}>;

type UnitCompatibility = Readonly<{
  parameterCount?: number;
  async?: boolean;
  generator?: boolean;
  roughReturnShape?: "none" | "void" | "primitive" | "array" | "object" | "promise" | "effect" | "component" | "unknown";
}>;

type InternalComparisonUnit = Readonly<{
  rawText: string;
  shape: NormalNode;
  compatibility: UnitCompatibility;
  language: "ts" | "tsx" | "svelte";
  kind: "function" | "method" | "objectMethod" | "variableFunction" | "svelteScriptFunction" | "svelteTemplate" | "svelteBlock";
  span: { file: string; start: number; end: number };
}>;
```

This is the initial TS structural shape, not the full eventual taxonomy. Svelte beads extend it only when a red behavior forces a new `kind`, `role`, or `trait` such as an element, block, snippet, render tag, rune, attribute, or directive. Those additions happen in the Svelte bead that needs them and include a deterministic hash-input fixture after the public behavior is green. Do not pre-add Svelte or semantic tags during package setup or TS structural work.

These are package-internal types. The public package Interface and CLI output expose only the stable result model, source spans, language, unit kind, stats, and semantic evidence. If a test imports internal comparison units, treat `shape` as opaque; tests should not construct arbitrary `NormalNode` trees except for local deterministic hash-input fixtures created after a public behavior is green. Semantic tests may assert compatibility behavior through runner output, not by manufacturing compatibility fields directly.

Do not add arbitrary attribute keys, invalid trait combinations, or speculative compatibility facts. Add a new kind, trait, or compatibility field only after a red behavior needs it, and update deterministic hash-input fixtures at that point. Exact source identifiers and literal values must not enter `NormalNode` when the active normalization policy erases them; preserved property names must be represented only through the explicit property trait. Centralize `NormalNode` construction, compatibility extraction, and stable hash-input rendering so detector logic does not grow ad hoc knowledge of every TS syntax shape.

TS/TSX and Svelte lower into `NormalNode` inside `ComparisonUnitExtractor`. Once Svelte work starts, an internal `SourceUnitLowerer` Seam is justified because there are two real Adapters: `TypeScriptSourceLowerer` and `SvelteSourceLowerer`. That Seam stays private to `ComparisonUnitExtractor`; callers still depend on the extractor's single deep Interface.

### Deep modules and seams

Keep the implementation deep around a few stable interfaces:

- **ComparisonUnitExtractor**: turns target paths into comparison units with source spans and private normalized shapes. It owns file scanning, ignore handling, parser selection, TS/TSX AST traversal, Svelte parsing/lowering, minimum-size filtering, and source-span mapping. The internal `SourceUnitLowerer` Seam is justified only when the first Svelte behavior creates the second real Adapter; callback lowering remains outside this plan.
- **StructuralCloneDetector**: owns raw hashes, AST hashes, subtree fingerprints, weighted Jaccard, and most-specific classification. Callers should not coordinate those modules themselves.
- **SemanticEvidenceDetector**: owns semantic candidate selection, advisory/skipped status, static literal analysis, Effect yield traces, and skipped reasons. Callers should not know which analyzer produced which skipped reason beyond the stable report model.
- **RunProfileResolver**: owns default config, built-in profile loading, CLI override precedence, validation, and effective-config reporting. Other modules receive a resolved run profile; they do not merge flags and profiles themselves.
- **Dry4tsRunner**: owns the deterministic orchestration of one run: resolve inputs, call extractor, call detector, attach stats, and hand the result model to the writer. The CLI should be a thin Adapter over this Module.
- **ReportWriter**: owns stable JSON output, sorting, ids, and source-span formatting.

The interface is the test surface. Unit tests may exercise inner pure functions where useful, but acceptance and regression tests should cross these deep module interfaces.

Module index:

| Module | Interface | Implementation owns | Adapter(s) | Does not own | First behavior test |
|---|---|---|---|---|---|
| `Dry4tsRunner` | Target paths + raw command/profile request in, stable result model out. | Orchestration, deterministic stage ordering, deterministic run counts, error shape, structural detector call, the no-op semantic detector call site installed by `EXT-SEMANTIC-SLOT-01`, and the programmatic public test surface. | CLI Adapter first. | Parsing, normalization, clone detection rules, JSON rendering, wall-clock performance reporting. | `CLI-JSON-01` through the CLI, then most acceptance tests may use this Interface directly for speed. |
| `ComparisonUnitExtractor` | Target paths + resolved run profile in, comparison units with raw text, opaque normalized shape, package-internal compatibility facts, unit kind, language, and source spans out. | File scanning, gitignore/profile ignores, parser selection, TS/TSX traversal, Svelte parsing, TS/Svelte lowering to private `NormalNode`, coarse compatibility extraction, size filtering, source-span mapping. | Internal `SourceUnitLowerer` Seam once Svelte starts: `TypeScriptSourceLowerer`, `SvelteSourceLowerer`. | Hashing, similarity, clone classification, semantic evidence facts/decisions, output formatting. | `T1-01` through `Dry4tsRunner`; Svelte behavior starts with `SV-SCRIPT-01`. |
| `StructuralCloneDetector` | Comparison units in, T1 clusters, T2 pairs, T3 pair candidates, and deterministic structural stats out. | Raw hashes, normalized-node hashes, subtree fingerprints, weighted Jaccard, most-specific classification, candidate counts, cheap candidate limiting. | None; candidate index remains private Implementation unless a second caller appears. | Parsing, NormalNode lowering, semantic evidence, report writing. | `T1-01`, then `T2-01`, then `T3-TS-01` through the same Interface. |
| `SemanticEvidenceDetector` | Comparison units + structural results + resolved semantic profile in, advisory semantic evidence and skipped evidence out. | Semantic candidate selection using unit metadata plus package-internal unit compatibility facts plus stable structural result fields, private source inspection/parsing, literal/static-expression evidence, Effect yield-trace evidence, Svelte static-expression evidence, evidence status, skipped reasons, deterministic ordering. | Internal analyzer strategy only after at least two analyzers exist; literal, Effect, and Svelte analyzers are private Implementation. | Structural clone classification, private structural fingerprints/Jaccard buckets, Svelte/TS structural lowering, JSON byte rendering. | `SEM-LIT-01`, then `SEM-INDEPENDENT-01` through the no-op runner call site installed by `EXT-SEMANTIC-SLOT-01` and compatibility facts from `EXT-COMPATIBILITY-01`. |
| `RunProfileResolver` | CLI args + built-in profile name in, resolved run profile out. | Defaults, built-in `default` and `conduit` profile config, Svelte/semantic profile config, profile merge order, validation, and effective-config reporting. | None; built-in profiles are config, not Adapters. | Clone detection behavior. | `PROFILE-CONDUIT-01`, then `EXT-PROFILE-01` reports Svelte/semantic config. |
| `ReportWriter` | Clone result model in, stable JSON bytes out. | Sorting, ids, source-span formatting, Svelte `language` / `unitKind` discriminants, semantic evidence rendering, skipped evidence rendering, and deterministic stats rendering. | JSON writer only. | Detection, validation, and wall-clock performance reporting. | `CLI-JSON-01` freezes empty JSON; `REPORT-NONEMPTY-01` freezes non-empty structural JSON; `EXT-RESULT-01` freezes Svelte discriminants; `EXT-SEMANTIC-JSON-01` freezes non-empty semantic JSON. |

Planned extension tracks:

| Track | Starts after | First behavior | Notes |
|---|---|---|---|
| Svelte structural lowering | Extension contract checkpoint | A `.svelte` script block lowers through `ComparisonUnitExtractor` and reports through the existing detector. | Use private `SourceUnitLowerer` Adapters because TS and Svelte are now two real Adapters. CSS/style clones remain out of scope. |
| Semantic literal/static evidence | Extension contract checkpoint | Two structurally different units with the same folded literal/static-expression behavior emit advisory semantic evidence. | Advisory only; it cannot upgrade a pair to T1/T2/T3. |
| Semantic Effect evidence | `SEM-LIT-02` | Two Effect pipelines with the same static yield-tag trace emit advisory semantic evidence. | Unknown dynamic tags produce skipped evidence, not confident findings. |
| Svelte semantic evidence | Svelte checkpoint + Semantic checkpoint | Compatible Svelte template/block units with the same folded static condition/directive expression emit advisory semantic evidence. | Serial integration bead; semantic code must not edit Svelte lowering or require extractor semantic facts. |
| Optional opt-in behavior probes | Pilot checkpoint creates a follow-up only if source-only semantic evidence misses important duplication. | A probe-safe pure fixture pair emits advisory evidence for matching deterministic input/output samples. | Not part of the mandatory full-scope path; unsafe candidates emit skipped evidence with reason and never execute by default. |
| Callback comparison | Pilot finds meaningful duplication inside inline callbacks that the full planned scope misses. | A non-trivial callback clone is included and reported without admitting trivial projection/sort callbacks. | Callback remains outside this Svelte/semantic plan because it needs a separate eligibility policy and write-scope series. |

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
    <private lowerer files created only after green behavior needs Locality>
  src/semantic/
    semantic-evidence-detector.ts
  src/report/
    report-writer.ts
  src/structural/
    structural-clone-detector.ts T1/T2/T3 orchestration and most-specific classification
  test/
    unit/
      <local invariant tests created only after a green acceptance path needs them>
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
      svelte-structural.test.ts
      semantic-literal.test.ts
      semantic-effect.test.ts
      semantic-svelte.test.ts
    regression/
      conduit-fixture.test.ts
    fixtures/
      ts/
      svelte/
      semantic/
      conduit-slice/
```

Private Implementation may later split under `src/extract/`, `src/normalize/`, `src/structural/`, or `src/semantic/` when a green refactor needs Locality. Keep TS lowering inside `ComparisonUnitExtractor` until a green behavior proves a private helper file is worth it. The `SourceUnitLowerer` Seam appears only when Svelte creates a second real Adapter; do not create `ts-source.ts` as a one-Adapter Seam during TS structural work. Do not create helper files such as raw-text normalizers, fingerprint bags, similarity calculators, candidate indexes, literal evaluators, trace analyzers, or probe runners just because the plan names the concept. Behavior-probe files are optional post-pilot work, not part of the mandatory layout. Those helpers are not public Modules, not Adapters, and not a separate Seam unless another caller appears or a green behavior proves the locality is worth it.

## Structural detection (T1 / T2 / T3)

T1, T2, and T3 share one extraction and normalization pipeline. The three types are points on a normalization-strength spectrum: same comparison units, same TypeScript compiler AST, same structural IR. The detector classifies each detected pair as the *most specific* type that matches.

### Comparison units

**TS / TSX structural stage:**
- function declarations (`T1-01` through `T3-IDX-01`)
- object methods (`T-OM-01`)
- class methods (`T-CLASS-01`)
- arrow / function expressions assigned to variables (`T-VARFN-01`)

**Svelte planned scope:**
- `<script lang="ts">` and module script functions (`SV-SCRIPT-01`)
- whole component templates that meet `minNodes` / `minLines` (`SV-TEMPLATE-01`)
- template near-misses with erased text/local names and preserved structure (`SV-TEMPLATE-02`)
- large `{#if}`, `{#each}`, `{#await}`, and `{#key}` blocks as nested Svelte template units (`SV-BLOCK-01`)
- Svelte 5 snippets/render tags where exposed by stable compiler syntax (`SV-SNIPPET-01`)
- Svelte 5 rune-heavy script structure as separate tracer bullets for `$props`, `$state`, `$derived`, and `$effect` (`SV-RUNE-PROPS-01` through `SV-RUNE-EFFECT-01`)
- element/component structure, static attribute names, and directive names as separate tracer bullets (`SV-ATTR-STATIC-01`, `SV-DIRECTIVE-EVENT-01`)

Inline callback functions are out of this plan. They need an eligibility policy, noise controls, and real conduit examples before the added Interface is worth it. The pilot may create callback follow-up beads if copied conduit fixtures show important missed duplication.

All units respect profile `minLines` and `minNodes` thresholds; small units don't enter T1/T2/T3 detection regardless of type.

Acceptance fixtures must be sized for the active profile. For CLI-driven behavior tests, the source units in the fixture must intentionally exceed the default profile's `minLines` and `minNodes`; do not write tiny examples that disappear before detection. If a behavior genuinely needs smaller fixture code, add or select a named test profile in that bead and include the profile in the Red and Verification commands.

### Raw-text normalization (T1 input)

For each unit:
- Strip line and block comments.
- Collapse runs of whitespace to a single space, preserving string-literal contents.
- Normalize line endings (`\r\n` → `\n`).
- Trim leading/trailing whitespace.

Use parser/scanner tokenization for raw-text normalization, not ad hoc regex over source text. For TS/TSX units and Svelte script units, preserve the exact token text for string, template, regex, number, and bigint literal tokens while normalizing whitespace/comment trivia outside those tokens. For Svelte template units, use Svelte parser spans and preserve literal/static expression token text where that text is part of the unit's T1 identity.

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

**Why preserve property names by default.** Domain code where property names carry semantics (`u.email` vs `u.phone`, `event.userId` vs `event.orderId`) generates false positives if names are erased. Default to preserve; revisit after the full-scope conduit pilot with real data.

Hash the full `NormalNode` tree with sha256. Two units with the same AST hash are **T2 candidates** (assuming they failed T1 — raw text differed).

### Svelte normalization

`SvelteSourceLowerer` parses `.svelte` files with `svelte/compiler` and lowers supported script/template syntax to the same private `NormalNode` IR. It should reuse the TS lowerer for TypeScript inside `<script>` blocks and Svelte expression ASTs where practical; it must not import from conduit's frontend runtime.

**Script blocks:**
- Instance and module scripts are parsed as TypeScript when `lang="ts"` or when the file profile says Svelte script is TS-compatible.
- Functions inside scripts become comparison units with `language: "svelte"` and `kind: "svelteScriptFunction"`.
- Exported props, runes, imports, and reactive declarations may contribute structural children, but they do not become comparison units unless a later red behavior needs that unit granularity. Semantic evidence re-inspects source privately instead of depending on extractor-emitted semantic facts.

**Template units:**
- The whole template becomes a `svelteTemplate` unit when it passes profile thresholds.
- Large `{#if}`, `{#each}`, `{#await}`, and `{#key}` blocks may also become `svelteBlock` units when they pass thresholds.
- Text nodes normalize away except for their presence/position. Literal text content must not enter `NormalNode`.
- HTML element and Svelte component tag names are preserved by default. They carry domain meaning in frontend code.
- Attribute, directive, event, action, bind, transition, and slot names are preserved by default; values and local identifiers normalize away. If semantic evidence needs their expression values, `SemanticEvidenceDetector` parses the source privately.
- `{#each}` lowers collection expression shape, key presence, and body structure; loop variable names normalize away.
- `{#if}` / `{:else if}` / `{:else}` preserve branch order and condition expression shape with identifiers/literals erased.
- `SV-SNIPPET-01` uses concrete public-output fixtures with `{#snippet row(item)}<li>{item.name}</li>{/snippet}` and `{@render row(user)}`. The red behavior asserts clone/non-clone output and source spans, not internal trait names. A local invariant test for snippet/render hash input may be added only after the public behavior is green.
- Rune support is one behavior per bead. `SV-RUNE-PROPS-01` starts with `$props()`, then `SV-RUNE-STATE-01`, `SV-RUNE-DERIVED-01`, and `SV-RUNE-EFFECT-01` add one rune form each. The public behavior is stable clone/non-clone output; local trait/hash tests are post-green invariants only.
- Attribute/directive support is one behavior per bead. `SV-ATTR-STATIC-01` proves static attribute names are preserved by default. `SV-DIRECTIVE-EVENT-01` proves event/bind/action directive names are preserved by default. Additional transition/slot/component-name beads are created only if a green Svelte checkpoint or conduit snapshot shows they are needed.
- Unsupported or version-unstable Svelte 5 syntax lowers to deterministic `unknown` children with spans, not broad catch-all loss for the entire template.
- Unsupported template nodes lower to `unknown` children with deterministic spans rather than crashing.

**Out of scope for this plan:** CSS/style clones, visual similarity, generated compiled Svelte output, and DOM runtime behavior.

### Fingerprints and similarity (T3 input)

For each unit's `NormalNode` tree:

1. Walk recursively; emit a stable hash for every subtree.
2. Collect into a multiset (count matters — two identical subtrees count twice).
3. For `T3-TS-01`, compare the small fixture's eligible units directly so the first Type-3 behavior proves the similarity path before any index can prune it.
4. In `T3-STATS-01`, report deterministic candidate counts and largest candidate bucket for the direct comparison path.
5. In `T3-IDX-01`, add conservative candidate buckets using unit kind, normalized parameter count, rough return shape, and normalized node-count bucket.
6. Compare units pairwise via weighted Jaccard within the eligible candidate set.
7. Pairs with `J(A, B) >= threshold` (default from profile) are **T3 candidates**.

The candidate index is deliberately cheap and private to `StructuralCloneDetector`. It must be recall-first: if a bucket rule might drop a legitimate inserted-guard near-miss, make the bucket looser and let Jaccard decide. Do not include exact top-level control-flow shape in initial buckets; inserted guards and logging branches are normal Type-3 gaps. Do not expose MinHash, indexing strategy, or bucket internals in the public Interface unless the pilot proves another caller needs them.

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

T1 is O(N) hash bucketing. T2 starts with O(N) AST hash buckets, then emits explicit pair entries only for members with different raw hashes. T2 exclusion is pair-specific: a unit may appear in both a T1 cluster and a T2 pair when it has a renamed/literal-changed sibling. Do not drop a whole member merely because it was already present in a T1 result. T3 is O(K^2) over the eligible candidate set; before the limiter bead, the eligible set may be all units for small fixtures. Once the limiter exists, comparisons are limited by loose candidate-index buckets. The default output records bucket sizes in deterministic stats but does not expose candidate-index sizing in the profile Interface; the pilot decides whether MinHash or tunable limits are worth adding.

### Classification

Each detected pair is classified as the *most specific* type:

| Match | Classification |
|---|---|
| `rawHash(a) == rawHash(b)` | **T1** |
| `astHash(a) == astHash(b)` && raw differs | **T2** |
| `J(a, b) ≥ threshold` && astHash differs | **T3** |
| `J(a, b) < threshold` | dropped |

## Semantic evidence

Semantic evidence is advisory. It helps agents review candidates that structural matching misses; it never proves equivalence and never silently upgrades a pair to T1/T2/T3. Every semantic item uses `status: "advisory"` when evidence is found or `status: "skipped"` when evidence cannot be collected. Unsafe runtime behavior is represented as skipped evidence with a stable reason, not a third status.

`SemanticEvidenceDetector` is the deep Module for this track. Its Interface is intentionally small: comparison units, structural results, and a resolved semantic profile in; stable semantic evidence and skipped evidence out. Its Implementation owns candidate selection, private source inspection/parsing, analyzers, skipped reasons, and deterministic ordering. Do not add `semanticFacts` to `ComparisonUnitExtractor`; that would make the extractor Interface shallow and force Svelte lowering to know semantic taxonomy.

### Semantic candidate selection

The semantic detector should consider:

- Units with compatible public unit metadata (`kind`, `language`, source spans) and package-internal `UnitCompatibility` facts (`parameterCount`, `async`, `generator`, and `roughReturnShape`).
- Svelte template/block pairs with compatible public unit kind and source spans after the Svelte checkpoint.
- Effect pipelines with compatible `Effect.gen` / pipe shape discovered through private source inspection.

It must exclude every pair already reported as T1/T2/T3. Do not add a v1 policy for annotating structural results with semantic evidence; if the pilot shows that annotation is useful, create a separate follow-up bead with an explicit output shape and acceptance behavior. Semantic selection must not read private `NormalNode` trees, fingerprints, Jaccard internals, candidate buckets, or below-threshold T3 pairs from `StructuralCloneDetector`. `EXT-COMPATIBILITY-01` freezes the initial compatibility facts before semantic subagents launch. If a later semantic behavior needs another compatibility fact, create a serial compatibility bead before the semantic bead; do not let a Wave 3 semantic subagent reach into extractor or shared type files. If later semantic work needs structural near-miss candidates as input, add an explicit structural near-miss result through its own bead before semantic code depends on it. Candidate selection is private Implementation; do not expose semantic candidate thresholds as CLI flags unless the pilot proves users need to tune them.

### Literal/static-expression evidence

`SEM-LIT-01` and `SEM-LIT-02` start with deterministic static evidence only:

- Evaluate scalar literals, arrays, objects, unary/binary constant expressions, and top-level immutable `const` aliases inside the same file.
- Normalize object key order deterministically.
- Never fold imported values, getters, function calls, `Date`, `Math.random`, environment reads, or unknown globals.
- Emit advisory evidence when two structurally different units produce the same folded expression shape at the same return/condition positions.
- Emit no evidence when folded values differ.

The literal evaluator is private Implementation behind `SemanticEvidenceDetector`. Create `src/semantic/literal-evaluator.ts` only when the green implementation needs the Locality.

`SEM-INDEPENDENT-01` immediately follows the first literal advisory behavior and proves semantic evidence does not depend on Type-3 near-miss output. The fixture should produce no T1/T2/T3 result, pass comparison units plus empty structural results through the semantic call site, and still emit the expected advisory literal evidence. This keeps semantic candidate selection behind the `SemanticEvidenceDetector` Module instead of coupling it to private structural similarity internals.

### Effect yield-trace evidence

`SEM-EFFECT-01` and `SEM-EFFECT-02` are static only:

- Recognize `Effect.gen(function* (...) { ... })`, `Effect.gen(function* () { ... })`, and simple `pipe(..., Effect.flatMap/Effect.map/Effect.catchAll)` shapes used in conduit-style code.
- Extract the ordered yield/call trace of statically named service Tags and Effect combinators.
- Normalize local variable names away.
- Preserve Tag symbol names such as `OpenCodeFileServiceTag` because those are the semantic service identities.
- Emit advisory evidence when two units have compatible structural shape and the same static yield/call trace.
- Emit skipped evidence with `reason: "dynamic-effect-trace"` when Tags are computed, hidden behind unrecognized wrappers, or imported aliases cannot be resolved statically.

Do not build mock Layers, run Effects, or import conduit modules. This track is source analysis, not runtime validation.

### Svelte static-expression evidence

`SEM-SVELTE-LIT-01` runs only after both the Svelte structural checkpoint and the semantic checkpoint are green. It reuses Svelte comparison units as candidate spans, then privately inspects the source for static template expressions:

- Fold scalar literals, arrays, objects, unary/binary constant expressions, and same-file immutable `const` aliases inside `{#if}` conditions and directive expressions.
- Normalize local names and literal values according to the same semantic literal rules.
- Emit advisory evidence when compatible Svelte template/block units have the same folded static condition or directive-expression shape.
- Emit no evidence when folded values differ or when the expression depends on imports, calls, stores, runes with runtime state, environment reads, or unknown globals.

This bead must not add extractor-emitted semantic facts and must not edit Svelte lowering. If source spans are insufficient, stop and create a serial integration bead instead of expanding Svelte ownership from the semantic packet.

### Optional post-pilot behavior probes

Runtime behavior probing is intentionally outside the mandatory full-scope path. The conduit profile keeps it disabled, and the pilot checkpoint creates probe follow-up beads only if source-only semantic evidence leaves important, actionable false negatives.

If created later, probe beads must stay opt-in:
- Run only on fixture-safe exported pure functions selected by an explicit probe profile.
- Use deterministic generated inputs from simple TypeScript signatures and literal examples.
- Execute in a worker with a timeout, no network, no filesystem writes, deterministic environment variables, and no access to conduit's runtime modules.
- Emit advisory evidence when both functions return equivalent normalized outputs for the generated corpus.
- Skip candidates with imports outside the fixture root, top-level side-effect signals, filesystem/network/process access, timers, randomness, `Date.now`, global mutation, non-deterministic async work, or unsupported signatures.
- Emit skipped evidence with a stable reason and do not execute unsafe candidates.

`BehaviorProbeRunner` is a private Module only if post-pilot probe work is created. It is not a public Seam and has no Adapter until a second execution backend exists.

## Output format

```json
{
  "type1": [
    {
      "id": "t1-001",
      "members": [
        { "file": "src/foo.ts", "unit": "isEmpty", "language": "ts", "unitKind": "function", "span": { "start": 10, "end": 18 } },
        { "file": "src/bar.ts", "unit": "isEmpty", "language": "ts", "unitKind": "function", "span": { "start": 45, "end": 52 } }
      ]
    }
  ],
  "type2": [
    {
      "id": "t2-001",
      "members": [
        { "file": "src/foo.ts", "unit": "validateUser", "language": "ts", "unitKind": "function", "span": { "start": 10, "end": 28 } },
        { "file": "src/bar.ts", "unit": "validateOrder", "language": "ts", "unitKind": "function", "span": { "start": 45, "end": 62 } }
      ]
    }
  ],
  "type3": [
    {
      "id": "t3-001",
      "similarity": 0.92,
      "members": [
        { "file": "src/foo.ts", "unit": "isEmpty", "language": "ts", "unitKind": "function", "span": { "start": 10, "end": 18 } },
        { "file": "src/bar.ts", "unit": "hasNoText", "language": "ts", "unitKind": "function", "span": { "start": 45, "end": 52 } }
      ]
    }
  ],
  "semanticEvidence": [
    {
      "id": "sem-001",
      "status": "advisory",
      "evidence": [
        { "type": "literal-static-expression", "detail": "same folded return shape" }
      ],
      "members": [
        { "file": "src/foo.ts", "unit": "makePolicy", "language": "ts", "unitKind": "function", "span": { "start": 10, "end": 30 } },
        { "file": "src/bar.ts", "unit": "buildPolicy", "language": "ts", "unitKind": "function", "span": { "start": 50, "end": 72 } }
      ]
    },
    {
      "id": "sem-002",
      "status": "skipped",
      "evidence": [
        { "type": "effect-yield-trace", "reason": "dynamic-effect-trace" }
      ],
      "members": [
        { "file": "src/foo.ts", "unit": "loadConfig", "language": "ts", "unitKind": "function", "span": { "start": 90, "end": 132 } },
        { "file": "src/bar.ts", "unit": "readConfig", "language": "ts", "unitKind": "function", "span": { "start": 15, "end": 61 } }
      ]
    }
  ],
  "stats": {
    "filesScanned": 951,
    "unitsCompared": 12453,
    "semanticCandidates": 18,
    "largestCandidateBucket": 112,
    "type1Clusters": 4,
    "type2Pairs": 9,
    "type3Pairs": 23
  }
}
```

Default JSON must be byte-stable for the same input tree and profile. It may contain deterministic counts, bucket sizes, semantic candidate counts, and skipped reasons, but it must not contain wall-clock duration, peak memory, timestamps, absolute temp paths, or other volatile runtime measurements. Performance measurements belong in the pilot performance artifact and Beads note, not in the default `ReportWriter` output.

Every result member carries stable source span data plus enough discriminants for agents to understand mixed input: `language` (`ts`, `tsx`, or `svelte`) and `unitKind` (`function`, `method`, `svelteTemplate`, `svelteBlock`, and so on). Do not add a result-level `kind` for language or evidence category; it becomes ambiguous for mixed TS/Svelte pairs. Structural category comes from the containing array (`type1`, `type2`, `type3`), and semantic category comes from `semanticEvidence[].evidence[].type`. `EXT-RESULT-01` freezes those member discriminants before Svelte and semantic subagents run in parallel.

In the structural result model, `type2` and `type3` entries are pair candidates with exactly two members. Do not merge overlapping T2/T3 pairs into connected clusters until pilot output proves that extra Implementation is useful. T1 may remain multi-member hash buckets. A Type-2 pair is emitted only when two members share an AST hash and have different raw hashes; exact pairs inside that AST bucket are still classified as Type-1, but either exact member may also appear in a separate Type-2 pair with a renamed/literal-changed sibling. Semantic evidence entries are also pair candidates, but v1 semantic evidence does not duplicate pairs already reported in T1/T2/T3. If the pilot shows agents need semantic annotations on structural results, add that as a separate output-shape bead.

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
  --include extensions          ts,tsx,svelte (default: ts,tsx,svelte)
  --respect-gitignore           Honor .gitignore (default: on)
  --ignore pattern              Additional ignore pattern (repeatable)
```

Structural thresholds, Svelte behavior, and semantic evidence policy live in profiles. Candidate-index sizing and callback eligibility stay private until pilot users need them; every new flag or profile key expands the Interface callers must learn. Runtime behavior probing is profile-only; do not add a CLI shortcut until there is real user demand.

## Conduit profile after `EXT-PROFILE-01`

```json
{
  "include": ["src/**/*.ts", "src/**/*.tsx", "src/**/*.svelte"],
  "ignore": [
    "dist", ".worktrees", ".beads", "node_modules", ".svelte-kit", "coverage",
    "packages/dry4ts/dist", "packages/dry4ts/test/fixtures",
    "**/*.d.ts", "**/generated/**"
  ],
  "structural": {
    "minLines": 6,
    "minNodes": 24,
    "erasePropertyNames": false,
    "threshold": 0.84
  },
  "svelte": {
    "enabled": true,
    "script": true,
    "template": true,
    "style": false
  },
  "semantic": {
    "enabled": true,
    "literalStatic": true,
    "effectYieldTrace": true,
    "behaviorProbe": "disabled"
  },
  "type1": { "enabled": true },
  "type2": { "enabled": true },
  "type3": { "enabled": true }
}
```

The `conduit` profile is production-first. Test fixtures and repeated example setup can be useful later, but they are noisy for the first architecture signal. If pilot review wants test duplication, create a separate `conduit-tests` profile and bead after the production pilot.

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
| **Regression** | Snapshot vs conduit slice and non-blocking pilot comparisons for the full planned scope |

### Local invariant tests

Do not prewrite a unit-test suite from an imagined internal design. A child bead starts with one failing public-interface behavior test. After that test is green, add a local unit test only when the implementation revealed an invariant that would be hard to diagnose through runner output.

Good local invariant tests protect concrete behavior already forced by a green acceptance path: hash-input determinism after `T1-02`, pair-specific T2 overlap after `T2-04`, Jaccard threshold math after `T3-TS-01`, or stable non-empty JSON sorting after `REPORT-NONEMPTY-01`. They are not separate closure criteria, and they must not force helper files or private Modules to exist before the red behavior needs them.

### Property tests

The only initial property bead is file-order determinism, run immediately after the first non-empty T1 output exists:

- `PROP-FILEORDER-01` — permuting input file order produces identical JSON output bytes.

Use fast-check with a fixed seed for that property. Do not pre-create a broader property suite. Create later property beads only after a green behavior or real bug exposes an invariant that an acceptance test cannot localize cheaply.

### Acceptance tests

End-to-end smoke for each planned behavior.

#### CLI and profile
- `CLI-JSON-01` — Empty fixture directory emits stable JSON.
- `REPORT-NONEMPTY-01` — A non-empty T1 result serializes through the CLI JSON contract with stable ids, members, spans, language, unit kind, and stats.
- `PROFILE-CONDUIT-01` — `--profile conduit --effective-profile` emits deterministic resolved config and includes production TS/TSX source with Svelte and semantic settings disabled until `EXT-PROFILE-01` owns the shared profile expansion.
- `EXT-PROFILE-01` — The resolved conduit profile includes `.svelte` production inputs and semantic advisory config, with behavior probes disabled.
- `EXT-RESULT-01` — The result model and JSON writer can render Svelte `language` / `unitKind` discriminants from a synthetic result without implementing Svelte lowering.
- `EXT-SEMANTIC-SLOT-01` — Empty output includes a stable `semanticEvidence` array and `Dry4tsRunner` has a no-op semantic detector call site.
- `EXT-SEMANTIC-JSON-01` — A synthetic non-empty semantic evidence result serializes through the CLI JSON contract with stable ids, status, evidence type/detail or reason, members, spans, language, and unit kind.
- `EXT-COMPATIBILITY-01` — TS function comparison units expose the compatibility facts semantic candidate selection needs without semantic code editing extractor or result-model files.

#### Type-1
- `T1-01` — Two byte-identical functions in different files reported as T1.
- `PROP-FILEORDER-01` — Permuting input file order produces identical JSON output bytes once the first non-empty T1 output exists.
- `T1-02` — Whitespace/comment-only differences still report as T1.
- `T1-04` — Changed string/template/regex literal token text, including whitespace inside string literals, does NOT report as T1.
- `T1-03` — Identical code in different positions of the same file reported as T1.

#### Type-2
- `T2-01` — Identical structure with renamed locals reported as T2 (not T1).
- `T2-02` — Identical structure with different literal values reported as T2.
- `T2-03A` — Identical structure with different property names is NOT reported as T2 under default config because property names are preserved.
- `T2-03B` — The same pair reports as T2 when a profile fixture enables `erasePropertyNames`.
- `T2-04` — An AST bucket with an exact T1 pair plus a renamed/literal-changed sibling still reports explicit T2 pairs for the renamed/literal-changed relations; exact pairs are not duplicated as T2 pairs.

#### Type-3 TS
- `T3-TS-01` — Function with the same broad structure plus one inserted early guard clause reports as a T3 pair, not T1/T2.
- `T3-TS-02` — Function with rewritten control flow does NOT match original at J ≥ threshold.
- `T3-STATS-01` — Deterministic T3 candidate counts and largest-bucket stats are present for the direct comparison path.
- `T3-IDX-01` — Pairwise work is limited to loose structural-signature buckets without dropping the inserted-guard T3 pair.

#### Additional TS unit shapes
- `T-OM-01` — Object method clone detected through the extractor path.
- `T-CLASS-01` — Class method clone detected through the extractor path.
- `T-VARFN-01` — Arrow/function expression assigned to a variable detected through the extractor path.

#### Early conduit signal
- `STRUCTURAL-CONDUIT-SNAPSHOT-01` — After structural TS is green, a copied production-first conduit slice emits stable structural-only JSON and records threshold/unit-granularity observations in Beads notes without tuning thresholds.

#### Performance & determinism
- Performance is measured only in the pilot performance bead. Determinism is locked earlier by `PROP-FILEORDER-01`.

#### Svelte structural
- `SV-SCRIPT-01` — Functions inside a Svelte `<script lang="ts">` block enter the existing detector path and report the same clone type as equivalent TS functions.
- `SV-TEMPLATE-01` — Two byte-identical eligible Svelte component templates report a T1 clone with stable `language: "svelte"`, `unitKind: "svelteTemplate"`, and source spans.
- `SV-TEMPLATE-02` — Two Svelte component templates with the same element/control-flow structure but different text, class values, and local variable names report as a T3 pair.
- `SV-BLOCK-01` — Large `{#if}` / `{#each}` blocks inside otherwise different Svelte components report a structural clone without requiring the whole component template to match.
- `SV-SNIPPET-01` — Two eligible templates using equivalent `{#snippet}` / `{@render}` structure report the same public clone/non-clone behavior as equivalent non-snippet templates; any trait-level checks are post-green local invariants.
- `SV-RUNE-PROPS-01` — Two Svelte script units using `$props()` with renamed locals report the expected structural clone through runner output.
- `SV-RUNE-STATE-01` — `$state(...)` literal values normalize away without preserving local variable names.
- `SV-RUNE-DERIVED-01` — `$derived(...)` expression shape contributes to structural comparison through public clone/non-clone output.
- `SV-RUNE-EFFECT-01` — `$effect(...)` body structure contributes to structural comparison without preserving local variable names.
- `SV-ATTR-STATIC-01` — Different static attribute names are preserved by default, so semantically different markup does not collapse into a clone.
- `SV-DIRECTIVE-EVENT-01` — Different event/bind/action directive names are preserved by default, so semantically different bindings do not collapse into a clone.

#### Semantic evidence
- `SEM-LIT-01` — Structurally different units with the same folded literal/static return shape emit advisory semantic evidence.
- `SEM-INDEPENDENT-01` — Semantic literal evidence still emits when structural results contain no T1/T2/T3 pair, proving semantic selection does not depend on private T3 near-miss internals.
- `SEM-LIT-02` — Structurally different units with different folded literal/static return shapes emit no semantic evidence.
- `SEM-EFFECT-01` — Two Effect pipelines with the same static service Tag yield trace emit advisory semantic evidence.
- `SEM-EFFECT-02` — Effect pipelines with dynamic or unresolved service Tags emit skipped evidence with `reason: "dynamic-effect-trace"` instead of advisory evidence.
- `SEM-SVELTE-LIT-01` — After Svelte and semantic checkpoints are green, compatible Svelte template/block units with the same folded static condition/directive expression emit advisory semantic evidence without extractor-emitted semantic facts.

#### Optional behavior probes
- `SEM-PROBE-01` — Post-pilot only: with an explicit probe-enabled profile, two fixture-safe pure functions that produce equal outputs over deterministic generated inputs emit advisory semantic evidence.
- `SEM-PROBE-02` — Post-pilot only: one representative unsafe probe candidate emits skipped evidence and is not executed; imports, top-level side effects, globals, time/random/fs/network access, unsupported signatures, and timeout risks become separate follow-up beads after the first skip path is green.

### Regression tests

- **Structural-only conduit snapshot** — after structural TS work, dry4ts output on a copied production-first conduit fixture slice matches stable structural-only JSON and records threshold/unit-granularity observations before extension work starts.
- **Full-scope conduit-slice snapshot** — dry4ts output on the copied conduit fixture slice matches a stored JSON snapshot including TS, Svelte, and semantic evidence. Updates require explicit `--update` and PR review.
- **Performance profile** — measurement-only pilot bead records runtime and memory using an external command or script plus existing deterministic stats in a performance artifact or Beads note, not in default JSON. It does not judge false positives or create performance follow-up beads. No runtime or memory gate is introduced until the pilot data is reviewed.
- **External overlap note** — If the pilot owner runs `jscpd` or another existing clone detector outside the package, record any useful overlap/miss examples in the pilot report. This is non-blocking and must not add a package dependency.

### Test infrastructure

- **Runner:** Vitest.
- **Properties:** fast-check only for the file-order determinism bead (`seed: 0xDEADBEEF`, `numRuns: 100` unless the bead says otherwise).
- **Fixtures:** hand-crafted `.ts`, `.tsx`, and `.svelte` files under `packages/dry4ts/test/fixtures/<scenario>/`. No parser mocking — fixtures are real source files. Each acceptance fixture must exceed the active profile's `minLines` and `minNodes`, or the bead must explicitly add/select a named test profile and include it in its Red and Verification commands.
- **No network, deterministic time:** tests run offline; optional post-pilot behavior-probe tests use fixed inputs and bounded timeouts but never assert wall-clock duration.
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

The beads below are templates, not a backlog. The normative gates above decide when a real Beads issue is created. Create parent beads for headings, then create child beads stage-by-stage: initial serial path first, Stage B structural hardening after `structural-interface-checkpoint`, structural conduit snapshot after `structural-checkpoint`, extension contract children after that snapshot, Svelte/semantic children after the extension contract checkpoint, and final pilot beads after `full-scope-checkpoint`. Use `bd dep add` for every dependency in the authoritative graph above. Do not pre-create later-stage children just because their row is documented here.

### Parent - Package setup and CLI contract

| Child bead | Depends on | Owner / files | Red | Expected failure | Green | Verification |
|---|---|---|---|---|---|---|
| Package setup | none | Serial owner of `pnpm-workspace.yaml`, `packages/dry4ts/package.json`, package config, initial lockfile. | `pnpm --filter dry4ts check` | Package cannot be resolved before setup; this bead is infrastructure-only. | Workspace package exists with split-ready scripts and no implementation beyond CLI stub wiring; `pnpm-workspace.yaml` has `packages: ["packages/*"]` or equivalent YAML while preserving existing `allowBuilds`. | `pnpm --filter dry4ts check` |
| `CLI-JSON-01` empty JSON | Package setup | `src/bin/dry4ts.ts`, `src/core/runner.ts`, `src/core/run-profile.ts`, `src/report/report-writer.ts`, `test/acceptance/cli-json-contract.test.ts`. | `pnpm --filter dry4ts test -- test/acceptance/cli-json-contract.test.ts -t "CLI-JSON-01"` | CLI output missing or not stable JSON. | Empty fixture directory emits stable JSON with empty `type1`, `type2`, `type3`, and stats. | `pnpm --filter dry4ts check && pnpm --filter dry4ts test -- test/acceptance/cli-json-contract.test.ts` |
| `PROFILE-CONDUIT-01` effective profile | `CLI-JSON-01` | `src/bin/dry4ts.ts` if CLI parsing needs changes, `src/core/run-profile.ts`, `test/acceptance/profile.test.ts`; serial if it needs `src/core/runner.ts` or `src/report/report-writer.ts`. | `pnpm --filter dry4ts test -- test/acceptance/profile.test.ts -t "PROFILE-CONDUIT-01"` | Effective profile is missing, unstable, includes tests by default, or includes Svelte/semantic settings before `EXT-PROFILE-01` owns that expansion. | `--profile conduit --effective-profile` reports deterministic production TS/TSX structural config. | `pnpm --filter dry4ts test -- test/acceptance/profile.test.ts` |

### Parent - Structural TS detection

Serial until `structural-checkpoint` because extraction, normalization, and `StructuralCloneDetector` are still taking shape. Do not add extractor seams only to make this table parallel-friendly.

| Child bead | Depends on | Owner / files | Red | Expected failure | Green | Verification |
|---|---|---|---|---|---|---|
| `T1-01` byte-identical functions | `CLI-JSON-01` | Owner of first structural path: `src/core/runner.ts` if wiring is not already frozen, `src/extract/comparison-unit-extractor.ts`, `src/structural/structural-clone-detector.ts`, `test/acceptance/type1.test.ts`; avoid `src/report/report-writer.ts` unless the packet explicitly owns JSON rendering. Keep TS lowering in `comparison-unit-extractor.ts` unless a green refactor proves a private helper file earns Locality. | `pnpm --filter dry4ts test -- test/acceptance/type1.test.ts -t "T1-01"` | No T1 cluster for identical functions. | TS function extraction, raw hash bucketing, and stable result-model T1 cluster through `Dry4tsRunner`. | `pnpm --filter dry4ts test -- test/acceptance/type1.test.ts` |
| `REPORT-NONEMPTY-01` non-empty JSON contract | `T1-01` | `src/report/report-writer.ts`, `test/acceptance/cli-json-contract.test.ts`; may edit `src/core/types.ts` only if the result model lacks required public fields. | `pnpm --filter dry4ts test -- test/acceptance/cli-json-contract.test.ts -t "REPORT-NONEMPTY-01"` | T1 exists in runner result data but CLI JSON omits it, sorts it unstably, or loses ids, members, spans, language, unit kind, or stats. | Non-empty T1 output serializes through the CLI JSON contract with stable ids, members, spans, `language`, `unitKind`, and deterministic stats. | `pnpm --filter dry4ts test -- test/acceptance/cli-json-contract.test.ts test/acceptance/type1.test.ts` |
| `PROP-FILEORDER-01` file-order determinism | `REPORT-NONEMPTY-01` | `test/property/file-order-determinism.test.ts`; may edit `src/core/runner.ts` or `src/report/report-writer.ts` only if red proves ordering is unstable. | `pnpm --filter dry4ts test -- test/property/file-order-determinism.test.ts -t "PROP-FILEORDER-01"` | Permuting input file order changes JSON bytes for the first non-empty T1 output. | Input traversal, result sorting, and JSON rendering are stable across file-order permutations before more extraction behavior lands. | `pnpm --filter dry4ts test -- test/property/file-order-determinism.test.ts` |
| `T1-02` whitespace/comments | `PROP-FILEORDER-01` | Raw-text normalization inside `ComparisonUnitExtractor` or private Implementation extracted after green. | `pnpm --filter dry4ts test -- test/acceptance/type1.test.ts -t "T1-02"` | Whitespace/comment-only changes miss T1. | Comments stripped, whitespace collapsed, string-literal whitespace preserved. | `pnpm --filter dry4ts test -- test/acceptance/type1.test.ts` |
| `T1-04` literal token safety | `T1-02` | Raw-text tokenization inside `ComparisonUnitExtractor` or private Implementation extracted after green. | `pnpm --filter dry4ts test -- test/acceptance/type1.test.ts -t "T1-04"` | Changed string/template/regex literal token text is normalized away and reports as T1. | Scanner/token-based raw normalization preserves literal token text, including whitespace inside string literals, so changed literal tokens do not report as T1. | `pnpm --filter dry4ts test -- test/acceptance/type1.test.ts -t "T1-04"` |
| `T1-03` same-file positions | `T1-04` | Source-span and unit identity mapping. | `pnpm --filter dry4ts test -- test/acceptance/type1.test.ts -t "T1-03"` | Same-file duplicates collapse into one member or lose spans. | Multiple comparison units from one file keep distinct source spans. | `pnpm --filter dry4ts test -- test/acceptance/type1.test.ts` |
| `T2-01` renamed locals | `T1-03` | TypeScript AST normalization through `ComparisonUnitExtractor` and `StructuralCloneDetector`. | `pnpm --filter dry4ts test -- test/acceptance/type2.test.ts -t "T2-01"` | Renamed locals are missed or reported as T1. | TS AST normalization erases local names and reports T2, not T1. | `pnpm --filter dry4ts test -- test/acceptance/type2.test.ts` |
| `T2-02` literal erasure | `T2-01` | TypeScript AST normalization only. | `pnpm --filter dry4ts test -- test/acceptance/type2.test.ts -t "T2-02"` | Literal changes break T2. | Literal values normalize away without hiding operators or control flow. | `pnpm --filter dry4ts test -- test/acceptance/type2.test.ts` |
| `T2-03A` property names preserved by default | `T2-02` | Profile + TS normalization. | `pnpm --filter dry4ts test -- test/acceptance/type2.test.ts -t "T2-03A"` | Different property names report as T2 under default config. | Property names are preserved by default, so this pair is not a clone. | `pnpm --filter dry4ts test -- test/acceptance/type2.test.ts -t "T2-03A"` |
| `T2-03B` property-name erasure profile | `T2-03A` | Profile + TS normalization. | `pnpm --filter dry4ts test -- test/acceptance/type2.test.ts -t "T2-03B"` | `erasePropertyNames` profile fixture still misses T2. | Property names are erased only when profile config enables it. | `pnpm --filter dry4ts test -- test/acceptance/type2.test.ts` |
| `T2-04` pair-specific overlap | `T2-03B` | `StructuralCloneDetector` classification only. | `pnpm --filter dry4ts test -- test/acceptance/type2.test.ts -t "T2-04"` | A T1 pair in an AST bucket hides a renamed/literal-changed sibling, or exact pairs are duplicated as T2. | Exclusion is pair-specific: exact pairs stay T1, renamed/literal-changed relations emit explicit two-member T2 pairs. | `pnpm --filter dry4ts test -- test/acceptance/type2.test.ts` |
| `T3-TS-01` near-miss structural match | `T2-04` | `StructuralCloneDetector` T3 path: fingerprints, similarity, most-specific T3 pair classification. Candidate limiting is all-units or deliberately loose for this small fixture. | `pnpm --filter dry4ts test -- test/acceptance/type3-ts.test.ts -t "T3-TS-01"` | A true near-miss pair is missed or reported as T1/T2. | One function with the same broad structure plus one inserted early guard clause reports as a T3 pair. | `pnpm --filter dry4ts test -- test/acceptance/type3-ts.test.ts -t "T3-TS-01"` |
| `T3-TS-02` rewritten-control-flow negative | `T3-TS-01` | Serial owner for this bead; `test/acceptance/type3-negative.test.ts`; may edit `src/structural/structural-clone-detector.ts` if red proves classifier/similarity change is needed. | `pnpm --filter dry4ts test -- test/acceptance/type3-negative.test.ts -t "T3-TS-02"` | Materially different control flow is reported as T3. | Pair stays below threshold or is filtered by loose structural signature before stats/indexing build on this behavior. | `pnpm --filter dry4ts test -- test/acceptance/type3-negative.test.ts` |
| `T3-STATS-01` deterministic T3 stats | `T3-TS-02` | `StructuralCloneDetector` result stats and `ReportWriter` stats rendering if the behavior asserts JSON. | `pnpm --filter dry4ts test -- test/acceptance/type3-ts.test.ts -t "T3-STATS-01"` | Candidate counts or largest-bucket stats are missing or unstable. | Direct-comparison T3 path emits deterministic candidate counts and largest-bucket stats. | `pnpm --filter dry4ts test -- test/acceptance/type3-ts.test.ts` |
| `T3-IDX-01` candidate index limiter | `T3-STATS-01` | Private candidate index inside `StructuralCloneDetector`; avoid changing extractor or public profile keys. | `pnpm --filter dry4ts test -- test/acceptance/type3-ts.test.ts -t "T3-IDX-01"` | Pairwise work is unbounded or the inserted-guard pair is pruned. | T3 comparisons run only inside loose structural-signature buckets and still find the inserted-guard pair. | `pnpm --filter dry4ts test -- test/acceptance/type3-ts.test.ts` |
| `T-OM-01` object methods | `T3-IDX-01` | Serial owner: `src/extract/comparison-unit-extractor.ts`, optional private file only if green refactor needs Locality, `test/acceptance/extract-object-methods.test.ts`. | `pnpm --filter dry4ts test -- test/acceptance/extract-object-methods.test.ts -t "T-OM-01"` | Object method clones are not extracted/reported. | Object methods enter comparison units and report through the existing detector path. Do not create class/variable extension slots for future beads unless this behavior needs that refactor. | `pnpm --filter dry4ts test -- test/acceptance/extract-object-methods.test.ts` |
| Structural interface checkpoint | `T-OM-01` | Integration owner only; documents current `Dry4tsRunner`, `ComparisonUnitExtractor`, `StructuralCloneDetector`, and `ReportWriter` Interfaces. It must not create new feature files or call sites. | No new red test. | Current T1/T2/T3/object-method behavior fails, public Interface shape is still changing, or the next serial bead's ownership is unclear. | Core interfaces are documented and the first T1/T2/T3 positive/negative/object-method behaviors pass together. | `pnpm --filter dry4ts test -- test/acceptance/type1.test.ts test/acceptance/type2.test.ts test/acceptance/type3-ts.test.ts test/acceptance/type3-negative.test.ts test/acceptance/extract-object-methods.test.ts` |
| `T-CLASS-01` class methods | Structural interface checkpoint | Serial owner: `src/extract/comparison-unit-extractor.ts`, optional private file only if green refactor needs Locality, `test/acceptance/extract-class-methods.test.ts`. | `pnpm --filter dry4ts test -- test/acceptance/extract-class-methods.test.ts -t "T-CLASS-01"` | Class method clone is not extracted/reported. | Byte-identical class methods enter comparison units and report through the existing T1 path. | `pnpm --filter dry4ts test -- test/acceptance/extract-class-methods.test.ts` |
| `T-VARFN-01` exported const arrows/functions | `T-CLASS-01` | Serial owner: `src/extract/comparison-unit-extractor.ts`, optional private file only if green refactor needs Locality, `test/acceptance/extract-variable-functions.test.ts`. | `pnpm --filter dry4ts test -- test/acceptance/extract-variable-functions.test.ts -t "T-VARFN-01"` | Variable-assigned function clone is not extracted/reported. | Byte-identical arrow/function expressions assigned to variables enter comparison units and report through the existing T1 path. | `pnpm --filter dry4ts test -- test/acceptance/extract-variable-functions.test.ts` |
| Structural checkpoint | `PROFILE-CONDUIT-01`, `T-VARFN-01` | Integration owner only; no feature edits. | No new red test. | Any structural acceptance, conduit effective-profile behavior, non-empty JSON contract, or determinism check fails after merging child branches. | T1/T2/T3 acceptance, extraction-shape acceptance, conduit profile, non-empty JSON, and file-order determinism pass on merged branch. | `pnpm --filter dry4ts test -- test/acceptance/cli-json-contract.test.ts test/acceptance/profile.test.ts test/acceptance/type1.test.ts test/acceptance/type2.test.ts test/acceptance/type3-ts.test.ts test/acceptance/type3-negative.test.ts test/acceptance/extract-object-methods.test.ts test/acceptance/extract-class-methods.test.ts test/acceptance/extract-variable-functions.test.ts test/property/file-order-determinism.test.ts` |

### Parent - Early conduit structural signal

This parent runs before Svelte and semantic work. It does not tune thresholds or change architecture; it records whether structural-only output on a production-first conduit slice is plausible enough for the next planned stage.

| Child bead | Depends on | Owner / files | Red | Expected failure | Green | Verification |
|---|---|---|---|---|---|---|
| `STRUCTURAL-CONDUIT-SNAPSHOT-01` structural conduit snapshot | Structural checkpoint | `test/regression/conduit-structural-fixture.test.ts`, `test/fixtures/conduit-slice/**`; forbidden: Svelte/semantic implementation files, threshold tuning, default JSON schema changes. | `pnpm --filter dry4ts test -- test/regression/conduit-structural-fixture.test.ts -t "STRUCTURAL-CONDUIT-SNAPSHOT-01"` | Production-first conduit fixture output is missing, unstable, or too noisy to interpret before Svelte/semantic work begins. | Copied conduit-slice fixture emits stable structural-only JSON; the Beads note records threshold/unit-granularity observations and any follow-up beads, but does not tune thresholds in place. | `pnpm --filter dry4ts test -- test/regression/conduit-structural-fixture.test.ts` |

### Parent - Extension contract

This parent owns the shared output/profile expansion, non-empty semantic JSON shape, compatibility facts, and no-op semantic runner call site that let Svelte and semantic subagents work without fighting over public JSON shape. Keep it serial, but keep each bead to one observable contract so the red command proves the specific contract it owns.

| Child bead | Depends on | Owner / files | Red | Expected failure | Green | Verification |
|---|---|---|---|---|---|---|
| `EXT-PROFILE-01` Svelte/semantic profile expansion | `STRUCTURAL-CONDUIT-SNAPSHOT-01` | Serial owner of `src/core/run-profile.ts`, `test/acceptance/profile.test.ts`. | `pnpm --filter dry4ts test -- test/acceptance/profile.test.ts -t "EXT-PROFILE-01"` | Resolved conduit profile lacks `.svelte` production input, semantic advisory config, or disabled behavior-probe config. | `--profile conduit --effective-profile` reports Svelte include settings and semantic source-only settings without changing detection behavior. | `pnpm --filter dry4ts test -- test/acceptance/profile.test.ts` |
| `EXT-RESULT-01` Svelte member discriminants | `EXT-PROFILE-01` | Serial owner of `src/core/types.ts`, `src/report/report-writer.ts`, `test/acceptance/cli-json-contract.test.ts`. | `pnpm --filter dry4ts test -- test/acceptance/cli-json-contract.test.ts -t "EXT-RESULT-01"` | A synthetic Svelte result cannot render stable `language: "svelte"` and Svelte `unitKind` member discriminants. | Result model and JSON writer render Svelte member discriminants from synthetic result data without implementing Svelte lowering. | `pnpm --filter dry4ts test -- test/acceptance/cli-json-contract.test.ts` |
| `EXT-SEMANTIC-SLOT-01` empty semantic slot and call site | `EXT-RESULT-01` | Serial owner of `src/core/types.ts`, `src/core/runner.ts`, `src/report/report-writer.ts`, `test/acceptance/cli-json-contract.test.ts`. | `pnpm --filter dry4ts test -- test/acceptance/cli-json-contract.test.ts -t "EXT-SEMANTIC-SLOT-01"` | Empty output lacks stable `semanticEvidence`, or `Dry4tsRunner` has no no-op semantic detector call site. | Empty output includes stable `semanticEvidence: []`, and `Dry4tsRunner` calls a no-op `SemanticEvidenceDetector` without implementing semantic analyzers. | `pnpm --filter dry4ts test -- test/acceptance/cli-json-contract.test.ts` |
| `EXT-SEMANTIC-JSON-01` non-empty semantic JSON contract | `EXT-SEMANTIC-SLOT-01` | Serial owner of `src/core/types.ts`, `src/report/report-writer.ts`, `test/acceptance/cli-json-contract.test.ts`. | `pnpm --filter dry4ts test -- test/acceptance/cli-json-contract.test.ts -t "EXT-SEMANTIC-JSON-01"` | A synthetic semantic evidence result cannot render stable status/evidence/member fields. | Non-empty semantic evidence serializes through the CLI JSON contract with stable ids, `status`, evidence `type`/`detail` or `reason`, members, spans, `language`, and `unitKind`; no semantic score is emitted in v1. | `pnpm --filter dry4ts test -- test/acceptance/cli-json-contract.test.ts` |
| `EXT-COMPATIBILITY-01` semantic compatibility facts | `EXT-SEMANTIC-JSON-01` | Serial owner of `src/extract/comparison-unit-extractor.ts`, `src/core/types.ts` if needed, and `test/acceptance/semantic-literal.test.ts` or a narrow runner-interface test. | `pnpm --filter dry4ts test -- test/acceptance/semantic-literal.test.ts -t "EXT-COMPATIBILITY-01"` | Function units do not expose `parameterCount`, `async`, `generator`, and rough return shape facts needed by semantic selection. | TS function units carry the initial `UnitCompatibility` facts through the runner-facing path before semantic subagents launch. | `pnpm --filter dry4ts test -- test/acceptance/semantic-literal.test.ts -t "EXT-COMPATIBILITY-01"` |
| Extension contract checkpoint | `EXT-COMPATIBILITY-01` | Integration owner only; no feature edits. | No new red test. | Profile expansion, Svelte discriminant rendering, empty/non-empty semantic output, compatibility facts, or no-op semantic call-site behavior fails together. | Shared profile/result/report/runner/compatibility contracts are frozen before Svelte and semantic subagents launch. | `pnpm --filter dry4ts test -- test/acceptance/profile.test.ts test/acceptance/cli-json-contract.test.ts test/acceptance/semantic-literal.test.ts` |

### Parent - Svelte structural detection

Create this parent before implementation, but create child beads only after the extension contract checkpoint closes. Keep this chain serial unless a green refactor creates disjoint lowerer files and exact frozen call sites. After `SV-SCRIPT-01`, the integration owner may create a Svelte-lowerer locality checkpoint only if the green code already wants separate private files for script, template, block, snippet, rune, or attribute lowering; that checkpoint records exact files and call sites before any Svelte fanout. Do not split files just to create parallel work. These beads may run in parallel with the semantic chain because they own extraction/Svelte tests, not semantic analysis.

| Child bead | Depends on | Owner / files | Red | Expected failure | Green | Verification |
|---|---|---|---|---|---|---|
| `SV-SCRIPT-01` Svelte script functions | Extension contract checkpoint | `src/extract/comparison-unit-extractor.ts`, optional `src/extract/svelte-source.ts` only after green refactor needs Locality, Svelte fixtures, `test/acceptance/svelte-structural.test.ts`; forbidden: `src/semantic/**`. | `pnpm --filter dry4ts test -- test/acceptance/svelte-structural.test.ts -t "SV-SCRIPT-01"` | Functions inside `<script lang="ts">` are ignored or lose source spans. | Svelte script functions lower through the existing detector path and report the same clone type as equivalent TS functions. | `pnpm --filter dry4ts test -- test/acceptance/svelte-structural.test.ts -t "SV-SCRIPT-01"` |
| `SV-TEMPLATE-01` template T1 and span | `SV-SCRIPT-01` | `src/extract/svelte-source.ts`, optional private Svelte lowerer file only if green refactor needs Locality, Svelte fixtures, `test/acceptance/svelte-structural.test.ts`. | `pnpm --filter dry4ts test -- test/acceptance/svelte-structural.test.ts -t "SV-TEMPLATE-01"` | Byte-identical eligible component templates do not report T1, or span/language/unit kind is unstable. | Whole-component template clones report through runner output with stable span, `language: "svelte"`, and `unitKind: "svelteTemplate"`. | `pnpm --filter dry4ts test -- test/acceptance/svelte-structural.test.ts -t "SV-TEMPLATE-01"` |
| `SV-TEMPLATE-02` template near-miss | `SV-TEMPLATE-01` | `src/extract/svelte-source.ts`, Svelte fixtures, `test/acceptance/svelte-structural.test.ts`. | `pnpm --filter dry4ts test -- test/acceptance/svelte-structural.test.ts -t "SV-TEMPLATE-02"` | Similar Svelte templates with changed text/class values/local names are missed or reported as T1/T2. | Whole-component template units normalize text/class values/local names away and report a T3 pair through `StructuralCloneDetector`. | `pnpm --filter dry4ts test -- test/acceptance/svelte-structural.test.ts -t "SV-TEMPLATE-02"` |
| `SV-BLOCK-01` Svelte block clones | `SV-TEMPLATE-02` | `src/extract/svelte-source.ts`, Svelte fixtures, `test/acceptance/svelte-structural.test.ts`. | `pnpm --filter dry4ts test -- test/acceptance/svelte-structural.test.ts -t "SV-BLOCK-01"` | Large `{#if}` / `{#each}` blocks inside otherwise different templates are missed. | Eligible Svelte control-flow blocks report through runner output with stable spans without requiring the whole component template to match. | `pnpm --filter dry4ts test -- test/acceptance/svelte-structural.test.ts -t "SV-BLOCK-01"` |
| `SV-SNIPPET-01` snippets/render tags | `SV-BLOCK-01` | `src/extract/svelte-source.ts`, Svelte fixtures, `test/acceptance/svelte-structural.test.ts`. | `pnpm --filter dry4ts test -- test/acceptance/svelte-structural.test.ts -t "SV-SNIPPET-01"` | Equivalent snippet/render structures are missed, or semantically different snippet structures collapse into a clone. | Snippet/render support is visible through runner clone/non-clone output and spans; internal trait/hash assertions are optional post-green local invariants only. | `pnpm --filter dry4ts test -- test/acceptance/svelte-structural.test.ts -t "SV-SNIPPET-01"` |
| `SV-RUNE-PROPS-01` `$props()` structure | `SV-SNIPPET-01` | `src/extract/svelte-source.ts`, Svelte fixtures, `test/acceptance/svelte-structural.test.ts`. | `pnpm --filter dry4ts test -- test/acceptance/svelte-structural.test.ts -t "SV-RUNE-PROPS-01"` | `$props()` script structure is missed or preserves renamed locals. | `$props()` structure participates in public structural clone output while local names normalize away. | `pnpm --filter dry4ts test -- test/acceptance/svelte-structural.test.ts -t "SV-RUNE-PROPS-01"` |
| `SV-RUNE-STATE-01` `$state()` structure | `SV-RUNE-PROPS-01` | `src/extract/svelte-source.ts`, Svelte fixtures, `test/acceptance/svelte-structural.test.ts`. | `pnpm --filter dry4ts test -- test/acceptance/svelte-structural.test.ts -t "SV-RUNE-STATE-01"` | `$state(...)` literal values or local names prevent a structural match. | `$state(...)` contributes structure while local names and literal values normalize away. | `pnpm --filter dry4ts test -- test/acceptance/svelte-structural.test.ts -t "SV-RUNE-STATE-01"` |
| `SV-RUNE-DERIVED-01` `$derived()` structure | `SV-RUNE-STATE-01` | `src/extract/svelte-source.ts`, Svelte fixtures, `test/acceptance/svelte-structural.test.ts`. | `pnpm --filter dry4ts test -- test/acceptance/svelte-structural.test.ts -t "SV-RUNE-DERIVED-01"` | `$derived(...)` expression shape is ignored or over-normalized. | `$derived(...)` expression shape contributes to public clone/non-clone output with identifiers/literals normalized according to profile rules. | `pnpm --filter dry4ts test -- test/acceptance/svelte-structural.test.ts -t "SV-RUNE-DERIVED-01"` |
| `SV-RUNE-EFFECT-01` `$effect()` structure | `SV-RUNE-DERIVED-01` | `src/extract/svelte-source.ts`, Svelte fixtures, `test/acceptance/svelte-structural.test.ts`. | `pnpm --filter dry4ts test -- test/acceptance/svelte-structural.test.ts -t "SV-RUNE-EFFECT-01"` | `$effect(...)` body structure is ignored or preserves local variable names. | `$effect(...)` body structure contributes to public clone/non-clone output without preserving local variable names. | `pnpm --filter dry4ts test -- test/acceptance/svelte-structural.test.ts -t "SV-RUNE-EFFECT-01"` |
| `SV-ATTR-STATIC-01` static attribute preservation | `SV-RUNE-EFFECT-01` | `src/extract/svelte-source.ts`, Svelte fixtures, `test/acceptance/svelte-structural.test.ts`. | `pnpm --filter dry4ts test -- test/acceptance/svelte-structural.test.ts -t "SV-ATTR-STATIC-01"` | Different static attribute names collapse because attributes are erased. | Static attribute names are preserved by default, so semantically different markup does not collapse into a clone. | `pnpm --filter dry4ts test -- test/acceptance/svelte-structural.test.ts -t "SV-ATTR-STATIC-01"` |
| `SV-DIRECTIVE-EVENT-01` directive-name preservation | `SV-ATTR-STATIC-01` | `src/extract/svelte-source.ts`, Svelte fixtures, `test/acceptance/svelte-structural.test.ts`. | `pnpm --filter dry4ts test -- test/acceptance/svelte-structural.test.ts -t "SV-DIRECTIVE-EVENT-01"` | Different event/bind/action directive names collapse because directives are erased. | Event/bind/action directive names are preserved by default, so semantically different bindings do not collapse into a clone. | `pnpm --filter dry4ts test -- test/acceptance/svelte-structural.test.ts` |
| Svelte checkpoint | `SV-DIRECTIVE-EVENT-01` | Integration owner only; no feature edits. | No new red test. | Any Svelte behavior fails after merge, or Svelte changes destabilize TS structural output. | Svelte script/template/block/snippet/rune/attribute/directive acceptance passes alongside structural TS acceptance. | `pnpm --filter dry4ts test -- test/acceptance/svelte-structural.test.ts test/acceptance/type1.test.ts test/acceptance/type2.test.ts test/acceptance/type3-ts.test.ts test/acceptance/type3-negative.test.ts` |

### Parent - Semantic evidence

Create this parent before implementation, but create child beads only after the extension contract checkpoint closes. Keep this chain serial because the semantic detector Interface and evidence model are taking shape. These beads may run in parallel with the Svelte chain when their file scopes remain disjoint.

| Child bead | Depends on | Owner / files | Red | Expected failure | Green | Verification |
|---|---|---|---|---|---|---|
| `SEM-LIT-01` folded literal advisory | Extension contract checkpoint | `src/semantic/semantic-evidence-detector.ts`, semantic fixtures, `test/acceptance/semantic-literal.test.ts`; forbidden: `src/extract/svelte-source.ts`. | `pnpm --filter dry4ts test -- test/acceptance/semantic-literal.test.ts -t "SEM-LIT-01"` | Structurally different units with the same folded literal/static return shape emit no semantic evidence. | Semantic detector privately inspects comparison-unit source and emits stable advisory evidence for same folded expression shape. | `pnpm --filter dry4ts test -- test/acceptance/semantic-literal.test.ts -t "SEM-LIT-01"` |
| `SEM-INDEPENDENT-01` semantic independence from T3 | `SEM-LIT-01` | `src/semantic/semantic-evidence-detector.ts`, semantic fixtures, `test/acceptance/semantic-literal.test.ts`; forbidden: `src/structural/structural-clone-detector.ts`, `src/report/report-writer.ts`, `src/core/types.ts`, and `src/extract/svelte-source.ts`. | `pnpm --filter dry4ts test -- test/acceptance/semantic-literal.test.ts -t "SEM-INDEPENDENT-01"` | Semantic evidence disappears unless the structural detector has produced a T3 near-miss or private candidate internals. | Literal advisory evidence emits for compatible units when structural results are empty, using unit metadata plus `UnitCompatibility`/source inspection rather than private T3 data. | `pnpm --filter dry4ts test -- test/acceptance/semantic-literal.test.ts` |
| `SEM-LIT-02` literal negative | `SEM-INDEPENDENT-01` | `src/semantic/semantic-evidence-detector.ts`, optional private literal evaluator after green, semantic fixtures, `test/acceptance/semantic-literal.test.ts`. | `pnpm --filter dry4ts test -- test/acceptance/semantic-literal.test.ts -t "SEM-LIT-02"` | Different folded values still emit advisory evidence. | Literal/static evidence is emitted only when folded shapes match. | `pnpm --filter dry4ts test -- test/acceptance/semantic-literal.test.ts` |
| `SEM-EFFECT-01` static Effect trace advisory | `SEM-LIT-02` | `src/semantic/semantic-evidence-detector.ts`, optional private Effect trace file after green, semantic fixtures, `test/acceptance/semantic-effect.test.ts`. | `pnpm --filter dry4ts test -- test/acceptance/semantic-effect.test.ts -t "SEM-EFFECT-01"` | Equivalent static Effect yield traces emit no semantic evidence. | Effect pipelines with the same static service Tag yield/call trace emit advisory semantic evidence. | `pnpm --filter dry4ts test -- test/acceptance/semantic-effect.test.ts -t "SEM-EFFECT-01"` |
| `SEM-EFFECT-02` dynamic Effect trace skip | `SEM-EFFECT-01` | `src/semantic/semantic-evidence-detector.ts`, semantic fixtures, `test/acceptance/semantic-effect.test.ts`. | `pnpm --filter dry4ts test -- test/acceptance/semantic-effect.test.ts -t "SEM-EFFECT-02"` | Dynamic/unresolved service Tags emit confident advisory evidence or disappear silently. | Dynamic/unresolved Effect traces emit skipped evidence with stable reason `dynamic-effect-trace`. | `pnpm --filter dry4ts test -- test/acceptance/semantic-effect.test.ts` |
| Semantic checkpoint | `SEM-EFFECT-02` | Integration owner only; no feature edits. | No new red test. | Any source-only semantic acceptance fails, semantic output is unstable, or semantic work changes structural clone classification. | Literal and Effect semantic acceptance passes alongside structural TS acceptance and the extension-owned non-empty semantic JSON contract. | `pnpm --filter dry4ts test -- test/acceptance/cli-json-contract.test.ts test/acceptance/semantic-literal.test.ts test/acceptance/semantic-effect.test.ts test/acceptance/type1.test.ts test/acceptance/type2.test.ts test/acceptance/type3-ts.test.ts test/acceptance/type3-negative.test.ts` |
| `SEM-SVELTE-LIT-01` Svelte static-expression advisory | Semantic checkpoint, Svelte checkpoint | `src/semantic/semantic-evidence-detector.ts`, Svelte/semantic fixtures, `test/acceptance/semantic-svelte.test.ts`; forbidden: `src/extract/svelte-source.ts`. | `pnpm --filter dry4ts test -- test/acceptance/semantic-svelte.test.ts -t "SEM-SVELTE-LIT-01"` | Compatible Svelte template/block units with the same folded static condition/directive expression emit no semantic evidence, or semantic code needs extractor-emitted facts. | Semantic detector privately inspects Svelte comparison-unit source spans and emits advisory evidence for matching folded static template expressions without editing Svelte lowering. | `pnpm --filter dry4ts test -- test/acceptance/semantic-svelte.test.ts test/acceptance/svelte-structural.test.ts` |
| Full-scope checkpoint | Svelte checkpoint, `SEM-SVELTE-LIT-01` | Integration owner only; no feature edits. | No new red test. | Structural, Svelte, source-only semantic, Svelte semantic integration, CLI JSON, or file-order tests fail together after merge. | The full planned dry4ts scope passes before pilot data collection starts. | `pnpm --filter dry4ts test -- test/acceptance/cli-json-contract.test.ts test/acceptance/profile.test.ts test/acceptance/type1.test.ts test/acceptance/type2.test.ts test/acceptance/type3-ts.test.ts test/acceptance/type3-negative.test.ts test/acceptance/svelte-structural.test.ts test/acceptance/semantic-literal.test.ts test/acceptance/semantic-effect.test.ts test/acceptance/semantic-svelte.test.ts test/property/file-order-determinism.test.ts` |

### Parent - Conduit pilot

Pilot work waits for the full-scope checkpoint. Keep snapshot and measurement separate so agents can run/review them independently. The pilot report is integration-owned; parallel pilot subagents write Beads notes and optional artifacts, not `docs/pilot-conduit.md`.

| Child bead | Depends on | Owner / files | Red | Expected failure | Green | Verification |
|---|---|---|---|---|---|---|
| Deterministic conduit snapshot | Full-scope checkpoint | `test/regression/conduit-fixture.test.ts`, `test/fixtures/conduit-slice/**`; forbidden: `docs/pilot-conduit.md`. | `pnpm --filter dry4ts test -- test/regression/conduit-fixture.test.ts -t "conduit-slice snapshot"` | Conduit slice output is missing, unstable, or omits Svelte/semantic evidence fields. | Copied conduit-slice fixture produces stable sorted JSON across TS, Svelte, and semantic evidence; findings go in the Beads note or optional artifact. | `pnpm --filter dry4ts test -- test/regression/conduit-fixture.test.ts` |
| Performance profile | Full-scope checkpoint | Measurement artifact or Beads note only; forbidden: `docs/pilot-conduit.md`, source instrumentation, and default JSON schema changes. | `mkdir -p /Users/dstern/.cache/conduit/dry4ts-handoffs/<run-id>/performance && /usr/bin/time -lp pnpm --filter dry4ts exec dry4ts --profile conduit test/fixtures/conduit-slice --format json > /Users/dstern/.cache/conduit/dry4ts-handoffs/<run-id>/performance/dry4ts.json 2> /Users/dstern/.cache/conduit/dry4ts-handoffs/<run-id>/performance/time.txt` | Runtime/memory evidence is missing from the Beads note or optional artifact; this is a measurement-only pilot bead, not a behavior red. | Records runtime and memory from the external command plus existing deterministic bucket/semantic stats in a Beads note or optional artifact only. | Re-run the same command, then `bd update <performance-profile-id> --append-notes "performance artifact: /Users/dstern/.cache/conduit/dry4ts-handoffs/<run-id>/performance"` |
| Pilot checkpoint | Snapshot, performance | Integration owner only; owns `docs/pilot-conduit.md`; no feature edits. | No new red test. | Pilot report lacks a decision about thresholds, Svelte false positives/negatives, source-only semantic evidence usefulness, skipped reasons, callbacks, behavior-probe follow-up, external overlap, candidate limiting, MinHash, or architecture follow-ups. | `docs/pilot-conduit.md` integrates the full-scope snapshot/performance evidence and creates explicit follow-up Beads issues. | `pnpm --filter dry4ts test -- test/regression/conduit-fixture.test.ts` |

### Optional parent - Behavior probes

Create this parent only if the pilot checkpoint records important semantic false negatives that source-only literal/Effect evidence cannot explain. Probe work is not a dependency of the full-scope checkpoint or conduit pilot.

| Child bead | Depends on | Owner / files | Red | Expected failure | Green | Verification |
|---|---|---|---|---|---|---|
| `SEM-PROBE-01` opt-in pure behavior probe | Pilot-created probe parent | `src/semantic/semantic-evidence-detector.ts`, optional `src/semantic/behavior-probe-runner.ts` after green, semantic fixtures, `test/acceptance/semantic-probe.test.ts`. | `pnpm --filter dry4ts test -- test/acceptance/semantic-probe.test.ts -t "SEM-PROBE-01"` | Probe-enabled profile does not produce evidence for fixture-safe equivalent pure functions. | Opt-in probe runs deterministic input/output samples in a sandboxed worker and emits advisory evidence for equivalent outputs. | `pnpm --filter dry4ts test -- test/acceptance/semantic-probe.test.ts -t "SEM-PROBE-01"` |
| `SEM-PROBE-02` unsafe probe skip | `SEM-PROBE-01` | `src/semantic/semantic-evidence-detector.ts`, `src/semantic/behavior-probe-runner.ts` if already created, semantic fixtures, `test/acceptance/semantic-probe.test.ts`. | `pnpm --filter dry4ts test -- test/acceptance/semantic-probe.test.ts -t "SEM-PROBE-02"` | A representative unsafe probe candidate executes or vanishes without a reason. | The first unsafe/runtime-dependent candidate is not executed and emits a stable skipped evidence reason. Create separate follow-up beads for imports, top-level side effects, globals, time/random/fs/network, unsupported signatures, and timeout risks only after this path is green. | `pnpm --filter dry4ts test -- test/acceptance/semantic-probe.test.ts -t "SEM-PROBE-02"` |

### Deferred polish

- Performance candidate filters beyond the first measured bottleneck.
- Reporters (text, SARIF, markdown, HTML).
- Baseline file support for incremental checks.
- CI integration patterns.
- Documentation site.
- Optional: MCP server for agent integration.

## Future directions beyond this plan

- **Callback comparison** — include non-trivial inline callbacks once a separate eligibility policy and noise controls are designed.
- **CSS/style clone detection** — compare style blocks after structural Svelte results show whether style duplication matters.
- **MCP server** — expose `find_clones`, `explain_pair`, `validate_pair` as agent tools.
- **Configurable normalization strength** — strict / medium / loose modes.
- **Cross-track ranking** — recommend which clone to prefer based on complexity, test signal, and dependents.

## Pilot revisits

- **Svelte coverage.** Review whether script/template/block unit granularity is too noisy or still misses important frontend duplication.
- **Semantic usefulness.** Review whether source-only literal and Effect evidence produce actionable findings or mostly skipped/noisy output; create behavior-probe follow-ups only when the pilot shows important false negatives that source-only analysis cannot explain.
- **Callback granularity.** Create callback comparison follow-ups only if pilot fixtures show missed inline-callback duplication; start with an inclusion behavior before adding exclusion-policy beads.
- **Property-name normalization.** Preserve property names by default. Revisit after pilot to evaluate erasure-on-domain-code false-positive rate.
- **Candidate index.** Keep cheap structural-signature buckets. Add MinHash only if pilot bucket stats show pairwise comparison blowups.
- **Overlapping results across types.** Keep separate results per detected type. Revisit if pilot shows the same function repeatedly appearing in overlapping T2/T3 pairs in confusing ways.
