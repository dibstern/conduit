# Plan-to-Beads Redesign — Schema-Driven, bd-Native Work Graphs

- **Date:** 2026-06-04
- **Status:** Design proposal (awaiting approval before implementation planning)
- **Skill:** `.agents/skills/plan-to-beads`
- **Supersedes:** the `plan-to-beads.v3` IR + template + render + formula design (never used in production)

---

## 1. Problem

`plan-to-beads` converts a written implementation plan into a Beads work graph where each child bead
carries an executable prompt contract and children read shared context by reference (progressive
disclosure at the bead level). The *ambition* is correct and worth keeping. The *implementation* has
grown in a way that defeats the project's own goals.

Evidence gathered while scoping this redesign:

- The skill is 6 days old (created 2026-05-29), "hardened" across 7 commits, and **has never been used
  end-to-end once**: `.beads/generated-formulas/` does not exist, `.beads/formulas/` is empty, and
  `bd list --has-metadata-key planToBeads` returns `[]`. Nothing depends on the current shape, so there
  is **zero migration burden**.
- It encodes a **15-role ontology, 20 subcontract types, ~13 snippet families / ~70 named snippet kinds**,
  5 `contextUse` phases, a v2→v3 compatibility mapping, and a ~30-item validation checklist across
  **630 lines of docs, 37 template TOMLs, and ~900 lines of Node scripts**.
- The *"minimal"* example needs **~145 lines of IR JSON** to add one `generatedAt` field.

### Why it fails the stated goals

The goals for this skill are: **(a)** map *any* well-structured plan into beads *purely* (no loss, no
invention); **(b)** change easily over time *without errors*; **(c)** be *worked on easily by agents*;
**(d)** be *actually usable* to produce a perfectly structured bead graph. Plus two cross-cutting
requirements: **protect against agent errors / always capture the right information**, and **preserve
progressive disclosure at the bead level** (a subagent reads only its work packet + the context beads it
references, never the whole plan).

The current design fails (b)/(c) structurally: **every field lives in four places that must stay in sync** —
the IR schema prose in `REFERENCE.md`, the matching `templates/roles/*.toml` placeholder,
`render-plan-to-beads.cjs`, and `validate-plan-to-beads.cjs`. Adding one field is four coordinated edits.
That is the opposite of "change easily without errors," and it is hostile to an agent maintaining the skill.

It fails (a)/(d) because the surface is too large to hold reliably and the "minimal" path is enormous, so
an agent is *more* likely to omit or mis-shape information, not less.

And the central machinery is **theater**: `child.toml` is a 1:1 placeholder mirror of the IR's `values`
object (`goal = "{{goal}}"`, `non_goals = {{non_goals_array}}`, …). The agent already authors every
concrete value in the IR; `render-plan-to-beads.cjs` only reshapes JSON→TOML with the same field names.
It adds no judgment. The formula/`cook`/`pour` layer on top is built for **reusable, parameterized
(`{{var}}`) templates** (release loops, recurring ops) — a mismatch for a **one-off** plan conversion with
no variables to substitute.

---

## 2. What `bd` actually provides (verified)

This redesign leans on native `bd` capabilities instead of reinventing them. Verified against the installed
`bd`:

| Capability | Command | Notes |
| --- | --- | --- |
| One-shot DAG creation | `bd create --graph <json>` | Node shape `{ key, title, type, description, parent, deps[], priority, metadata }`. Resolves `key`→id, wires `deps`, nests via `parent`. **`metadata` is `map[string]string`** (nested data → JSON-string values). **Ignores `--dry-run`** — it really creates. |
| Native hierarchy types | `bd types` | `epic`, `story`, `task`, `decision` (ADR), `spike`, `feature`, `chore`, `bug`, `milestone` are built in — **epic → story → task is first-class**. |
| Parallel-execution molecule | `bd swarm create <epic>` | Turns an epic + children + deps **DAG** into a swarm. No formula required. |
| DAG structural validation | `bd swarm validate <epic>` | Checks dependency direction, orphans, missing deps, cycles, disconnected subgraphs; reports **ready fronts (parallel waves), max parallelism, estimated worker-sessions**. |
| Integration / human gates | `bd gate create` | Types `human`/`timer`/`gh:run`/`gh:pr`/`bead`. Manually creatable (not formula-only). |
| Serialized merge | `bd merge-slot` | Native exclusive-access primitive (`holder` + `waiters`) — serialized conflict resolution. |
| Cycle check | `bd dep cycles` | DAG safety. |
| Epic lifecycle | `bd epic status`, `bd epic close-eligible` | Native rollup + auto-close. |
| Rich per-bead metadata | `bd create --metadata @f.json`, `bd update --metadata` | Single-create accepts arbitrary nested JSON. |

**Implication:** the permanent, consistent, progressive-disclosure structure we want **is the bead graph
itself** (epic / context / story / task / checkpoint nodes + deps + per-bead metadata). It does not need a
formula. It needs a **consistent metadata contract enforced before `bd create --graph`**, plus the native
`swarm`/`gate`/`merge-slot` primitives for coordination.

---

## 3. Goals and non-goals of the redesign

**Goals**

1. **One source of truth.** A single JSON Schema defines the graph and every bead's metadata contract.
   Validation and documentation derive from it. Adding a field is *one* edit.
2. **Enforced per-type conformance.** The schema dictates the *ideal template for each role and child
   kind*, and the validator rejects nonconforming beads with exact field paths. ("Protect against agent
   errors / always capture the right info.")
3. **Pure, total coverage.** A coverage ledger guarantees every plan section maps to ≥1 bead or is
   explicitly marked out-of-scope — nothing dropped, nothing invented.
4. **bd-native representation.** Output is `graph.json` (bd's own `--graph` format) + native
   `swarm`/`gate`/`merge-slot`. No bespoke formula/template/render layer.
5. **Progressive disclosure preserved.** Per-bead work packets + context beads referenced by
   `contextRefs`; a subagent loads only its task and the context it points at.
6. **Agent-maintainable.** The schema is the only contract; the long tail is opt-in `$defs`; the validator
   is a thin schema walker.

**Non-goals**

- Reusable parameterized templates (that is what `bd` formulas are for; plan conversion is one-off).
- A deterministic "generator" that replaces decomposition judgment (impossible; see §6).
- Backward compatibility with `plan-to-beads.v2/v3` (never used).

---

## 4. Architecture overview

```
plan.md
  │  (agent decomposition — the irreducible judgment)
  ▼
graph.json  ──────────────────────────────────────────────┐
  │  (optional) normalizer: inherit story defaults,        │  ONE JSON Schema
  │             auto-wire contextRefs, role→type, defaults  │  is the source of truth
  ▼                                                         │  for this whole column
schema validate (MANDATORY — bd --graph has no dry-run) ◄──┘
  │
  ▼
coverage ledger check  +  adversarial review (graph.json vs plan.md)
  │
  ▼
bd create --graph graph.json        → epic/story/task/context/checkpoint beads + deps
bd swarm validate <epic>            → waves, cycles, orphans, parallelism
bd swarm create  <epic>             → swarm molecule for parallel agents
bd gate create / bd merge-slot      → checkpoint gates + serialized merges
```

The three approaches chosen earlier map onto this:

- **A — single schema as source of truth:** the right-hand column. `plan-graph.schema.json` defines the
  `graph.json` shape *and* the metadata/work-packet contract. The validator is schema-driven; `REFERENCE.md`
  cites the schema as authority instead of duplicating field lists.
- **D — slim MECE core + opt-in extensions:** §5. A small closed core of roles/child-kinds covers the
  common plan; the ~70 snippet kinds become optional `$defs` referenced only when a plan needs them.
- **B — coverage ledger + verification:** §7. Classify→draft→validate→review, with a coverage ledger for
  totality and an adversarial pass for faithfulness.

---

## 5. The schema: roles, child kinds, and the metadata contract

`plan-graph.schema.json` (JSON Schema, chosen for portability — runs anywhere with `node`, no build step,
agent-readable). It validates a `graph.json` and, within each node, a `metadata` object whose **values are
strings** (graph constraint), with structured payloads carried as JSON-string fields and validated by a
companion `$defs` set.

### 5.1 Node shape (bd-native, unchanged from bd)

```jsonc
{
  "key": "auth-login-t1",      // stable logical id → bd generates the real id
  "type": "task",              // bd native type: epic|story|task|decision|spike|chore|feature|milestone
  "title": "T1 empty creds → 400",
  "description": "…",
  "parent": "auth-login",      // hierarchy edge
  "deps": ["auth-login"],      // readiness edges (DAG)
  "priority": 2,
  "metadata": { /* string→string; see 5.3 */ }
}
```

### 5.2 Role / child-kind catalog (the slim MECE core)

`metadata.role` is the discriminator. Core roles:

| Role | bd `type` | Purpose | Core required metadata |
| --- | --- | --- | --- |
| `epic` | `epic` | Whole plan instance | `validationProfile`, `planRef` |
| `story` | `story` | Deliverable grouping; carries `stageDefaults` (owner/forbidden files, serial-by-default) | `stageDefaults` |
| `child` | `task` | One executable work packet (see `kind`) | `workPacket` (kind-dependent) |
| `checkpoint` | `task`/`milestone` | Integration / fanout / merge / release gate → maps to `bd gate`/`merge-slot` | `checkpointContract` |
| `context.*` | `decision`/`chore` | Durable read-by-reference context | `provides`, role-specific snippets |
| `acceptance` | `task` | Generated acceptance / mutation proof layer (see §8) | `acceptanceContract` (required when profile demands) |

`context.*` subroles (collapsed from today's 7 separate context roles, kept as a namespaced enum so the
ontology survives without role-count sprawl):
`context.global` · `context.architecture` · `context.policy` · `context.decision` · `context.guardrail` ·
`context.review` · `context.progress`.

**Child `kind`** (discriminated union — this is "the ideal template per type, enforced"):

| `kind` | Required (beyond goal/handoff) | Forbidden |
| --- | --- | --- |
| `tdd` | `validationContract.redCommand` + `expectedFailure` + `expectedRedShape`; `constraintContract.(allowedFiles \| changeSurfaceRef)`; `executionContract.greenScope` | — |
| `fixture` | `provenance`, `refreshPolicy`, `expectedSignal` | `redCommand` |
| `acceptance` | `acceptanceMatrixRefs`, `proofCommand` | — |
| `integration` | `verification`; references a checkpoint | `redCommand` (broad, not single-behavior) |

The validator rejects e.g. a `kind:"tdd"` child missing `validationContract.redCommand` **with the exact
JSON path**. New child kinds are added as one `oneOf` branch — a single, local schema edit.

### 5.3 Work-packet contract (preserved ontology, trimmed core)

The work packet is the heart of progressive disclosure and is preserved, but the **core required** set is
trimmed from 8 subcontracts to the load-bearing ones; the rest are optional and validated when present:

- **Core (required for `kind:tdd`):** `goalContract` (goal, expectedOutcome, nonGoals, behaviorId);
  `inputContract` (sourcePlan, contextRefs, contextUse, fixtures); `constraintContract`
  (allowed/forbidden/readOnly files or `changeSurfaceRef`, guardrailRefs); `validationContract`
  (redCommand, expectedFailure, expectedRedShape, verification); `outputContract` (outputShape, fileTouches,
  commitBoundary, evidenceToRecord); `handoffContract` (`requiresBeadsNote=true`, commit-SHA, close owner).
- **Optional (validated if present):** `executionContract` (orderedSteps, greenScope, codeContracts,
  inlineFixtures), `failureContract` (stop/blocker conditions, follow-up template refs, escalation).

`contextUse` keeps its timing model (`before-edit` | `during-edit` | `verification` | `handoff` |
`if-blocked`) with `required` + `reason` + `failureIfMissing`, and has exactly **one home**:
`workPacket.inputContract.contextUse`. This is what lets a subagent know *when* to read each context bead —
core to "constrain the agent but give it enough context to stop, ask, and finish completely."

### 5.4 Reference integrity and the two edge types

The schema enforces that every `deps` key, `parent`, `contextRefs` entry, `provides` value,
`typedContractRefs`, `acceptanceMatrixRefs`, `guardrailRefs`, and `evidenceRefs` **resolves to a node key**
(or is explicitly marked `external`). The DAG itself (cycles, waves, orphans) is validated by
`bd swarm validate` + `bd dep cycles` — *not* re-implemented in the skill.

Two edges, never conflated:

- **`deps`** = readiness. Use for true prerequisites and for *unresolved* decisions (a `context.decision`
  that must close before the task is ready — i.e. "stop and ask" is modeled as a dependency/gate).
- **`metadata.contextRefs`** = read-time routing. The subagent reads these but they do not gate readiness.
  This is progressive disclosure: a shared concept is **one context node referenced by many tasks**; a
  concept spanning multiple nodes (e.g. a module-map node + a protocol-contract node) is referenced as two.

---

## 6. Generation model (decision deferred to this doc)

No script can author the graph: decomposing prose into vertical slices, file scopes, and red commands is
irreducible agent judgment, and today's `render.cjs` proves a substitution engine adds none of it. So the
real consistency guarantee is the **schema + validator**, not a template engine. Two viable models:

### Option G1 — Author `graph.json` directly
The agent emits `graph.json`; the schema validates. **Pros:** one artifact, nothing extra to maintain, the
schema is the only contract — maximally aligned with goal (c). **Cons:** the agent repeats inheritance by
hand (e.g. copying a story's `forbiddenFiles` into each child); the validator catches *structural* gaps but
not "you forgot to inherit."

### Option G2 — Author a lean `graph.json`, then a deterministic normalizer completes it
The normalizer is a pure `graph → graph` function over the **same schema** (so there is still only one
schema, no second IR language). It does the work `render.cjs` does *not*: inherit `stageDefaults` into
children, auto-wire `contextRefs` from each context node's `provides`, apply role→`type` mapping, and fill
defaults. Validate the completed graph. **Pros:** less for the agent to author, inheritance/wiring is
consistent by construction (DRY, fewer omissions → directly serves the anti-error goal). **Cons:** one more
(small, pure, well-tested) script for agents to maintain.

**Recommendation:** **G2, framed as a "normalizer" over the single schema** — start with the highest-value,
lowest-risk transforms (stage-default inheritance, `contextRefs` auto-wire from `provides`, role→type), and
nothing else. It is the *only* place a "generator each time" earns its keep, and it shrinks the agent's
error surface, which is the top priority. If the normalizer proves to carry too little value in practice, it
degrades gracefully to G1 (the agent simply authors the fields the normalizer would have filled). Ship the
schema + validator first; the normalizer is additive and never a second source of truth.

---

## 7. Correctness pipeline (coverage ledger + verification)

Because `bd create --graph` **ignores `--dry-run`**, preview/correctness must happen *before* submission.
The skill's process:

1. **Classify (coverage ledger).** Walk the plan top-to-bottom; assign every section to a role/kind, or
   mark it `out-of-scope` with a reason. The ledger (`section → node keys | out-of-scope`) is the totality
   proof for goal (a): no plan content silently disappears, none is invented.
2. **Draft `graph.json`** (G1 or G2).
3. **Schema validate (mandatory).** `node validate.cjs graph.json` — conformance per role/kind, ref
   integrity, no unresolved placeholders, work-packet completeness.
4. **Adversarial review.** A reviewer pass (subagent) diffs `graph.json` back against `plan.md`: *What was
   dropped? Invented? Which children have overlapping writable file scopes with no checkpoint-owned merge
   rule? Does every "stop and ask" branch in the plan exist as a `context.decision` dep or checkpoint
   escalation?* The reviewer is given the plan and the graph, **not** a preferred conclusion.
5. **Structural validation (native).** `bd swarm validate <epic>` + `bd dep cycles` after a dry **author**
   step (validate the JSON, not via bd). Confirms waves/parallelism/cycles/orphans.
6. **Create + coordinate.** `bd create --graph` → `bd swarm create` → `bd gate create` / `bd merge-slot`
   for checkpoints. Then `bd swarm validate` again on the real ids and `bd ready`.

Validation is layered: **schema** (shape/completeness) + **ledger** (totality) + **review** (faithfulness)
+ **bd swarm/dep** (graph safety). Each catches a different failure class.

---

## 8. Acceptance pipeline — first-class, profile-gated

The acceptance layer is **not** demoted to long-tail; the near-term direction is to *require* it. It is a
first-class role gated by an epic-level profile:

```
epic.metadata.validationProfile = "tdd"            // acceptance optional (this iteration)
                                = "tdd+acceptance"  // acceptance REQUIRED — schema then enforces:
                                                    //  • ≥1 `acceptance` node per story (or epic)
                                                    //  • every `child` carries acceptanceMatrixRefs
                                                    //  • checkpoint.validationContract references the proof
```

`acceptanceContract` keeps the structured shape (gherkin feature subset, JSON IR, generator command,
step-handler policy, runner adapter, mutation + mutation-report contracts) as schema `$defs`. **Flipping the
default from `tdd` to `tdd+acceptance` is a one-line change** — no restructuring, because the role and refs
already exist. This is exactly the "optional now, required soon" path requested.

---

## 9. Progressive disclosure and subagent empowerment

The point of the contracts is to **constrain** a subagent (file scope, green scope, allowed tools) while
giving it enough context to act well. The graph delivers this:

- **Read only what you own:** a task's prompt = its `workPacket` + the context beads in `contextRefs`
  (read at the `contextUse` phase). The subagent never loads the whole plan.
- **Stop and ask:** unexpected observations route to a `context.decision` dependency or a checkpoint
  `escalationContract` — modeled as readiness edges so work blocks rather than guesses.
- **Schedule future work:** speculative work is a `followup-template` (a `context.*` node, non-executable)
  promoted to a real `child` only when the plan/agent says so — kept out of the ready queue until then.
- **Finish completely:** `outputContract.fileTouches` + `handoffContract.requiresBeadsNote` +
  `commitBoundary` force a complete, recorded handoff — "no forgotten changes."

---

## 10. Worked example (old ↔ new)

**Plan:** "Password login — T1: empty creds → 400. Red: `pnpm test -t 'T1 empty creds'`. Architecture:
`AuthController` owns request validation."

**Today (excerpt of ~145-line IR):** `epic` + `global-contract` + `architecture` (+ typed
`artifactContract`) + `parent` + `child` (30+ flat `values` keys) + `checkpoint`, rendered through
`render.cjs` into a `.formula.toml`, cooked, persisted, poured.

**New (`graph.json`, complete for this slice):**

```jsonc
{ "nodes": [
  { "key":"auth-epic","type":"epic","title":"Auth revamp",
    "metadata":{ "schema":"ptb/v1","role":"epic","validationProfile":"tdd","planRef":"docs/plans/auth.md" } },

  { "key":"auth-arch","type":"decision","parent":"auth-epic","title":"Auth module boundaries",
    "metadata":{ "schema":"ptb/v1","role":"context.architecture","provides":"[\"auth-arch\"]",
                 "snippets":"{\"moduleMap\":{\"AuthController\":\"owns request validation\"}}" } },

  { "key":"auth-login","type":"story","parent":"auth-epic","title":"Password login",
    "metadata":{ "schema":"ptb/v1","role":"story",
                 "stageDefaults":"{\"allowedFiles\":[\"src/auth/**\"],\"forbiddenFiles\":[\"src/billing/**\"]}" } },

  { "key":"auth-login-t1","type":"task","parent":"auth-login","deps":["auth-login"],
    "title":"T1 empty creds → 400",
    "metadata":{ "schema":"ptb/v1","role":"child","kind":"tdd","contextRefs":"[\"auth-arch\"]",
      "workPacket":"{\"goalContract\":{\"goal\":\"Empty creds return 400\",\"behaviorId\":\"T1\"},\"inputContract\":{\"contextUse\":[{\"ref\":\"auth-arch\",\"phase\":\"before-edit\",\"required\":true,\"reason\":\"Validation lives in AuthController\",\"failureIfMissing\":\"Open a decision\"}]},\"constraintContract\":{\"allowedFiles\":[\"src/auth/auth-controller.ts\",\"test/auth/login.test.ts\"]},\"validationContract\":{\"redCommand\":\"pnpm test -t 'T1 empty creds'\",\"expectedFailure\":\"no 400 path\",\"expectedRedShape\":\"single assertion\",\"verification\":\"pnpm test -- auth\"},\"outputContract\":{\"outputShape\":\"patch+note\"},\"handoffContract\":{\"requiresBeadsNote\":true,\"requiresCommitSha\":true}}" } },

  { "key":"auth-login-cp","type":"task","parent":"auth-login","deps":["auth-login-t1"],
    "title":"Login integration checkpoint",
    "metadata":{ "schema":"ptb/v1","role":"checkpoint",
                 "checkpointContract":"{\"gate\":{\"kind\":\"integration\"},\"validation\":{\"commands\":[\"pnpm test -- auth\"]},\"merge\":{\"owner\":\"integration\"}}" } }
]}
```

Then: `bd create --graph graph.json` → `bd swarm validate auth-epic` → `bd swarm create auth-epic`; the
checkpoint becomes a `bd gate`. The agent authored **one** validated artifact; the structure is enforced by
the schema and the DAG by bd.

---

## 11. Skill file structure

```
.agents/skills/plan-to-beads/
  SKILL.md                      # tight: the 80% path + when to load REFERENCE
  schema/plan-graph.schema.json # THE source of truth (roles, kinds, work packet, $defs, profiles)
  scripts/validate.cjs          # thin schema-driven validator (+ ref-integrity, ledger checks)
  scripts/normalize.cjs         # (G2) pure graph→graph: inheritance, contextRef wiring, role→type, defaults
  REFERENCE.md                  # ontology guide that CITES the schema; snippet $defs catalog (on-demand)
  EXAMPLES.md                   # worked plans incl. old↔new and an acceptance-profile example
```

**Deleted:** `templates/` (37 TOMLs), `render-plan-to-beads.cjs`, the formula/`cook`/`pour` workflow, and
the v2→v3 compatibility prose. The validator shrinks from a 436-line hand-maintained field list to a schema
walker.

---

## 12. Evolvability story (goals b, c)

- **Add a field:** edit the schema once. Validator and docs follow. (Was: four edits.)
- **Add a child kind:** one `oneOf` branch in the schema.
- **Require acceptance:** flip the `validationProfile` default.
- **Add a snippet kind:** one `$def`, referenced from the relevant role; not in the hot path.
- **An agent maintaining the skill** reasons about one JSON Schema + two small scripts, not four parallel
  representations.

---

## 13. Risks and open questions

1. **Flat `map[string]string` metadata.** Structured payloads are JSON-strings; bd can't query inside them
   (only key-presence via `--has-metadata-key`). *Mitigation:* sufficient for progressive disclosure (the
   subagent parses its own packet). If nested querying is ever needed, a second pass
   `bd update <child> --metadata @packet.json` upgrades specific beads to nested. Start flat.
2. **`bd create --graph` ignores `--dry-run`.** Preview must be schema-validation before submit (already
   the design). Worth confirming on each `bd` upgrade.
3. **`bd` version coupling.** The skill now depends on `--graph`, `swarm`, `gate`, `merge-slot` semantics.
   *Mitigation:* a one-line `bd`-capability preflight in `SKILL.md`; pin observed behaviors in `REFERENCE.md`.
4. **Authoring large `workPacket` JSON-strings by hand is error-prone.** *Mitigation:* the schema validates
   the parsed payload; G2's normalizer can also assemble the JSON-string from structured input so the agent
   never hand-escapes JSON.
5. **Reviewer subagent cost.** The adversarial pass adds latency/tokens. *Mitigation:* make it scale with
   plan size; skip for trivial single-child plans (the schema + ledger still run).
6. **Normalizer scope creep (G2).** Keep it a *pure, minimal* `graph→graph`; never let it become a second
   source of truth. Revisit if it grows.

---

## 14. Open decisions for sign-off

- **Generation model:** recommendation is **G2 (normalizer over the single schema)**, shippable after a
  schema-only G1 baseline. Confirm or choose G1.
- **Core role/kind set (§5.2):** confirm the collapse of 7 context roles into `context.*` subroles and the
  4 child kinds, or adjust.
- **Profile default:** ship at `validationProfile:"tdd"` now; agree the flip to `tdd+acceptance` is a future
  one-line change.

---

## 15. Next step

On approval, proceed to an implementation plan (writing-plans), then build via the skill-authoring path
(`write-a-skill` / `writing-skills`). Track the work in Beads.
