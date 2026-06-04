# Plan To Beads Schema Engine Options

## Context

The repo-local `.agents/skills/plan-to-beads` skill already has a useful v3 shape:

- `SKILL.md` and `REFERENCE.md` define the conceptual model: Beads hold the durable graph, child beads carry executable prompt contracts, and shared plan context is referenced through `needs`, `contextRefs`, `inherits`, `provides`, and typed contract refs.
- `templates/` contains generic TOML snippets for formulas, roles, and contract families.
- `scripts/render-plan-to-beads.cjs` renders a plan IR into a formula by hydrating `{{snake_case}}` placeholders.
- `scripts/validate-plan-to-beads.cjs` checks skill-source invariants and generated formula invariants such as unresolved placeholders, duplicate logical ids, reference resolution, child work-packet completeness, checkpoint contract shape, and `contextUse` placement.

That current validator is mostly an output validator. It protects the generated TOML and Beads graph shape, but it is not a real schema engine for the input plan IR. The renderer also defaults missing placeholders to empty strings, empty arrays, empty tables, `false`, or `0`, which is convenient for generation but dangerous for agent reliability because an incomplete IR can quietly become a concrete formula that fails later.

Conduit already depends on `effect` and uses `Schema` in app code. Zod is not a direct dependency. AJV appears only as a transitive dependency, so a JSON Schema validator should not rely on it without making it explicit.

## Evaluation Criteria

The schema design should optimize for:

- **Runtime validation:** catch invalid or incomplete plan IR before rendering, and keep post-render formula checks.
- **Portability:** let the skill remain usable by agents and in other repos without requiring conduit's full app stack.
- **Implementation cost:** minimize churn in the current CJS renderer/templates.
- **Generated artifacts:** support JSON Schema, examples, placeholder manifests, and reference docs from one source of truth.
- **Reviewability:** make schema changes visible, diffable, and understandable to humans reviewing a plan-to-beads change.
- **Skill portability:** avoid making a reusable agent skill depend on a large, repo-specific runtime unless there is a generated portable fallback.
- **Dependency weight:** avoid adding Zod, AJV, schema generators, or build tooling unless the reliability gain is clear.
- **Agent reliability:** prefer explicit errors and generated examples over implicit defaults and prose-only schema rules.

## Options

### Decision Matrix

| Option | Runtime validation | Portability | Implementation cost | Generated artifacts | Reviewability | Dependency weight | Agent reliability | Fit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Current CJS validator/templates | Medium for output, low for IR | High | Low | Low | Medium | None | Medium-low | Keep as post-render guard |
| JSON Schema | High with validator | Very high | Medium | High | High | Low to medium | High | Best portable contract |
| Zod | High | Medium | Medium | Medium with generators | High | New direct dep | High | Good generally, weak repo fit |
| Effect Schema | High | Medium | Medium | High with JSON Schema export | Medium-high | Already direct dep | High | Best repo-local authoring engine |
| TypeScript types only | Low | Medium | Low | Low | Medium | Existing TS | Low | Insufficient alone |
| Generated docs/templates from schema | Depends on source schema | High if generated files committed | Medium-high | Very high | High | Depends on generator | High | Strong companion, not standalone |
| Hybrid Effect Schema plus generated JSON Schema plus CJS output validation | High | High | Medium | Very high | High | No new app dep, possible build tooling | Very high | Recommended |

### Current CJS Validator and Templates

The current approach is valuable because it is dependency-free, easy to run with `node`, and close to the actual TOML output. It can validate facts that a generic IR schema will not see after rendering, including unresolved placeholders, duplicate `provides`, child `contextUse` placement, reference resolution across rendered steps, and required role-specific metadata tables.

The weakness is that it validates late. By the time it sees a generated formula, the renderer may already have turned absent fields into empty values. That makes error provenance weaker: the failure is reported against TOML output instead of the IR field or extraction decision that caused it. The regex/text approach is also hard to extend for richer TOML semantics, nested contract variants, compatibility migrations, or generated documentation.

Keep this layer, but narrow its job: source-template checks plus post-render formula checks. Do not make it the canonical input schema.

### JSON Schema

JSON Schema is the best portable contract for a repo-local skill that may later be copied to dotfiles or other projects. It is language-neutral, diffable, readable enough for agents, and works well with editor validation, examples, and external tooling. It can express the main plan IR: top-level fields, role discriminators, typed contract records, required child subcontracts, enums like `contextUse.phase`, and reference-like string fields.

The limits are semantic. JSON Schema is awkward for graph rules such as "every `needs` reference must resolve to a role id or external ref", "child context refs must also have timing rules when required by policy", "parallel children must have disjoint write scopes or a checkpoint merge rule", and "legacy v2 fields normalize into v3 homes". Those are validation rules, but they are not naturally structural JSON Schema rules.

Use JSON Schema as a generated public contract, not necessarily as the only source of truth. If it is hand-authored, add a small explicit validator dependency such as AJV instead of relying on transitive dependencies.

### Zod

Zod would make the IR schema easy to write and easy for agents to understand. It has good runtime validation, good TypeScript inference, and familiar error behavior. It is a pragmatic choice in many TypeScript repos.

The problem is repo fit. Conduit already uses Effect Schema, while Zod is not installed. Adding Zod would create a second schema idiom for a repo-local skill and would need additional tooling for JSON Schema generation if portability matters. That is not fatal, but it is hard to justify when the repo already has a capable schema system.

Choose Zod only if the skill is intentionally being optimized for broad external TypeScript familiarity over conduit consistency.

### Effect Schema

Effect Schema fits conduit best as the local authoring and runtime validation engine. It is already a direct dependency, already appears in app code, and can provide runtime decoding, TypeScript types, brands, transforms, compatibility normalization, and JSON Schema export from the same source.

It is particularly useful for plan-to-beads because the IR is not only structural. The system needs decoding and normalization:

- accept compatibility aliases such as `logical_id` and `logicalId`;
- normalize v2 flat child fields into v3 `workPacket` subcontracts;
- enforce role-discriminated required fields;
- keep typed contract kinds tied to valid placeholder target fields;
- produce clear parse failures before TOML rendering.

The tradeoff is portability. A pure Effect Schema validator requires the repo's Node dependency install and usually a TypeScript runtime or compiled output. It is also less universally familiar to agents than JSON Schema or Zod. That is manageable if the portable artifacts are generated and committed.

Use Effect Schema as the canonical local source only if the migration also commits generated JSON Schema and keeps a small CJS-compatible validation entrypoint.

### TypeScript Types Only

TypeScript types are cheap and useful for maintainers, but they do not protect the actual skill workflow. Agents and scripts will read JSON, TOML, and markdown. A TypeScript type cannot reject a malformed `plan-ir.json` at runtime, cannot validate generated formula output, and cannot explain failures to a non-TypeScript consumer.

Use inferred TypeScript types as a byproduct of Effect Schema or Zod. Do not make types the schema.

### Generated Docs and Templates From a Schema

Generated artifacts are worth doing, but only after the source schema is real. The highest-value artifacts are:

- `schemas/plan-ir.schema.json` for portable validation and editor support.
- `schemas/plan-ir.example.json` from a known valid minimal IR.
- `schemas/placeholder-manifest.json` mapping role placeholders to schema paths and defaults.
- A generated appendix in `REFERENCE.md` for role fields, required fields, enum values, and compatibility aliases.
- Optional template audits that fail when `templates/roles/*.toml` references a placeholder not owned by the schema.

Do not generate the TOML role templates wholesale at first. They are reviewable today and close to Beads formula behavior. Generate a manifest and checks before generating templates. Template generation can come later if placeholder drift remains painful.

### Hybrid

The strongest design is a hybrid with clear layer boundaries:

1. **Canonical IR schema:** write the plan IR schema in Effect Schema because conduit already uses it and it can handle decode, transform, and typed runtime checks.
2. **Portable contract:** generate and commit JSON Schema from the Effect Schema source.
3. **Runtime entrypoint:** expose `validate-plan-ir` so agents can validate `plan-ir.json` before rendering.
4. **Renderer:** keep the current renderer initially, but change the workflow so it receives decoded, normalized IR and stops using silent defaults for required fields.
5. **Formula validator:** keep the current CJS `validate-plan-to-beads.cjs` as the post-render validator for TOML and graph invariants.
6. **Beads validator:** keep `bd cook --dry-run` and `bd cook --mode=runtime --dry-run` as the external Beads behavior check.
7. **Generated review artifacts:** generate JSON Schema, examples, placeholder manifests, and docs snippets from the canonical schema.

This gives conduit maintainers strong local validation without making the skill unreadable or unusable outside conduit.

## Recommendation

Adopt the hybrid: **Effect Schema as the repo-local canonical IR schema, generated JSON Schema as the portable contract, and the existing CJS validator as the post-render formula guard.**

Do not replace the current CJS scripts in one jump. The immediate reliability issue is not that the formula validator is CJS; it is that the input IR has no strict schema before rendering and missing fields can become empty placeholders. Fix that first.

The target shape should be:

- `schemas/plan-ir.schema.ts`: canonical Effect Schema source for plan IR, roles, typed contracts, work packets, checkpoints, acceptance pipeline contracts, context use, and compatibility aliases.
- `schemas/plan-ir.schema.json`: generated JSON Schema committed for portability.
- `schemas/plan-ir.example.json`: generated minimal valid example.
- `schemas/placeholder-manifest.json`: generated mapping from template placeholders to schema paths, defaults, and requiredness.
- `scripts/validate-plan-ir.*`: validates and normalizes input IR, then reports errors against IR paths.
- `scripts/render-plan-to-beads.cjs`: continues to render TOML, but is called after IR validation. Over time, it should reject missing required values rather than defaulting them silently.
- `scripts/validate-plan-to-beads.cjs`: remains the output validator for generated TOML, unresolved placeholders, graph refs, and role completeness.

This design keeps the skill reliable for agents: they can validate early, inspect generated schema/docs, and still use the existing post-render checks that understand Beads formula output. It also avoids adding Zod just for this skill.

## Migration Path

1. **Freeze the current contract.** Treat `plan-to-beads.v3` in `REFERENCE.md`, role templates, and the existing validator as the baseline behavior. Add schema work without changing the generated TOML shape.

2. **Add a minimal IR schema.** Start with top-level plan fields, role discriminator, logical id, title, description, `needs`, `contextRefs`, `inherits`, `provides`, `typedContractRefs`, `contextUse`, and `values`. Validate only the fields the renderer already understands.

3. **Move required child and checkpoint fields into schema.** Encode the v3 child `workPacket` and checkpoint subcontracts as first-class schema objects. Keep compatibility for current `values` placeholders while introducing structured homes.

4. **Normalize before rendering.** Add a validation step that accepts compatibility aliases and produces one normalized IR shape. The renderer should consume normalized keys, not raw mixed-case input.

5. **Generate portable artifacts.** Emit JSON Schema, a minimal example, and a placeholder manifest. Commit those generated files so agents and non-Effect environments can inspect the contract.

6. **Audit placeholder drift.** Add a cheap check that every `{{snake_case}}` placeholder in role templates is either in the manifest or explicitly marked as a renderer-owned computed field.

7. **Tighten defaults.** Keep empty defaults only for optional fields. Required fields should fail in `validate-plan-ir` before rendering.

8. **Keep Beads checks last.** Continue running `validate-plan-to-beads.cjs`, `bd cook --dry-run`, and the relevant `bd mol pour --dry-run` before approving a generated plan.

## Open Questions

- Should the canonical schema live inside the repo-local skill only, or should the source of truth remain in the dotfiles-backed global skill tree with conduit carrying generated artifacts?
- How portable does the skill need to be outside conduit? If portability is a hard requirement, generated JSON Schema and a dependency-light validator become mandatory, not optional.
- Should the IR expose structured `workPacket` fields directly, or keep accepting the current `values` placeholder object as compatibility input for a full version?
- How strict should schema validation be about cross-role graph rules before rendering versus after rendering?
- Should TOML parsing be introduced for the output validator, or is the current text validator acceptable while `bd cook` remains the semantic TOML check?
- Which docs should be generated from schema versus maintained by hand so reviewers can still understand conceptual changes?
