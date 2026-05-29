# Plan To Beads Reference

## Purpose

`/plan-to-beads` turns a structured implementation plan into a Beads-backed work graph. The source templates are generic. A generated plan-specific formula or direct `bd` mutation hydrates placeholders from a plan IR.

## Plan IR

The converter should build this IR before rendering templates:

```json
{
  "planId": "short-stable-id",
  "planTitle": "Human title",
  "sourcePlan": "docs/plans/example.md",
  "roles": [
    {
      "role": "child",
      "logicalId": "stage-behavior-01",
      "title": "Concrete behavior title",
      "needs": ["fixture-basic"],
      "contextRefs": ["global-contract", "architecture-core"],
      "inherits": ["stage-parent"],
      "metadata": {}
    }
  ]
}
```

Use the IR as the only source for plan-specific values. Do not edit the generic templates with concrete behavior names, file paths, expected failures, or commands.

## Hooking Shared Context Into Children

Every role exposes context through `provides`; children consume it through `contextRefs` or `inherits`.

| Source role | Child hook | Meaning |
| --- | --- | --- |
| `global-contract` | `contextRefs` | Scope, non-goals, repo/package boundary, global constraints |
| `architecture` | `contextRefs` | Module ownership, public/private interfaces, forbidden seams |
| `policy` | `contextRefs` | TDD rules, output policy, profile policy, subagent rules |
| `fixture` | `inputs` plus `contextRefs` | Fixture provenance, refresh policy, expected signal |
| `parent` | `inherits` | Stage defaults, owner files, shared forbidden files |
| `checkpoint` | `needs` and `contextRefs` | Fanout gate, integration validation, frozen extension points |
| `pilot` | `needs` and `contextRefs` | Measurement evidence that creates or rejects follow-up work |
| `followup-template` | `contextRefs` | Schema for later child beads, not executable work by default |

`needs` gates readiness. `contextRefs` tells an agent what to read. `inherits` merges defaults into the child prompt contract. `provides` names data that later beads may reference.

## Role To Type Mapping

Use these defaults unless the repository has stricter conventions:

| Role | Beads type | Why |
| --- | --- | --- |
| `epic` | `epic` or molecule root | Whole plan instance |
| `global-contract` | `decision` | Durable scope and non-goals |
| `architecture` | `decision` | Cross-cutting design contract |
| `policy` | `decision` | Cross-cutting execution rules |
| `parent` | `feature` | Deliverable stage or feature group |
| `child` | `task` | One executable implementation contract |
| `checkpoint` | `task` or `gate` | Validation and fanout readiness |
| `fixture` | `chore` | Mechanical/provenance work |
| `pilot` | `task` | Evidence collection with validation |
| `followup-template` | `chore` | Non-executable template for later work |

`parent` should usually be a `feature`, not a `task`, because it groups behavior and carries stage defaults. Use `chore` for non-product mechanical work such as fixture manifests, validation sweeps, export/sync, or template maintenance.

## Version Control

- Commit generic source templates in `.agents/skills/plan-to-beads/templates/`.
- Generate plan-specific formulas in `.beads/generated-formulas/<plan-id>.formula.toml` for review.
- Install a generated formula into `.beads/formulas/` only when the user wants a reusable formula name.
- Store molecule instances and runtime status in Beads/Dolt; `.beads/*.jsonl` are passive exports.
- Include `contractVersion = "plan-to-beads.v1"` and `templateVersion` in rendered metadata.

## Rendering Strategy

Preferred path:

1. Parse the plan into IR.
2. Validate IR completeness.
3. Compose `templates/formula/executable-plan.formula.toml` with role snippets from `templates/roles/`.
4. Replace every placeholder.
5. Write a plan-specific generated formula.
6. `bd cook` and `bd mol pour --dry-run`.

Small-plan fallback:

1. Hydrate role templates directly into `bd create`, `bd update`, and `bd dep add`.
2. Query Beads after mutation.
3. Run the same schema validation against Beads metadata.

## Template Layers

- `templates/formula/`: outer formula shape and common vars.
- `templates/roles/`: one Beads issue/step per role.
- `templates/contracts/`: reusable metadata snippets for child work packets, subagent launch packets, and durable handoff notes.

The converter may inline contract snippets into role snippets, or render role snippets directly when the role already contains the needed fields. The generated formula is the first artifact that must be valid TOML.

## Validation Checklist

Before pouring:

- Generated TOML has no unresolved `{{...}}` placeholders.
- `bd cook <generated-formula> --dry-run` succeeds.
- Dry-run pour shows the expected root, context beads, parents, checkpoints, and children.
- All `logicalId` values are unique.
- All `needs`, `contextRefs`, `inherits`, `provides`, fixture refs, and follow-up template refs resolve.
- All child beads contain required `workPacket` fields.
- `redCommand` targets exactly one behavior; broader commands live in `verification`.
- `allowedFiles` and `forbiddenFiles` are concrete after hydration.
- Parallel waves have disjoint write ownership or checkpoint-owned merge rules.
- Checkpoints define validation commands, fanout rules, subagent launch packet shape, and handoff requirements.
- Fixture beads preserve source provenance and refresh policy.

After pouring:

```bash
bd dep cycles
bd list --has-metadata-key planToBeads --json
bd ready
```

## Placeholder Rules

Use `{{snake_case}}` placeholders. Array and object placeholders represent already-rendered TOML fragments, not quoted strings.

Examples:

- `{{plan_id}}` renders as a scalar string fragment when quoted.
- `{{needs_array}}` renders as a TOML array, for example `["global-contract"]`.
- `{{work_packet_table}}` renders as nested TOML fields.

The source snippets may not be valid standalone TOML before hydration. The generated formula must be valid TOML.
