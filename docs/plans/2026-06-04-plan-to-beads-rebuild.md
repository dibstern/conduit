# Plan-to-Beads Rebuild Implementation Plan (Revision 2 — portable Zod package)

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.
> **Supersedes Revision 1** (ajv + hand-authored JSON Schema + conduit-coupled + create-only). This revision
> reflects the final decisions in `docs/plans/2026-06-04-plan-to-beads-redesign-design.md` §16.

**Goal:** Rebuild `plan-to-beads` as a **portable, standalone skill package** whose single source of truth is a
**Zod schema (TypeScript)**, which converts a written plan into a **bd-native `graph.json`**, then **additively
reconciles** it into a Beads work graph (create / update plan-owned fields / noop / flag orphans / fail-closed
conflicts) so the bead representation can be **updated as plans evolve**.

**Architecture:** `src/schema.ts` (Zod) defines the graph, a `discriminatedUnion` over `metadata.role` and child
`metadata.kind`, the work-packet subcontracts, and the metadata contract — yielding both runtime validation and
`z.infer` types. Decode applies defaults + normalization. `src/identity.ts` provides stable identity
(`planId`+`logicalId`+`planContentHash`) and the plan-owned/execution-owned field split. `src/validate.ts` adds
ref-integrity (incl. workPacket-internal refs + the `@external` convention) and coverage-ledger checks on top of
Zod. `src/reconcile.ts` diffs desired-vs-current; `src/apply.ts` executes ops via `bd create --graph` (creates) +
`bd update --metadata`/`bd dep` (updates), idempotent + resumable; `src/review.ts` renders a Markdown review
artifact; `src/cli.ts` exposes `validate` / `plan` / `apply`. Coordination uses native `bd swarm`/`gate`/`merge-slot`.

**Tech Stack:** TypeScript run **without a build** via `node --experimental-strip-types` (node ≥ 24; `tsx` fallback),
**Zod** (sole runtime dep), `node --test` for tests, `bd` CLI (assumed present). No conduit coupling.

**Design source:** `docs/plans/2026-06-04-plan-to-beads-redesign-design.md` (read §16 first), plus the exploration in
`design/{schema-engine-options.md,direct-bd-mutation-and-review-artifacts.md}`.

---

## Required Reading & Conventions

1. Read the design doc §16 (final decisions), §5 (roles/work packet), §7 (pipeline), §8 (acceptance profile).
2. **Verified `bd` facts** (do not re-derive): `bd create --graph <file>` takes `{nodes:[{key,title,type,description,
   parent,deps[],priority,metadata}]}`; `metadata` is **`map[string]string`** (nested payloads → JSON-string values);
   it **creates immediately and ignores `--dry-run`**. Native types include `epic`/`story`/`task`/`decision`/`spike`/
   `chore`. `bd list --json` returns beads incl. `metadata`. `bd update <id> --metadata @f.json`,
   `bd dep add`, `bd dep cycles`, `bd swarm validate <epic>`, `bd swarm create <epic>`, `bd gate create`,
   `bd merge-slot` all exist.
3. **TEST ISOLATION — non-negotiable:** any test that calls a mutating `bd` command MUST target a **throwaway database**
   (e.g. `BEADS_DB=$(mktemp -d)/test.db` or `bd --db <tmp>`), seeded from a fixture. **Never** touch the repo's real
   store and **never** `git checkout .beads`. A test helper must create + tear down the temp db.
4. **Runner:** prefer `node --experimental-strip-types`. Imports between local `.ts` files use explicit `.ts`
   specifiers. If strip-types misbehaves with the test glob, fall back to `tsx` (declared as a devDep). Task 1 resolves
   this once.
5. **Packaging:** this is a standalone package. All paths below are **relative to the skill root**
   (`plan-to-beads/`), not conduit. The skill currently sits at `.agents/skills/plan-to-beads/`; the new files are added
   there, and extraction to its own repo / `~/.agents/skills` is a later, separate step (out of scope here).
6. **Coexistence:** new code lives under `src/` + `test/`; old files (`templates/`, `scripts/render-plan-to-beads.cjs`,
   `scripts/validate-plan-to-beads.cjs`) stay until Task 14 so every intermediate commit is green.

---

## Task 0: Beads tracking setup

**Step 1:** `bd create "Rebuild plan-to-beads as portable Zod package" --type epic --priority 1 --json` → capture `$EPIC`.
**Step 2:** create one task bead per Task 1–15, `--parent $EPIC`. **Step 3:** `bd update <task-1> --claim`.
**Step 4:** no git commit (Beads is passive export; don't stage `.beads`).

---

## Task 1: Package scaffold + runner

**Files:** Create `plan-to-beads/package.json`, `plan-to-beads/.gitignore`, `plan-to-beads/src/version.ts`,
`plan-to-beads/test/smoke.test.ts`.

**Step 1: package.json**
```json
{
  "name": "plan-to-beads",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "engines": { "node": ">=24" },
  "bin": { "plan-to-beads": "src/cli.ts" },
  "scripts": {
    "test": "node --experimental-strip-types --test 'test/*.test.ts'",
    "validate": "node --experimental-strip-types src/cli.ts validate"
  },
  "dependencies": { "zod": "^3.25.0" },
  "devDependencies": { "tsx": "^4.19.0" }
}
```
`.gitignore`: `node_modules/`.

**Step 2: minimal modules to prove the toolchain**
`src/version.ts`: `export const SCHEMA_VERSION = "ptb/v1";`
`test/smoke.test.ts`:
```ts
import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { SCHEMA_VERSION } from "../src/version.ts";
test("toolchain runs TS + zod", () => {
  assert.equal(SCHEMA_VERSION, "ptb/v1");
  assert.equal(z.string().parse("x"), "x");
});
```

**Step 3:** `cd plan-to-beads && npm install` (expect zod + tsx resolved).
**Step 4:** `npm test` → expect 1 pass. If the `node --experimental-strip-types --test` glob fails to find/run `.ts`,
switch the `test` script to `tsx --test test/*.test.ts` and re-run. Record the working runner in `README.md`.
**Step 5: Commit** `chore(plan-to-beads): scaffold portable zod package + runner`.

---

## Task 2: Zod schema — the single source of truth

**Files:** Create `src/schema.ts`; `test/schema.test.ts`; fixtures `test/fixtures/good-minimal.graph.json`,
`test/fixtures/bad-missing-redcommand.graph.json`, `test/fixtures/bad-bad-kind.graph.json`.

The schema models the **graph.json as authored** (metadata values are strings; structured payloads are JSON-strings).
Zod validates the outer node + parses/validates each JSON-string payload via a refinement. Use `z.discriminatedUnion`
on `metadata.role`, and a nested discriminated union on child `metadata.kind`.

**Step 1: Write `src/schema.ts`** (complete core)
```ts
import { z } from "zod";

export const SCHEMA_VERSION = "ptb/v1";

/** Payloads carried as JSON-strings in graph metadata (bd metadata is map[string]string). */
const ContextUse = z.object({
  ref: z.string(),
  phase: z.enum(["before-edit", "during-edit", "verification", "handoff", "if-blocked"]),
  required: z.boolean(),
  reason: z.string().min(1),
  failureIfMissing: z.string().min(1),
});

const GoalContract = z.object({
  goal: z.string().min(1),
  expectedOutcome: z.string().min(1),
  nonGoals: z.array(z.string()).default([]),
  behaviorId: z.string().min(1),
});
const InputContract = z.object({
  sourcePlan: z.string().optional(),
  contextRefs: z.array(z.string()).default([]),
  inherits: z.array(z.string()).default([]),
  contextUse: z.array(ContextUse).default([]),
  fixtureRefs: z.array(z.string()).default([]),
  typedContractRefs: z.array(z.string()).default([]),
});
const ConstraintContract = z.object({
  allowedFiles: z.array(z.string()).optional(),
  forbiddenFiles: z.array(z.string()).default([]),
  readOnlyFiles: z.array(z.string()).default([]),
  changeSurfaceRef: z.string().optional(),
  guardrailRefs: z.array(z.string()).default([]),
  requiredSkills: z.array(z.string()).default([]),
}).refine((c) => !!c.allowedFiles?.length || !!c.changeSurfaceRef,
  { message: "constraintContract needs allowedFiles or changeSurfaceRef" });
const ExecutionContract = z.object({
  orderedSteps: z.array(z.string()).default([]),
  greenScope: z.string().min(1),
  codeContracts: z.array(z.unknown()).default([]),
  inlineFixtures: z.array(z.unknown()).default([]),
});
const ValidationContract = z.object({
  redCommand: z.string().optional(),
  expectedFailure: z.string().optional(),
  expectedRedShape: z.string().optional(),
  verification: z.string().min(1),
  acceptanceMatrixRefs: z.array(z.string()).default([]),
  proofCommand: z.string().optional(),
});
const OutputContract = z.object({
  outputShape: z.string().min(1),
  fileTouches: z.array(z.object({
    path: z.string(), operation: z.enum(["create", "modify", "delete", "rename"]), reason: z.string().optional(),
  })).default([]),
  commitBoundary: z.record(z.unknown()).optional(),
  evidenceToRecord: z.array(z.string()).default([]),
});
const FailureContract = z.object({
  failureConditions: z.array(z.string()).default([]),
  stopConditions: z.array(z.string()).default([]),
  blockerDecisionRefs: z.array(z.string()).default([]),
  followupTemplateRefs: z.array(z.string()).default([]),
});
const HandoffContract = z.object({
  requiresBeadsNote: z.literal(true),
  requiresCommitSha: z.boolean().default(true),
  closeByIntegrationOwner: z.boolean().default(false),
  artifactRoot: z.string().optional(),
});

const WorkPacketBase = {
  goalContract: GoalContract,
  inputContract: InputContract,
  constraintContract: ConstraintContract,
  validationContract: ValidationContract,
  outputContract: OutputContract,
  handoffContract: HandoffContract,
  failureContract: FailureContract.optional(),
};
// Per-kind required shapes ("ideal template per type", enforced).
export const WorkPacket = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tdd"), ...WorkPacketBase,
    executionContract: ExecutionContract,                 // REQUIRED for tdd (audit fix)
    validationContract: ValidationContract.refine(
      (v) => !!v.redCommand && !!v.expectedFailure && !!v.expectedRedShape,
      { message: "tdd requires redCommand + expectedFailure + expectedRedShape" }),
  }),
  z.object({ kind: z.literal("fixture"), ...WorkPacketBase,
    executionContract: ExecutionContract.optional(),
    provenanceContract: z.object({ provenance: z.string(), refreshPolicy: z.string(), expectedSignal: z.string() }),
  }),
  z.object({ kind: z.literal("acceptance"), ...WorkPacketBase,
    executionContract: ExecutionContract.optional(),
    validationContract: ValidationContract.refine(
      (v) => v.acceptanceMatrixRefs.length > 0 && !!v.proofCommand,
      { message: "acceptance child requires acceptanceMatrixRefs + proofCommand" }),
  }),
  z.object({ kind: z.literal("integration"), ...WorkPacketBase, executionContract: ExecutionContract.optional() }),
]);

export const CheckpointContract = z.object({
  gate: z.object({ kind: z.enum(["pre-edit","fanout","integration","completion","publication","release"]),
                   for: z.string().optional() }),
  fanout: z.record(z.unknown()).optional(),
  merge: z.object({ owner: z.string().optional(), ownershipMapRef: z.string().optional(),
                    conflictPolicy: z.string().optional() }).optional(),
  validation: z.object({ commands: z.array(z.string()), acceptanceMatrixRefs: z.array(z.string()).default([]) }),
  escalation: z.object({ stopConditions: z.array(z.string()).default([]),
                         decisionRefs: z.array(z.string()).default([]) }).optional(),
});
export const StageDefaults = z.object({
  allowedFiles: z.array(z.string()).default([]),
  forbiddenFiles: z.array(z.string()).default([]),
  serialByDefault: z.boolean().default(false),
  objective: z.string().optional(),
});
export const AcceptanceContract = z.object({
  gherkinFeature: z.record(z.unknown()),
  runnerAdapter: z.object({ command: z.string() }),
  jsonIr: z.record(z.unknown()).optional(),
  generator: z.record(z.unknown()).optional(),
  stepHandler: z.record(z.unknown()).optional(),
  mutation: z.record(z.unknown()).optional(),
  mutationReport: z.record(z.unknown()).optional(),
});

export const ROLES = ["epic","story","child","checkpoint","acceptance",
  "context.global","context.architecture","context.policy","context.decision",
  "context.guardrail","context.review","context.progress","followup-template"] as const;

/** A JSON-string field whose parsed value matches `inner`. */
const jsonString = <T extends z.ZodTypeAny>(inner: T) =>
  z.string().transform((s, ctx) => {
    try { return inner.parse(JSON.parse(s)); }
    catch (e) { ctx.addIssue({ code: "custom", message: `invalid JSON payload: ${(e as Error).message}` }); return z.NEVER; }
  });

const BaseMeta = { schema: z.literal(SCHEMA_VERSION), provides: jsonString(z.array(z.string())).optional() };

export const Metadata = z.discriminatedUnion("role", [
  z.object({ role: z.literal("epic"), ...BaseMeta,
    validationProfile: z.enum(["tdd","tdd+acceptance"]).default("tdd"), planId: z.string(), planRef: z.string() }),
  z.object({ role: z.literal("story"), ...BaseMeta, stageDefaults: jsonString(StageDefaults) }),
  z.object({ role: z.literal("child"), ...BaseMeta,
    kind: z.enum(["tdd","fixture","acceptance","integration"]),
    contextRefs: jsonString(z.array(z.string())).optional(),
    workPacket: jsonString(WorkPacket),
    planContentHash: z.string().optional() }),
  z.object({ role: z.literal("checkpoint"), ...BaseMeta, checkpointContract: jsonString(CheckpointContract) }),
  z.object({ role: z.literal("acceptance"), ...BaseMeta, acceptanceContract: jsonString(AcceptanceContract) }),
  ...["context.global","context.architecture","context.policy","context.decision",
      "context.guardrail","context.review","context.progress","followup-template"].map((r) =>
    z.object({ role: z.literal(r as any), ...BaseMeta,
      contextRefs: jsonString(z.array(z.string())).optional(),
      snippets: jsonString(z.record(z.unknown())).optional() })),
]);

export const Node = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  type: z.enum(["epic","story","task","decision","spike","chore","feature","milestone"]).optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  parent: z.string().optional(),
  deps: z.array(z.string()).default([]),
  priority: z.number().int().min(0).max(4).optional(),
  metadata: Metadata,
});
export const CoverageEntry = z.object({ section: z.string() })
  .and(z.union([ z.object({ nodes: z.array(z.string()) }), z.object({ outOfScope: z.string() }) ]));
export const Graph = z.object({ nodes: z.array(Node).min(1), coverage: z.array(CoverageEntry).optional() });

export type TGraph = z.infer<typeof Graph>;
export type TNode = z.infer<typeof Node>;
```

**Step 2: fixtures** — `good-minimal.graph.json` (epic w/ `planId`+`planRef`, a `context.architecture`, a `story`
w/ `stageDefaults`, a `child` kind `tdd` with a full `workPacket` incl. `executionContract.greenScope`, a
`checkpoint`). `bad-missing-redcommand` removes `redCommand` from the tdd packet. `bad-bad-kind` sets `kind:"xxx"`.

**Step 3: `test/schema.test.ts`**
```ts
import test from "node:test"; import assert from "node:assert/strict";
import fs from "node:fs"; import path from "node:path";
import { Graph } from "../src/schema.ts";
const fx = (n: string) => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures", n), "utf8"));
test("good-minimal parses", () => { assert.equal(Graph.safeParse(fx("good-minimal.graph.json")).success, true); });
test("tdd missing redCommand fails with a path through workPacket", () => {
  const r = Graph.safeParse(fx("bad-missing-redcommand.graph.json"));
  assert.equal(r.success, false);
  assert.ok(JSON.stringify(r.error!.issues).match(/workPacket|redCommand/));
});
test("unknown child kind fails", () => {
  assert.equal(Graph.safeParse(fx("bad-bad-kind.graph.json")).success, false);
});
```
**Step 4:** `npm test` → schema tests pass. **Step 5: Commit** `feat(plan-to-beads): zod schema source of truth`.

---

## Task 3: Identity & field ownership

**Files:** `src/identity.ts`; `test/identity.test.ts`.

**Step 1: failing tests** — `planContentHash` is stable across re-serialization, changes when a *plan-owned* field
changes, and is unchanged when an *execution-owned* field changes. `splitFields` returns the plan-owned subset.

**Step 2: implement**
```ts
import { createHash } from "node:crypto";
import type { TNode } from "./schema.ts";
export const PLAN_OWNED = ["title","description","parent","deps","metadata.workPacket",
  "metadata.checkpointContract","metadata.acceptanceContract","metadata.stageDefaults",
  "metadata.contextRefs","metadata.snippets","metadata.validationProfile"] as const;
// Build a canonical object of plan-owned fields (stable key order) and hash it.
export function planContentHash(node: TNode): string { /* pick PLAN_OWNED, sort keys deeply, JSON.stringify, sha256 */ }
export function planId(node: TNode): string { return (node.metadata as any).planId ?? ""; }
```
`planContentHash` must deep-sort keys so JSON ordering can't change the hash. Execution-owned fields
(`status`,`assignee`,`notes`, close-state) are **not** in `PLAN_OWNED` and never affect the hash.

**Step 3:** tests pass. **Step 4: Commit** `feat(plan-to-beads): stable identity + planContentHash`.

---

## Task 4: Normalize (decode-time defaults + inheritance + wiring)

**Files:** `src/normalize.ts`; `test/normalize.test.ts`; fixture `test/fixtures/lean.graph.json`.

Pure `graph → graph` over a **parsed** graph. (Zod `.default()` already fills many fields at parse; this pass does the
cross-node transforms Zod can't.)

**Step 1: failing tests** — child inherits nearest-ancestor `story.stageDefaults.allowedFiles` when absent; child
under epic directly (no story) is handled (no throw); `metadata.contextRefs` is the dedup-ordered union of existing
+ `workPacket.inputContract.contextRefs`; `type` filled from `role` for **every** role incl. `context.global`;
author-set `allowedFiles` is **not** overwritten; idempotent (`normalize(normalize(x)) deepEqual normalize(x)`);
normalized lean graph validates.

**Step 2: implement**
```ts
export const ROLE_TO_TYPE: Record<string,string> = {
  epic:"epic", story:"story", child:"task", checkpoint:"task", acceptance:"task",
  "context.global":"decision","context.architecture":"decision","context.policy":"decision",
  "context.decision":"decision","context.review":"decision",
  "context.guardrail":"chore","context.progress":"chore","followup-template":"chore",
};
export function normalizeGraph(graph: TGraph): TGraph { /* deep-clone; fill type from ROLE_TO_TYPE if absent;
  for each child: if no allowedFiles, copy nearest-ancestor story stageDefaults.allowedFiles; set contextRefs =
  dedupe(existing ++ inputContract.contextRefs) preserving first-seen order; default priority=2. Re-serialize only
  mutated JSON-string payloads. Never overwrite author-set values. */ }
```
Assert `ROLE_TO_TYPE` covers `ROLES` (a test iterates `ROLES` and asserts each has a mapping — audit fix).

**Step 3:** tests pass. **Step 4: Commit** `feat(plan-to-beads): graph normalizer`.

---

## Task 5: Validate (Zod + ref-integrity + coverage)

**Files:** `src/validate.ts`; `test/validate.test.ts`; fixtures `bad-dangling-ref`, `good-external-ref`,
`bad-coverage-ref`, `bad-overlapping-scope`.

`validateGraph(graph)` → `{ ok, errors:[{path,message}] }`. Layers:
1. **Zod** `Graph.safeParse` (structure/per-role/per-kind). Map issues to `{path: issue.path.join("/"), message}`.
2. **Ref-integrity:** build `keys = set(node.key)` and `provided = union(provides)`. For each node verify `parent`,
   each `deps[]`, parsed `metadata.contextRefs`, **and workPacket-internal refs** (`inputContract.contextRefs`,
   `typedContractRefs`, `validationContract.acceptanceMatrixRefs`, `constraintContract.guardrailRefs`,
   `failureContract.*Refs`) resolve to a `key`/`provided` value **or** end with the literal suffix **`@external`**
   (the defined convention — external refs are allowed and skipped). Detect duplicate keys.
3. **Coverage well-formedness:** if `graph.coverage` present, each entry has exactly one of `nodes`/`outOfScope`, and
   every `nodes[]` resolves to a key.
4. **Parallel write-scope:** sibling children that can be ready simultaneously (share a parent, no dep between them)
   must have disjoint `allowedFiles` globs **or** a checkpoint with a `merge` contract owning them; else warn.

**Step 1:** failing tests for dangling ref (named), `@external` accepted, coverage ref unresolved, overlapping scope
flagged, good-minimal clean. **Step 2:** implement. **Step 3:** tests pass.
**Step 4: Commit** `feat(plan-to-beads): graph validation (refs + coverage + scopes)`.

---

## Task 6: Isolated bd test harness

**Files:** `test/helpers/bd.ts`; `test/helpers.test.ts`.

**Step 1:** implement `withTempBd(fn)` — create a temp dir, set `BEADS_DB`/`--db` to a fresh db there (confirm the
exact isolation flag via `bd --help`; prefer `bd --db <path>` per command, else `BEADS_DB` env), run `fn(bd)` where
`bd(args)` shells out scoped to that db, then remove the temp dir. Provide `bdJson(args)` returning parsed `--json`.
**Step 2:** a test that creates 1 bead in the temp db, lists it, deletes it, and asserts the **repo store is
untouched** (the helper never references the repo `.beads`). **Step 3:** passes.
**Step 4: Commit** `test(plan-to-beads): isolated bd database harness`.

> Hard rule reminder: every later bd-mutating test uses `withTempBd`. No test calls bd against the real store.

---

## Task 7: Reconcile (diff desired vs current)

**Files:** `src/reconcile.ts`; `test/reconcile.test.ts`.

Pure function — no bd calls (current state is passed in), so it is unit-testable without a db.
```ts
export type Op =
  | { kind:"create"; key:string; node:TNode }
  | { kind:"update"; key:string; id:string; node:TNode; changed:string[] }
  | { kind:"noop"; key:string; id:string }
  | { kind:"orphan"; key:string; id:string }           // in current, not desired → flag
  | { kind:"conflict"; key:string; id:string; reason:string };
export function reconcile(desired: TGraph, current: CurrentBead[]): Op[] { /* index current by logicalId within the
  same planId; for each desired node: not in current → create; in current and planContentHash equal → noop; differs →
  if current.planContentHash !== current.lastAppliedHash AND desired hash !== lastApplied → conflict; else update
  (changed = plan-owned fields that differ). current-only logicalIds → orphan. Return ops in dependency-safe order
  (parents/creates before dependents). */ }
```
`CurrentBead` carries `{ id, logicalId, planId, planContentHash, lastAppliedHash, status }`. `lastAppliedHash` is read
from bead metadata written at last apply; `status` lets reconcile treat closed beads as conflicts when the desired
content changed.

**Step 1:** failing tests over fixtures `reconcile/v1.graph.json` → `reconcile/v2.graph.json` with a synthetic
`current` array: first run = all `create`; v2 with t1 changed = `update` (changed lists the field); unchanged = `noop`;
a current-only key = `orphan`; a closed-with-changed-desired = `conflict`; ordering puts parents before children.
**Step 2:** implement. **Step 3:** tests pass. **Step 4: Commit** `feat(plan-to-beads): additive reconcile diff`.

---

## Task 8: Apply (execute ops via bd) + post-apply validation

**Files:** `src/apply.ts`; `test/apply.test.ts` (uses `withTempBd`).

`applyOps(ops, bd)`:
- **creates** → build a `graph.json` from the create ops and run `bd create --graph` once (one transaction-ish call);
  stamp `metadata.lastAppliedHash = planContentHash` on each created node.
- **updates** → per op, `bd update <id> --metadata @tmp.json` writing only plan-owned metadata + refresh
  `lastAppliedHash`; reconcile `deps` via `bd dep add`/remove for plan-derived edges only.
- **noop** → skip. **orphan/conflict** → do not mutate; collect into the returned report for the human.
- Idempotent + resumable: re-running `applyOps` after a partial failure recomputes ops and continues.
- **Post-apply:** `bd dep cycles`; `bd list --json` by planId to verify metadata; `bd swarm validate <epic>`.

**Step 1:** failing tests (in `withTempBd`): apply v1 → 5 beads exist with correct metadata; apply v2 → t1 updated,
t2 created, checkpoint dep added, **a manually-set `notes`/`status` on t1 is preserved**; re-apply v2 → all `noop`
(idempotent). **Step 2:** implement. **Step 3:** tests pass.
**Step 4: Commit** `feat(plan-to-beads): apply ops to bd + post-apply validation`.

---

## Task 9: Review artifact

**Files:** `src/review.ts`; `test/review.test.ts`.

`renderReview(ops, graph)` → Markdown: counts by op + role; root/story/child/checkpoint/context titles; dependency
table; **conflicts and orphans called out**; external refs; `validationProfile`; post-apply checklist. The CLI emits
it for graphs above a node threshold (≈8) or on `plan`.

**Step 1:** failing tests: review of the v1→v2 ops contains an "Update" row for t1, a "Create" row for t2, a
"Conflicts: 0" line, and the dep table lists checkpoint→t2. **Step 2:** implement (pure string). **Step 3:** pass.
**Step 4: Commit** `feat(plan-to-beads): markdown review artifact`.

---

## Task 10: CLI

**Files:** `src/cli.ts` (shebang `#!/usr/bin/env -S node --experimental-strip-types`); `test/cli.test.ts`.

Commands:
- `validate <graph.json>` → normalize + validate; print `path: message` per error; exit 1 on failure, else `VALID`.
- `plan <graph.json>` → normalize + validate + **render review to stdout**; **no mutation**. (This is the safe
  preview, since `bd create --graph` has no dry-run.)
- `apply <graph.json>` → normalize + validate + read current (`bd list --json` by planId) + reconcile + apply +
  post-apply validation; print the review + the applied/skipped/flagged summary.

**Step 1:** failing tests: `validate` good→exit0/`VALID`, bad→exit1 with a path; `plan` emits review and creates
nothing (assert temp db empty after). **Step 2:** implement (thin; delegates to the modules). **Step 3:** pass.
**Step 4: Commit** `feat(plan-to-beads): cli (validate/plan/apply)`.

---

## Task 11: SKILL.md (tight 80% path)

**Files:** Rewrite `SKILL.md` (≤ ~110 lines). Frontmatter `name`/`description` (turn a plan into a bd work graph;
trigger words: plan-to-beads, convert plan to beads, bead work graph, reconcile plan beads). Process: `bd prime` →
**classify every plan section + build a coverage ledger** → draft `graph.json` (node shape; metadata string→string
with JSON-string payloads; epic→story→task via `parent`; `deps`=readiness vs `contextRefs`=read-time) →
`plan-to-beads plan graph.json` (normalize+validate+**review**, no mutation) → **adversarial review** of the review
artifact vs the plan → `plan-to-beads apply graph.json` (reconcile+apply) → it runs post-apply `bd dep cycles` +
`bd swarm validate`; then `bd swarm create <epic>`; checkpoints → `bd gate create`/`bd merge-slot`. Hard-rules box:
never `bd create --graph` by hand for preview (no dry-run — use `plan`); child `contextUse` lives only in
`workPacket.inputContract`; resolved context = `contextRefs`, unresolved decision = `deps`; reconcile preserves
execution state and **flags** orphans/conflicts (never auto-deletes). Pointer to REFERENCE.md for the schema, role
catalog, acceptance profile, `@external` convention, and field-ownership rules.
**Commit** `docs(plan-to-beads): rewrite SKILL.md for the zod/bd-native path`.

---

## Task 12: REFERENCE.md

**Files:** Rewrite `REFERENCE.md`. "The Zod schema in `src/schema.ts` is the source of truth; this explains intent."
Cover: role catalog (role → bd type → purpose); child kinds + required fields; edges (deps/contextRefs/parent);
the `@external` ref convention; snippet `snippets` keys (add a Zod sub-schema when first used); acceptance profile
(`tdd` ↔ `tdd+acceptance`); **reconcile + field-ownership** (plan-owned vs execution-owned; `planContentHash`;
conflict = both-sides-changed; orphans flagged); bd mapping (`create --graph` no-dry-run, `update --metadata`,
`dep`, `dep cycles`, `swarm validate/create`, `gate`, `merge-slot`). **Commit** `docs(plan-to-beads): rewrite REFERENCE.md`.

---

## Task 13: EXAMPLES.md + example checker

**Files:** Rewrite `EXAMPLES.md`; `test/examples.test.ts`.

Content: (1) old↔new (the old ~145-line IR abbreviated for contrast vs the new `graph.json`); (2) acceptance-profile
example (`tdd+acceptance`); (3) **reconcile example** (v1 graph, then v2 with an added task + widened scope, and the
resulting create/update/noop ops). Tag graph blocks with an explicit info-string ` ```json ptb-graph ` so the checker
can find them. `test/examples.test.ts` extracts every ` ```json ptb-graph ` block and asserts `validateGraph` passes
(non-graph JSON blocks are ignored). **Commit** `docs(plan-to-beads): rewrite EXAMPLES.md + validate examples`.

---

## Task 14: Delete the old stack + migrate design docs

**Step 1: repo-wide reference scan** (audit fix — not skill-local):
```bash
rg -n "render-plan-to-beads|validate-plan-to-beads|plan-to-beads/templates|executable-plan.formula|\.formula\.toml" \
  --glob '!**/node_modules/**' 2>&1 | head -c 1500
```
Resolve every hit outside the three rewritten docs (update or confirm historical). Confirm `SKILL/REFERENCE/EXAMPLES`
no longer mention the old stack.
**Step 2: delete** `git rm -r templates scripts/render-plan-to-beads.cjs scripts/validate-plan-to-beads.cjs`. Keep
`design/` (move it under the package; it's the design record).
**Step 3: verify** `npm test` green; `node --experimental-strip-types src/cli.ts validate test/fixtures/good-minimal.graph.json` → `VALID`.
**Step 4: Commit** `refactor(plan-to-beads): delete unused IR/templates/render/formula stack`.

---

## Task 15: Final verification + close

**Step 1:** `npm test` → all green (schema, identity, normalize, validate, reconcile, apply, review, cli, examples).
**Step 2:** validator rejects every `bad-*` fixture with a precise path (loop + assert exit 1).
**Step 3:** in `withTempBd`: apply v1 → apply v2 → assert create+update+noop happened and execution state preserved;
re-apply → all noop; `bd swarm validate` clean. (Throwaway db only.)
**Step 4:** `bd close <task ids>`; `bd epic status $EPIC`; `bd close $EPIC`.
**Step 5: Commit + push** `feat(plan-to-beads): complete portable zod/bd-native rebuild`.

---

## Test Coverage Notes (why sufficient)

- **Correctness in every instance:** schema tests cover each role + all four child kinds (good) and the dominant
  failures (missing required tdd field, unknown kind, dangling ref, unresolved coverage, overlapping scope) (bad).
  Reconcile tests cover create/update/noop/orphan/conflict + ordering. Apply tests prove execution-state preservation
  and idempotence. Identity tests prove the hash ignores execution-owned fields. Normalize tests prove inheritance,
  wiring, role→type completeness, no-overwrite, and idempotence.
- **Won't break related functionality:** the package is standalone (no imports into any host app), so it cannot
  regress runtime code. **Every bd-mutating test runs against a throwaway db via `withTempBd`** — the real store is
  never touched and `.beads` is never `git checkout`ed. Deletion (Task 14) is guarded by a repo-wide reference scan
  and a post-delete `npm test` + CLI smoke.
