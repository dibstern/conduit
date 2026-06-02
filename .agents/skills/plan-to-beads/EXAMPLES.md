# Plan To Beads Examples

## Minimal Conversion

Source plan:

```md
# Add JSON Report Timestamp

Scope: add a stable `generatedAt` field to JSON reports.
Non-goal: do not change text output.

Behavior T1: empty input writes a JSON report with `generatedAt`.
Red: `pnpm test -- report-json -t "T1 generatedAt"`
Expected failure: JSON output has no `generatedAt`.
Green: add only the JSON field and deterministic test fixture.
Verification: `pnpm test -- report-json`
```

Generated Beads shape:

- `epic`: root plan molecule.
- `global-contract`: scope, non-goal, source plan path.
- `parent`: report JSON stage defaults.
- `child`: behavior `T1`, with `goalContract`, `inputContract`, `constraintContract`, `executionContract`, `validationContract`, `outputContract`, `failureContract`, and `handoffContract`.
- `checkpoint`: verifies the report stage and owns integration/close rules.

The child references shared context instead of copying it:

```toml
[steps.metadata.workPacket.inputContract]
sourcePlan = "docs/plans/json-report.md"
contextRefs = ["json-report-global-contract", "json-report-stage"]
inherits = ["json-report-stage"]
typedContractRefs = []
contextUse = [
  { ref = "json-report-global-contract", phase = "before-edit", required = true, reason = "Scope and non-goals constrain the patch", failureIfMissing = "Stop and create a decision bead" }
]
fixtureRefs = []
baselineRefs = []
evidenceRefs = []
externalPlanRefs = []
```

Validate before approval:

```bash
node .agents/skills/plan-to-beads/scripts/render-plan-to-beads.cjs plan-ir.json .beads/generated-formulas/json-report.formula.toml
node .agents/skills/plan-to-beads/scripts/validate-plan-to-beads.cjs .beads/generated-formulas/json-report.formula.toml
bd cook .beads/generated-formulas/json-report.formula.toml --dry-run
```

Persist and dry-run pour only after approval:

```bash
bd cook .beads/generated-formulas/json-report.formula.toml --persist --force
bd mol pour json-report-executable-plan --dry-run
bd dep cycles
```

Use `.beads/formulas/` instead of `--persist` only when the generated formula should become a reusable named formula.
