# Uncle Bob Skills And Quality Tools Design

**Date:** 2026-05-27
**Status:** Draft for review

## Goal

Create a portable, harness-agnostic set of small agent skills that apply Uncle Bob Martin's acceptance-pipeline, mutation, CRAP, DRY, and property-testing ideas to Conduit without copying SwarmForge's orchestration harness.

The skills should be useful in Conduit first, but written so they can move to other TypeScript projects with only project-local configuration changes.

## Core Constraint: File-Based Handoffs

Each skill writes files for the next skill or subagent to read. Chat summaries are non-authoritative.

Agents and subagents may report the artifact path they produced, but the next agent must read the artifact directly instead of relying on a prose recap from the previous agent.

The handoff contract is:

- Every workflow run has a run directory.
- Every skill reads `handoff.manifest.json` if it exists.
- Every skill writes its own artifact files.
- Every skill updates `handoff.manifest.json` with the paths, producer, status, and timestamps of the artifacts it wrote.
- A parent agent may coordinate the sequence, but state moves through files.

Default run directory:

```text
test-results/ubm/<run-id>/
```

`test-results/` is already ignored in Conduit, so generated reports do not pollute commits by default.

Persistent source artifacts live under explicit project paths:

```text
test/acceptance/features/
test/acceptance/steps/
tools/ubm/
```

The exact paths should be configurable so the skills remain portable.

## Source Principles

Use these sources as principles, not as harnesses to copy wholesale:

- Acceptance Pipeline Specification: use Gherkin examples as a behavioral source of truth, compile them into executable tests, then mutate examples to measure whether the acceptance tests are connected to real behavior.
- SwarmForge: preserve role boundaries and artifact handoffs, but do not copy tmux/session orchestration or role-prompt bulk.
- Matt Pocock skills: each skill is concise, responsible for one job, composable, progressively disclosed, and easy to adapt.
- `crap4go`, `dry4go`, and `mutate4go`: use their metric intent and CLI ergonomics as references. Prefer existing TypeScript tools where they already solve the problem.

## Non-Goals

- Do not build a broad "Uncle Bob agent" skill.
- Do not make one skill run the whole workflow.
- Do not require Cucumber, Vitest, Playwright, or any specific harness in the skill text.
- Do not assume a fixed local OpenCode server or debug port.
- Do not make mutation, CRAP, or DRY checks part of Conduit's default verification path.
- Do not add broad refactors or quality gates before the tools have been calibrated on real Conduit slices.

## Conduit Context

Conduit already has:

- Vitest unit and integration scripts.
- Playwright replay, daemon, multi-instance, live, and visual suites.
- `fast-check` and a `pnpm test:pbt` script.
- V8 coverage through `@vitest/coverage-v8`.
- Effect test helpers and several runtime-specific harnesses.

The UBM tools should call these existing project commands through configuration. They should not bypass Conduit's testing guidance or invent a parallel daemon/provider harness.

## Artifact Protocol

Every run directory contains:

```text
handoff.manifest.json
request.md
acceptance/
quality/
mutation/
notes/
```

Minimum manifest shape:

```json
{
  "schemaVersion": 1,
  "runId": "2026-05-27-session-switch",
  "repoRoot": "/absolute/path/to/repo",
  "createdAt": "2026-05-27T00:00:00.000Z",
  "artifacts": [
    {
      "kind": "acceptance-feature",
      "path": "test/acceptance/features/session-switch.feature",
      "producer": "ubm-acceptance-spec",
      "status": "ready",
      "createdAt": "2026-05-27T00:00:00.000Z"
    }
  ]
}
```

Artifact rules:

- Paths are repo-relative unless the artifact is outside the repo.
- Artifacts contain the evidence, not just conclusions.
- Reports use JSON for machine handoff and Markdown for human inspection when useful.
- A skill that cannot complete writes a blocker artifact under `notes/` and records it in the manifest.
- Downstream skills consume the manifest plus referenced files, not chat history.

## Skills

### `ubm-run-artifacts`

Creates or validates the run artifact directory and manifest.

Use when starting or resuming a UBM quality workflow.

Inputs:

- User request.
- Optional run id.
- Optional project config path.

Outputs:

- `test-results/ubm/<run-id>/request.md`
- `test-results/ubm/<run-id>/handoff.manifest.json`

This skill does not write acceptance examples, run tests, or inspect code quality.

### `ubm-acceptance-spec`

Writes deterministic Gherkin feature files from user intent.

Use when turning a feature request, bug, or behavior change into acceptance examples.

Inputs:

- Manifest.
- `request.md`.
- Relevant source or docs chosen by the agent.

Outputs:

- `test/acceptance/features/<feature>.feature`
- `test-results/ubm/<run-id>/acceptance/spec-notes.md`

Rules:

- Prefer examples over abstract prose.
- Keep scenarios deterministic and observable.
- Avoid implementation details unless they are part of the user-visible contract.
- Record ambiguous decisions in `spec-notes.md`.

### `ubm-acceptance-generate`

Parses Gherkin and generates harness-specific executable tests through a project adapter.

Use when a feature file needs executable acceptance tests.

Inputs:

- Manifest.
- Feature files from `ubm-acceptance-spec`.
- Project acceptance adapter config.

Outputs:

- `test-results/ubm/<run-id>/acceptance/gherkin-ir.json`
- Generated tests in the configured generated-test directory.
- `test-results/ubm/<run-id>/acceptance/generate-report.json`

Implementation direction:

- Use `@cucumber/gherkin` as the parser/compiler primitive.
- Keep the skill harness-agnostic.
- For Conduit, the first adapter should generate Vitest tests that can use existing Effect, replay, integration, or Playwright helpers as appropriate.

### `ubm-acceptance-run`

Runs generated acceptance tests and records the result.

Use when validating a generated acceptance suite.

Inputs:

- Manifest.
- Generated tests.
- Project run command from config.

Outputs:

- `test-results/ubm/<run-id>/acceptance/run-output.log`
- `test-results/ubm/<run-id>/acceptance/run-report.json`

Rules:

- Use the narrowest configured command that proves the generated tests.
- Preserve raw output in the log file.
- Record command, exit code, duration, and failing scenario names in JSON.

### `ubm-acceptance-mutate`

Mutates Gherkin example values and checks whether the acceptance suite detects the changes.

Use when testing whether acceptance examples are genuinely connected to behavior.

Inputs:

- Manifest.
- Feature files.
- Generated acceptance tests.
- Acceptance run command.

Outputs:

- `test-results/ubm/<run-id>/acceptance/mutations.json`
- `test-results/ubm/<run-id>/acceptance/mutation-report.json`
- `test-results/ubm/<run-id>/acceptance/survivors.md`

Implementation direction:

- Build a small local tool for this. Standard code mutation tools mutate implementation code, not Gherkin examples.
- Mutate examples conservatively: booleans, enum values, numbers, boundary dates, IDs, labels, and table cells.
- Never overwrite the source `.feature` file without writing a reversible patch or temporary copy.

### `ubm-crap-report`

Calculates CRAP-style risk by combining function complexity with test coverage.

Use when prioritizing where to add tests or reduce complexity.

Inputs:

- Manifest.
- Project CRAP config.
- Coverage command and coverage output path.

Outputs:

- `test-results/ubm/<run-id>/quality/crap-report.json`
- `test-results/ubm/<run-id>/quality/crap-report.md`

Implementation direction:

- Build a small TypeScript tool that combines AST complexity with coverage data.
- Do not rely blindly on Conduit's current `pnpm test:coverage`, because its configured coverage include list is intentionally narrow.
- Keep thresholds advisory until calibrated.

### `ubm-dry-report`

Finds structural duplication candidates.

Use when looking for repeated code patterns, not just pasted text blocks.

Inputs:

- Manifest.
- Project DRY config.
- Target paths.

Outputs:

- `test-results/ubm/<run-id>/quality/dry-report.json`
- `test-results/ubm/<run-id>/quality/dry-report.md`

Implementation direction:

- Build `dry4ts` as a TypeScript-native structural detector inspired by `dry4go`.
- Use the TypeScript compiler AST.
- Normalize identifiers, local names, property names, and literal values.
- Compare function, method, object-method, and exported arrow-function bodies by structural fingerprints and Jaccard similarity.
- Treat `jscpd` as an optional copy/paste first pass, not as a substitute for structural DRY analysis.
- For Conduit v1, scan `.ts` and `.tsx`; scan Svelte `<script>` blocks only if the first pass needs frontend coverage.

### `ubm-file-mutation`

Runs mutation testing for a focused source file or small target set.

Use when hardening tests around a module after behavior tests exist.

Inputs:

- Manifest.
- Target source file.
- Test command or mutation config.

Outputs:

- `test-results/ubm/<run-id>/mutation/stryker-report.json`
- `test-results/ubm/<run-id>/mutation/survivors.md`

Implementation direction:

- Prefer StrykerJS with the Vitest runner for TypeScript mutation testing.
- Do not build `mutate4ts` unless Stryker cannot handle a required Conduit slice.
- Scope mutation runs to one file or a tiny target set first.

### `ubm-property-scout`

Identifies behavior that should be expressed as property tests.

Use when the target code has parsers, formatters, protocol transforms, reducers, ordering, idempotence, round trips, or broad input ranges.

Inputs:

- Manifest.
- Target source file or feature area.
- Existing tests.

Outputs:

- `test-results/ubm/<run-id>/quality/property-candidates.md`
- Optional `test-results/ubm/<run-id>/quality/property-run-report.json` if configured to run existing property tests.

Rules:

- Do not invent property tests that only restate examples.
- Prefer invariants that would catch entire classes of bugs.
- For Conduit, use existing `fast-check` patterns and `pnpm test:pbt` when running existing property tests.

## Tooling Decisions

### Acceptance

Use `@cucumber/gherkin` to parse and compile Gherkin into an intermediate representation.

Do not make the skills depend on `@cucumber/cucumber`. A project adapter may target Cucumber, Vitest, Playwright, or another runner. Conduit should start with generated Vitest because that fits the existing test stack and Effect helpers.

### Mutation

Use StrykerJS before considering a custom TypeScript mutation runner.

The first Conduit configuration should support a single source file and an explicit test command. Full-project mutation is too expensive and too noisy as a default.

### DRY

Build `dry4ts` if we want Uncle Bob-style structural duplication detection.

`jscpd` remains useful for copy/paste detection, but it is not equivalent to `dry4go` because `dry4go` normalizes AST structure and compares patterns whose identifiers and literals differ.

### CRAP

Build a small CRAP combiner for TypeScript.

Existing TypeScript tools can report complexity and coverage separately, but the useful report here is per-function CRAP-style risk ordered for action.

## Portable Project Config

Use a small project config file rather than embedding Conduit paths in the skills:

```json
{
  "schemaVersion": 1,
  "acceptance": {
    "featureDir": "test/acceptance/features",
    "generatedDir": "test-results/ubm/generated/acceptance",
    "adapter": "vitest",
    "runCommand": "pnpm exec vitest run test-results/ubm/generated/acceptance"
  },
  "quality": {
    "coverageCommand": "pnpm exec vitest run --coverage --coverage.reporter=json",
    "propertyCommand": "pnpm test:pbt",
    "dryTargets": ["src", "test"],
    "mutationRunner": "stryker"
  }
}
```

The exact format can change during implementation, but each skill should read config instead of hard-coding project assumptions.

## Skill Packaging

Each skill should have:

```text
ubm-<name>/
  SKILL.md
  REFERENCE.md   # only if the main file would exceed 100 lines
```

Skill descriptions must be specific enough for triggering:

- First sentence: what the skill does.
- Second sentence: `Use when ...`.
- No historical essay in `SKILL.md`.
- One level of references only.

Scripts should live outside the skill unless they are truly portable and deterministic. For Conduit, start project-local under:

```text
tools/ubm/
```

Only promote a script into a reusable skill resource after it works on real Conduit code and has clear inputs, outputs, and tests.

## Suggested Workflow

The workflow is composable, not a single skill:

1. `ubm-run-artifacts` creates the run directory and manifest.
2. `ubm-acceptance-spec` writes the feature file.
3. `ubm-acceptance-generate` generates executable tests.
4. `ubm-acceptance-run` proves the tests fail or pass.
5. Existing `tdd` skills implement the behavior.
6. `ubm-acceptance-run` proves the acceptance tests pass.
7. `ubm-acceptance-mutate` checks acceptance strength.
8. `ubm-crap-report`, `ubm-dry-report`, `ubm-file-mutation`, and `ubm-property-scout` run as focused hardening passes.

Every step reads the manifest and referenced files from the previous step.

## Security And Safety

- No network access by default.
- No provider debug port assumptions.
- No secret capture in reports.
- No writing outside the repo or configured artifact root.
- No generated executable code outside configured generated directories.
- No dynamic `eval`.
- No mutation of source files without a temporary copy, patch file, or explicit implementation step.
- Respect `.gitignore`, `node_modules`, `dist`, `.git`, `.worktrees`, and generated-output directories.
- Keep full raw command output in files, not chat.
- Preserve the user's dirty worktree; never stash changes.

## Initial Conduit Pilot

Start with a pure TypeScript behavior surface before applying the workflow to daemon, provider, or live E2E paths.

Good candidates:

- Event projection.
- WebSocket message schema mapping.
- Session switch reducers.
- Provider event translation where fixtures already exist.

Avoid first:

- Live OpenCode or Claude SDK flows.
- Daemon lifecycle tests.
- Visual tests.
- Large full-suite mutation runs.

## Implementation Phases

### Phase 1: Skills And Artifact Contract

- Add the skill docs.
- Add the artifact manifest reference.
- Add example artifact files.
- Do not implement metric CLIs yet.

### Phase 2: Acceptance Pipeline

- Add project config.
- Add `@cucumber/gherkin` parser integration.
- Add the Vitest acceptance adapter.
- Add example generated acceptance tests.

### Phase 3: Acceptance Mutation

- Add the Gherkin example mutator.
- Report killed and survived example mutations.
- Tune mutation operators against one Conduit feature.

### Phase 4: Quality Reports

- Add CRAP combiner.
- Add `dry4ts` MVP.
- Add StrykerJS file-target config.
- Wire property-scout to existing `fast-check` conventions.

### Phase 5: Calibration

- Run the workflow on one Conduit slice.
- Remove noisy findings.
- Adjust thresholds.
- Decide which reports are worth keeping as reusable skill resources.

## Open Questions

- Should generated acceptance tests ever be committed, or should they always live under `test-results/ubm/`?
- Should `dry4ts` normalize imported API names, or preserve selected framework names such as `Effect`, `Schema`, and `Layer` to reduce false positives?
- Should CRAP reports include test files, or only production files?
- Should acceptance mutation be allowed to run against Playwright replay tests, or only generated Vitest tests at first?

## References

- Acceptance Pipeline Specification: https://github.com/unclebob/Acceptance-Pipeline-Specification
- SwarmForge: https://github.com/unclebob/swarm-forge
- Matt Pocock skills: https://github.com/mattpocock/skills
- `crap4go`: https://github.com/unclebob/crap4go
- `dry4go`: https://github.com/unclebob/dry4go
- `mutate4go`: https://github.com/unclebob/mutate4go
- `@cucumber/gherkin`: https://github.com/cucumber/gherkin
- StrykerJS Vitest runner: https://stryker-mutator.io/docs/stryker-js/vitest-runner/
- `jscpd`: https://jscpd.dev/
