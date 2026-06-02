# 2026-05-11 Fix Daemon Effect Server Bind Summary

## Source

- Plan reviewed: `docs/plans/2026-05-11-fix-daemon-effect-server-bind.md`
- Plan title: `Fix Daemon Effect Server Bind - Single Source of Truth Implementation Plan`
- Purpose: restore HTTPS daemon binding to `0.0.0.0` after the Phase 8 Effect migration by making `DaemonConfigRefTag` and `TlsCertTag` the canonical runtime sources for bind config and TLS material.

## Plan Structure

The plan is a task-by-task implementation runbook with a strong source-of-truth contract at the top.

- Header contract: required execution skill, goal, target architecture, tech stack, audit amendments incorporated, and anti-bandaid rules.
- Pre-flight setup: worktree, branch, install, baseline verification, and stop condition if baseline fails.
- Numbered tasks:
  - Task 1 seeds `DaemonConfigRef` from explicit daemon options and has its own commit.
  - Tasks 2-5 are one connected migration slice with explicit no-commit boundaries until the slice passes.
  - Task 6 performs broad automated and manual integration verification.
  - Task 7 opens the PR with a complete prepared body.
- Each implementation task includes a goal, file list, step-level code snippets, focused commands, expected failures or passes, and commit instructions where applicable.
- The plan ends with a test coverage guarantee matrix and a list of skills to reference during execution.

## Information Types Communicated

- Product/runtime goal: daemon HTTPS should bind to `0.0.0.0` and be reachable over Tailscale.
- Architectural source-of-truth rule: runtime config and TLS material move to Effect tags; `DaemonLifecycleContext` becomes a server-handle sink.
- Prior-audit resolution list: concrete amendments from an R2 audit that must be preserved.
- Negative constraints: anti-bandaid rules forbidding stale `ctx.host`, `ctx.port`, and `ctx.tls` patterns.
- Workspace setup instructions: worktree path, branch name, install command, baseline checks, and failure stop rule.
- Task decomposition: ordered migration tasks with explicit goals and affected files.
- Step-level implementation guidance: exact tests to add, code shapes, replacement tables, imports, helper functions, and deletion lists.
- TDD expectations: commands expected to fail before implementation and pass after implementation.
- Dependency and sequencing constraints: HTTP must update the actual bound port before onboarding reads it; Tasks 2-5 must commit together.
- Verification commands: focused Vitest commands, `pnpm check`, `pnpm lint`, broad test command, `rg` invariant checks, manual smoke commands.
- Environment prerequisites: `mkcert`, Tailscale IPv4 discovery, port availability, foreground daemon startup.
- Manual acceptance evidence: expected `lsof`, `curl`, redirect, setup-info, and CA download results.
- Version-control instructions: git add sets, commit messages, push command, PR title/body, and "No Claude Code footer".
- Coverage guarantee: a task-to-regression-coverage matrix.
- Execution policy: required skills and debugging loop if smoke verification fails.

## Fit To Existing Formula Parts

- `epic`: fits the whole source-of-truth plan, including title, goal, source plan, and overall restoration objective.
- `global-contract`: fits the top-level goal, tech stack, source-of-truth runtime rule, anti-bandaid rules, non-goals, and repo-wide constraints.
- `architecture`: fits the canonical config/TLS design, server-handle-only lifecycle context, HTTP/onboarding sequencing, setup-info dependency boundary, and module ownership.
- `policy`: fits TDD expectations, no-red-commit rule, baseline stop rule, skill requirements, no-footer rule, and smoke-failure debugging loop.
- `parent`: fits Tasks 1-7 as stage or feature group beads, especially Task 1, the combined Tasks 2-5 migration slice, manual verification, and PR publication.
- `child`: fits most numbered implementation steps that have a concrete goal, file scope, expected red command, green scope, verification command, and handoff requirement.
- `checkpoint`: fits baseline verification, Task 2-5 commit gate, focused test gates, full migration verification, invariant `rg` check, manual smoke gate, and PR-ready gate.
- `fixture`: fits generation and use of `test/fixtures/test-cert.pem` and `test/fixtures/test-key.pem`, including provenance and refresh command.
- `pilot`: weak fit only for manual smoke proving the real daemon bind behavior. It is evidence collection, but the plan treats it as required acceptance rather than exploratory pilot work.
- `followup-template`: little direct fit. The plan does not define deferred future work templates; it mainly defines executable implementation and verification.
- `work-packet` contract snippet: fits implementation child details such as goal, files, constraints, commands, expected failures, verification, and failure conditions.
- `subagent-launch` contract snippet: partial fit for the required skill list and task execution guidance, but the plan does not define parallel subagent launch packets.
- `handoff-note` contract snippet: partial fit for baseline failure reporting, smoke failure loops, and final PR/test evidence, but the plan does not specify a durable handoff note format.

## Gaps / Schema Additions

- Add a first-class `preflight` role or checkpoint subtype for workspace setup, branch/worktree creation, dependency install, baseline validation, and stop-if-baseline-fails behavior. This information is more operational than global policy and more setup-oriented than a normal checkpoint.
- Add a `commit-boundary` or `vcs-operation` schema element for atomic commit grouping, explicit no-commit windows, exact `git add` file sets, commit messages, push commands, and PR creation. Current roles can store this as policy/checkpoint metadata, but the semantics are important enough to validate.
- Add an `acceptance-smoke` or `manual-verification` role/checkpoint subtype for external-environment checks with prerequisites, command evidence, and expected live outputs. Plain checkpoint validation commands do not fully capture environment blockers like missing Tailscale or mkcert state.
- Add an `audit-amendment` or `review-resolution` metadata block for prior audit findings that the converted work graph must preserve. These are not exactly architecture, policy, or child work; they are traceability constraints from previous review.
- Add a `coverage-matrix` snippet for the test coverage guarantee table. It maps tasks to correctness claims and regression coverage, which is useful cross-task metadata but does not belong to a single child work packet.
- Consider a `publication` role for PR creation and final review packaging. Task 7 is executable but is not implementation, fixture, checkpoint, or follow-up-template work.

## Notes For Combined Summary

- This plan is unusually concrete and conversion-friendly: most implementation work can become child beads directly because the plan names files, commands, expected failures, expected passes, and exact constraints.
- The strongest schema pressure comes from operational lifecycle material around pre-flight, commit boundaries, manual smoke evidence, and PR publication.
- The formula should preserve the Tasks 2-5 atomic migration slice as a parent with child beads and a checkpoint-owned commit gate; splitting those tasks into independent ready work would violate the plan.
- Manual verification should remain a required gate, not a follow-up, because the plan's goal depends on real network binding and Tailscale reachability.
- Audit amendments should be retained as traceability metadata so later child beads can prove they did not regress the R2 findings.
