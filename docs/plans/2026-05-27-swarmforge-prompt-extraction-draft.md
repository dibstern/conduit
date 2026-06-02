# SwarmForge Prompt Extraction Draft

Date: 2026-05-27
Status: Draft for review

## Purpose

This document describes how to extract the useful parts of Uncle Bob Martin's
SwarmForge `.prompt` files into harness-agnostic workflow skills.

This is separate from the Uncle Bob skills design plan. It answers a narrower
question: which parts of the SwarmForge role prompts should become portable
skills, which parts should become shared references, and which parts should be
left behind because they are specific to SwarmForge's tmux, branch, worktree, or
notification harness.

No SwarmForge prompt text should be copied verbatim into skills until licensing
is clarified. The extraction should preserve principles, responsibilities, and
artifact contracts, not prompt prose.

## Extraction Position

Use SwarmForge prompts as normative workflow source material, but do not install
them as raw `.prompt` files.

The durable value is:

- clear role ownership
- file-based handoffs
- deterministic Gherkin acceptance examples
- TDD before implementation
- separation between implementation, refactoring, mutation, CRAP, DRY, and
  property testing
- architecture ownership of coupling, cohesion, information hiding, and
  mutation sequencing
- receiver-owned judgment: the next agent reads files and repo state, then
  applies its own rules

The non-portable parts are:

- tmux session choreography
- `notify-agent.sh`
- assigned role worktrees
- automatic branch merges
- automatic commits
- Go-only APS command installation
- language tool installation at agent startup
- four persistent role agents as the required runtime model

## Source Prompt Files

Primary SwarmForge sources:

- `swarmforge/specifier.prompt`
- `swarmforge/coder.prompt`
- `swarmforge/refactorer.prompt`
- `swarmforge/architect.prompt`
- `swarmforge/constitution.prompt`
- `swarmforge/constitution/project.prompt`
- `swarmforge/constitution/engineering.prompt`
- `swarmforge/constitution/workflow.prompt`

The example prompts under `examples/clojureHTW/swarmforge/` should be treated as
examples only. They are useful for seeing how project-specific constitution
rules override generic workflow rules, but they should not drive the TypeScript
Conduit skill shape.

## Core Transform

SwarmForge role prompts mix identity, scope, tools, startup behavior, branching,
handoff, and completion policy. Harness-agnostic skills should separate those
concerns.

| SwarmForge prompt part | Extract as | Rationale |
| --- | --- | --- |
| Role identity | Skill trigger and responsibility sentence | Agents already have their own identity; skills need narrow activation rules. |
| Role ownership bullets | One-purpose skills | Keeps skills composable and avoids recreating four broad agents. |
| Constitution layering | Shared reference file | All skills can read the same project rules without embedding them. |
| Tool installation on startup | Tool readiness checks | Portable skills should inspect configured tools, not install globally by default. |
| `notify-agent.sh` handoff | Manifest and artifact writes | File artifacts work across Codex, Claude, CI, local scripts, and future harnesses. |
| Branch plus commit handoff | Optional state pointer in manifest | Useful when available, but local dirty work and uncommitted docs must still work. |
| Queued role messages | Artifact inbox directory | Multiple agents can write requests without relying on tmux panes. |
| Automatic commits and merges | Harness policy, not skill logic | Skills should not mutate git history unless the user or wrapper explicitly asks. |
| APS Go command requirement | Acceptance adapter contract | TypeScript projects can use `@cucumber/gherkin` while preserving APS semantics. |

## File Handoff Model

Every extracted skill writes files for the next skill or agent to read.

Default run root:

```text
test-results/ubm/<run-id>/
```

Required files:

```text
handoff.manifest.json
request.md
```

Common subdirectories:

```text
acceptance/
architecture/
implementation/
quality/
mutation/
property/
verification/
handoffs/
inbox/
notes/
```

Receiver rule:

1. Read `handoff.manifest.json`.
2. Read the artifacts listed for the relevant producer.
3. Inspect the current repo state when needed.
4. Ignore sender process narrative.
5. Apply only the receiving skill's own rules.
6. Write new artifacts and update the manifest.

The handoff manifest is the coordination surface. Chat summaries are useful for
humans, but they are not authoritative workflow input.

## Extracted Skill Set

The following skills are the recommended extraction shape. They intentionally do
not mirror SwarmForge's four broad roles.

### `ubm-workflow-constitution`

Source prompt parts:

- `constitution.prompt`
- `constitution/project.prompt`
- `constitution/engineering.prompt`

Responsibility:

Load project-local Uncle Bob workflow rules, tool mappings, artifact roots, and
verification commands.

Use when:

- starting an Uncle Bob workflow run
- validating that project-local quality tools are configured
- preparing another skill to run against a specific repository

Writes:

```text
test-results/ubm/<run-id>/constitution.resolved.json
test-results/ubm/<run-id>/constitution.notes.md
```

Does not:

- install tools globally
- create branches
- change source files
- decide the implementation plan

Skill shape:

```md
---
name: ubm-workflow-constitution
description: Resolves project-local Uncle Bob workflow rules, tool commands, artifact roots, and verification commands. Use when starting or validating a UBM workflow run before spec, implementation, refactor, mutation, CRAP, DRY, or property-test skills.
---

# UBM Workflow Constitution

## Quick start

Read the project UBM config if present. Write a resolved constitution JSON file
under the run directory. If required tools are missing, report missing commands
without installing them unless explicitly asked.

## Output

Update `handoff.manifest.json` with the resolved constitution path.
```

### `ubm-workflow-handoff`

Source prompt parts:

- `constitution/workflow.prompt`

Responsibility:

Create, validate, queue, and consume file-based handoffs.

Use when:

- starting a new UBM run
- passing work between skills
- queueing parallel subagent findings
- validating that the next agent has file-backed input

Writes:

```text
test-results/ubm/<run-id>/handoff.manifest.json
test-results/ubm/<run-id>/handoffs/<producer>-to-<consumer>.json
test-results/ubm/<run-id>/inbox/<priority>-<timestamp>-<producer>.json
```

Does not:

- tell the receiver how to do its work
- summarize the producer's process
- require a git commit
- require a tmux pane or notification command

Portable handoff fields:

```json
{
  "schemaVersion": 1,
  "runId": "2026-05-27-example",
  "producer": "ubm-acceptance-spec",
  "consumer": "ubm-implement-slice",
  "handoffName": "session-routing-acceptance",
  "repoRoot": "/absolute/repo/path",
  "git": {
    "branch": "main",
    "commit": "optional",
    "dirty": true
  },
  "artifacts": [
    {
      "kind": "acceptance-feature",
      "path": "test/acceptance/features/session-routing.feature"
    }
  ],
  "request": "Apply your own skill rules to this state."
}
```

### `ubm-acceptance-spec`

Source prompt parts:

- `specifier.prompt`

Responsibility:

Turn user intent into deterministic externally visible behavior examples.

Use when:

- turning a feature request into acceptance behavior
- pruning Gherkin examples before implementation
- preparing a spec handoff for implementation

Writes:

```text
test/acceptance/features/<feature>.feature
test-results/ubm/<run-id>/acceptance/spec-notes.md
test-results/ubm/<run-id>/handoffs/spec-to-implementation.json
```

Extracted rules:

- Ask questions when behavior is ambiguous.
- Specify externally visible behavior, not internal design.
- Keep examples deterministic.
- Use Gherkin parameters for values that should be mutation tested.
- Prune redundant parameters that do not improve acceptance mutation signal.
- Use `Background` only when it preserves scenario meaning.
- Stop for user approval before handing off an accepted spec when the user has
  not already authorized implementation.

Rejected prompt parts:

- automatic commit before notifying coder
- fixed scenario comment format unless the project adopts it
- APS-specific parser implementation requirement

### `ubm-acceptance-generate`

Source prompt parts:

- `coder.prompt`
- `constitution/engineering.prompt`

Responsibility:

Parse feature files and generate executable acceptance tests through a
project-local adapter.

Use when:

- validating that acceptance specs are executable
- regenerating tests after a feature file changes
- preparing acceptance artifacts before implementation or verification

Writes:

```text
test-results/ubm/<run-id>/acceptance/gherkin-ir.json
test-results/ubm/<run-id>/acceptance/generated-tests-manifest.json
acceptance/generated/<feature>.test.ts
```

Extracted rules:

- Keep generated acceptance tests separate from unit tests.
- Use a real Gherkin parser, not an ad hoc parser.
- Keep project-specific step handlers explicit.
- Run generation sequentially.

Harness-agnostic adaptation:

- For TypeScript, prefer `@cucumber/gherkin` plus generated Vitest tests.
- For projects that already use Cucumber execution, allow a Cucumber adapter.
- The parser is configured by the project constitution; it is not hard-coded in
  the skill.

### `ubm-acceptance-run`

Source prompt parts:

- `coder.prompt`
- `constitution/engineering.prompt`

Responsibility:

Run generated acceptance tests and write machine-readable results.

Use when:

- checking whether accepted feature files are connected to executable behavior
- verifying a completed implementation slice

Writes:

```text
test-results/ubm/<run-id>/verification/acceptance.log
test-results/ubm/<run-id>/verification/acceptance-result.json
```

Extracted rules:

- Run generated acceptance tests as their own command.
- Do not treat generated acceptance tests as a substitute for unit tests.
- Avoid concurrent full-suite commands while generating acceptance artifacts.

### `ubm-implement-slice`

Source prompt parts:

- `coder.prompt`
- selected engineering rules

Responsibility:

Implement an approved behavior slice with focused tests and clear boundaries.

Use when:

- the acceptance spec is accepted
- a behavior slice needs production implementation
- the next step is TDD implementation, not refactor, mutation, or architecture

Writes:

```text
test-results/ubm/<run-id>/implementation/change-notes.md
test-results/ubm/<run-id>/verification/unit-result.json
test-results/ubm/<run-id>/handoffs/implementation-to-refactor.json
```

Extracted rules:

- Start from accepted spec and architecture guidance.
- Write focused unit tests before production code.
- Keep behavior in testable modules where practical.
- Put environment-bound code behind small adapter boundaries.
- Keep implementation understandable enough for the next agent.
- Leave broad cleanup to refactor unless it blocks implementation.

Rejected prompt parts:

- broad "coder" identity
- automatic commits
- prohibition on all property tests, because project-local TDD may need them
  when the slice is explicitly property-shaped

Composition note:

This skill may be unnecessary if the project already has a good `tdd` skill.
In that case, keep only a small UBM handoff wrapper that feeds accepted spec
artifacts into the existing TDD skill and requires the implementation artifact
outputs above.

### `ubm-refactor-slice`

Source prompt parts:

- `refactorer.prompt`
- selected architecture and engineering rules

Responsibility:

Preserve behavior while improving names, duplication, boundaries, and
testability in touched code.

Use when:

- implementation passes but structure needs cleanup
- behavior is stuck in environment-heavy modules
- quality reports identify local cleanup candidates

Writes:

```text
test-results/ubm/<run-id>/quality/refactor-report.md
test-results/ubm/<run-id>/verification/refactor-verification.json
test-results/ubm/<run-id>/handoffs/refactor-to-architecture.json
```

Extracted rules:

- Do not introduce new behavior.
- Keep refactors small enough to verify locally.
- Move behavior toward testable modules when it does not change behavior.
- Keep adapter shells small.
- Verify with relevant unit and acceptance commands.

Rejected prompt parts:

- "run coverage and increase where reasonable" as a default mandate
- automatic CRAP and DRY execution inside this skill
- automatic commit and handoff

Reason:

CRAP, DRY, and property testing are better as separate skills. The refactor
skill should be able to act on reports without owning every report generator.

### `ubm-property-scout`

Source prompt parts:

- `refactorer.prompt`
- `constitution/engineering.prompt`

Responsibility:

Identify useful property-test opportunities and write or improve property tests
when the project has an approved property-test command.

Use when:

- invariants, round trips, ordering, conservation, idempotence, broad input
  ranges, or parser/formatter stability matter
- a refactor or architecture review asks for property hardening

Writes:

```text
test-results/ubm/<run-id>/property/property-scout.md
test-results/ubm/<run-id>/property/property-result.json
```

Extracted rules:

- Keep property tests separate from normal verification unless explicitly
  requested.
- Do not mix property-test tags into normal coverage, mutation, CRAP, or
  acceptance mutation runs by default.
- Prefer project-local property frameworks.

### `ubm-crap-report`

Source prompt parts:

- `refactorer.prompt`
- `constitution/engineering.prompt`

Responsibility:

Report high-risk functions using complexity and coverage.

Use when:

- prioritizing refactor and test work
- deciding whether touched code needs hardening before handoff

Writes:

```text
test-results/ubm/<run-id>/quality/crap-report.json
test-results/ubm/<run-id>/quality/crap-report.md
```

Extracted rules:

- CRAP is owned by hardening/refactor work, not by the implementation step.
- Only testable modules should participate.
- Use project-local coverage configuration.

Harness-agnostic adaptation:

- Go uses `crap4go`.
- TypeScript needs a project-local CRAP combiner unless an existing project tool
  provides per-function CRAP directly.

### `ubm-dry-report`

Source prompt parts:

- `refactorer.prompt`
- `architect.prompt`
- `constitution/engineering.prompt`

Responsibility:

Find meaningful structural duplication and write candidates for human or agent
review.

Use when:

- looking for duplicate behavior, not just copied text
- refactor or architecture work needs duplication evidence

Writes:

```text
test-results/ubm/<run-id>/quality/dry-report.json
test-results/ubm/<run-id>/quality/dry-report.md
```

Extracted rules:

- DRY should inform reasonable duplication reduction.
- Do not force every similarity into an abstraction.
- Exclude generated, vendored, build, and environment-only code.

Harness-agnostic adaptation:

- `jscpd` can be an optional copy/paste prepass.
- Uncle Bob-style DRY for TypeScript needs structural fingerprints like
  `dry4go`, not only textual duplicate detection.

### `ubm-architecture-review`

Source prompt parts:

- `architect.prompt`
- selected engineering rules

Responsibility:

Review high-level design, module boundaries, dependency direction, and
testability boundaries.

Use when:

- a refactor handoff needs architecture judgment
- multiple quality reports point to boundary problems
- a behavior slice changed module ownership or dependency direction

Writes:

```text
test-results/ubm/<run-id>/architecture/review.md
test-results/ubm/<run-id>/architecture/decisions.json
test-results/ubm/<run-id>/handoffs/architecture-to-mutation.json
```

Extracted rules:

- Decide when a design change is needed and when a local change is enough.
- Minimize coupling and maximize cohesion.
- Preserve information hiding.
- Split modules that mix unrelated behaviors.
- Design boundaries that maximize testable modules and minimize unsuitable
  adapter shells.
- Keep tests separate from test helpers.

Rejected prompt parts:

- automatic reorganization as a default action
- automatic merging of role branches
- automatic final verification sequence

### `ubm-file-mutation`

Source prompt parts:

- `architect.prompt`
- `constitution/engineering.prompt`

Responsibility:

Run focused source mutation testing one file at a time and write survivor
evidence.

Use when:

- hardening a specific source file
- checking whether tests actually constrain touched behavior
- re-running mutation after implementation or refactor

Writes:

```text
test-results/ubm/<run-id>/mutation/<source-file>.mutation.json
test-results/ubm/<run-id>/mutation/<source-file>.survivors.md
```

Extracted rules:

- Run mutation one source file at a time.
- Prefer differential mutation when the tool supports a trustworthy manifest.
- Use full mutation for first runs, explicit audits, or suspect manifests.
- Keep mutation tests separate from unit and acceptance tests.
- Prefer worker limits when available.
- Show progress for long runs.

Harness-agnostic adaptation:

- TypeScript should use StrykerJS first.
- A custom `mutate4ts` is not needed unless StrykerJS fails the required
  focused-file workflow.

### `ubm-acceptance-mutate`

Source prompt parts:

- `architect.prompt`
- `specifier.prompt`
- `constitution/engineering.prompt`

Responsibility:

Mutate Gherkin example values and report survived acceptance mutations.

Use when:

- testing whether acceptance examples are connected to real behavior
- hardening acceptance specs after implementation passes
- running final acceptance hardening

Writes:

```text
test-results/ubm/<run-id>/acceptance-mutation/result.json
test-results/ubm/<run-id>/acceptance-mutation/survivors.md
```

Extracted rules:

- Mutate Gherkin example values, not production code.
- Require progress output for long mutation runs.
- Use softer mutation levels for final broad acceptance checks unless a stricter
  audit is requested.

Harness-agnostic adaptation:

- This remains a small custom TypeScript tool or adapter because source-code
  mutation tools do not mutate Gherkin examples.

## Prompt Parts To Preserve As Shared Reference

Some SwarmForge rules should not become standalone skills. They should live in a
shared `REFERENCE.md` or project-local UBM constitution file read by each skill.

Recommended shared reference sections:

- Definition of testable modules vs environmentally unsuitable adapter shells.
- Separation between unit, generated acceptance, property, mutation, CRAP, and
  DRY commands.
- Rule that generated acceptance tests are not a substitute for unit tests.
- Rule that property tests are explicit and separate unless requested.
- Rule that unknown commands should be inspected through local help or project
  docs before use.
- Rule that unfamiliar tools should prefer project-local cache/config paths.
- Rule that generated, vendored, build, and ignored directories are excluded
  from quality scans by default.

## Prompt Parts To Reject

These should not be extracted into portable skills:

- "You are the specifier/coder/refactorer/architect" identity lines.
- Any requirement to run inside tmux.
- `swarmtools/notify-agent.sh`.
- `.swarmforge/`, `.worktrees/`, `logs/`, or `agent_context/` directory
  requirements.
- The rule that startup creates helper scripts.
- Fixed Go installation commands for all projects.
- Automatic branch merge on handoff receipt.
- Automatic commit on handoff completion.
- The exact handoff prose format.
- The rule that agents must not inspect other branches, except as a narrower
  safety principle: only read branch state named by the user or by an artifact.

## Suggested Skill Directory Shape

The extracted skill package should avoid one giant skill. A portable package
could look like this:

```text
ubm-workflow-handoff/
  SKILL.md
  EXAMPLES.md

ubm-workflow-constitution/
  SKILL.md
  REFERENCE.md

ubm-acceptance-spec/
  SKILL.md
  EXAMPLES.md

ubm-acceptance-generate/
  SKILL.md
  REFERENCE.md

ubm-acceptance-run/
  SKILL.md

ubm-acceptance-mutate/
  SKILL.md
  REFERENCE.md

ubm-implement-slice/
  SKILL.md

ubm-refactor-slice/
  SKILL.md

ubm-property-scout/
  SKILL.md

ubm-crap-report/
  SKILL.md
  REFERENCE.md

ubm-dry-report/
  SKILL.md
  REFERENCE.md

ubm-file-mutation/
  SKILL.md
  REFERENCE.md

ubm-architecture-review/
  SKILL.md
```

Each `SKILL.md` should stay under 100 lines. Detailed tool contracts, schemas,
and examples should move into one-level reference files.

## Example Cross-Agent Flow

The harness can be Codex, Claude, CI, a shell script, or a future orchestrator.
The flow stays file-based:

1. `ubm-workflow-handoff` creates `test-results/ubm/<run-id>/`.
2. `ubm-workflow-constitution` writes `constitution.resolved.json`.
3. `ubm-acceptance-spec` writes feature files and a spec handoff.
4. The implementation agent reads the spec handoff and feature files.
5. `ubm-acceptance-generate` writes generated test artifacts.
6. `ubm-implement-slice` or the existing `tdd` skill writes implementation
   notes and verification results.
7. `ubm-acceptance-run` writes acceptance results.
8. `ubm-refactor-slice` writes a refactor report.
9. `ubm-crap-report`, `ubm-dry-report`, and `ubm-property-scout` write focused
   hardening reports as needed.
10. `ubm-architecture-review` writes boundary decisions.
11. `ubm-file-mutation` writes source mutation survivors.
12. `ubm-acceptance-mutate` writes acceptance mutation survivors.
13. A final human or harness step decides whether to commit, open a PR, or start
   another slice.

No step depends on the previous agent's chat summary.

## Review Questions

1. Should `ubm-implement-slice` exist, or should this package reuse the existing
   `tdd` skill plus a UBM handoff wrapper?
2. Should `ubm-workflow-constitution` be a skill, or only a reference file read
   by all UBM skills?
3. Should `ubm-workflow-handoff` be a standalone skill, or should every UBM skill
   embed the same manifest-writing rules?
4. Should the first implementation package include all skills above, or only the
   acceptance, handoff, CRAP, DRY, mutation, and property-reporting skills?
5. Should TypeScript acceptance generation standardize on generated Vitest tests
   first, with Cucumber execution as an adapter option?

## References

- SwarmForge repository: https://github.com/unclebob/swarm-forge
- SwarmForge `specifier.prompt`: https://raw.githubusercontent.com/unclebob/swarm-forge/main/swarmforge/specifier.prompt
- SwarmForge `coder.prompt`: https://raw.githubusercontent.com/unclebob/swarm-forge/main/swarmforge/coder.prompt
- SwarmForge `refactorer.prompt`: https://raw.githubusercontent.com/unclebob/swarm-forge/main/swarmforge/refactorer.prompt
- SwarmForge `architect.prompt`: https://raw.githubusercontent.com/unclebob/swarm-forge/main/swarmforge/architect.prompt
- SwarmForge constitution prompt: https://raw.githubusercontent.com/unclebob/swarm-forge/main/swarmforge/constitution.prompt
- SwarmForge engineering rules: https://raw.githubusercontent.com/unclebob/swarm-forge/main/swarmforge/constitution/engineering.prompt
- SwarmForge workflow rules: https://raw.githubusercontent.com/unclebob/swarm-forge/main/swarmforge/constitution/workflow.prompt
