# 2026-05-15 Claude Subagent Live Child Streaming Design Summary

## Source

- Source plan: `docs/plans/2026-05-15-claude-subagent-live-child-streaming-design.md`
- Topic: make Claude subagent child sessions visible and live while the parent Claude turn is still running.
- Review scope: structure, communicated information types, and fit against current plan-to-beads formula roles and contract snippets.

## Plan Structure

The plan is a compact design note, not an executable work breakdown. Its sections communicate:

- `Goal`: one user-visible behavior target.
- `Current Shape`: current implementation state and the limitation that motivates the change.
- `Chosen Approach`: ordered runtime behavior for early child-session creation, parent metadata emission, and per-task polling.
- `Data Flow`: snapshot-to-event translation model, cursor state, persistence/push behavior, and parent-owned finalization.
- `Relay Delivery Requirement`: a cross-cutting delivery invariant for child events emitted from a parent provider instance.
- `Persistence Requirement`: a storage precondition needed before appending child transcript events.
- `Error Handling`: runtime failure policy for polling and empty child sessions.
- `Testing`: behavior-focused test bullets, including use of mocked Claude behavior instead of a real Claude install.

## Information Types Communicated

- Product behavior: child sessions should appear immediately on Claude `task_started` and remain navigable while the parent turn is active.
- Existing-system diagnosis: the current materialization path is snapshot-only and waits for parent `result`.
- Runtime sequence: deterministic child ID computation, session ensure, parent `tool.running` metadata, poller start, final poll, poller stop, and fallback materialization.
- Data-source semantics: Claude subagent APIs are treated as snapshots, not streams.
- Deduplication/cursor model: per-child in-memory tracking for message UUIDs, text lengths by block, and tool start/completion IDs.
- Event routing invariant: relay delivery must use `event.sessionId` for child events while retaining the fixed sink session for ownership-sensitive requests.
- Persistence invariant: child session rows must exist before child transcript events because of event-store foreign keys.
- Error policy: polling errors are non-fatal to the parent turn, final poll failures are logged, and empty early-created child sessions remain navigable.
- Testing intent: targeted unit/integration behavior without a real Claude installation.
- Deferred alternative: a note to consider delayed child creation until first content if immediate empty child sessions feel noisy.

## Fit To Existing Formula Parts

- `epic`: fits the whole live child streaming plan.
- `global-contract`: fits the high-level goal, scope, non-goal of using a real Claude install in primary tests, and UX stance of immediate navigability.
- `architecture`: fits the provider/runtime flow, snapshot polling model, event routing invariant, persistence invariant, and finalization path.
- `policy`: fits non-fatal polling failures, retry/backoff behavior, empty-child-session behavior, and testing without a real Claude install.
- `parent`: could group the implementation around a Claude subagent live streaming feature/stage, but the plan does not define multiple explicit stages.
- `child`: could be derived for individual behaviors such as early child creation, relay sink session tagging, snapshot delta emission, final poll shutdown, and Task card navigation.
- `checkpoint`: fits integration gates around event-store safety, relay routing, final poll behavior, and frontend navigation.
- `fixture`: fits mocked Claude SDK/subagent snapshot data and test harness setup.
- `pilot`: weak fit; the plan does not define an evidence-gathering pilot, though the deferred UX-noise alternative could become a pilot if product uncertainty needs measurement.
- `followup-template`: fits the deferred alternative only if the conversion preserves it as optional future work rather than current implementation.
- `work-packet`: fits the testing bullets only after decomposition into child behaviors with allowed files, red command, expected failure, green scope, and verification.
- `subagent-launch`: conceptually relevant because the feature is about Claude subagents, but the snippet is for launching implementation subagents, not modeling application-level Claude subagent lifecycle.
- `handoff-note`: fits the need to preserve finalization/fallback behavior and the deferred UX alternative for later agents.

## Gaps / Schema Additions

- `current-state` or `problem-statement`: the `Current Shape` section carries implementation diagnosis and motivation. It can be squeezed into `architecture`, but that loses the distinction between existing behavior and intended architecture.
- `runtime-sequence` or `lifecycle`: the plan communicates temporal ordering and ownership across task start, polling, parent result, final poll, and fallback materialization. Existing roles can store this as architecture prose, but there is no structured sequence/lifecycle part.
- `invariant`: relay delivery and persistence requirements are crisp system invariants. They fit `architecture` or `checkpoint`, but a named invariant type would make them reusable by multiple child work packets and gates.
- `error-policy`: retry/backoff, non-fatal final failures, and empty-session behavior fit `policy`, but current child work packets do not appear to have explicit error semantics fields.
- `acceptance-scenario`: the testing bullets describe behavior expectations more directly than commands. They can become `verification` in work packets, but a separate scenario list would preserve source intent before command selection.
- `deferred-alternative`: the comment about delayed child creation is neither executable work nor a generic follow-up template. A lightweight decision-alternative field would preserve it without promoting it to work.
- `application-subagent-lifecycle`: the existing `subagent-launch` snippet risks ambiguity because it describes agent-execution launch contracts, while this plan describes Claude provider subagent sessions inside the product.

## Notes For Combined Summary

This plan is best represented as a small epic with one architecture context bead, one error/testing policy bead, one fixture bead for mocked Claude snapshots, and several child work packets derived from the testing bullets. The main schema pressure is not decomposition, but preserving design-note information: current-state diagnosis, ordered runtime lifecycle, invariants, and deferred alternatives. Combined formula guidance should distinguish application-level provider subagents from implementation subagents so the `subagent-launch` snippet is not misapplied.
