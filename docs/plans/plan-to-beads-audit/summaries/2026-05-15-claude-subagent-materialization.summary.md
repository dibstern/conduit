# 2026-05-15 Claude Subagent Materialization Plan Summary

## Source

- Source plan: `docs/plans/2026-05-15-claude-subagent-materialization.md`
- Plan title: `Claude Subagent Materialization Implementation Plan`
- Stated goal: make Claude SDK subagent output visible as conduit child sessions with stable parent Task-card navigation and type-checked Claude-to-canonical field extraction.
- Main architecture: keep the parent Claude turn in `ClaudeProviderInstance` and `ClaudeEventTranslator`, then materialize SDK subagent transcripts into conduit-owned SQLite sessions once the Claude SDK exposes them through `listSubagents()` and `getSubagentMessages()`.

## Plan Structure

- Header contract:
  - Claude execution instruction to use an implementation sub-skill.
  - Goal, architecture summary, and tech stack.
- Design decisions:
  - Durable cross-cutting choices about child sessions, deterministic IDs, parent Task metadata, SDK adapter seams, backward-compatible schema changes, matching assumptions, canonical frontend data, and phased promptability.
- Sequential implementation tasks:
  - Task 1 locks current gaps with failing tests.
  - Tasks 2 through 4 fix event sink routing, tool metadata persistence, and parent-aware session creation.
  - Task 5 implements the materializer and child transcript persistence.
  - Task 5B is a conditional sub-plan for read-only child sessions, a real-SDK promptability probe, and optional child-session send routing.
  - Tasks 6 through 8 cover frontend navigation, type guarantees, and integration-style child session flow.
  - Task 9 defines final verification.
- Repeated task shape:
  - File list with modify/create/test intent.
  - Ordered implementation steps.
  - Concrete TypeScript, SQL, or shell snippets.
  - Expected failing or passing behavior.
  - Focused validation command.
  - Commit path list and commit message.
- Final gate:
  - Focused suite, standard checks, optional broader suite, and a final review checklist.

## Information Types Communicated

- Product behavior and user-facing outcome: parent Task cards navigate to child sessions instead of inlining subagent transcripts.
- System architecture: provider instance, event translator, materializer, event store, projectors, history adapter, frontend `ToolMessage`, and session switching boundaries.
- Cross-provider data contract: canonical `subagentType`, `taskId`, `metadata.childSessionId`, `providerTaskId`, `sdkSubagentId`, and provider key naming.
- Provider-specific SDK contract: Claude SDK subagent discovery APIs, transcript message shapes, `parent_tool_use_id`, SDK field names, and typed SDK fixtures.
- Persistence contract: schema additions, projection behavior, JSON metadata merge rules, idempotent child transcript persistence, and parent/session linkage.
- Runtime routing rules: latest sink selection, parent-to-child event routing, read-only child behavior before proof, and parent-query routing for promptable children only after proof.
- Test strategy: red tests, contract tests, focused unit tests, integration-style unit tests, visual tests, optional real-SDK probe, and final verification commands.
- File ownership and change scope: per-task modify/create/test file lists, commit path lists, and forbidden behavior such as not parsing IDs out of result text.
- Code sketches: interface shapes, type guards, deterministic ID function, SQL update, fake SDK adapter, and sample fixtures.
- Conditional execution: Part 3 of Task 5B is allowed only if Part 2 produces concrete evidence that SDK subagent targeting works.
- Evidence to capture: exact working `parent_tool_use_id` identifier, observed SDK fields, streamed event fields, SDK version constraints, and failure criteria.
- Version-control choreography: one commit per major slice, with exact `git add` paths and commit messages.
- Final acceptance checklist: explicit end-state assertions across persistence, routing, UI, promptability, canonical naming, and SDK typing.

## Fit To Existing Formula Parts

- `epic` fits the whole plan instance: title, goal, architecture summary, and final acceptance.
- `global-contract` fits the overall scope, non-goals, provider boundary, backward compatibility, read-only-before-proof rule, and canonical data expectations.
- `architecture` fits the child-session model, deterministic ID derivation, event-store/projector flow, adapter seam, routing model, and parent/child session ownership.
- `policy` fits TDD-first execution, typed fixture requirements, no broad SDK casts, no frontend snake-case compatibility, promptability phasing, unsupported-send behavior, and no independent `claude-subagent-*` provider queries.
- `parent` fits the top-level tasks and Task 5B parts as stage/grouping beads with inherited file scope and stage-level defaults.
- `child` fits most executable implementation behaviors inside tasks, especially slices with file scope, expected failure, green scope, and focused verification.
- `checkpoint` fits failing-test gates, Task 5B Part 2 proof gate, final verification, fanout readiness, and "do not implement Part 3 until proof" constraints.
- `fixture` fits typed SDK fixtures, fake SDK transcript data, story mocks, and visual/OpenCode fixture stability expectations.
- `pilot` fits the opt-in real Claude SDK probe in Task 5B Part 2.
- `followup-template` fits optional or deferred work if the probe fails or if promptable child sessions are intentionally postponed.
- `work-packet` fits the repeated task body well: goal, inputs, constraints, allowed files, expected failure, green scope, verification, and failure conditions.
- `subagent-launch` partially fits the initial Claude execution instruction and any parallel-agent handoff, but the plan does not contain rich per-child launch packets.
- `handoff-note` fits task-level commit boundaries and final review evidence, but only loosely.

## Gaps / Schema Additions

- Conditional branch outcomes do not fit cleanly. Task 5B needs a structured decision gate with outcomes such as `passes`, `fails`, `activates`, `blocks`, and `stopHere`. This could extend `checkpoint` rather than require a new role.
- Evidence capture from a pilot is underspecified in current parts. Add a `pilot.evidence` or `evidence-report` contract for observed values, SDK version, commands run, pass/fail criteria, and the durable decision produced by the probe.
- Commit choreography is not represented by current roles or snippets. Add optional `versionControl` metadata to `parent` or `child` with `paths`, `message`, and commit boundary intent.
- File lists lose useful intent. Add typed file entries to `work-packet`, for example `modify`, `create`, `test`, and `optionalUpdate`, instead of only `allowedFiles`.
- Implementation snippets are richer than current work-packet fields. Add an optional `implementationSketches` collection with target file/symbol, language, and whether the snippet is normative or illustrative.
- Cross-layer contract traces need first-class shape. The plan's typed SDK fixture to canonical event to relay to persistence to frontend path could be captured as an `acceptanceTrace` field on `checkpoint` or `child`.
- Runtime safety states are not just policy. Read-only, promptable, non-promptable, and unsupported-send behavior would benefit from a `capabilityState` field that can be attached to architecture, checkpoint, and child beads.
- Provider/API uncertainty appears repeatedly. Add a structured `unknowns` or `assumptionsToProve` field, especially for SDK identifier mapping and `parent_tool_use_id` behavior.

## Notes For Combined Summary

- This plan is a strong example of an executable plan with TDD slices, concrete code sketches, and explicit verification.
- The current formula roles cover most content at the role level. The biggest gaps are not new work roles; they are missing metadata shapes for conditional gates, evidence capture, commit boundaries, typed file intents, and cross-layer acceptance traces.
- Task 5B should be highlighted in the combined audit because it mixes checkpoint, pilot, conditional branch, and optional follow-up behavior in one nested sub-plan.
- The plan includes many code snippets that are more specific than normal acceptance criteria. A combined schema should preserve them without forcing them into prose-only `constraints`.
- The plan's final checklist is well suited to become checkpoint acceptance, while each task's focused command belongs in work-packet or checkpoint verification.
