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

Minimal `plan-ir.json`:

```json
{
  "planId": "json-report",
  "planTitle": "Add JSON Report Timestamp",
  "sourcePlan": "docs/plans/json-report.md",
  "planDescription": "Executable Beads graph for the JSON timestamp plan.",
  "typedContracts": [
    {
      "logicalId": "json-report-artifact-contract",
      "kind": "artifactContract",
      "ownerLogicalId": "json-report-architecture",
      "targetField": "artifact_contracts_array_of_tables",
      "provides": ["json-report-artifact-contract"],
      "metadata": {
        "artifact": "JSON report",
        "schemaVersion": "v1",
        "format": "json",
        "fieldRules": [{ "field": "generatedAt", "rule": "stable timestamp string" }],
        "bounds": {},
        "redactionRules": []
      }
    }
  ],
  "roles": [
    {
      "role": "epic",
      "logicalId": "json-report-epic",
      "title": "Add JSON Report Timestamp",
      "description": "Root plan molecule.",
      "provides": ["json-report-epic"]
    },
    {
      "role": "global-contract",
      "logicalId": "json-report-global-contract",
      "title": "JSON report scope",
      "description": "Scope and non-goals.",
      "provides": ["json-report-global-contract"],
      "values": {
        "scope_array": ["Add generatedAt to JSON reports."],
        "non_goals_array": ["Do not change text output."]
      }
    },
    {
      "role": "architecture",
      "logicalId": "json-report-architecture",
      "title": "JSON report architecture",
      "description": "ReportWriter owns the JSON output contract.",
      "contextRefs": ["json-report-global-contract"],
      "provides": ["json-report-architecture"]
    },
    {
      "role": "parent",
      "logicalId": "json-report-stage",
      "title": "JSON report stage",
      "description": "Stage defaults for JSON report work.",
      "contextRefs": ["json-report-global-contract", "json-report-architecture"],
      "provides": ["json-report-stage"],
      "values": {
        "stage": "json-output",
        "objective": "Add the JSON-only timestamp behavior.",
        "default_allowed_files_array": [
          "packages/json-report/src/report-writer.ts",
          "packages/json-report/test/report-json.test.ts"
        ],
        "default_forbidden_files_array": [
          "packages/json-report/src/text-report-writer.ts"
        ],
        "serial_by_default_bool": true
      }
    },
    {
      "role": "child",
      "logicalId": "json-report-t1-generated-at",
      "title": "T1 JSON generatedAt field",
      "description": "One red-green behavior for generatedAt.",
      "needs": ["json-report-stage"],
      "contextRefs": ["json-report-global-contract", "json-report-architecture"],
      "inherits": ["json-report-stage"],
      "typedContractRefs": ["json-report-artifact-contract"],
      "contextUse": [
        {
          "ref": "json-report-global-contract",
          "phase": "before-edit",
          "required": true,
          "reason": "Scope and non-goals constrain the patch.",
          "failureIfMissing": "Stop and create a decision bead."
        }
      ],
      "values": {
        "goal": "Make empty input write a JSON report with generatedAt.",
        "expected_outcome": "The JSON report includes generatedAt and text output is unchanged.",
        "non_goals_array": ["Do not change text output."],
        "behavior_id": "T1-generatedAt",
        "inputs_array": [{ "type": "plan", "path": "docs/plans/json-report.md" }],
        "constraints_array": ["Use red-green-refactor.", "Keep the patch JSON-only."],
        "allowed_files_array": [
          "packages/json-report/src/report-writer.ts",
          "packages/json-report/test/report-json.test.ts"
        ],
        "forbidden_files_array": [
          "packages/json-report/src/text-report-writer.ts"
        ],
        "ordered_steps_array": ["Run the red command.", "Implement the minimal JSON field.", "Run verification."],
        "green_scope": "Add only the JSON generatedAt field and deterministic test fixture.",
        "red_command": "pnpm test -- report-json -t \"T1 generatedAt\"",
        "expected_failure": "JSON output has no generatedAt.",
        "expected_red_shape": "A single assertion failure for the missing generatedAt field.",
        "verification": "pnpm test -- report-json",
        "acceptance_criteria_array": ["JSON output contains generatedAt."],
        "output_shape": "Patch plus Beads handoff note.",
        "patch_shape": "One focused code/test patch.",
        "file_touches_array_of_tables": [
          { "path": "packages/json-report/src/report-writer.ts", "operation": "modify", "reason": "Write generatedAt." },
          { "path": "packages/json-report/test/report-json.test.ts", "operation": "modify", "reason": "Prove generatedAt." }
        ],
        "commit_boundary_table": {
          "commitMessage": "test: add JSON report generatedAt",
          "gitAddPaths": [
            "packages/json-report/src/report-writer.ts",
            "packages/json-report/test/report-json.test.ts"
          ]
        },
        "failure_conditions_array": ["Stop if the behavior requires text output changes."],
        "requires_commit_sha_bool": true,
        "handoff_notes_schema_table": { "summary": "string", "verification": "string" }
      }
    },
    {
      "role": "checkpoint",
      "logicalId": "json-report-checkpoint",
      "title": "JSON report integration checkpoint",
      "description": "Verify and close the JSON report stage.",
      "needs": ["json-report-t1-generated-at"],
      "contextRefs": ["json-report-global-contract", "json-report-architecture"],
      "provides": ["json-report-checkpoint"],
      "values": {
        "gate_kind": "integration",
        "gate_for": "json-report-stage",
        "validation_commands_array": ["pnpm test -- report-json"],
        "merge_owner": "integration-owner",
        "conflict_policy": "Stop and resolve with the checkpoint owner."
      }
    }
  ]
}
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
bd mol pour json-report-executable-plan
bd dep cycles
```

Use `.beads/formulas/` instead of `--persist` only when the generated formula should become a reusable named formula.
