# dry4ts: Structural and Semantic Clone Detection for TypeScript and Svelte

**Date:** 2026-05-27
**Status:** Design (pre-implementation)
**Target consumer:** conduit (TS + Svelte + Effect-TS)

## Scope

A deterministic clone detector for TypeScript and Svelte covering all four clone types in a single tool:

- **Type-1** (exact, modulo whitespace and comments)
- **Type-2** (identical structure with renamed identifiers and changed literals)
- **Type-3** (gapped / near-miss structural clones)
- **Type-4** (semantic equivalence despite different structure)

T1/T2/T3 share one normalization and fingerprinting pipeline and are distinguished by classification at output time. T4 runs a separate behavioral-fingerprint pipeline.

## Goals

- **Deterministic.** No LLM calls. Reproducible across runs and machines.
- **Cover Type-1 through Type-4** for TS/TSX and Svelte (including full template normalization, not just `<script>`).
- **Effect-aware.** First-class handling of `Effect.gen` functions, since conduit is Effect-heavy.
- **Agent-friendly output.** JSON-first, stable ordering, counter-examples for near-misses.
- **Single internal IR.** All input lowers to a uniform structural representation; one set of similarity/clustering rules.

## Non-goals (v1)

- Proving semantic equivalence (we report candidates with evidence, not proofs).
- Symbolic execution or SMT solving.
- Cross-language clone detection.
- Svelte component DOM-snapshot Type-4 (deferred to v4).
- CI gating (advisory only until thresholds calibrated).

## Architecture

### Two pillars, one IR

```
Input files
   ↓
Parsers (TS / Svelte) → Comparison units with source spans
   ↓
   ├── Structural pipeline ──→ Raw-text hash         (T1 buckets)
   │                              ↓
   │                          NormalNode → AST hash  (T2 buckets)
   │                              ↓
   │                          Subtree fingerprints → Jaccard clusters (T3 candidates)
   │                              ↓
   │                          Classify pair: T1 | T2 | T3  (most specific wins)
   │
   └── Type-4 pipeline ──→ Classifier → multi-track fingerprints
                              ↓
                          Type-signature pre-filter
                              ↓
                          Hash clustering within signature bucket
                              ↓
                          Multi-track evidence scoring
                              ↓
                          Cascade validation
                              ↓
                          Validated clusters + counter-examples
   ↓
Merged output (JSON / text)
```

Both pipelines lower input to a shared structural IR:

```ts
type NormalNode = {
  tag: string;
  children: NormalNode[];
};
```

TS, TSX, and Svelte (script + template + style) all lower into `NormalNode`. The same JS expression normalizer runs whether the expression is in a `.ts` file or a Svelte directive body.

### Module layout

```
dry4ts/
  src/bin/dry4ts.ts
  src/core/
    pipeline.ts
    scanner.ts
    type-signatures.ts    canonical TS type signatures for grouping
    cluster.ts
    output.ts
    types.ts
  src/parsers/
    ts.ts
    svelte.ts
  src/normalize/
    raw-text.ts           whitespace + comment strip (T1 hash input)
    estree.ts             full AST normalization (T2 hash + T3 fingerprints)
    svelte-template.ts
    css.ts
  src/structural/
    exact-match.ts        T1 (raw hash) + T2 (normalized AST hash) bucketing
    fingerprints.ts       T3 subtree fingerprint bag
    similarity.ts         T3 weighted Jaccard
    classify.ts           T1 | T2 | T3 decision per detected pair
  src/type4/
    classifier.ts         purity / Effect / tested detection
    track1-behavior.ts    pure behavioral fingerprint
    track2-effect.ts      Effect-trace fingerprint
    track3-tests.ts       test-corpus role (input source + validator)
    literal-evaluator.ts  static literal evaluation for test extraction
    cross-shape.ts        Track 1' (lift) and Track 2' (unwrap)
    validation.ts         differential fuzz, shrinking, walk equivalence
    input-generation.ts   type-driven fast-check arbitraries
    mock-layer.ts         canonical Effect Layer with recording
  test/
    unit/
      normalize-raw-text.test.ts
      normalize-estree.test.ts
      normalize-svelte-template.test.ts
      normalize-css.test.ts
      exact-match.test.ts
      fingerprints.test.ts
      similarity.test.ts
      classify.test.ts
      type-signatures.test.ts
      classifier.test.ts
      cross-shape.test.ts
      input-generation.test.ts
      mock-layer.test.ts
      literal-evaluator.test.ts
      cluster.test.ts
      output.test.ts
    property/
      structural-invariants.test.ts
      type4-invariants.test.ts
      pipeline-invariants.test.ts
    acceptance/
      type1.test.ts
      type2.test.ts
      type3-ts.test.ts
      type3-svelte.test.ts
      type4-track1.test.ts
      type4-track2.test.ts
      type4-cross-shape.test.ts
      type4-track3.test.ts
      literal-evaluator.test.ts
      performance.test.ts
    regression/
      conduit-fixture.test.ts
      jscpd-overlap.test.ts
    fixtures/
      ts/
      svelte/
      tested/
      conduit-slice/
```

## Structural detection (T1 / T2 / T3)

T1, T2, and T3 share one normalization pipeline. The three types are points on a normalization-strength spectrum — same comparison units, same parser, same AST normalization. The detector classifies each detected pair as the *most specific* type that matches.

### Comparison units

**TS / TSX:**
- function declarations
- class methods
- object methods (`{ foo() {...} }`)
- arrow / function expressions assigned to variables
- inline callback functions that meet the **callback eligibility rule**

**Callback eligibility rule.** An inline callback (e.g., the lambda passed to `.map(...)`, `.filter(...)`, `pipe(...)`) enters comparison if **any** of:

1. Has `≥ N` normalized nodes (configurable, `--callback-min-nodes`, default 24).
2. Contains any control-flow construct (`if`, `switch`, `try`/`catch`, loops, top-level ternary).
3. Body has `≥ 2` statements.

Trivial callbacks (`x => x.foo`, `(a, b) => a - b`, `u => u.active`) fail all three and are excluded. Large single-expression projections like `user => ({ id, name, email, phone })` pass rule 1 and are kept. Small but structurally interesting callbacks like `x => { if (x > 0) return x; return -x; }` pass rule 2.

**Svelte:**
- whole component template
- significant `{#if}`, `{#each}`, `{#await}`, `{#key}` blocks
- snippets and `{@render ...}` regions
- sizeable element subtrees
- script blocks (instance + module) — routed through TS extraction
- `<style>` blocks via CSS normalizer (optional)

All units respect `--min-lines` and `--min-nodes` thresholds — small units don't enter T1/T2/T3 detection regardless of type.

### Raw-text normalization (T1 input)

For each unit:
- Strip line and block comments.
- Collapse runs of whitespace to a single space, preserving string-literal contents.
- Normalize line endings (`\r\n` → `\n`).
- Trim leading/trailing whitespace.

Hash result with sha256. Two units with the same raw hash are **T1 candidates**.

### TS / ESTree normalization (T2 / T3 input)

Parse with `@typescript-eslint/parser`. Lower each comparison unit to `NormalNode` with these rules.

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
- **property names** (default: preserve; `--erase-property-names` flips to erasure)

**Why preserve property names by default.** Domain code where property names carry semantics (`u.email` vs `u.phone`, `event.userId` vs `event.orderId`) generates false positives if names are erased. Default to preserve; revisit after Phase 7 pilot with real data.

Hash the full `NormalNode` tree with sha256. Two units with the same AST hash are **T2 candidates** (assuming they failed T1 — raw text differed).

### Svelte template normalization

Use `svelte/compiler.parse(source, { modern: true, filename })`. Lower every Svelte AST node to `NormalNode`:

- Drop comments and whitespace-only text nodes.
- Normalize non-empty text content to `text` (not the actual words).
- Preserve child order.
- Sort attributes/directives (order isn't semantic for most cases).
- Preserve HTML element names: `button`, `input`, `form`, `dialog`, etc.
- Normalize Svelte component names to `component` (config: `erase` | `preserve` | `prefix`).
- Preserve special element names: `svelte:window`, `svelte:document`, `svelte:body`, `svelte:head`, `svelte:element`, `svelte:options`.
- Preserve directive kind + semantic target: `bind:value`, `on:click`, `class:*`, `use:*`, `transition:*`, `in:*`, `out:*`, `animate:*`, `style:*`.
- Normalize directive expression bodies through the shared JS expression normalizer.
- Normalize literal class/text/style values away, but keep a `static`/`dynamic`/`mixed` flag on the attribute node.
- Svelte 5 constructs: snippets, `{@render}`, `{@const}`, `{@html}`, `{@debug}`, attachments.
- `IfBlock` / `EachBlock` / `AwaitBlock` / `KeyBlock`: preserve structure (branch counts, then/catch/pending presence), normalize expressions via the JS normalizer.

The output IR for a Svelte template is structurally comparable to any other `NormalNode` — fingerprinting and Jaccard apply uniformly.

### Fingerprints and similarity (T3 input)

For each unit's `NormalNode` tree:

1. Walk recursively; emit a stable hash for every subtree.
2. Collect into a multiset (count matters — two identical subtrees count twice).
3. Compare units pairwise via weighted Jaccard over multisets.
4. Pairs with `J(A, B) ≥ threshold` (default 0.84) are **T3 candidates**.

Svelte source-span resolution must map back to the original `.svelte` source, not the parser's compiled positions.

### Detection algorithm

```
for each unit u:
  rawHashTable[rawHash(u)].add(u)
  astHashTable[astHash(u)].add(u)
  fingerprints[u] = subtreeMultiset(normalize(u))

T1Clusters  = rawHashTable buckets with size > 1
T2Clusters  = astHashTable buckets with size > 1, excluding any member already in T1Clusters
T3Candidates = pairs within type-signature buckets, J ≥ threshold,
               excluding pairs already in T1 or T2
```

T1 and T2 are O(N) hash bucketing. T3 is O(K²) per signature bucket (same as the original design).

### Classification

Each detected pair is classified as the *most specific* type:

| Match | Classification |
|---|---|
| `rawHash(a) == rawHash(b)` | **T1** |
| `astHash(a) == astHash(b)` && raw differs | **T2** |
| `J(a, b) ≥ threshold` && astHash differs | **T3** |
| `J(a, b) < threshold` | dropped |

## Type-4 detection

### Per-function classifier

For each TS function / method / arrow:

- **Pure (sync)?** Synchronous, returns a non-Promise value, no side-effect AST signals: no `fetch`, no `Date.now`, no `Math.random`, no module-state mutation, no DOM access, no logging.
- **Pure (async)?** `async function` or return type `Promise<T>` AND uses only whitelisted Promise APIs: `Promise.resolve`, `Promise.all`, `Promise.allSettled`, `Promise.race`, `await <whitelisted-call>`. Same side-effect ban as sync pure (no `setTimeout`, `setInterval`, `fetch`, `Date.now`, DOM, etc.). Pure-async is a sub-variant of pure; both flow through Track 1 (the worker `await`s the result for pure-async).
- **`Effect.gen`?** Return type is `Effect<...>` OR uses `Effect.gen(function*() { yield* ... })`.
- **Tested?** Find associated `*.test.ts` referencing this function symbol.

A function may match multiple categories. **All applicable tracks produce fingerprints.** A pure tested function emits a Track 1 fingerprint, a Track 1' (lifted) fingerprint, and contributes to Track 3 validation.

### Track 1: Pure behavioral fingerprint

1. Extract type signature via TS compiler API. Resolve generics where possible.
2. Build a deterministic fast-check arbitrary from the type:
   - primitives → `fc.string` / `fc.integer` / `fc.boolean` / etc.
   - union → `fc.oneof(...)`
   - object → `fc.record({...})`
   - optional / null → tuple with `undefined` / `null` branches
   - generics → `fc.string` placeholder unless inference resolves them
3. **If an Effect Schema or Zod schema exists for the input type, derive the arbitrary from the schema** (higher quality than type-driven).
4. **If tests exist for this function (Track 3), prepend test inputs as priority cases.**
5. Generate N seeded inputs (default 100, deterministic seed).
6. Run `f` on each input in a worker process with a timeout (default 500ms). For pure-async functions, the worker `await`s the result and hashes the resolved value; rejection is recorded as `{ kind: error.constructor.name, msgShape, rejected: true }`; pending past timeout is a worker error.
7. Normalize each output:
   - Sorted JSON keys
   - `NaN` → `null`
   - `undefined` → `null`
   - `Date` → ISO string
   - thrown `Error` → `{ kind: error.constructor.name, msgShape: stripStackAndIdentifiers(error.message) }`
8. Hash `(input, output)` trace as `sha256(canonical_json(trace))`. **Track 1 fingerprint.**

Pure-sync and pure-async functions emit Track 1 fingerprints in the same shape, so a pure-sync `f` and a pure-async `g` with the same observable behavior cluster together naturally.

### Track 1' (pure → Effect lift)

For every pure function, also compute a Track 2 fingerprint by wrapping:

```ts
const lifted = (...args) => Effect.succeed(f(...args));
```

Run `lifted` through Track 2. This enables matches between pure helpers and `Effect.gen` wrappers around the same logic.

### Track 2: Effect-trace fingerprint

For each Effect-returning function:

1. Identify required services from the Effect's `R` (Requirements) type.
2. Resolve each service's **Tag identity** — the unique `Context.Tag<Id, Shape>` reference (or `Effect.Tag` class). Two services with the same method shape but different Tags (e.g., `UserService` vs `AdminService`, both with `findById`) are **not** interchangeable.
3. Build a canonical mock `Layer` providing every required service. Each service method:
   - Records the call: `{ tag, method, args (canonicalized) }` — `tag` is a stable string identity derived from the Tag (module path + Tag symbol name), not the service's method shape.
   - Returns a canonical mock value:
     - Primitive return type → `null` / `0` / `""`.
     - Structured return type → schema-driven mock if Effect Schema exists; otherwise canonical empty value.
     - Stream / Iterable → canonical empty.
4. Generate input arguments via the same type-driven generator as Track 1.
5. Run the Effect with the mock Layer, recording the trace.
6. Trace = `{ inputs, yields: [{ tag, method, args }], result, errorKind? }`.
7. Hash the trace as `sha256(canonical_json(trace))`. **Track 2 fingerprint.**

Two Effects clustering on Track 2 must share the same Tag identities in the same yield order — same shape with different Tags ≠ clone.

### Track 2' (Effect → pure unwrap)

For `Effect.gen` functions that yield no services (pure Effects — only `Effect.succeed` / `Effect.map` / etc.):

1. Detect statically: AST walk shows no `yield* SomeService.foo`.
2. Run the Effect via `Effect.runSync` (with timeout) to extract result.
3. Run through Track 1 normalization.
4. Emit a Track 1-compatible fingerprint.

### Track 3: Test corpus (dual-role)

**Role A — Input source for Track 1:**
- Locate associated test files (co-location convention or symbol reference).
- Extract `(input, expected output)` pairs from `expect(f(...args)).toBe(value)` patterns.
- Args and expected value are routed through the **literal evaluator** (next section) — pairs are extracted whenever the evaluator reduces both to literals, not only when the source spelling is a direct literal.
- Prepend as priority inputs when computing Track 1.

**Role B — Validation step:**
- When two tested functions cluster together, swap their test corpora.
- If `g` passes all of `f`'s tests AND `f` passes all of `g`'s tests, the pair is **validated** without further fuzzing.
- Cheaper and higher-confidence than differential fuzz.

### Literal evaluator (Track 3 input extraction)

A small, recursive, side-effect-free static evaluator that determines whether an expression reduces to a literal value. Powers Track 3 extraction across loops, table-driven tests, helper constants, and computed expressions. Never executes user code.

**Public interface:**

```ts
type Literal =
  | { kind: "scalar"; value: string | number | boolean | bigint | null | undefined }
  | { kind: "regex"; source: string; flags: string }
  | { kind: "array"; items: Literal[] }
  | { kind: "object"; entries: Record<string, Literal> };

function tryEvaluate(node: ESTreeNode, scope: Scope): Literal | undefined;
```

Returns `undefined` for any expression that doesn't reduce to a literal.

**Supported expressions:**

| # | Tier | Pattern | Example |
|---|------|---------|---------|
| 1 | v1 | Scalar literals | `42`, `"hi"`, `true`, `null`, `undefined` |
| 2 | v1 | Object / array literals | `{ a: 1 }`, `[1, 2]` |
| 3 | v1 | Top-level `const` references | `const X = "hi"`, then `X` |
| 4 | v2+ | `as const` assertions | `[1, 2] as const` |
| 5 | v2+ | `Object.freeze({...})` wrapping | `Object.freeze({ a: 1 })` |
| 6 | **v2** | Member access into literal objects | `USERS.alice` where `USERS = {alice: {...}}` |
| 7 | **v2** | Index access into literal arrays | `INPUTS[0]` where `INPUTS = [...]` |
| 8 | **v2** | Numeric arithmetic on literals | `1 + 2`, `3 * 4`, `5 % 2` |
| 9 | **v2** | String concatenation on literals | `"foo" + "bar"` |
| 10 | **v2** | Template literals with literal substitutions | `` `${name}-${id}` `` |
| 11 | **v2** | Spread in array literal | `[...A, ...B]` where both resolve |
| 12 | **v2** | Spread in object literal | `{...DEFAULTS, x: 1}` |
| 13 | v2+ | Ternary on literal condition | `cond ? a : b` where cond resolves |
| 14 | v2+ | `Object.entries(literalObj)` in for-of | `for (const [k,v] of Object.entries(MAP))` |
| 15 | v2+ | `Array.from({length: N}, fn)` | `Array.from({length: 5}, (_, i) => i)` — bounded range only |

**Tier legend.** `v1` = the original minimum-viable baseline (scalars, structures, const references — enough to ship `it.each` and `for-of` literal-array extraction). **`v2`** = the four feature groups detailed in [v2 scope](#v2-scope-merged-into-v1) below. `v2+` = additional polish features that fall out for free once v2 lands. **All three tiers are merged into the v1 dry4ts release.** Tier labels exist only to document scope history and identify what could be cut if the v1 timeline tightened.

**Higher-level extraction patterns (built on `tryEvaluate`):**

- **`it.each` / `test.each` tables** — evaluate the table to a literal array; for each row, substitute row fields in the test body's `expect(f(rowRef)).toBe(rowRef)` and re-evaluate.
- **`describe.each([...]).it.each([...])` nesting** — outer-row context combined with inner-row context.
- **`for (const x of <literal-array>) { ... }`** and **`array.forEach(x => ...)`** — unroll loop over each evaluated element; substitute loop variable.

**Deferred to future versions:**

- `array.map(callback)` / `.filter(callback)` / `.reduce(callback)` — requires evaluating arbitrary callbacks (interpreter territory).
- `JSON.parse(<literal-string>)` — pulls in JSON parsing semantics.
- Cross-file fixture imports — requires multi-file analysis pass.
- Conditional expressions where condition depends on comparison of literals (`x === "foo" ? a : b` when both branches reduce).

**Why this design is elegant:**

- One recursive function (`tryEvaluate`) plus a small set of higher-level extractors. Adding a new pattern = adding a new case in the recursion.
- Pure function, trivially testable by feeding ASTs and asserting on output. No parser/runtime in the test path.
- Read-only: never executes user code, no sandbox risk, deterministic.
- Composes uniformly: `it.each` table = "evaluate array, then per-row evaluate body"; spread = "evaluate inner, splice." All extractors reduce to evaluator calls.

#### v2 scope (merged into v1)

The v2 expansion was originally to be deferred. It is now part of the v1 release. v2 consists of four orthogonal feature groups, each one a single new case in the `tryEvaluate` recursion. Higher-level extractors do not change — they consume `Literal | undefined` and stay agnostic to which patterns the evaluator can resolve.

**v2-Arithmetic** *(patterns #8, #9; acceptance `T-LE-08`):*
- Binary operators on numeric literals: `+`, `-`, `*`, `/`, `%`, `**`.
- Unary `-` and unary `+` on numeric literals.
- Binary `+` on string literals → string concatenation.
- Mixed-type `+` follows JS coercion: `1 + "2" → "12"`.
- `NaN`, `Infinity`, `-0`, division-by-zero, `MAX_SAFE_INTEGER` overflow all follow JS semantics; the evaluator does not error.
- **Excluded:** bitwise ops (`&`, `|`, `^`, `<<`, `>>`, `>>>`), comparison operators (`<`, `===`, etc.). Bitwise rarely appears in test fixtures; comparisons live in the ternary case (#13).

**v2-Template substitution** *(pattern #10; acceptance `T-LE-09`):*
- Untagged template literal: `` `static-${expr}-text` ``.
- Every `${expr}` is recursively evaluated; if any returns `undefined`, the whole template returns `undefined`.
- Result is a single concatenated string `Literal`.
- **Excluded:** tagged templates (`` html`<p>${x}</p>` ``) — semantics depend on the tag function, defer to a future tier.

**v2-Spread** *(patterns #11, #12; acceptance `T-LE-10`):*
- Array spread: `[a, ...B, c]` where `B` resolves to `{ kind: "array", items }`; result is `[a, ...items, c]` after evaluating `a` and `c`.
- Object spread: `{...D, x: 1}` where `D` resolves to `{ kind: "object", entries }`; later keys override earlier per JS semantics.
- Nested: `[...A, ...B]` where both resolve.
- **Excluded:** spreading non-iterables (`[...{a:1}]`), spreading user-defined iterables (would require executing `Symbol.iterator`).

**v2-Member access** *(patterns #6, #7; acceptance `T-LE-07`, `T-LE-13` for `Object.entries`):*
- Static property access: `obj.prop` where `obj` resolves to `{ kind: "object" }`.
- Computed property: `obj["prop"]` where both the receiver and the index expression resolve.
- Indexed access: `arr[N]` where `arr` resolves to array and `N` resolves to a non-negative integer in bounds. Out-of-bounds → `undefined` scalar (no error).
- Optional chaining: `obj?.prop` — same as `.prop` once the receiver resolves to non-nullish; non-nullish-and-resolves yields `undefined` scalar.
- **Excluded:** getter properties (cannot verify purity statically). Prototype-inherited properties (would require type-checker queries beyond the evaluator's purview).

**Decoupling property (why "without touching call sites" matters):**

The four v2 groups are pure additions to `tryEvaluate`'s recursion. Higher-level extractors call `tryEvaluate(node, scope)` and branch on `Literal | undefined`; they never inspect AST node kinds themselves. Therefore:

- Adding `1 + 2` evaluation lets `it.each` tables include arithmetic-derived rows without changing the `it.each` extractor.
- Adding template literals lets `for (const x of [`a-${SUFFIX}`, ...])` work without changing the for-of extractor.
- Adding spread lets `for (const x of [...BASE_CASES, ...EDGE_CASES])` work without changing any extractor.

This is what makes "v2 merged into v1" cheap: extractor code stays frozen; the evaluator just gets stronger.

**v2 implementation cost estimate.** ~1 day total within Phase 6 — each feature group is one switch case plus 3–4 unit tests. The decoupling property means no integration work.

### Multi-track evidence weighting

Each function produces a *set* of fingerprints (one per applicable track). Clustering is **within-track**: cluster Track 1 fingerprints together, Track 2 fingerprints together, etc.

Then score each cluster pair by how many tracks they match on:

| Evidence | Action |
|---|---|
| Match on Track 1 AND Track 3 validation passes | Emit as **validated** |
| Match on Track 1 AND Track 1' (lifted matches Effect-shape too) | Emit as **validated** |
| Match on Track 2 AND Track 2' agreement | Emit as **validated** |
| Match on Track 1 only | Run differential-fuzz cascade |
| Match on Track 2 only | Run Effect-walk equivalence cascade |
| Match on Track 3 corpus hash only (rare) | Run Track 1 to confirm |

### Cascade validation with shrinking

**Track 1 cascade (pure):**
- `fast-check.assert((x) => f(x) === g(x))` with 1000 inputs.
- Pass → emit as **validated**.
- Fail → fast-check shrinks to a minimal counter-example. Emit as **near-miss** with:
  ```
  Not Type-4 clones. Differ at input: {x: null}
  f returns false, g returns true.
  ```

**Track 2 cascade (Effect):**
- Run both Effects with shared mock Layer, same input.
- Compare traces byte-by-byte.
- Mismatch → emit as **near-miss** with first-divergent yield.

**Track 3 cascade (tested):**
- Cross-pollinate test corpora. Any failing test → emit as **near-miss** with the failing test.

### Type-signature pre-filter

Before clustering, canonicalize function type signatures:

```
(string | null) => boolean                    →  (T1) => T2     where T1 = Nullable<string>, T2 = boolean
(User, Options) => Effect<Url, FetchError>    →  (T1, T2) => Effect<T3, T4>
```

Functions only cluster within the same canonical-signature bucket. Reduces clustering cost from O(N²) to O(K²) per bucket, K << N. Also kills nonsensical cross-comparisons.

## Output format

```json
{
  "type1": [
    {
      "id": "t1-001",
      "kind": "ts" | "svelte-template" | "svelte-script" | "svelte-style",
      "members": [
        { "file": "src/foo.ts", "unit": "isEmpty", "span": { "start": 10, "end": 18 } },
        { "file": "src/bar.ts", "unit": "isEmpty", "span": { "start": 45, "end": 52 } }
      ]
    }
  ],
  "type2": [
    {
      "id": "t2-001",
      "kind": "ts" | "svelte-template" | "svelte-script" | "svelte-style",
      "members": [
        { "file": "src/foo.ts", "unit": "validateUser", "span": { "start": 10, "end": 28 } },
        { "file": "src/bar.ts", "unit": "validateOrder", "span": { "start": 45, "end": 62 } }
      ]
    }
  ],
  "type3": [
    {
      "id": "t3-001",
      "kind": "ts" | "svelte-template" | "svelte-script" | "svelte-style",
      "similarity": 0.92,
      "members": [
        { "file": "src/foo.ts", "unit": "isEmpty", "span": { "start": 10, "end": 18 } },
        { "file": "src/bar.ts", "unit": "hasNoText", "span": { "start": 45, "end": 52 } }
      ]
    }
  ],
  "type4": [
    {
      "id": "t4-001",
      "tracks": ["behavior", "lifted", "test"],
      "validationStatus": "validated",
      "members": [
        { "file": "src/foo.ts", "function": "isEmpty", "span": { "start": 10, "end": 18 } },
        { "file": "src/bar.ts", "function": "hasNoText", "span": { "start": 45, "end": 52 } }
      ],
      "counterExample": null
    },
    {
      "id": "t4-002",
      "tracks": ["behavior"],
      "validationStatus": "near-miss",
      "members": [
        { "file": "src/a.ts", "function": "isEmptyV1", "span": {} },
        { "file": "src/b.ts", "function": "isEmptyV2", "span": {} }
      ],
      "counterExample": {
        "input": { "value": null },
        "results": { "isEmptyV1": true, "isEmptyV2": false }
      }
    }
  ],
  "stats": {
    "filesScanned": 951,
    "unitsCompared": 12453,
    "type1Clusters": 4,
    "type2Clusters": 9,
    "type3Clusters": 23,
    "type4Validated": 7,
    "type4NearMisses": 11,
    "durationMs": 18400
  }
}
```

## CLI

```
dry4ts [options] [file-or-directory ...]

Detection:
  --type1                       Run Type-1 detection (default: on)
  --no-type1                    Disable Type-1
  --type2                       Run Type-2 detection (default: on)
  --no-type2                    Disable Type-2
  --type3                       Run Type-3 detection (default: on)
  --no-type3                    Disable Type-3
  --type4                       Run Type-4 detection (default: on)
  --no-type4                    Disable Type-4
  --type4-tracks list           Comma-separated: behavior,lifted,effect,unwrap,test (default: all)

Structural tuning (applies to T1/T2/T3):
  --threshold N                 Jaccard threshold (default: 0.84)
  --min-lines N                 Min lines per unit (default: 6)
  --min-nodes N                 Min normalized nodes per unit (default: 24)
  --callback-min-nodes N        Min normalized nodes for inline callbacks (default: 24)
  --erase-property-names        Erase property names during normalization (default: off)
  --svelte-component-names mode erase | preserve | prefix (default: erase)

Type-4 tuning:
  --fuzz-inputs N               fast-check inputs per pair (default: 1000)
  --fingerprint-inputs N        fast-check inputs per fingerprint (default: 100)
  --seed N                      Deterministic seed (default: 0xDEADBEEF)
  --timeout-ms N                Per-function execution timeout (default: 500)
  --schema-provider name        effect-schema | zod | none (default: auto-detect)

Output:
  --format text|json            (default: text)
  --json                        Alias for --format json
  --text                        Alias for --format text
  --explain                     Include counter-examples (default: on)
  --no-explain                  Omit counter-examples

Filtering:
  --profile name                Built-in profile (default | conduit)
  --include extensions          ts,tsx,svelte,svelte.ts (default: all)
  --respect-gitignore           Honor .gitignore (default: on)
  --ignore pattern              Additional ignore pattern (repeatable)
```

## Conduit profile

```json
{
  "include": ["src/**/*.ts", "src/**/*.svelte", "test/**/*.ts"],
  "ignore": [
    "dist", ".worktrees", "node_modules", ".svelte-kit", "coverage",
    "**/*.d.ts", "**/generated/**"
  ],
  "structural": {
    "minLines": 6,
    "minNodes": 24,
    "callbackMinNodes": 24,
    "erasePropertyNames": false,
    "svelteTemplate": true,
    "svelteComponentNames": "erase"
  },
  "type1": { "enabled": true },
  "type2": { "enabled": true },
  "type3": {
    "enabled": true,
    "threshold": 0.84
  },
  "type4": {
    "tracks": ["behavior", "lifted", "effect", "unwrap", "test"],
    "fuzzInputs": 1000,
    "fingerprintInputs": 100,
    "seed": 3735928559,
    "timeoutMs": 500,
    "schemaProvider": "effect-schema"
  }
}
```

## Testing strategy

### Why a layered approach

End-to-end acceptance tests catch regressions but can't localize failures, can't enumerate detector invariants, and leave the normalizer underspecified — many wrong normalization rules still produce correct end-to-end answers for a fixed set of inputs by accident. Since roughly 70% of the codebase is pure functions, layered testing is cheap and dramatically more thorough.

### Test pyramid

| Layer | Share | Purpose |
|---|---|---|
| **Unit** | ~70% | Per-pure-module correctness, exhaustive invariants |
| **Property** | ~15% | Detector invariants via fast-check |
| **Acceptance** | ~10% | End-to-end smoke for each detection type |
| **Regression** | ~5% | Snapshot vs conduit slice, sanity-check vs jscpd |

### Unit tests

One test file per pure module. Hand-crafted minimal fixtures; no parser stubbing.

**`normalize/raw-text.ts`**
- Whitespace collapse leaves logic identical
- Comments stripped (line + block)
- String-literal whitespace preserved
- Line ending normalization (`\r\n` ↔ `\n`)
- Empty input handled

**`normalize/estree.ts`** — TS / ESTree normalizer
- Identifier erasure: `const x = 1` and `const y = 1` → identical NormalNode
- Literal erasure: `1` and `2` → identical NormalNode
- Property name preservation/erasure honors config
- Control flow preserved: `if/else` ≠ `switch`
- Operator preserved: `+` ≠ `-`
- Async / generator flag preserved
- Statement order preserved
- Destructuring positional shape preserved
- Type structure light preservation (shape, not names)

**`normalize/svelte-template.ts`**
- Whitespace/comment dropping
- Element name preservation (button ≠ div)
- Component name normalization modes (`erase` / `preserve` / `prefix`)
- Directive normalization (`bind:value`, `on:click`, `class:*`, `use:*`, etc.)
- Static vs dynamic flag on attributes
- `{#if}` / `{#each}` / `{#await}` / `{#key}` structure preservation
- Svelte 5 constructs (`{@render}`, `{@const}`, snippets, attachments)
- Source-span resolution maps to original `.svelte` positions

**`normalize/css.ts`**
- Selector structure preserved, identifier values normalized
- At-rules preserved
- Property value normalization

**`structural/exact-match.ts`**
- Raw-hash bucket lookup correctness
- AST-hash bucket lookup correctness
- T1 deduplication: a T1 pair is not also reported as T2
- Self-pairs excluded

**`structural/fingerprints.ts`**
- Multiset count correctness (two identical subtrees → count 2)
- Hash stability across runs
- Empty / single-node trees handled

**`structural/similarity.ts`**
- Identical multisets → 1.0
- Disjoint multisets → 0.0
- Subset relation → partial in expected range
- Weight scheme behaves as specified

**`structural/classify.ts`**
- T1 wins over T2 wins over T3 (most specific)
- Threshold boundary cases (J = threshold exactly)
- Pair below threshold dropped

**`core/type-signatures.ts`**
- `(string) => boolean` and `(number) => boolean` both canonicalize to `(T1) => T2`
- Generics resolved where the checker can
- Union / intersection types canonicalized
- `Effect<A, E, R>` signatures grouped correctly

**`type4/classifier.ts`**
- Pure detection rejects `Math.random`, `Date.now`, `fetch`, DOM access, module-state mutation
- Effect detection: `Effect.gen` and `Effect<...>` return type
- Tested detection associates function with `*.test.ts` files

**`type4/cross-shape.ts`**
- Lift: pure `f` → `(...args) => Effect.succeed(f(...args))`
- Unwrap: detects pure Effect (no service yields), `Effect.runSync`-able
- Idempotent: `lift(unwrap(f)) ≅ f` for pure Effects

**`type4/input-generation.ts`**
- Primitives map correctly
- Union → `fc.oneof`
- Optional → tuple with undefined branch
- Generics fall back to `fc.string`
- Effect Schema / Zod schema integration

**`type4/mock-layer.ts`**
- Records calls correctly
- Returns canonical values for primitive return types
- Schema-driven mocks
- Stream / Iterable canonical empty

**`type4/literal-evaluator.ts`**
- All 15 supported expression patterns evaluate to expected `Literal` shape
- Returns `undefined` for non-literal expressions (function call, free variable, `array.map`)
- Pure: same input AST → same output, no global state
- Composition: if `tryEvaluate(a)` and `tryEvaluate(b)` both return, `tryEvaluate(a + b)` returns the concat (string) or sum (number)
- Idempotence: re-evaluating an already-literal result returns the same `Literal`
- Scope handling: shadowed bindings prefer innermost; top-level `const` resolves when not shadowed

**`core/cluster.ts`**
- Same bucket key → considered for clustering
- Different bucket key → never clustered
- Single-member buckets → no clusters

**`core/output.ts`**
- Stable key ordering
- Span-to-line mapping for `.svelte` source positions
- Counter-example structure correctness

### Property-based meta-tests

All run with fast-check; `seed: 0xDEADBEEF`, `numRuns: 100` (configurable per-property).

**Structural invariants (T1 / T2 / T3):**
- `prop-T1-WhitespaceIrrelevant` — adding blank lines / changing indentation never changes T1 classification.
- `prop-T1-CommentsIrrelevant` — adding or removing comments never changes T1 classification.
- `prop-T2-RenamePreservesClone` — consistently renaming all identifiers in `f` and `g` doesn't change AST hash equality.
- `prop-T2-LiteralChangePreservesClone` — replacing all literal values doesn't change AST hash equality.
- `prop-T3-IdempotentNormalization` — `normalize(normalize(AST)) == normalize(AST)`.
- `prop-T3-ReorderAttributesPreservesSvelte` — reordering Svelte attributes doesn't change template Jaccard.
- `prop-Classify-Monotone` — for any pair, the classifier always picks the most specific matching type (T1 > T2 > T3).
- `prop-Determinism` — running the detector twice on the same input produces identical output bytes.

**Type-4 invariants:**
- `prop-T4-LiftCrossShape` — for any pure `f`, `f` and `(...args) => Effect.succeed(f(...args))` are always classified as T4 cross-shape clones.
- `prop-T4-UnwrapCrossShape` — for any pure Effect, `Effect.runSync(eff)` and the unwrap equivalent are T4 cross-shape clones.
- `prop-T4-DeadCodePreservesBehavior` — adding `if (false) { ... }` doesn't change Track 1 fingerprint.
- `prop-T4-Identity` — any function is T4 with itself.
- `prop-T4-Symmetry` — `f ↔ g` classification is symmetric.

**Pipeline invariants:**
- `prop-Pipeline-FileOrderIrrelevant` — permuting input file order produces identical clusters.
- `prop-Pipeline-LineEndings` — `\n` vs `\r\n` inputs produce identical fingerprints and classifications.
- `prop-Pipeline-WhitespaceIrrelevant` — extra blank lines or indentation changes never alter any clone classification (T1, T2, T3, or T4).

### Acceptance tests

End-to-end smoke for each detection type.

#### Type-1
- `T1-01` — Two byte-identical functions in different files reported as T1.
- `T1-02` — Whitespace/comment-only differences still report as T1.
- `T1-03` — Identical code in different positions of the same file reported as T1.

#### Type-2
- `T2-01` — Identical structure with renamed locals reported as T2 (not T1).
- `T2-02` — Identical structure with different literal values reported as T2.
- `T2-03` — Identical structure with different property names NOT reported as T2 under default config (property names preserved); same pair reported as T2 with `--erase-property-names`.

#### Type-3 TS
- `T3-TS-01` — Function with renamed locals/literals matches original at J ≥ 0.95.
- `T3-TS-02` — Function with rewritten control flow does NOT match original at J ≥ threshold.
- `T3-TS-03` — Class method clone detected across files.
- `T3-TS-04` — Arrow function assigned to const detected.

#### Callback granularity
- `T-CB-01` — Trivial callbacks (`x => x.foo`, `(a,b) => a-b`, `u => u.active`) excluded from comparison (no clone clusters formed).
- `T-CB-02` — Large single-expression projection (`user => ({ id, name, email, phone, ... })`, ≥ 24 nodes) included in comparison.
- `T-CB-03` — Small callback with control flow (`x => { if (x>0) return x; return -x; }`) included even when below `--callback-min-nodes`.
- `T-CB-04` — Callback with `≥ 2` statements included even when below `--callback-min-nodes`.

#### Type-3 Svelte
- `T3-SV-01` — Two components with same structure but different visible text/classes/variable names match.
- `T3-SV-02` — Components with different semantic element structure (button vs div) do not strongly match.
- `T3-SV-03` — `{#if}` / `{#each}` / `{#await}` / snippet / render-tag blocks all normalize and contribute.
- `T3-SV-04` — Directive types preserved; same directive with different expression body still matches.
- `T3-SV-05` — Output line ranges resolve to original `.svelte` source positions.
- `T3-SV-06` — Svelte 5 constructs (`{@render}`, `{@const}`, snippets, attachments) handled.

#### Type-4 Track 1
- `T4-T1-01` — `isEmpty(s) = s==null || s.trim()===""` and `hasNoText(s)` with different control flow but same behavior reported as clones.
- `T4-T1-02` — Same signature but materially different behavior NOT reported.
- `T4-T1-03` — Near-miss pairs include a shrunk counter-example.
- `T4-T1-04` — Deterministic: same input source → same fingerprint across machines/runs.
- `T4-T1-05` — Pure-async function `async (a,b) => Promise.resolve(a+b)` and pure-sync `(a,b) => a+b` reported as clones (worker `await`s the async result).
- `T4-T1-06` — Function using `Promise.all([Promise.resolve(x), Promise.resolve(y)])` classified as pure-async and clusters with the equivalent sync version.
- `T4-T1-07` — Function using `setTimeout` or `fetch` NOT classified as pure-async (correctly excluded from Track 1).

#### Type-4 Track 2
- `T4-T2-01` — Two `Effect.gen` with same yielded service-method sequence (different control flow inside) reported as clones.
- `T4-T2-02` — Same Effect with reordered yields NOT reported.
- `T4-T2-03` — Two Effects yielding identical method shapes on **different Tags** (e.g., `UserService.findById` vs `AdminService.findById`) NOT reported as clones — Tag identity differs.
- `T4-T2-04` — Two Effects yielding the same Tag and same method but with reordered argument-equivalent calls produce identical traces only when argument canonicalization holds.

#### Type-4 cross-shape
- `T4-CS-01` — Pure helper and `Effect.gen` wrapper around it reported as cross-shape clones via Track 1' lifting.
- `T4-CS-02` — Pure `Effect.gen` (no service yields) matches equivalent pure function via Track 2'.

#### Type-4 Track 3
- `T4-T3-01` — Two tested functions that pass each other's tests reported as **validated** clones.
- `T4-T3-02` — Test inputs prepended to Track 1 detect an edge-case clone that fast-check alone misses.

#### Literal evaluator (Track 3 input extraction)
- `T-LE-01` — Extracts pairs from `it.each([{ input, expected }, ...])(...)` tables.
- `T-LE-02` — Extracts pairs from `test.each([...])` (alias of `it.each`).
- `T-LE-03` — Extracts pairs from `describe.each([...]).it.each([...])` nested tables (outer × inner row context).
- `T-LE-04` — Extracts pairs from `for (const input of [...])` over a literal array.
- `T-LE-05` — Extracts pairs from `array.forEach(input => expect(f(input)).toBe(...))` over a literal array.
- `T-LE-06` — Resolves top-level `const ARR = [...]` reference, then extracts from `for (const x of ARR)`.
- `T-LE-07` — Resolves member access into literal object: `for (const u of USERS)` where `USERS = [{...}, {...}]`.
- `T-LE-08` — Evaluates string concatenation in expected value: `expect(f(x)).toBe("prefix-" + x)`.
- `T-LE-09` — Evaluates template literal with literal substitutions: `` expect(f(x)).toBe(`prefix-${x}`) ``.
- `T-LE-10` — Evaluates spread in array literal: `for (const x of [...A, ...B])` where both resolve.
- `T-LE-11` — Evaluates `Object.freeze({...})` wrapping and `as const` assertions.
- `T-LE-12` — Evaluates ternary on literal condition: `[true ? "a" : "b"]` reduces to `["a"]`.
- `T-LE-13` — Evaluates `Object.entries(MAP)` in `for (const [k, v] of Object.entries(MAP))`.
- `T-LE-14` — Evaluates `Array.from({length: 5}, (_, i) => i)` to `[0,1,2,3,4]`.
- `T-LE-15` — Returns `undefined` for input from function call (`makeFixtures()`); no extraction, no false pair.
- `T-LE-16` — Returns `undefined` for free variable not in scope; no extraction.
- `T-LE-17` — Returns `undefined` for `array.map(callback)` (deferred case); no extraction.

#### Performance & determinism
- `PERF-01` — Full conduit run completes in < 5 minutes on developer laptop.
- `PERF-02` — Output JSON stably sorted (file, then line); diffs show only real changes.
- `PERF-03` — Memory usage under 4 GB on a conduit-sized codebase.

### Regression tests

- **Conduit-slice snapshot** — dry4ts output on a pinned conduit revision matches a stored JSON snapshot. Updates require explicit `--update` and PR review.
- **jscpd-overlap** — T1 pairs reported by dry4ts overlap with jscpd's output on the same input (subset or equal). Sanity-checks that dry4ts doesn't miss obvious copy-paste clones.

### Test infrastructure

- **Runner:** Vitest.
- **Properties:** fast-check, `seed: 0xDEADBEEF`, `numRuns: 100` (configurable per-property).
- **Fixtures:** hand-crafted minimal `.ts` / `.svelte` files under `test/fixtures/<scenario>/`. No parser mocking — fixtures are real source files.
- **Snapshots:** Vitest snapshot for normalizer output review in PRs.
- **No network, no time:** tests run offline and deterministically.
- **Coverage target:** 90% line coverage on pure modules; 70% on integration/orchestration.
- **Mutation testing (Phase 7+):** Stryker against the test suite, verifying it catches mutations to normalizer rules, similarity computation, hashing, classifier rules.

### Sufficiency analysis

| Failure mode | Acceptance only | Layered |
|---|---|---|
| Normalizer drops wrong AST node | Sometimes (if it surfaces in a fixture) | Always (direct normalizer unit test) |
| Hash collision on subtree | No | Yes (collision-resistance unit test) |
| Worker timeout / crash unhandled | No | Yes (worker unit test) |
| Wrong Jaccard weighting | Maybe (if it crosses threshold) | Always (similarity unit test) |
| Refactoring breaks T2/T3 detection | No | Yes (rename-preserves-clone property) |
| File ordering changes output | No | Yes (file-order-irrelevant property) |
| Effect.gen detection misses edge case | Sometimes | Yes (classifier unit test) |
| T1 reported as T2 (or vice versa) | Maybe | Yes (classify unit + classify-monotone property) |
| Cross-shape lift fails for valid pairs | Sometimes | Yes (cross-shape unit + lift property) |

Acceptance alone gets us ~40% confidence; layered approach gets us ~95% with similar effort.

### Per-phase test requirements

Each phase ships unit + property + acceptance tests together. No "tests added later" debt.

- **Phase 1:** `normalize/raw-text`, `normalize/estree`, `structural/*` unit tests; T1/T2/T3 structural invariant properties; T1, T2, T3-TS acceptance tests.
- **Phase 2:** `normalize/svelte-template`, `normalize/css` unit tests; Svelte structural property tests; T3-SV acceptance tests.
- **Phase 3:** `core/type-signatures`, `type4/classifier`, `type4/input-generation` unit tests; T4 Track 1 properties; T4-T1 acceptance tests.
- **Phase 4:** cascade validation unit tests; near-miss counter-example shape tests.
- **Phase 5:** `type4/mock-layer`, `type4/cross-shape` unit tests; lift/unwrap properties; T4-T2 and T4-CS acceptance tests.
- **Phase 6:** `type4/literal-evaluator` unit tests (all 15 supported patterns + deferred-case `undefined` returns); Track 3 corpus extraction unit tests; `T4-T3` and `T-LE-01..17` acceptance tests.
- **Phase 7:** conduit-slice regression snapshot; jscpd-overlap regression test; Stryker mutation testing run.
- **Phase 8 (deferred):** reporter tests, baseline file tests.

## Implementation phases

### Phase 1 — Structural detection (T1/T2/T3) TS-only MVP (2–3 days)

- Scaffold package, CLI, output schema.
- Scanner for `.ts` files.
- Raw-text normalizer + raw-hash bucketing (T1).
- ESTree-based TS normalizer + AST-hash bucketing (T2).
- Subtree fingerprint set + weighted Jaccard (T3).
- Classifier picking most-specific match (T1 > T2 > T3).
- Text and JSON output.
- Tests ship with the phase: `normalize/raw-text`, `normalize/estree`, `structural/*` unit tests; T1/T2/T3 structural invariant property tests; `T1-01..03`, `T2-01..03`, `T3-TS-01..04` acceptance tests.

### Phase 2 — Structural Svelte (2–3 days)

- Integrate `svelte/compiler.parse` with `modern: true`.
- Svelte template normalizer covering full rule set.
- Wire Svelte units into raw-hash, AST-hash, and fingerprint pipelines (T1/T2/T3 all apply uniformly to templates).
- Source-span mapping back to `.svelte` source.
- CSS normalizer for `<style>` blocks (optional).
- Tests ship with the phase: `normalize/svelte-template`, `normalize/css` unit tests; Svelte structural property tests; `T3-SV-01..06` acceptance tests.

### Phase 3 — Type-4 Track 1 (3–4 days)

- TS compiler API integration for type extraction.
- Type-driven fast-check arbitraries.
- Worker-pool execution with timeout.
- Output normalization and stable hashing.
- Hash clustering with type-signature pre-filter.
- Tests ship with the phase: `core/type-signatures`, `type4/classifier`, `type4/input-generation` unit tests; T4 Track 1 property tests; `T4-T1-01..04` acceptance tests.

### Phase 4 — Differential fuzz validation (1–2 days)

- Cascade: cluster → `fast-check.assert(f(x) === g(x))` → shrink on failure.
- Counter-example output structure.
- Wires into existing Track 1 pipeline.
- Tests ship with the phase: cascade-validation unit tests; near-miss counter-example shape tests.

### Phase 5 — Type-4 Track 2 and cross-shape (3–4 days)

- `Effect.gen` detection.
- Mock Layer generator (canonical service stubs with call recording).
- Effect trace recorder.
- Track 1' (lift) and Track 2' (unwrap) cross-shape implementations.
- Tests ship with the phase: `type4/mock-layer`, `type4/cross-shape` unit tests; lift/unwrap property tests; `T4-T2-01..02`, `T4-CS-01..02` acceptance tests.

### Phase 6 — Type-4 Track 3 + literal evaluator (3–4 days)

- Test file association heuristics.
- **Literal evaluator** (`src/type4/literal-evaluator.ts`): recursive `tryEvaluate(node, scope) → Literal | undefined` covering all 15 supported expression patterns.
- Higher-level extractors on top of the evaluator: `it.each` / `test.each` tables, `describe.each` nesting, `for...of` and `forEach` unrolling.
- Track 3 corpus extraction routes through the evaluator (not just direct literals).
- Priority-input feed into Track 1.
- Cross-pollination validation.
- Tests ship with the phase: `type4/literal-evaluator` unit tests covering all 15 patterns + deferred-case `undefined` returns; Track 3 corpus extraction unit tests; `T4-T3-01..02` and `T-LE-01..17` acceptance tests.

### Phase 7 — Conduit pilot (1–2 days)

- Run on conduit slices: projection, parsing, event-store mapping, router logic.
- Calibrate thresholds, fuzz counts, timeouts from real friction.
- Tune Effect Schema integration.
- Document findings, false-positive patterns, and refactoring recommendations.
- Tests ship with the phase: conduit-slice regression snapshot; jscpd-overlap regression test; Stryker mutation testing run.

### Phase 8 (deferred) — Polish for general use

- Performance: MinHash candidate pre-filter, suffix-array indexing if needed.
- Reporters (SARIF, markdown, HTML).
- Baseline file support for incremental checks.
- CI integration patterns.
- Documentation site.
- Optional: MCP server for agent integration.

**Total estimate:** 14–22 days for v1. Phase 1–2 (full structural T1/T2/T3 with Svelte) usable in 4–6 days. Phase 3–6 (Type-4 with Effect support, tests, and literal evaluator) adds the novel semantic-clone capability in another 8–14 days. Per-phase tests are budgeted into each phase's day count.

## Future directions (out of v1)

- **Svelte component DOM-snapshot Type-4** — render with canonical props, snapshot rendered DOM, hash. Catches Type-4 at the component level.
- **Schema-aware probes** — deeper Effect Schema integration for domain-type-driven arbitraries.
- **MCP server** — expose `find_clones`, `explain_pair`, `validate_pair` as agent tools.
- **Configurable normalization strength** — strict / medium / loose modes.
- **Cross-track ranking** — recommend which clone to prefer based on complexity, test coverage, dependents.
- **Literal evaluator Tier 3** — add `array.map`/`.filter`/`.reduce` with statically-evaluable callbacks, `JSON.parse(<literal>)`, cross-file fixture imports, and conditional-on-literal-comparison branches. Each is a single new case in the evaluator's recursion; deferred from v1 because they cross into interpreter/multi-file territory.

## Pilot revisits (resolved for v1, re-examine after Phase 7)

- **Callback granularity.** Resolved: callback eligibility = `nodes ≥ 24 OR control-flow OR ≥ 2 statements` (configurable via `--callback-min-nodes`). Revisit if pilot shows trivial-callback noise or missed-clone gaps.
- **Property-name normalization.** Resolved: preserve property names by default (`--erase-property-names` flips to erasure). Revisit after pilot to evaluate erasure-on-domain-code false-positive rate.
- **Effect Service identity.** Resolved: Track 2 uses Tag identity (`Context.Tag` reference), not method shape. Revisit only if pilot surfaces structural-Tag aliasing patterns.
- **Async pure functions.** Resolved: pure-async sub-classification flows through Track 1 with worker `await`; whitelisted Promise APIs (`resolve`, `all`, `allSettled`, `race`) only. Revisit if pilot finds important async patterns outside the whitelist.
- **Overlapping clusters across types.** Resolved: keep separate clusters per detected type. Revisit if pilot shows the same function repeatedly appearing in overlapping T2/T3 clusters in confusing ways — may collapse to a single `[A, B, C]` cluster with per-pair classification annotations.
