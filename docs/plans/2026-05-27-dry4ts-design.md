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

T1/T2/T3 share one extraction, normalization, fingerprinting, and classification pipeline. The first releasable milestone is TS/TSX structural detection, stable JSON output, a conduit profile, and a conduit pilot. Svelte template normalization, Type-4 semantic detection, and human-oriented text output are follow-up work created from pilot evidence.

## Goals

- **Deterministic.** No LLM calls. Reproducible across runs and machines.
- **Cover Type-1 through Type-3** for TS/TSX in v1.
- **Agent-friendly output.** JSON output, stable ordering, source spans, similarity scores, and run stats.
- **Single structural IR.** All v1 input lowers to a uniform structural representation; one set of similarity/clustering rules.
- **Fast first value.** Reuse the earlier UBM DRY-tool scope: TypeScript compiler AST, structural fingerprints, a non-blocking pilot sanity check against existing tools if useful, and Svelte only if the first pilot shows frontend coverage is necessary.

## Non-goals (v1)

- Proving semantic equivalence (we report candidates with evidence, not proofs).
- Symbolic execution or SMT solving.
- Cross-language clone detection.
- Svelte template structural detection.
- Runtime Type-4 probing, Effect-aware semantic traces, and literal-corpus validation.
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

Do not create post-v1 Svelte or Type-4 parent beads during initial implementation. The pilot checkpoint creates concrete follow-up beads only when pilot evidence justifies the added Implementation.

Minimum concrete dependency matrix:

```bash
# Replace each placeholder with the actual child/checkpoint bead id after creation.
bd dep add <cli-json-01-id> <package-setup-id>
bd dep add <profile-conduit-01-id> <cli-json-01-id>
bd dep add <t1-01-id> <cli-json-01-id>
bd dep add <t1-02-id> <t1-01-id>
bd dep add <t1-03-id> <t1-02-id>
bd dep add <t2-01-id> <t1-03-id>
bd dep add <t2-02-id> <t2-01-id>
bd dep add <t2-03-id> <t2-02-id>
bd dep add <t3-ts-01-id> <t2-03-id>
bd dep add <t3-idx-01-id> <t3-ts-01-id>
bd dep add <structural-interface-checkpoint-id> <t3-idx-01-id>
bd dep add <t3-ts-02-id> <structural-interface-checkpoint-id>
bd dep add <t3-ts-03-id> <structural-interface-checkpoint-id>
bd dep add <t3-ts-04-id> <structural-interface-checkpoint-id>
bd dep add <t-cb-01-id> <structural-interface-checkpoint-id>
bd dep add <t-cb-02-id> <t-cb-01-id>
bd dep add <t-cb-03-id> <t-cb-02-id>
bd dep add <t-cb-04-id> <t-cb-03-id>
bd dep add <structural-checkpoint-id> <t3-ts-02-id>
bd dep add <structural-checkpoint-id> <t3-ts-03-id>
bd dep add <structural-checkpoint-id> <t3-ts-04-id>
bd dep add <structural-checkpoint-id> <t-cb-04-id>
bd dep add <conduit-snapshot-id> <structural-checkpoint-id>
bd dep add <performance-profile-id> <conduit-snapshot-id>
bd dep add <pilot-checkpoint-id> <conduit-snapshot-id>
bd dep add <pilot-checkpoint-id> <performance-profile-id>
```

Child beads inside a parent should depend only on the immediately required prior behavior. Do not create one dependency chain just because the plan is written top-to-bottom. Parallel-ready examples:

- After `CLI-JSON-01`, the conduit profile/effective-profile bead may run in parallel with the first T1 structural bead if their allowed files are disjoint.
- After `structural-interface-checkpoint`, extraction shape beads may run in parallel only when each packet lists exact private extraction files and forbids shared orchestrator files.
- After the structural checkpoint, conduit snapshot and performance-profile prep may run in parallel.
- Post-v1 Svelte and Type-4 work may run in parallel with later analysis only after the pilot checkpoint creates explicit follow-up beads.

Parallel waves:

| Wave | Ready after | Parallel-ready child beads | Serial exclusions |
|---|---|---|---|
| 0 | none | Package setup only | Workspace and lockfile owner; no parallel package edits. |
| 1 | `CLI-JSON-01` | `PROFILE-CONDUIT-01` and `T1-01` if file scopes are disjoint | `ReportWriter` JSON contract is owned by `CLI-JSON-01`. |
| 2 | `structural-interface-checkpoint` | `T3-TS-02`, `T3-TS-03`, `T3-TS-04`, `T-CB-01` | Shared orchestrators are forbidden unless the packet names a private extraction file. |
| 3 | Structural checkpoint | Deterministic conduit snapshot and performance profile | Pilot checkpoint waits for both. |

Serial ownership points:

- `pnpm-workspace.yaml`, `packages/dry4ts/package.json`, and lockfile changes are owned by package/dependency beads.
- `src/core/runner.ts`, `src/extract/comparison-unit-extractor.ts`, and `src/structural/structural-clone-detector.ts` are shared orchestrator files. They are serial unless a checkpoint bead explicitly freezes their Interface for parallel work.
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
Handoff artifact: test-results/dry4ts/<run-id>/handoffs/<bead-id>.md
Manifest entry: test-results/dry4ts/<run-id>/handoff.manifest.json
Commit SHA: <subagent branch sha after green>
Stop and report if: dependency is not green, base branch is stale, an allowed-file list is wrong, package metadata must change, or implementation needs a shared file owned by another open bead.
```

Subagents must work in their assigned worktree, never in the shared main checkout. They must not stash or revert unrelated work. Before handoff they update their bead, run verification, commit their branch, and write the handoff artifact with: files changed, red failure observed, green verification output, commit SHA, unresolved risks, and follow-up beads created.

An integration agent or human owner merges one green bead branch at a time. For each merge: confirm `bd show <id>` dependencies are closed, merge/rebase the branch onto the integration base, run the bead verification command, update `test-results/dry4ts/<run-id>/handoff.manifest.json`, then run the next checkpoint command when all checkpoint dependencies are merged. If a merge needs files outside the subagent packet, stop and create a follow-up bead instead of expanding the merge in place.

Integration checkpoints:

1. After package setup and CLI contract: verify workspace commands, dependency ownership, empty JSON output, and effective-profile reporting.
2. After structural TS: verify T1/T2/T3 acceptance, callback eligibility, and file-order determinism.
3. Before pilot close: run conduit-slice regression and performance measurement, then create follow-up beads for Svelte, Type-4, threshold, external-tool overlap, or architecture changes.

Implementation agents should claim exactly one child bead, make the smallest maintainable change, run that bead's verification command, update or close the bead, and create follow-up beads for discovered work.

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

The v1 pipeline lowers TS/TSX comparison units to a shared structural IR:

```ts
type NormalNode = {
  kind: string;
  role?: string;
  attrs?: Record<string, string | number | boolean>;
  children: NormalNode[];
};
```

`kind` is a small vocabulary such as `function`, `if`, `call`, `member`, `binary`, or `literal`. `role` records child position when it matters (`condition`, `then`, `else`, `callee`, `argument`). `attrs` records normalized semantic shape such as operator kind, async/generator flags, declaration kind, property-name policy result, and coarse type shape. `attrs` must not contain source identifiers or literal values when the active normalization policy erases them.

TS and TSX lower into `NormalNode` inside `ComparisonUnitExtractor`. Future Svelte work should reuse this IR through a Svelte Adapter behind `ComparisonUnitExtractor`; callers should not need to know whether a unit came from a `.ts`, `.tsx`, or `.svelte` file.

### Deep modules and seams

Keep the implementation deep around a few stable interfaces:

- **ComparisonUnitExtractor**: turns target paths into comparison units with source spans and `NormalNode`s. It owns file scanning, ignore handling, parser selection, TS/TSX AST traversal, callback eligibility, minimum-size filtering, and source-span mapping. TS traversal is private Implementation in v1. Add a Svelte Adapter only when the post-v1 Svelte bead creates a second real Adapter.
- **StructuralCloneDetector**: owns raw hashes, AST hashes, subtree fingerprints, weighted Jaccard, and most-specific classification. Callers should not coordinate those modules themselves.
- **RunProfileResolver**: owns default config, built-in profile loading, CLI override precedence, validation, and effective-config reporting. Other modules receive a resolved run profile; they do not merge flags and profiles themselves.
- **Dry4tsRunner**: owns the deterministic orchestration of one run: resolve inputs, call extractor, call detector, attach stats, and hand the result model to the writer. The CLI should be a thin Adapter over this Module.
- **ReportWriter**: owns stable JSON output, sorting, ids, and source-span formatting.

The interface is the test surface. Unit tests may exercise inner pure functions where useful, but acceptance and regression tests should cross these deep module interfaces.

Module index:

| Module | Interface | Implementation owns | Adapter(s) | Does not own | First behavior test |
|---|---|---|---|---|---|
| `Dry4tsRunner` | Target paths + raw command/profile request in, stable result model out. | Orchestration, deterministic stage ordering, run stats, error shape, and the programmatic public test surface. | CLI Adapter first. | Parsing, normalization, clone detection rules, JSON rendering. | `CLI-JSON-01` through the CLI, then most acceptance tests may use this Interface directly for speed. |
| `ComparisonUnitExtractor` | Target paths + resolved run profile in, comparison units with raw text, `NormalNode`, unit kind, and source spans out. | File scanning, gitignore/profile ignores, parser selection, TS/TSX traversal, TS AST lowering to `NormalNode`, callback eligibility, size filtering, source-span mapping. | None in v1; TS traversal is private Implementation. Add a Svelte Adapter only after pilot creates a post-v1 bead. | Hashing, similarity, clone classification, output formatting. | `T1-01` through `Dry4tsRunner`; direct Interface tests only after an extraction invariant is hard to diagnose through runner output. |
| `StructuralCloneDetector` | Comparison units in, T1/T2 clusters and T3 pair candidates out. | Raw hashes, normalized-node hashes, subtree fingerprints, weighted Jaccard, most-specific classification, candidate counts, cheap candidate limiting. | None in v1; candidate index remains private Implementation until pilot data proves a real Adapter is needed. | Parsing, NormalNode lowering, post-v1 semantic detection, report writing. | `T1-01`, then `T2-01`, then `T3-TS-01` through the same Interface. |
| `RunProfileResolver` | CLI args + built-in profile name in, resolved run profile out. | Defaults, profile merge order, validation, effective-config reporting. | Built-in `default` and `conduit` profiles. | Clone detection behavior. | `PROFILE-CONDUIT-01` reports deterministic effective profile. |
| `ReportWriter` | Clone result model in, stable JSON bytes out. | Sorting, ids, source-span formatting, similarity rendering, stats rendering. | JSON writer only in v1. | Detection and validation. | Empty scan emits stable JSON; T1 result preserves sorted member order. |

Future Modules:

| Module | First allowed after | Intended Interface | Notes |
|---|---|---|---|
| `SvelteComparisonUnitAdapter` | Pilot shows frontend duplication is material. | `.svelte` source in, comparison units out through `ComparisonUnitExtractor`. | Script blocks reuse the TS traversal Implementation; template normalization must not change `StructuralCloneDetector`. CSS/style clones are separate follow-up work. |
| `Type4CloneDetector` | Structural pilot is reviewed and semantic duplicate examples are chosen. | Function candidates in, advisory semantic evidence out. | Start with classifier/skipped evidence. Runtime probing, Effect traces, literal corpus, and cross-shape validation are separate follow-up beads. |
| `LiteralCorpusExtractor` | Type-4 Track 3 is approved. | Test source + target symbol in, literal corpus or skipped evidence out. | `tryEvaluate` stays private Implementation; callers do not pass raw parser nodes or scopes. |

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
  src/normalize/
    raw-text.ts           whitespace + comment strip (T1 hash input)
    ts-structure.ts       TypeScript AST normalization (T2 hash + T3 fingerprints)
  src/report/
    report-writer.ts
  src/structural/
    structural-clone-detector.ts T1/T2/T3 orchestration and most-specific classification
    fingerprints.ts             T3 subtree fingerprint bag
    similarity.ts               T3 weighted Jaccard
    candidate-index.ts          cheap structural-signature buckets before Jaccard
  test/
    unit/
      normalize-raw-text.test.ts
      normalize-ts-structure.test.ts
      structural-clone-detector.test.ts
      fingerprints.test.ts
      similarity.test.ts
      candidate-index.test.ts
      report-writer.test.ts
    property/
      structural-invariants.test.ts
      pipeline-invariants.test.ts
    acceptance/
      cli-json-contract.test.ts
      profile.test.ts
      type1.test.ts
      type2.test.ts
      type3-ts.test.ts
      performance.test.ts
    regression/
      conduit-fixture.test.ts
    fixtures/
      ts/
      conduit-slice/
```

## Structural detection (T1 / T2 / T3)

T1, T2, and T3 share one extraction and normalization pipeline. The three types are points on a normalization-strength spectrum: same comparison units, same TypeScript compiler AST, same structural IR. The detector classifies each detected pair as the *most specific* type that matches.

### Comparison units

**TS / TSX v1:**
- function declarations
- class methods
- object methods (`{ foo() {...} }`)
- arrow / function expressions assigned to variables
- inline callback functions that meet the **callback eligibility rule**

**Callback eligibility rule.** An inline callback (e.g., the lambda passed to `.map(...)`, `.filter(...)`, `pipe(...)`) enters comparison if **any** of:

1. Has `>= N` normalized nodes (profile config `callbackMinNodes`, default 24).
2. Contains any control-flow construct (`if`, `switch`, `try`/`catch`, loops, top-level ternary).
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
3. Group units by structural signature: unit kind, normalized parameter count, rough return shape, normalized node-count bucket, and top-level control-flow shape.
4. Compare units pairwise via weighted Jaccard only within the same candidate-index bucket.
5. Pairs with `J(A, B) >= threshold` (default from profile) are **T3 candidates**.

The candidate index is deliberately cheap and private to `StructuralCloneDetector`. Do not expose MinHash, indexing strategy, or bucket internals in the public Interface unless the pilot proves a second Adapter is needed.

### Detection algorithm

```
for each unit u:
  rawHashTable[rawHash(u)].add(u)
  astHashTable[astHash(u)].add(u)
  fingerprints[u] = subtreeMultiset(normalize(u))
  candidateIndex[structuralSignature(u)].add(u)

T1Clusters  = rawHashTable buckets with size > 1
T2Clusters  = astHashTable buckets with size > 1, excluding any member already in T1Clusters
T3Candidates = pairs within candidateIndex buckets, J >= threshold,
               excluding pairs already in T1 or T2
```

T1 and T2 are O(N) hash bucketing. T3 is O(K^2) only inside cheap candidate-index buckets, with bucket sizes recorded in stats so the pilot can identify whether MinHash or another limiter is worth adding.

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

Start with a `SvelteComparisonUnitAdapter` behind `ComparisonUnitExtractor`:

- Script blocks reuse the TS traversal Implementation.
- Template blocks lower to the same `NormalNode` IR.
- The first behavior is one Svelte structural clone through the existing `StructuralCloneDetector` Interface.
- CSS/style clones are a separate follow-up, not part of the first Svelte bead.

### Type-4 semantic detection

Start with classifier/skipped evidence only:

- Pure, async, Effect, tested, and unsafe candidates are classified statically.
- Runtime probing is disabled and returns skipped evidence.
- No validated semantic clone is emitted until concrete conduit examples justify runtime execution.

Runtime probing, Effect traces, cross-shape matching, and literal-corpus validation are separate follow-up Modules. `BehaviorProbeRunner` is private Implementation until there are two execution Adapters or another caller. `LiteralCorpusExtractor` is the future public Interface for test-corpus extraction; raw `tryEvaluate(node, scope)` stays private so callers do not learn AST/scope internals.

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
    "type2Clusters": 9,
    "type3Pairs": 23,
    "durationMs": 18400
  }
}
```

In v1, `type3` entries are pair candidates with exactly two members. Do not merge overlapping T3 pairs into connected clusters until pilot output proves that extra Implementation is useful. T1/T2 may remain multi-member hash buckets.

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
  "include": ["src/**/*.ts", "src/**/*.tsx", "test/**/*.ts"],
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
| **Property** | Detector invariants via fast-check after the corresponding behavior exists; not a pre-written property suite |
| **Acceptance** | End-to-end smoke for one caller-visible behavior at a time |
| **Regression** | Snapshot vs conduit slice and non-blocking pilot comparisons |

### Behavior inventory for unit/property tests

This is a reference map for useful local tests, not implementation ordering, file-creation instructions, or closure criteria. A child bead starts with one failing public-interface behavior test. Add a unit or property test only after the acceptance behavior is green and the local test protects an invariant that would otherwise be hard to diagnose.

**`normalize/raw-text.ts`**
- Whitespace collapse leaves logic identical
- Comments stripped (line + block)
- String-literal whitespace preserved
- Line ending normalization (`\r\n` ↔ `\n`)
- Empty input handled

**`normalize/ts-structure.ts`** — TypeScript AST normalizer
- Identifier erasure: `const x = 1` and `const y = 1` → identical NormalNode
- Literal erasure: `1` and `2` → identical NormalNode
- Property name preservation/erasure honors config
- Control flow preserved: `if/else` ≠ `switch`
- Operator preserved: `+` ≠ `-`
- Async / generator flag preserved
- Statement order preserved
- Destructuring positional shape preserved
- Type structure light preservation (shape, not names)

**`structural/structural-clone-detector.ts`**
- Raw-hash bucket lookup correctness
- AST-hash bucket lookup correctness
- T1 deduplication: a T1 pair is not also reported as T2
- Self-pairs excluded
- Most-specific classification: T1 wins over T2 wins over T3
- Pair below threshold dropped

**`structural/fingerprints.ts`**
- Multiset count correctness (two identical subtrees → count 2)
- Hash stability across runs
- Empty / single-node trees handled

**`structural/similarity.ts`**
- Identical multisets → 1.0
- Disjoint multisets → 0.0
- Subset relation → partial in expected range
- Weight scheme behaves as specified

**`structural/candidate-index.ts`**
- Same structural-signature bucket → eligible for Jaccard
- Different bucket key → never pairwise compared for T3
- Largest bucket size is reported in stats

**`report/report-writer.ts`**
- Stable key ordering
- Span-to-line mapping for TS source positions
- Empty scan emits stable JSON

### Property-based meta-tests

All run with fast-check; `seed: 0xDEADBEEF`, `numRuns: 100` (configurable per-property).

**Structural invariants (T1 / T2 / T3):**
- `prop-T1-WhitespaceIrrelevant` — adding blank lines / changing indentation never changes T1 classification.
- `prop-T1-CommentsIrrelevant` — adding or removing comments never changes T1 classification.
- `prop-T2-RenamePreservesClone` — consistently renaming all identifiers in `f` and `g` doesn't change AST hash equality.
- `prop-T2-LiteralChangePreservesClone` — replacing all literal values doesn't change AST hash equality.
- `prop-T3-IdempotentNormalization` — `normalize(normalize(AST)) == normalize(AST)`.
- `prop-Classify-Monotone` — for any pair, the classifier always picks the most specific matching type (T1 > T2 > T3).
- `prop-Determinism` — running the detector twice on the same input produces identical output bytes.

**Pipeline invariants:**
- `prop-Pipeline-FileOrderIrrelevant` — permuting input file order produces identical results.
- `prop-Pipeline-LineEndings` — `\n` vs `\r\n` inputs produce identical fingerprints and classifications.
- `prop-Pipeline-WhitespaceIrrelevant` — extra blank lines or indentation changes never alter T1/T2/T3 classification when semantics are unchanged.

### Acceptance tests

End-to-end smoke for each v1 behavior.

#### CLI and profile
- `CLI-JSON-01` — Empty fixture directory emits stable JSON.
- `PROFILE-CONDUIT-01` — `--profile conduit --effective-profile` emits deterministic resolved config and includes TS/TSX only.

#### Type-1
- `T1-01` — Two byte-identical functions in different files reported as T1.
- `T1-02` — Whitespace/comment-only differences still report as T1.
- `T1-03` — Identical code in different positions of the same file reported as T1.

#### Type-2
- `T2-01` — Identical structure with renamed locals reported as T2 (not T1).
- `T2-02` — Identical structure with different literal values reported as T2.
- `T2-03` — Identical structure with different property names NOT reported as T2 under default config (property names preserved); same pair reported as T2 when a profile fixture enables `erasePropertyNames`.

#### Type-3 TS
- `T3-TS-01` — Function with the same broad structure plus one inserted/removed guard, logging branch, or validation step reports as a T3 pair, not T1/T2.
- `T3-IDX-01` — Candidate-index stats are present and pairwise work is limited to structural-signature buckets.
- `T3-TS-02` — Function with rewritten control flow does NOT match original at J ≥ threshold.
- `T3-TS-03` — Class method clone detected across files.
- `T3-TS-04` — Arrow function assigned to const detected.

#### Callback granularity
- `T-CB-01` — Trivial callbacks (`x => x.foo`, `(a,b) => a-b`, `u => u.active`) excluded from comparison (no clone results formed).
- `T-CB-02` — Large single-expression projection (`user => ({ id, name, email, phone, ... })`, ≥ 24 nodes) included in comparison.
- `T-CB-03` — Small callback with control flow (`x => { if (x>0) return x; return -x; }`) included even when below profile `callbackMinNodes`.
- `T-CB-04` — Callback with `>= 2` statements included even when below profile `callbackMinNodes`.

#### Performance & determinism
- `PERF-01` — Conduit pilot records runtime, peak memory, largest buckets, and slowest comparison stages. No runtime or memory gate is introduced until the pilot data is reviewed.

### Regression tests

- **Conduit-slice snapshot** — dry4ts output on the copied conduit fixture slice matches a stored JSON snapshot. Updates require explicit `--update` and PR review.
- **External overlap note** — If the pilot owner runs `jscpd` or another existing clone detector outside the package, record any useful overlap/miss examples in the pilot report. This is non-blocking and must not add a v1 package dependency.

### Test infrastructure

- **Runner:** Vitest.
- **Properties:** fast-check, `seed: 0xDEADBEEF`, `numRuns: 100` (configurable per-property).
- **Fixtures:** hand-crafted minimal `.ts` / `.tsx` files under `packages/dry4ts/test/fixtures/<scenario>/`. No parser mocking — fixtures are real source files.
- **No network, no time:** tests run offline and deterministically.
- **Behavior target:** every closed Beads issue has a red/green behavior test or a documented reason it is docs-only.

### Sufficiency analysis

| Failure mode | Acceptance only | Layered |
|---|---|---|
| Normalizer drops wrong AST node | Sometimes (if it surfaces in a fixture) | Always (direct normalizer unit test) |
| Hash input instability | No | Yes (deterministic hash-input fixture test) |
| Wrong Jaccard weighting | Maybe (if it crosses threshold) | Always (similarity unit test) |
| Refactoring breaks T2/T3 detection | No | Yes (rename-preserves-clone property) |
| File ordering changes output | No | Yes (file-order-irrelevant property) |
| T1 reported as T2 (or vice versa) | Maybe | Yes (classify unit + classify-monotone property) |

Do not attach numeric confidence or coverage targets. Use acceptance behavior, mutation-worthy invariants, determinism, and pilot evidence as closure signals.

### Bead testing contract

Each implementation child bead ships one vertical behavior slice. Parent beads group related child beads and should never be claimed for implementation. Expected file lists are guide rails, not a command to pre-create modules. If the current red test does not force a file to exist, do not add that file yet.

Child bead closure rules:

- One failing behavior test first, through the CLI JSON contract or one named deep Module Interface.
- One `Red` command with `-t "<single acceptance id>"` for behavior beads. Infrastructure-only setup/dependency beads must say why no behavior red applies.
- Minimal implementation to pass that one behavior.
- Unit/property tests only after green, when they protect an invariant discovered by the implementation.
- Full bead verification after green and refactor.
- Close only after writing the bead handoff artifact and updating/creating any follow-up Beads issues.

## Implementation bead hierarchy

The beads below are templates for Beads issue creation. Create parent beads for headings, child beads for each row, dependency beads for package changes, and checkpoint beads for integration. Use `bd dep add` for every dependency called out below.

### Parent - Package setup and CLI contract

| Child bead | Depends on | Owner / files | Red | Expected failure | Green | Verification |
|---|---|---|---|---|---|---|
| Package setup | none | Serial owner of `pnpm-workspace.yaml`, `packages/dry4ts/package.json`, package config, initial lockfile. | No behavior red; setup bead is infrastructure-only. | `pnpm --filter dry4ts check` cannot resolve the package before setup. | Workspace package exists with split-ready scripts and no implementation beyond CLI stub wiring. | `pnpm --filter dry4ts check` |
| `CLI-JSON-01` empty JSON | Package setup | `src/bin/dry4ts.ts`, `src/core/runner.ts`, `src/core/run-profile.ts`, `src/report/report-writer.ts`, `test/acceptance/cli-json-contract.test.ts`. | `pnpm --filter dry4ts test -- test/acceptance/cli-json-contract.test.ts -t "CLI-JSON-01"` | CLI output missing or not stable JSON. | Empty fixture directory emits stable JSON with empty `type1`, `type2`, `type3`, and stats. | `pnpm --filter dry4ts check && pnpm --filter dry4ts test -- test/acceptance/cli-json-contract.test.ts` |
| `PROFILE-CONDUIT-01` effective profile | `CLI-JSON-01` | `src/core/run-profile.ts`, `test/acceptance/profile.test.ts`. | `pnpm --filter dry4ts test -- test/acceptance/profile.test.ts -t "PROFILE-CONDUIT-01"` | Effective profile is missing, unstable, or includes non-v1 Svelte/Type-4 settings. | `--profile conduit --effective-profile` reports deterministic TS/TSX structural config. | `pnpm --filter dry4ts test -- test/acceptance/profile.test.ts` |

### Parent - Structural TS detection

Serial until `structural-interface-checkpoint` because extraction, normalization, and `StructuralCloneDetector` are still taking shape. After that checkpoint, only beads with disjoint allowed files and explicit forbidden shared files may run in parallel.

| Child bead | Depends on | Owner / files | Red | Expected failure | Green | Verification |
|---|---|---|---|---|---|---|
| `T1-01` byte-identical functions | `CLI-JSON-01` | `ComparisonUnitExtractor` and `StructuralCloneDetector` first path; likely `src/extract/comparison-unit-extractor.ts`, `src/extract/ts-source.ts`, `src/normalize/raw-text.ts`, `src/structural/structural-clone-detector.ts`, `test/acceptance/type1.test.ts`. | `pnpm --filter dry4ts test -- test/acceptance/type1.test.ts -t "T1-01"` | No T1 cluster for identical functions. | TS function extraction, raw hash bucketing, stable JSON T1 cluster. | `pnpm --filter dry4ts test -- test/acceptance/type1.test.ts` |
| `T1-02` whitespace/comments | `T1-01` | Raw-text normalization; avoid changing parser/extractor unless the red test proves it. | `pnpm --filter dry4ts test -- test/acceptance/type1.test.ts -t "T1-02"` | Whitespace/comment-only changes miss T1. | Comments stripped, whitespace collapsed, string-literal whitespace preserved. | `pnpm --filter dry4ts test -- test/unit/normalize-raw-text.test.ts test/acceptance/type1.test.ts` |
| `T1-03` same-file positions | `T1-02` | Source-span and unit identity mapping. | `pnpm --filter dry4ts test -- test/acceptance/type1.test.ts -t "T1-03"` | Same-file duplicates collapse into one member or lose spans. | Multiple comparison units from one file keep distinct source spans. | `pnpm --filter dry4ts test -- test/acceptance/type1.test.ts` |
| `T2-01` renamed locals | `T1-03` | TypeScript AST normalization through `StructuralCloneDetector`. | `pnpm --filter dry4ts test -- test/acceptance/type2.test.ts -t "T2-01"` | Renamed locals are missed or reported as T1. | TS AST normalization erases local names and reports T2, not T1. | `pnpm --filter dry4ts test -- test/unit/normalize-ts-structure.test.ts test/acceptance/type2.test.ts` |
| `T2-02` literal erasure | `T2-01` | TypeScript AST normalization only. | `pnpm --filter dry4ts test -- test/acceptance/type2.test.ts -t "T2-02"` | Literal changes break T2. | Literal values normalize away without hiding operators or control flow. | `pnpm --filter dry4ts test -- test/unit/normalize-ts-structure.test.ts test/acceptance/type2.test.ts` |
| `T2-03` property-name policy | `T2-02` | Profile + TS normalization. | `pnpm --filter dry4ts test -- test/acceptance/type2.test.ts -t "T2-03"` | Property-name policy is ignored. | Property names are preserved by default and erased only by profile config. | `pnpm --filter dry4ts test -- test/acceptance/type2.test.ts` |
| `T3-TS-01` near-miss structural match | `T2-03` | `StructuralCloneDetector` T3 path: fingerprints, similarity, most-specific T3 pair classification. Candidate limiting may be all-units for this small fixture. | `pnpm --filter dry4ts test -- test/acceptance/type3-ts.test.ts -t "T3-TS-01"` | A true near-miss pair is missed or reported as T1/T2. | One function with the same broad structure plus one inserted/removed guard, logging branch, or validation step reports as a T3 pair. | `pnpm --filter dry4ts test -- test/acceptance/type3-ts.test.ts -t "T3-TS-01"` |
| `T3-IDX-01` candidate index and stats | `T3-TS-01` | Private candidate index inside `StructuralCloneDetector`; avoid changing extractor. | `pnpm --filter dry4ts test -- test/acceptance/type3-ts.test.ts -t "T3-IDX-01"` | Pairwise work is unbounded or candidate bucket stats are missing. | T3 comparisons run only inside structural-signature buckets and report largest candidate bucket stats. | `pnpm --filter dry4ts test -- test/unit/candidate-index.test.ts test/acceptance/type3-ts.test.ts` |
| Structural interface checkpoint | `T3-IDX-01` | Integration owner only; freezes `Dry4tsRunner`, `ComparisonUnitExtractor`, `StructuralCloneDetector`, and `ReportWriter` Interfaces for parallel extraction work. | No new red test. | Current T1/T2/T3 behavior fails or public Interface shape is still changing. | Core interfaces are documented in the plan and the first T1/T2/T3 behaviors pass together. | `pnpm --filter dry4ts test -- test/acceptance/type1.test.ts test/acceptance/type2.test.ts test/acceptance/type3-ts.test.ts` |
| `T3-TS-02` rewritten-control-flow negative | Structural interface checkpoint | Prefer fixtures/test only unless the red test proves classifier/similarity change is needed. | `pnpm --filter dry4ts test -- test/acceptance/type3-negative.test.ts -t "T3-TS-02"` | Materially different control flow is reported as T3. | Pair stays below threshold or is filtered by structural signature. | `pnpm --filter dry4ts test -- test/acceptance/type3-negative.test.ts` |
| `T3-TS-03` class methods | Structural interface checkpoint | Private class-method extraction file plus `test/acceptance/extract-class-methods.test.ts`; forbidden: shared orchestrator files unless packet says otherwise. | `pnpm --filter dry4ts test -- test/acceptance/extract-class-methods.test.ts -t "T3-TS-03"` | Class method clone is not extracted/reported. | Class methods enter comparison units and report T3 when structurally similar. | `pnpm --filter dry4ts test -- test/acceptance/extract-class-methods.test.ts` |
| `T3-TS-04` exported const arrows | Structural interface checkpoint | Private variable/function-expression extraction file plus `test/acceptance/extract-variable-functions.test.ts`; forbidden: shared orchestrator files unless packet says otherwise. | `pnpm --filter dry4ts test -- test/acceptance/extract-variable-functions.test.ts -t "T3-TS-04"` | Arrow function clone is not extracted/reported. | Arrow/function expressions assigned to variables enter comparison units. | `pnpm --filter dry4ts test -- test/acceptance/extract-variable-functions.test.ts` |
| `T-CB-01` trivial callbacks excluded | Structural interface checkpoint | Private callback extraction/eligibility file plus `test/acceptance/callback-eligibility.test.ts`; forbidden: shared orchestrator files unless packet says otherwise. | `pnpm --filter dry4ts test -- test/acceptance/callback-eligibility.test.ts -t "T-CB-01"` | Trivial callbacks create noisy clone results. | Trivial callbacks fail eligibility and do not form results. | `pnpm --filter dry4ts test -- test/acceptance/callback-eligibility.test.ts` |
| `T-CB-02` large projection callbacks included | `T-CB-01` | Callback eligibility only. | `pnpm --filter dry4ts test -- test/acceptance/callback-eligibility.test.ts -t "T-CB-02"` | Large projection callbacks are excluded. | Large single-expression projections enter comparison. | `pnpm --filter dry4ts test -- test/acceptance/callback-eligibility.test.ts` |
| `T-CB-03` control-flow callbacks included | `T-CB-02` | Callback eligibility only. | `pnpm --filter dry4ts test -- test/acceptance/callback-eligibility.test.ts -t "T-CB-03"` | Small control-flow callbacks are excluded. | Control-flow callbacks enter comparison despite size. | `pnpm --filter dry4ts test -- test/acceptance/callback-eligibility.test.ts` |
| `T-CB-04` multi-statement callbacks included | `T-CB-03` | Callback eligibility only. | `pnpm --filter dry4ts test -- test/acceptance/callback-eligibility.test.ts -t "T-CB-04"` | Multi-statement callbacks are excluded. | Callbacks with at least two statements enter comparison. | `pnpm --filter dry4ts test -- test/acceptance/callback-eligibility.test.ts` |
| Structural checkpoint | `T3-TS-02`, `T3-TS-03`, `T3-TS-04`, `T-CB-04` | Integration owner only; no feature edits. | No new red test. | Any structural acceptance or determinism check fails after merging child branches. | T1/T2/T3 acceptance and file-order determinism pass on merged branch. | `pnpm --filter dry4ts test -- test/acceptance/type1.test.ts test/acceptance/type2.test.ts test/acceptance/type3-ts.test.ts test/property/pipeline-invariants.test.ts` |

### Parent - Conduit pilot

Pilot work waits for the structural checkpoint. Keep snapshot and measurement separate so agents can run/review them independently.

| Child bead | Depends on | Owner / files | Red | Expected failure | Green | Verification |
|---|---|---|---|---|---|---|
| Deterministic conduit snapshot | Structural checkpoint | `test/regression/conduit-fixture.test.ts`, `test/fixtures/conduit-slice/**`, `docs/pilot-conduit.md`. | `pnpm --filter dry4ts test -- test/regression/conduit-fixture.test.ts -t "conduit-slice snapshot"` | Conduit slice output is missing or unstable. | Copied conduit-slice fixture produces stable sorted JSON; updates require explicit review. | `pnpm --filter dry4ts test -- test/regression/conduit-fixture.test.ts` |
| Performance profile | Deterministic conduit snapshot | `test/acceptance/performance.test.ts`, `docs/pilot-conduit.md`. | `pnpm --filter dry4ts test -- test/acceptance/performance.test.ts -t "PERF-01"` | Runtime, memory, bucket, or slow-stage stats are missing. | Records runtime, peak memory, largest buckets, slowest stages, false positives, and follow-up beads for candidate limiting or MinHash if bucket blowups appear. | `pnpm --filter dry4ts test -- test/acceptance/performance.test.ts` |
| Pilot checkpoint | Snapshot, performance | Integration owner only; no feature edits. | No new red test. | Pilot report lacks a decision about Svelte, Type-4, thresholds, external overlap, or architecture follow-ups. | `docs/pilot-conduit.md` records findings and creates explicit follow-up Beads issues. | `pnpm --filter dry4ts test -- test/regression/conduit-fixture.test.ts test/acceptance/performance.test.ts` |

### Post-v1 follow-up bead templates

Create these only when the pilot checkpoint justifies them.

| Follow-up | Trigger | First behavior | First red command | Scope limit |
|---|---|---|---|---|
| Svelte structural adapter | Pilot misses important frontend duplication. | Two Svelte templates with same structure but different text/classes/variable names report T3 through `StructuralCloneDetector`. | `pnpm --filter dry4ts test -- test/acceptance/type3-svelte.test.ts -t "T3-SV-01"` | Template Adapter only; no CSS/style clone detection. |
| Type-4 classifier/skipped evidence | Pilot finds structural false negatives that are semantic duplicates. | Runtime-probe-disabled candidate emits skipped/advisory evidence, not validated clone. | `pnpm --filter dry4ts test -- test/acceptance/type4-classifier.test.ts -t "T4-CLASSIFIER-01"` | Static classifier only; no worker execution. |
| Literal corpus extractor | Type-4 Track 3 is approved. | `it.each` table extraction produces corpus for one target symbol. | `pnpm --filter dry4ts test -- test/acceptance/literal-corpus.test.ts -t "T-LE-01"` | `LiteralCorpusExtractor` Interface only; `tryEvaluate` private; no member access, spread, template, `Object.entries`, or `Array.from` until separate evidence beads. |

### Deferred polish

- Performance candidate filters beyond the first measured bottleneck.
- Reporters (text, SARIF, markdown, HTML).
- Baseline file support for incremental checks.
- CI integration patterns.
- Documentation site.
- Optional: MCP server for agent integration.

## Future directions (out of v1)

- **Svelte component DOM-snapshot Type-4** — render with canonical props, snapshot rendered DOM, hash. Catches Type-4 at the component level.
- **Runtime Type-4 probes** — deterministic worker execution only after classifier/skipped evidence is useful and safe.
- **Effect-aware semantic traces** — Tag identity, static yield plans, and optional mock Layers only after concrete conduit examples justify them.
- **Schema-aware probes** — deeper Effect Schema integration for domain-type-driven arbitraries.
- **MCP server** — expose `find_clones`, `explain_pair`, `validate_pair` as agent tools.
- **Configurable normalization strength** — strict / medium / loose modes.
- **Cross-track ranking** — recommend which clone to prefer based on complexity, test signal, and dependents.
- **Literal evaluator expansion** — member access, spread, templates, wrappers, ternaries, `Object.entries`, `Array.from`, `array.map`/`.filter`/`.reduce`, `JSON.parse(<literal>)`, and cross-file fixture imports. Each needs a pilot-backed child bead.

## Pilot revisits

- **Svelte coverage.** Add Svelte template normalization only if TS/TSX pilot output misses important frontend duplication.
- **Type-4 need.** Add semantic detection only if pilot false negatives are valuable enough to justify runtime-safety complexity.
- **Callback granularity.** Start with `nodes >= 24 OR control-flow OR >= 2 statements`. Revisit if pilot shows trivial-callback noise or missed-clone gaps.
- **Property-name normalization.** Preserve property names by default. Revisit after pilot to evaluate erasure-on-domain-code false-positive rate.
- **Candidate index.** Keep cheap structural-signature buckets in v1. Add MinHash only if pilot bucket stats show pairwise comparison blowups.
- **Overlapping results across types.** Keep separate results per detected type. Revisit if pilot shows the same function repeatedly appearing in overlapping T2 clusters and T3 pairs in confusing ways.
