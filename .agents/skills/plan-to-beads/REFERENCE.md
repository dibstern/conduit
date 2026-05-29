# Plan To Beads Reference

## Formula Skeleton

```toml
formula = "plan-to-beads-executable-plan"
description = "Convert a structured implementation plan into a persistent executable Beads molecule."
version = 1
type = "workflow"

[vars.plan_id]
description = "Short plan id, e.g. dry4ts"
required = true

[vars.plan_title]
description = "Human title for the plan"
required = true

[vars.source_plan]
description = "Original plan path or empty for Beads-only plans"
default = ""
```

## Shared Metadata Envelope

Put role and wiring data under `steps.metadata.planToBeads`.

```toml
[steps.metadata.planToBeads]
contractVersion = "plan-to-beads.v1"
role = "child"
logicalId = "t1-01"
sourcePlan = "{{source_plan}}"
inherits = ["structural-parent"]
contextRefs = ["global-contract", "architecture-policy", "testing-policy"]
provides = []
```

Field meaning:

- `role`: one of `global-contract`, `parent`, `architecture`, `policy`, `fixture`, `child`, `checkpoint`, `pilot`, `followup-template`.
- `logicalId`: stable id used by formulas, docs, `contextRefs`, and validation.
- `inherits`: parent/stage defaults to merge into the agent packet.
- `contextRefs`: beads the agent must read before executing this bead.
- `provides`: named contract or fixture made available to later beads.

## Global Contract Bead

```toml
[[steps]]
id = "global-contract"
title = "{{plan_id}}: global contract"
type = "decision"
description = "Scope, non-goals, repo boundaries, global constraints, and success criteria."

[steps.metadata.planToBeads]
contractVersion = "plan-to-beads.v1"
role = "global-contract"
logicalId = "global-contract"
sourcePlan = "{{source_plan}}"
provides = ["globalContract"]

[steps.metadata.globalContract]
scope = []
nonGoals = []
repoBoundary = []
packageBoundary = []
successCriteria = []
globalForbiddenWork = []
requiredSkills = []
```

## Architecture Bead

```toml
[[steps]]
id = "architecture-policy"
title = "{{plan_id}}: architecture policy"
type = "decision"
needs = ["global-contract"]

[steps.metadata.planToBeads]
contractVersion = "plan-to-beads.v1"
role = "architecture"
logicalId = "architecture-policy"
contextRefs = ["global-contract"]
provides = ["architecturePolicy"]

[[steps.metadata.architecturePolicy.modules]]
name = "ComparisonUnitExtractor"
interface = "Resolved input paths and profile in; comparison units out."
implementationOwns = ["scanning", "parsing", "source spans"]
doesNotOwn = ["clone classification", "report formatting"]
seamRules = ["Do not create one-adapter seams."]
```

## Policy Bead

```toml
[[steps]]
id = "testing-policy"
title = "{{plan_id}}: TDD and validation policy"
type = "decision"
needs = ["global-contract"]

[steps.metadata.planToBeads]
contractVersion = "plan-to-beads.v1"
role = "policy"
logicalId = "testing-policy"
contextRefs = ["global-contract"]
provides = ["testingPolicy"]

[steps.metadata.testingPolicy]
redGreenRefactor = true
oneBehaviorPerChild = true
requireSingleRedCommand = true
requireVerificationCommand = true
parserMocksAllowed = false
```

## Parent / Stage Bead

```toml
[[steps]]
id = "structural-parent"
title = "{{plan_id}}: structural implementation"
type = "feature"
needs = ["architecture-policy", "testing-policy"]

[steps.metadata.planToBeads]
contractVersion = "plan-to-beads.v1"
role = "parent"
logicalId = "structural-parent"
contextRefs = ["global-contract", "architecture-policy", "testing-policy"]
provides = ["stageDefaults:structural"]

[steps.metadata.stageContract]
stage = "structural"
creationGate = "Create children only after global context and policies exist."
defaultAllowedRoots = ["packages/{{plan_id}}"]
defaultForbiddenFiles = []
sharedOwnershipRules = []
serialByDefault = true

[steps.metadata.stageContract.parallelPolicy]
wave = 1
maxSubagents = 1
disjointFileScopesRequired = true
```

## Fixture Bead

```toml
[[steps]]
id = "fixture-t1-basic"
title = "{{plan_id}}: T1 fixture manifest"
type = "chore"
needs = ["structural-parent"]

[steps.metadata.planToBeads]
contractVersion = "plan-to-beads.v1"
role = "fixture"
logicalId = "fixture-t1-basic"
contextRefs = ["global-contract", "testing-policy"]
provides = ["fixture:t1-basic"]

[steps.metadata.fixtureManifest]
fixtureId = "t1-basic"
source = "hand-crafted behavior fixture"
refreshPolicy = "manual explicit review only"
expectedSignals = ["stable T1 output"]

[[steps.metadata.fixtureManifest.files]]
sourcePath = "inline plan fixture"
fixturePath = "packages/{{plan_id}}/test/fixtures/t1-basic/a.ts"
reason = "T1 positive behavior"
```

## Child Work Packet

```toml
[[steps]]
id = "t1-01"
title = "{{plan_id}}: T1 reports byte-identical functions"
type = "task"
needs = ["fixture-t1-basic"]

[steps.metadata.planToBeads]
contractVersion = "plan-to-beads.v1"
role = "child"
logicalId = "t1-01"
inherits = ["structural-parent"]
contextRefs = ["global-contract", "architecture-policy", "testing-policy", "fixture-t1-basic"]

[steps.metadata.workPacket]
goal = "Implement one vertical T1 behavior."
inputs = ["fixture:t1-basic"]
constraints = ["red-green-refactor", "minimal green implementation only"]
allowedFiles = ["packages/{{plan_id}}/src/extract/comparison-unit-extractor.ts"]
forbiddenFiles = ["packages/{{plan_id}}/src/report/report-writer.ts"]
redCommand = "pnpm --filter {{plan_id}} test -- test/acceptance/type1.test.ts -t \"T1-01\""
expectedFailure = "No T1 cluster for identical functions."
greenScope = "Extract eligible TS functions and report T1 through runner output."
verification = "pnpm --filter {{plan_id}} test -- test/acceptance/type1.test.ts"
failureConditions = ["Needs a forbidden/shared file", "Dependency is not closed"]

[steps.metadata.workPacket.handoff]
requiresBeadsNote = true
requiresCommitSha = true
closeByIntegrationOwner = true
```

## Checkpoint Bead

```toml
[[steps]]
id = "structural-checkpoint"
title = "{{plan_id}}: structural checkpoint"
type = "task"
needs = ["t1-01"]

[steps.metadata.planToBeads]
contractVersion = "plan-to-beads.v1"
role = "checkpoint"
logicalId = "structural-checkpoint"
contextRefs = ["global-contract", "architecture-policy", "testing-policy"]
provides = ["checkpoint:structural"]

[steps.metadata.checkpointContract]
gateFor = "next-stage-child-creation"
requiresClosed = ["t1-01"]
validationCommands = ["pnpm --filter {{plan_id}} test -- test/acceptance/type1.test.ts"]
fanoutRules = ["Do not create next-stage children until this checkpoint is closed."]
blocksChildCreationUntilClosed = true
```

## Pilot Bead

```toml
[[steps]]
id = "pilot-snapshot"
title = "{{plan_id}}: pilot snapshot"
type = "task"
needs = ["structural-checkpoint"]

[steps.metadata.planToBeads]
contractVersion = "plan-to-beads.v1"
role = "pilot"
logicalId = "pilot-snapshot"
contextRefs = ["global-contract", "structural-checkpoint"]

[steps.metadata.pilotContract]
purpose = "Collect evidence only; do not tune behavior in this bead."
commands = []
forbiddenWork = ["threshold tuning", "new detection tracks"]
```

## Follow-Up Template Bead

```toml
[[steps]]
id = "followup-template"
title = "{{plan_id}}: follow-up template"
type = "chore"
needs = ["pilot-snapshot"]

[steps.metadata.planToBeads]
contractVersion = "plan-to-beads.v1"
role = "followup-template"
logicalId = "followup-template"
createExecutableChildren = false

[steps.metadata.followupTemplate]
trigger = "Pilot finds a concrete false negative or false positive."
requiredFields = ["observedEvidence", "proposedBehavior", "redCommand", "greenScope", "verification"]
```

## Validation Queries

```bash
bd cook .beads/formulas/plan-to-beads-executable-plan.formula.toml --dry-run
bd cook .beads/formulas/plan-to-beads-executable-plan.formula.toml --mode=runtime --var plan_id=dry4ts --var plan_title="dry4ts"
bd mol pour plan-to-beads-executable-plan --dry-run --var plan_id=dry4ts --var plan_title="dry4ts"
bd dep cycles
bd list --has-metadata-key planToBeads --json
```

After runtime cooking, inspect metadata for unresolved placeholders:

```bash
bd cook .beads/formulas/plan-to-beads-executable-plan.formula.toml --mode=runtime --var plan_id=dry4ts --var plan_title="dry4ts" | rg '\{\{'
```

If placeholders remain inside nested metadata, do not pour the molecule as-is. Either generate a plan-specific formula with concrete metadata values or update the poured beads with `bd update <id> --metadata '<json>'`.
