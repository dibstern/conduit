# Claude SDK Agent Access Fix Plan

## Summary

Fix the Claude SDK migration issues at their contracts: permission resolution must unblock the same sink promise the SDK callback is awaiting, capability discovery must run in the workspace with the same setting sources as real turns, Claude agents must not be hidden by parent-model filtering, agent changes must restart SDK queries because the SDK has no `setAgent`, and Claude task/subagent lifecycle events must not complete the main turn.

## Implementation

- Make `ClaudePermissionBridge` resolve pending permissions through the current session `EventSink` when it supports interactive resolution, and remove adapter-global sink capture.
- Pass `workspaceRoot` into Claude capability probing and cache capabilities per workspace root.
- Return all Claude agents from SDK discovery in agent handlers and client init; only clear stale active agent ids that are not in the returned list.
- Track the current Claude agent in `ClaudeSessionContext`; restart the SDK query for a changed agent between turns and reject changes while the turn is active.
- Map SDK task progress, notification, tool progress, and parent-linked messages into child task/tool metadata; leave main `turn.completed` driven only by SDK `result`.

## Tests

- Add red tests for permission resolve hang, sink isolation, workspace-scoped capability probing/cache, unfiltered Claude agents, agent query restart, active-turn agent switch rejection, and task progress not completing main turns.
- Verify with the targeted Claude/agent suites first, then `pnpm check`, `pnpm lint`, `pnpm test:unit`, and `pnpm test:all > test-output.log 2>&1 || (echo "Tests failed, see test-output.log" && exit 1)`.

## Assumptions

- Do not touch the existing dirty `opencode.jsonc` in the main checkout.
- Use the isolated worktree at `.worktrees/claude-sdk-agent-access-fixes`.
