# AGENTS.md

The opencode instance at localhost:4096 is running and accessible.
NEVER stash changes, you are interrupting other sessions and work.

## Purpose

`conduit` is a web UI orchestrator for AI coding assistants. It lets one long-lived daemon expose sessions to browser clients across multiple projects. Provider adapters (OpenCode, Claude Agent SDK) are stateless execution engines that stream events into conduit's SQLite event store.

## Architecture At A Glance

- `src/bin/cli.ts` is the thin CLI entrypoint; `src/bin/cli-core.ts` routes commands.
- The CLI either runs a relay in-process with `foreground` or manages a long-lived `Daemon` over Unix socket IPC.
- `src/lib/daemon/daemon.ts` owns process lifecycle, persisted config, the shared HTTP and IPC servers, project registration, and the OpenCode instance registry.
- One daemon can host many projects. Each project gets its own relay stack mounted under `/p/<slug>`.
- `src/lib/relay/relay-stack.ts` builds the per-project relay around `OpenCodeClient`, `SessionManager`, `SSEConsumer`, `WebSocketHandler`, pollers, and PTY wiring.
- `src/lib/server/*` handles the shared HTTP and WebSocket edge; `src/lib/handlers/*` dispatch browser messages into focused domain handlers.
- The SQLite event store is the source of truth for sessions and messages. Provider adapters are stateless execution engines that stream events into the store.

Read `docs/agent-guide/architecture.md` before changing daemon behavior, project routing, relay wiring, event store, projectors, provider adapters, session flow, instance management, or PTY behavior.

## Source Map

- `src/bin/`: CLI entrypoints.
- `src/lib/daemon/`: daemon lifecycle, IPC,  config persistence, projects.
- `src/lib/server/`: HTTP and WebSocket server, router, static files, push.
- `src/lib/relay/`: OpenCode event pipeline, pollers, PTY upstream wiring.
- `src/lib/persistence/`: SQLite event store, projectors, migrations.
- `src/lib/provider/`: Provider adapters (OpenCode, Claude SDK).
- `src/lib/session/`: session orchestration and status polling.
- `src/lib/instance/`: OpenCode instance management and client access.
- `src/lib/handlers/`: browser message handlers.
- `src/lib/frontend/`: Svelte 5 SPA.
- `docs/plans/`: design and implementation records. Check here before changing behavior that may already be planned or explained.

## Verification

Default verification path for most changes:

```bash
pnpm check
pnpm lint
pnpm test:unit
# Needs to be logged since the output is large and gets truncated.
pnpm test:all > test-output.log 2>&1 || (echo "Tests failed, see test-output.log" && exit 1)
```

Read `docs/agent-guide/testing.md` before choosing broader verification. Use the narrowest integration, E2E, daemon, multi-instance, or visual command that matches the changed surface.

## Deeper Docs

- `docs/agent-guide/architecture.md`: deeper runtime architecture and request or event flow.
- `docs/agent-guide/testing.md`: verification selection guidance and targeted commands.
- `docs/plans/`: historical design and implementation context for features and refactors.

## Development Tips

- When writing frontend code, default to the standard Svelte 5 best practice and patterns.

## Troubleshooting Tips

- Local conduit: It runs at `http://localhost:2633/`.
- Local opencode instance Debug: You can hit the local instance of opencode, running on port 4096, using:
    - Authorized: `curl -s -u "opencode:$OPENCODE_SERVER_PASSWORD" http://localhost:4096/<DESIRED-PATH> 2>&1 | python3 -m json.tool`
    - Or just open `http://localhost:4096` in a browser and use dev
        tools to inspect requests, responses, and WebSocket messages.
- Check the daemon logs in `~/.opencode/daemon.log` for errors or unexpected behavior.
- You can use `playwright-cli console` (see the playwright-cli skill) to inspect the console logs to help debug the frontend.
- Don't remove temporary debug logging until you're confident you've fixed the issue.

## Agent skills

### Issue tracker

GitHub Issues at `dibstern/conduit`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles, default strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root (created lazily by `/grill-with-docs`). See `docs/agents/domain.md`.

## Operating Principles

Keep it simple. Simple is better than complex.
Assume the user is a principal engineer.
Make the smallest maintainable change that solves the actual request.
Prefer existing patterns over new abstractions.
Avoid broad refactors, speculative helpers, and clever architecture unless clearly justified.
Use judgment. Read enough surrounding code to understand the existing pattern, then avoid unnecessary exploration.
Optimize for correctness, speed, judgment, and token efficiency.
Correct the user when appropriate.
Prefer FAANG-level code quality: clear naming, strong types, simple control flow, minimal mutation, focused functions, pure functions/components where practical, and no unnecessary abstraction.

## Context Discipline

Protect context aggressively.

Answer the narrow question first. Inspect the smallest relevant file, symbol, route, component, diff, log, or test output.

Prefer targeted searches, focused file sections, nearby call sites, capped logs, and scoped validation. Avoid running validation commands like `npm run build`, `npm run test`, or `npm run lint` unless absolutely necessary. Use normal scoped commands like `rg`, with a byte cap when needed.

Avoid dumping full files, full logs, unrelated directories, broad repo searches, large diffs, or generated output after the relevant code is found.

Do not byte-cap instruction files, skill files, tool docs, or agent policy files. Read the whole relevant file unless it is unexpectedly huge.

## Command Output

Protect context usage. **Any command with unknown or potentially large output must be scoped and byte-capped.**

Byte-cap unknown or potentially large output. Line caps alone are unsafe because a single line can be huge.

```bash
COMMAND 2>&1 | head -c 4000
COMMAND 2>&1 | tail -c 4000
```

### Good Byte Capping Examples

```bash
rg -n -m 20 'functionName|ComponentName|routeName' src 2>&1 | head -c 200
bash -o pipefail -c 'npm run type-check 2>&1 | tail -c 500'
bash -o pipefail -c 'npm run test 2>&1 | tail -c 2000'
bash -o pipefail -c 'npm run build 2>&1 | tail -c 500'
rg -l "SEARCH_TERM" src 2>&1 | head -c 4000
```

Do not rely on `head -n`, `tail -n`, or `sed -n` as the only cap.

Scope before printing content: list files first, search specific paths, count matches when useful, and avoid reading generated, binary, minified, database, or huge JSON/JSONL files unless required.

Preserve exit codes when needed:

```bash
tmp="$(mktemp)"
COMMAND >"$tmp" 2>&1
status=$?
tail -c 5000 "$tmp"
rm -f "$tmp"
exit "$status"
```

Avoid unbounded `cat`, broad `rg`, `find`, `ls -R`, `git diff`, tests, builds, and `select *`.

If capped output is insufficient, narrow the command before increasing the cap.

## Code Changes

Prefer direct edits with the available patch tool.
Patch the narrow failing path first.
Avoid unrelated cleanup.
Do not add helpers, wrappers, maps, files, abstractions, or validation layers unless they clearly reduce complexity.

## Patterns to Avoid

Avoid single-use abstractions.

Prefer inline types and direct logic when a helper, wrapper, map, or named type is used only once.

Avoid wrapper functions that simply call another function.

## Validation

Match validation to risk.

Skip validation for low-risk changes and say so plainly.
Use the cheapest useful check for risky changes.
Do not run full test suites or full builds unless risk justifies it or the user asks.

## Subagents

Use subagents only when they save context, save time, or materially improve output quality.

For research, review, and exploration tasks, avoid confirmation bias. Do not pass a preferred conclusion. Ask the subagent to investigate, compare, or verify, and require evidence, tradeoffs, uncertainty, and better alternatives.

Prefer subagents for:

- documentation/API checks
- web research
- non-trivial copywriting/content generation

Avoid subagents for trivial work the main agent can finish faster.

When using a subagent, assign a narrow task and require:

- findings
- files inspected
- files changed, if any
- validation run, if any
- risks or uncertainty

You own final judgment and integration.

## Communication

Before editing, state the approach only for non-trivial tasks.

During complex work, keep updates short:

- what was found
- what changed
- what risk remains

After work, summarize:

- what changed
- files touched
- validation run, or why skipped
- remaining risk

Keep summaries short. Do not explain obvious edits.

Oververbosity:low