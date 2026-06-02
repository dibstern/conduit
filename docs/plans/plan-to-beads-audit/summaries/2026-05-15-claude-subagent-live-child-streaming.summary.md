# 2026-05-15 Claude Subagent Live Child Streaming Summary

## Source

- Plan reviewed: `docs/plans/2026-05-15-claude-subagent-live-child-streaming.md`
- Plan title: `Claude Subagent Live Child Streaming Implementation Plan`
- Formula context reviewed: `.agents/skills/plan-to-beads/SKILL.md` and `.agents/skills/plan-to-beads/REFERENCE.md`

## Plan Structure

The plan starts with an executor instruction, then a compact header contract:

- Required implementation skill instruction for Claude.
- Goal statement.
- Architecture summary.
- Tech stack list.

The body is organized as seven numbered tasks:

1. Lock live child-session requirements with failing tests.
2. Tag relay pushes by canonical event session.
3. Add Claude subagent session ensure API.
4. Add snapshot diffing for subagent transcripts.
5. Start live pollers on `task_started`.
6. Keep final materialization as catch-up.
7. Final verification.

Each implementation task generally contains:

- File scope grouped as `Modify:` or `Test:`.
- Ordered implementation steps.
- Concrete API/type/code snippets where the implementation needs precision.
- Focused verification command.
- Expected test result.
- Commit command and commit message.

The final verification task contains no intended code changes, a focused suite, standard checks, conditional E2E escalation guidance, and a contingency commit command if defects are found.

## Information Types Communicated

- Product goal: child Claude subagent sessions should appear immediately on `task_started` and stream while the parent turn is still running.
- Architecture contract: child sessions remain conduit-owned, Claude SDK subagents stay stateless, snapshot polling feeds canonical events, and relay tagging follows `event.sessionId`.
- Event-flow contracts: `task_started`, parent Task metadata, child session IDs, canonical `text.delta`, `message.created`, final `result`, and final materialization behavior.
- Persistence invariants: child session creation is idempotent and final catch-up must not duplicate live-polled events.
- Test-first sequence: new failing tests are written before implementation, with explicit expected failures.
- Per-task file ownership: each task names exact source and test files.
- Implementation details: method signatures, cursor shape, keying strategy, timing behavior, retry/backoff behavior, and one required source comment.
- Verification commands: red test command, task-local Vitest commands, focused final suite, and standard checks.
- Expected outcomes: failure modes before implementation and pass/idempotency expectations after implementation.
- Git choreography: each task includes staging paths and a specific commit message.
- Conditional escalation: replay/browser E2E is only needed if WebSocket replay fixtures or browser session-switch behavior change.

## Fit To Existing Formula Parts

- `epic`: fits the title, goal, and overall live-child-streaming outcome.
- `global-contract`: fits the top-level goal, tech stack, global behavior constraints, and non-negotiable outcomes such as immediate child visibility and no duplicate final materialization.
- `architecture`: fits the architecture header plus cross-cutting contracts around relay tagging, session ownership, polling, persistence, materialization, and canonical events.
- `policy`: fits test-first execution, narrow verification, commit-per-task discipline, conditional E2E escalation, and the required executor skill instruction.
- `parent`: each numbered task can act as a sequential stage parent, although the plan does not explicitly label broader phases or parallel waves.
- `child`: Tasks 2 through 6 map well to executable child work packets. Task 1 can map to a child work packet for red tests, but it contains several distinct failing behaviors that could also be split into multiple children.
- `checkpoint`: the red test run, task-local test runs, final verification task, and conditional E2E escalation all fit checkpoint semantics.
- `fixture`: the fake SDK stream, snapshot transcript examples, and fake `getSubagentMessages()` behavior are fixture-like inputs, but the plan treats them as inline test setup rather than standalone fixture artifacts.
- `pilot`: no clear pilot role appears. The plan does not ask for exploratory measurement before committing to follow-up work.
- `followup-template`: no durable follow-up template appears. The conditional E2E escalation is a conditional validation branch, not a reusable follow-up template.
- `work-packet` contract snippet: most task bodies can hydrate this, including goal, inputs, allowed files, constraints, red command, green scope, verification, and failure conditions.
- `subagent-launch` contract snippet: not directly represented. The plan contains an executor skill instruction, but not a launch packet for parallel subagents.
- `handoff-note` contract snippet: not represented. The plan uses commits as durable boundaries, not explicit handoff notes.

## Gaps / Schema Additions

- Commit boundaries: the current roles do not clearly model per-child `git add` scopes and exact commit messages. Add child/checkpoint metadata such as `commitBoundary` with `paths`, `message`, and `commitCondition`.
- Ordered implementation steps: the work-packet snippet has fields for goals and constraints, but this plan relies on ordered micro-steps. Add an optional `orderedSteps` array for child work packets.
- File intent: `allowedFiles` captures scope, but not whether each file is source, test, modify-only, or no-code-change. Add `fileTouches` entries with `path`, `intent`, and `operation`.
- Inline code contracts: required signatures, cursor fields, snippets, and required comments need a stable home. Add an optional `codeContracts` or `implementationContracts` section to child metadata.
- Expected red/green outcomes: `expectedFailure` and `verification` exist, but the plan often names both pre-implementation failure and post-implementation pass/idempotency expectations. Add `expectedBefore` and `expectedAfter` fields or allow multiple named assertions.
- Conditional verification: checkpoints support validation commands, but not conditionally triggered commands. Add `conditionalValidation` with `when`, `command`, and `reason`.
- Executor instruction: the required `superpowers:executing-plans` instruction fits policy loosely, but a dedicated `executorPolicy.requiredSkills` field would preserve it without mixing it into product policy.
- Fixture-like inline examples: snapshot examples and fake SDK streams are not durable fixture beads. Either keep them inside child `inputs` or add a lightweight `inlineFixture` input type for examples that should not become standalone fixture tasks.

## Notes For Combined Summary

- This plan is highly executable: task order, file scopes, commands, expected outcomes, and commits are all explicit.
- The strongest formula stress comes from information that is procedural rather than architectural: ordered steps, exact commits, conditional verification, and inline code contracts.
- Existing parts can represent the main work graph without adding new roles. The likely improvements are metadata fields inside `child`, `checkpoint`, and `policy`, not new top-level formula roles.
- The plan has no meaningful pilot, reusable follow-up template, subagent launch packet, or handoff note.
- The conversion should preserve the sequential dependency chain unless a reviewer deliberately splits Task 1 into independent red-test children.
