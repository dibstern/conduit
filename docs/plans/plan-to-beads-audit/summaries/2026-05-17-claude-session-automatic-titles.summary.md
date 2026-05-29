# 2026-05-17 Claude Session Automatic Titles Plan Summary

## Source

- Source plan: `docs/plans/2026-05-17-claude-session-automatic-titles.md`
- Plan purpose: implement automatic Claude session titles after the first accepted Claude user message, using a short-lived Haiku query and Conduit's SQLite event store.
- Conversion context: audit against current plan-to-beads roles `epic`, `global-contract`, `architecture`, `policy`, `parent`, `child`, `checkpoint`, `fixture`, `pilot`, `followup-template`, plus contract snippets `work-packet`, `subagent-launch`, and `handoff-note`.

## Plan Structure

- Title and executor directive: names the implementation plan and requires `superpowers:executing-plans` for execution.
- Header summary: gives a goal, architecture summary, and tech stack.
- Settled Decisions: records scope, non-goals, provider ownership, async behavior, title sanitization, fallback behavior, debug visibility, manual rename precedence, and persistence rules.
- Current Bug: explains the existing auto-rename path, wrong OpenCode ownership boundary, and projector overwrite bug.
- Six numbered tasks:
  - Task 1 fixes relay-owned Claude rename semantics.
  - Task 2 adds `SessionTitleService`.
  - Task 3 wires title generation from prompt handling.
  - Task 4 adds browser console logging for debug system errors.
  - Task 5 adds a focused integration check.
  - Task 6 runs final verification.
- Each implementation task generally contains file scopes, failing-test instructions, implementation steps, focused verification commands, expected outcomes, and a commit recipe.
- Implementation Notes: captures Claude SDK options, timeout guidance, default-title detection, debug visibility, and no-backfill behavior.

## Information Types Communicated

- Product behavior: when titles are generated, how many words they may contain, fallback titles, and manual-rename precedence.
- Provider and ownership boundaries: Claude titles belong to Conduit's SQLite/event-store path, not the OpenCode session API.
- Architecture contracts: prompt handler trigger point, background Effect fiber, short-lived Claude SDK query, event-store append/projection, projector title ownership, WebSocket debug payload behavior.
- Existing defect diagnosis: the old rename route targets the wrong owner, and duplicate `session.created` events can revert titles.
- File ownership and write scope: each task lists production and test files to modify or create.
- TDD workflow: most tasks start with failing tests, then implementation, then focused test commands.
- Concrete implementation sketches: TypeScript interfaces, helper functions, SQL snippets, WebSocket payload shape, SDK query options, and title-generation prompt text.
- Verification strategy: focused unit/integration commands, static Effect guardrail, typecheck/lint, and criteria for whether to escalate to broader E2E tests.
- Execution sequencing: tasks are ordered so rename semantics and projector safety land before title generation wiring and integration coverage.
- Version-control intent: each task includes `git add` paths and a proposed commit message.
- Conditional implementation choices: several steps give fallback paths such as using a new focused projector test, choosing relay-layer versus relay-stack wiring, running a single store test if the broader directory is too broad, or testing `SessionTitleService` directly if the full prompt handler is too heavy.
- Test fixtures and examples: sample Claude title text, sample `system_error` payload, fake Claude title query factory, and mock service factory defaults.

## Fit To Existing Formula Parts

- `epic`: fits the plan title, goal, and overall deliverable.
- `global-contract`: fits settled decisions such as first-Claude-message scope, no repo scanning, no backfill, manual rename precedence, six-word cap, and persistence-only title changes.
- `architecture`: fits the header architecture summary, current bug ownership analysis, event-store/projector semantics, prompt handler trigger point, SDK query boundary, WebSocket debug payload, and implementation notes.
- `policy`: fits TDD-first sequencing, failure/fallback rules, no full E2E by default, required executor skill, and focused verification expectations.
- `parent`: each numbered task can become a stage parent carrying shared file scopes and defaults.
- `child`: each concrete implementation/test step can become a child work packet when it has a clear file scope, behavior, command, and expected outcome.
- `checkpoint`: focused test runs, commit points, final verification, and the broader-E2E escalation decision fit checkpoint beads.
- `fixture`: fake Claude query factories, mock service defaults, sample title text, and sample debug payloads fit fixture context.
- `pilot`: no clear pilot exists. Task 5 is evidence-producing integration work, but it is required verification rather than optional pilot discovery.
- `followup-template`: no clear follow-up template exists. The plan explicitly says not to backfill existing sessions.
- `work-packet`: fits per-child goal, inputs, constraints, file scopes, red/green commands, expected failure, verification, and failure conditions.
- `subagent-launch`: only weakly fits. The plan has a required executor sub-skill, but does not define independent subagent launches, wave ownership, or disjoint parallel work packets.
- `handoff-note`: partly fits the repeated commit recipes and expected outcomes, but the plan does not contain durable handoff text beyond commit boundaries.

## Gaps / Schema Additions

- Problem statement / baseline defect: `Current Bug` is not quite architecture, policy, or work. A `problem-statement` or `baseline-defect` role would preserve observed behavior, root cause, and regression intent without turning it into executable work.
- Implementation snippet library: the plan contains exact helper functions, SQL, SDK options, prompt text, and payload examples. These can be stuffed into child inputs or architecture notes, but a `reference-snippet` or `implementation-sketch` context role would preserve reusable code/prompt examples more cleanly.
- Conditional branch / decision point: "if too broad", "if wiring is too heavy", and layer-placement choices are not first-class. Add a `decision-point` role or optional branch metadata on `child`/`checkpoint`.
- Commit recipe / version-control milestone: repeated `git add` and `git commit -m ...` blocks do not fit cleanly in `handoff-note` or `checkpoint`. Add checkpoint metadata for `commitScope` and `commitMessage`, or add a small `commit-checkpoint` role.
- Executor/tooling prerequisite: the required `superpowers:executing-plans` directive can live in `policy`, but formula output may need a dedicated `requiredSkills` or `executorPrereqs` field so execution harness requirements are not lost.
- Debug payload contract: the `system_error` message shape could fit architecture, but a structured `protocol-contract` context role or architecture subtype would better preserve wire-message schemas.
- Optional validation escalation: final verification includes a decision about broader E2E tests. A checkpoint can carry this, but it needs explicit metadata for escalation criteria and stop conditions.

## Notes For Combined Summary

- This plan is highly executable: it has strong sequencing, scoped files, test-first steps, expected commands, and concrete code sketches.
- The main conversion risk is granularity. The numbered tasks are too large for single child beads; each task should likely become a parent with children for tests, implementation, focused verification, and commit/checkpoint.
- The plan communicates diagnosis and reference implementation detail more richly than the current role set models. Those details should not be discarded during conversion because they explain why the event-store ownership and projector behavior matter.
- No pilot or follow-up-template content appears necessary for this plan.
- Preserve the explicit no-backfill non-goal and manual-rename-wins rule as global contract items because they constrain multiple tasks.
