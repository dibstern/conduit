# Plan To Beads Templates

These files are generic role templates. They are not plan-specific formulas.

`/plan-to-beads` should parse a plan into an IR, hydrate these snippets, compose a generated formula under `.beads/generated-formulas/`, then validate it with Beads before pouring.

Placeholders use `{{snake_case}}`. Placeholders ending in `_array`, `_table`, `_tables`, or `_object` are pre-rendered TOML fragments.

## Files

- `formula/executable-plan.formula.toml`: full-formula skeleton.
- `roles/*.toml`: role snippets for one Beads issue/step.
- `contracts/*.toml`: reusable metadata table snippets used by role templates.

Do not commit concrete plan behavior, file paths, commands, or expected failures into these templates.
