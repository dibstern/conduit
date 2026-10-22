# Codex provider design

Status: design, 2026-10-21. Pinned to `codex-cli 0.162.1` (`codex app-server`, JSON-RPC over stdio JSONL).

Codex becomes conduit's fourth provider driver, next to Claude (Agent SDK), OpenCode (server) and Cursor (SDK).
It reuses the provider-neutral detached runner host that Cursor uses. Each conduit session runner owns one
`codex app-server` child. Five slices follow two prefactors.

## Competitor survey

| Competitor | Revision | Process model | Approvals | Questions | Resume / fork / rollback | Tests |
|---|---|---|---|---|---|---|
| t3code | main@2026-10-21 `848e352b48` | one app-server per provider instance, shared by threads | full, session "always" per kind | blocking (expire on restart) + async (survive) | `thread/resume excludeTurns`, `thread/fork lastTurnId`, `thread/revert` | bidirectional recordings replayed through production adapter + SQLite |
| paseo | main@2026-10-21 `5d70bf0645` | one app-server per session + temp catalog children | no `permissions/requestApproval`; unknown RPC gets `{}` | async persisted | rewind = fork before turn | fake peer + real CLI vs mock Responses API |
| monocode | main@2026-10-21 `74b8139c41` | one app-server per UI session, subagent threads share it | Full = `on-request` + danger-full-access + local accept; no "always" for commands/files | blocking (no restart recovery) + async via `turn/steer` | resume; `thread/revert` on edit; silent fresh-thread fallback | pure mapper tests |
| bb | main@2026-10-20 `b143a22860` | bridge process, one app-server child per thread | cards for command/file/permissions, session grants; amendments discarded | blocking + async; rich MCP elicitation forms | resume `excludeTurns`; fork via checkpoints; rewind as staged fork | four-direction recorded traces |
| zeron | main@2026-10-19 `911ec56e41` | one app-server per chat runtime, 30 min idle | forced `danger-full-access` + `never`; stray approvals as Yes/No | blocking; answer after crash becomes prose; no MCP elicitation | resume; steer acked on echoed user message; transcript-copy fork; no rollback | exhaustive notification classification |
| diri | main@2026-10-21 `3df8c3f736` | TUI/PTY (counter-example) | n/a | n/a | transcript identity check | real CLI vs fake provider, isolated home |
| capy | docs 2026-10-21T08:41Z | hosted | n/a | n/a | n/a | n/a |

**Convergence (3+):** app-server over stdio; `initialize` with `experimentalApi`; `item/completed` is authoritative
over deltas; `turn/steer` with `expectedTurnId`; `untrusted`/`on-request`/`never` permission mapping; send policy,
sandbox and reviewer explicitly; one app-server per conversation runtime (paseo, bb, zeron, monocode).
`-32601` for unknown server requests is t3code and monocode only; paseo answers `{}`, which silently "succeeds".

**Outliers worth taking:** t3code's split between *accepted* and *executing* native turn ids (Stop targeted a queued
turn, `89c320df0b`); t3code's settle-on-turn-end for items Codex never completes (`ccae51a814`, `45bcde1441`);
monocode's Full Access via `on-request` (with `never`, explicit escalations never reach the client); monocode's
read-only sandbox in plan mode; paseo/diri's real CLI against a mock Responses API in an isolated `CODEX_HOME`.

**Gaps nobody closes:** typed-decode failures are dropped silently (t3code `client.ts:153`); multi-file `fileChange`
items keep only the first file (t3code `CodexAdapterV2.ts:3586`); `isSecret`/`isOther` question flags are dropped;
replay never asserts full transcript consumption; blocking approvals die on server restart everywhere. Conduit's
detached runners close the last gap for free.

## Approaches considered

Convergence column: **F** follows the 3+ convergence, **D** departs.

| | Approach | Source | Conv. | Verdict |
|---|---|---|---|---|
| A | Shared app-server per account, many threads multiplexed | t3code | D | Rejected: couples sessions to one process (t3code OOM fix `b2cc18d3f2`), and conduit's runner already gives restart survival per session |
| B | Detached conduit runner per session owns one app-server child | Cursor in conduit, paseo, bb, zeron, monocode | F | **Chosen** |
| C | Connect to Codex's own `app-server daemon` over its unix control socket | codex 0.162 `app-server daemon/proxy` | D | Rejected: one daemon per `CODEX_HOME` defeats per-account isolation, and its lifetime is outside conduit's control |
| D | Drive the TUI through a PTY | diri | D | Rejected: no structured approvals, items or usage |
| E | Generate full Effect schemas from upstream (3.6 MB, 888 files) | t3code | D | Rejected: strict generated enums broke resume three times (`75ab5ab3fb`, `95139254ba`, `451afcb22d`) |
| F | Hand-written narrow schemas for consumed fields, open enums, pinned by captured traces, plus a dev drift check against `generate-ts` | conduit ADR-0002 | D | **Chosen** |
| G | `codex exec --json` per turn, no app-server | none | D | Rejected: no approvals, steer or questions |
| H | Daemon-side shared trace kit for all JSON-RPC providers | improve-architecture candidate 3 | n/a | Rejected: Codex is the only JSON-RPC stdio provider; a shared kit would be a single-use abstraction |
| I | New canonical event kinds for command output, file changes, plans | improve-architecture candidate 4 | n/a | Rejected: `tool.running.metadata` and `tool.completed.result` are already open, so no new kinds or exhaustiveness churn |
| J | Deliver fork digests through `thread/inject_items` instead of inline | t3code `ContextHandoffDelivery` | D | Rejected for now: experimental method, and safe retries need t3code's pending/injected/inline delivery ledger. The inline digest path is shared and proven |

Module-lens approaches (where the depth lives):

| | Approach | Verdict |
|---|---|---|
| M1 | One deep `codex/app-server` module (transport, JSON-RPC, method table), and a pure `codex-item-mapper` (native item → runtime events) with no I/O | **Chosen.** The mapper is unit-free: it is pinned by trace replay through the real runner |
| M2 | One turn-lifecycle owner per runner: accepted/executing turn ids, open items, goal successors, settlement | **Chosen.** t3code's recommendation for its own 7,500-line adapter: splitting settlement across handlers recreates Stop races |
| M3 | Codex payload as one big file like `cursor-runner-payload.ts` (1,058 lines) | Rejected: payload stays a thin adapter over M1/M2 |
| M4 | Make every per-driver dispatch site exhaustive over the driver-kind union, so a new driver is a compile error at each site | **Chosen** as prefactor P1. A central `ProviderDriverModule` registry was rejected: the sites need cross-layer dependencies |
| M5 | A generic runner-driver kit that removes Cursor's 70-line recovery boilerplate and Claude defaults from the runner host | **Chosen** as prefactor P2 |

## Recommendation

Approaches **B + F + M1 + M2**, after prefactors **P1** and **P2**. Continuation decoupling (**P3**) lands before slice 3.

## Architecture

```
browser ── daemon (single SQLite writer)
             │  provider-neutral runner host (spool, receipts, idle exit, hot upgrade, recovery, waiters)
             └── conduit runner  (one per session, survives daemon restart)
                   └── codex app-server --listen stdio://   (CODEX_HOME = account home)
           discovery: short-lived app-server child per account (model/list, account/read, rateLimits, skills/list)
```

### Modules (`src/lib/provider/codex/`)

| Module | Interface | Notes |
|---|---|---|
| `app-server/transport.ts` | `AppServerTransport { send(message), messages: Stream<unknown>, exit, close }` over a child or a trace player | Fragment buffering until newline (t3code `702a6ade3c`), 128 MiB message cap, stderr drained, CRLF and split UTF-8 safe |
| `app-server/client.ts` | `request(method, params)`, `notifications: Stream`, `onServerRequest(method, handler)` | Initialize once, tolerate "Already initialized". Unknown server request → `-32601`. Server requests run in a bounded forked scope so a waiting approval never blocks notifications |
| `app-server/protocol.ts` | Narrow Effect schemas for the methods conduit uses | Enum-like fields are `String` with known-literal helpers. Unknown item `type` decodes to `{type, id, raw}` |
| `codex-item-mapper.ts` | `(state, notification) → [state, ProviderRuntimeEvent[]]`, pure | Snapshot dedup per item; all `fileChange.changes`; plan delta vs task-list distinction |
| `codex-turn-lifecycle.ts` | `start`, `steer`, `interrupt`, `onTurnStarted/Completed`, `settle` | Accepted vs executing turn id; goal successors; settles open items on turn end |
| `codex-interactions.ts` | maps server requests ↔ `sink.requestPermission` / `sink.requestQuestion` | Preserves `isSecret`, `isOther`, options; session grants per request kind |
| `codex-session-config.ts` | permission mode → `{approvalPolicy, sandboxPolicy, approvalsReviewer, collaborationMode}` | Sent on every `turn/start` |
| `codex-runner-payload.ts` | `RunnerPayload` | Thin: wires the modules above |
| `codex-runner-launch.ts` / `codex-runner-driver.ts` / `codex-provider-runtime.ts` | runner host launch, discovery, catalog cache | Mirror Cursor's files, via the P2 kit |
| `codex-session-store.ts` | identity file `<configDir>/codex/stores/<sessionId>/session.json` `{threadId, codexHome, controllerPid, forkSource?}` | Atomic tmp + rename + dir fsync, shared helper extracted from `cursor-session-recovery.ts` |
| `codex-usage.ts`, `codex-auth.ts`, `codex-home.ts` | slices 3 and 4 | |

### Driver traits (`PROVIDER_DRIVERS.codex`)

| Trait | Value | Why |
|---|---|---|
| `supportsFileAttachments` | `false` | Codex input has text and images, no PDF. Images still go inline as data URLs |
| `composerModeControl` | `"permission-mode"` | |
| `permissionModes` | `["ask","acceptEdits","auto","full","plan"]` | See mapping below. No `dontAsk` |
| `supportsQuestionSkip` | `false` until a trace pins an empty answer | |
| `supportsFileRewind` | `false` | `thread/revert` changes conversation history only; conduit has no file checkpoints |
| `interactionSink` | `"permission-asking"` | First non-Claude runner to ask |
| `supportsNativeResume` | `false` | Means "Claude reactor resume" today. Codex resumes from its runner-owned store, as Cursor does |
| `forkStrategy` | `"native"` | `thread/fork` through a completed native turn, with transcript digest fallback |
| `accountKind` / `defaultAccountSource` / `catalogSource` | `"config-directory"` / `"selection"` / `"discovery"` | |
| `usageHarness` | `undefined` until slice 3, then `"codex"` (already in `UsageReadingSchema`) | |
| `steering` | `"native"` | `turn/steer` with `expectedTurnId` |
| `promptsSurviveRestart` | `true` | The runner survives the daemon, so blocking approvals and questions stay live. t3code expires them |
| `supportsGoalState` | `false`, then `true` in slice 2 | |
| `readOnlySubagents` | `true` | |
| `streamsSessionLifecycle`, `usesLocalSessions`, `interruptViaEngine` | `true` | As Cursor |

### Permission modes

| Mode | `approvalPolicy` | sandbox | reviewer | Notes |
|---|---|---|---|---|
| ask | `untrusted` | `readOnly` | user | |
| acceptEdits | `on-request` | `workspaceWrite` | user | |
| auto | `on-request` | `workspaceWrite` | `auto_review` | |
| full | `on-request` | `dangerFullAccess` | user | Any escalation is auto-accepted in the runner. With `never`, explicit escalations never reach the client (monocode) |
| plan | `on-request` | `readOnly` | user | plus `collaborationMode.mode: "plan"`; departs t3code, which leaves writes possible in plan mode |

All four fields are sent on every `turn/start`, because an omitted reviewer stays sticky (t3code `fbd77420f2`).

## Data flow

1. **Turn.** Daemon admits input → runner `sendTurn`. If the runner has no live thread, it reads the identity file:
   with a `threadId` it calls `thread/resume {threadId, excludeTurns: true}` plus settings; without one it calls
   `thread/start`. The identity is written before the turn is acknowledged. Then `turn/start` with input items, model,
   effort, `summary: "detailed"` and the mode fields.
2. **Events.** Notifications go through the pure mapper and out to the runner `EventSink`:

   | Native | Runtime event |
   |---|---|
   | `item/agentMessage/delta`, `item/completed agentMessage` | `text.delta`; completed text is authoritative |
   | `item/reasoning/summaryTextDelta`, `textDelta` | `thinking.start/delta/end` keyed by `(itemId, kind, index)` |
   | `commandExecution` | `tool.started` (Bash input `{command, cwd}`), `outputDelta` coalesced at 250 ms into `tool.running.metadata.output` (64 KiB tail), `tool.completed {output, exitCode}` |
   | `fileChange` | Edit/Write tool with **every** entry in `changes` |
   | `mcpToolCall`, `webSearch`, `imageView`, `collabToolCall` | `mcp__<server>__<tool>`, WebSearch, Read, Task cards |
   | `turn/plan/updated` | TodoWrite-equivalent task list |
   | `item/plan/delta` | Plan document text (plan mode) |
   | `thread/tokenUsage/updated` | context meter from `tokenUsage.last` + `modelContextWindow` |
   | `contextCompaction` | `session.compaction` |
   | unknown item type | generic tool card titled with the native type, never dropped |
   | `turn/completed` | `turn.completed` / `turn.interrupted` / `turn.error` after `settle()` closes any open item |

3. **Steer.** A concurrent send is a steer: `turn/steer {expectedTurnId: executingTurnId}`. Acknowledgement is the
   echoed `userMessage` item. If the turn ended in between, the runner starts a new turn with the same input.
4. **Interrupt.** `turn/interrupt` on the executing turn. If `turn/start` returned `startedAt: null` (queued natively),
   wait for `turn/started` before interrupting (t3code). Pending approvals resolve as `cancel`.
5. **Approvals.** `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
   `item/permissions/requestApproval` → `sink.requestPermission`. Decisions: `once` → `accept` (permissions: grant,
   scope turn), `always` → `acceptForSession` when offered in `availableDecisions` (permissions: scope session),
   `reject` → `decline`. File approvals take their paths from the earlier `fileChange` item. Correlate by
   `approvalId ?? itemId`. `serverRequest/resolved` clears a card answered elsewhere.
6. **Questions.** `item/tool/requestUserInput` → `sink.requestQuestion` with options, `isOther` and `isSecret` kept.

## Error handling

- **Decode (ADR-0001).** Bad JSON line: log `codex.decode_failed` with method and byte size, skip the line, keep the
  stream. Known method with an invalid payload: same diagnostic, skip that message. Unknown notification: counted
  debug diagnostic. Never terminate the transport for a payload problem.
- **`codexErrorInfo` → `turn.error.code`:** `Unauthorized` → `auth_required`; `UsageLimitExceeded` and a final 429
  → `usage_limited` (slice 3 adds `session.usage_limited`); `ContextWindowExceeded` → `context_overflow`;
  `HttpConnectionFailed` / `ResponseStreamDisconnected` → `provider_unavailable`, retryable; else `provider_error`.
- **Missing thread.** "No rollout found" or archived → `thread/unarchive` and retry once (t3code `44bd4c9caf`, `51c6daa3bd`).
  Still missing → `turn.error code: codex_thread_missing`. Never silently start a fresh thread (monocode avoid).
- **Child exit.** A dead app-server fails the active turn with `provider_unavailable`. The next turn respawns and resumes.
- **Terminalization.** `sendTurn` resolves only on `turn/completed`, interrupt settlement or child exit, and the
  runner host settles the command centrally (`settleRunnerCommand`). This already covers t3code `e77a48e81a`
  (stream ended without a terminal).
- **Version.** Discovery reads `initialize.userAgent`; below `0.160.0` it reports `codex_version_unsupported`.

## Testing

- **Trace player.** `CONDUIT_CODEX_APP_SERVER_TRACE=<file.jsonl>` swaps the child for a player behind
  `AppServerTransport` (Cursor precedent). It matches outgoing messages by method (responses to server requests by
  id), remaps recorded request ids to live ones, and releases recorded inbound frames in order. A mismatch answers
  `-32099`; `CONDUIT_CODEX_APP_SERVER_TRACE_REPORT=<file>` gets `{ consumed, total, mismatches, unconsumed }` on close,
  so tests assert full consumption from the report.
- **Recorder.** `scripts/record-codex-app-server-trace.ts` (`pnpm codex:record-traces`) runs real `codex app-server`
  in a throwaway `CODEX_HOME` against a local mock Responses API (no credentials; paseo/diri), redacts paths,
  hostname and installation id, and refuses credential-like output. Derived scenarios (decode failure, unknown item,
  old version) are rewritten from `basic`. `pnpm codex:replay-traces` is the module's own end-to-end check and
  `pnpm codex:schema-drift` compares `CONSUMED_DEFINITIONS` with `generate-json-schema`. A `--live` mode for
  scenarios that need real model behaviour is deferred until a slice needs it. Traces live in
  `test/fixtures/codex-app-server-traces/`.
- **Daemon integration** (`test/integration/daemon/codex-*.test.ts`, `ProcessHarness`): turn, tools, every approval
  decision, question answered after daemon restart, steer, Stop on a queued turn, runner crash recovery,
  decode-failure skip, multi-file change; later goal, usage limit, fork, revert.
- **Live E2E (opt-in)** `test/e2e/provider/codex-live.test.ts` writes a trace plus an event dump artifact.
- **Visual.** Codex logo and cards in Storybook; `pnpm acceptance:visual` when composer surfaces change.

## Prefactors

- **P1 Exhaustive driver dispatch.** Each per-driver dispatch site becomes exhaustive over `KnownProviderDriverKind`
  (switch with a `never` check, or a full `Record`), so adding `"codex"` to the union makes the compiler list every
  site. `accountsStateFromInstances` currently turns any unknown driver into a Claude account; discovery and usage
  readers are `Partial` records; browser usage-harness literals are hand-copied. A single central module registry was
  considered and rejected: the sites need relay, daemon and RPC-layer dependencies, so one record would import across
  layers. Every competitor surveyed scatters registration (bb needs a literal ratchet script); conduit's closed union
  gets the guarantee from the compiler at each site instead.
- **P2 Runner driver kit.** Extract `makeRunnerDriverRuntime` from `cursor-provider-runtime.ts` (the
  `recoverCommands` boilerplate), make `snapshotCommandSettings` generic instead of returning Claude's
  `RunnerCommandSettings`, remove `driverKind ?? "claude"` defaults, and extract the atomic identity store from
  `cursor-session-recovery.ts`.
- **P3 Driver-neutral continuation** (before slice 3). `continuation.ts` and the native fork path gate on
  `supportsNativeResume && "folder" in account`, which means "is Claude". Replace with a driver-module
  `continuation` hook so Codex can resume at reset and switch accounts.

## Slices

1. **Core.** P1, P2, then: transport, client, protocol, mapper, lifecycle, interactions, session config, runner
   payload/launch/driver, discovery (models with efforts as variants and service tiers, `skills/list` as commands),
   existing `codex login` via `account/read`, approvals, blocking questions, steer, interrupt, transcript-digest
   fork, logo and labels.
2. **Async questions, `/goal`, `/compact`.** Async `agentMessage delivery: "async"` questions answered as a
   steered or queued user message, persisted, dismissible. Goals via `thread/goal/*` and `session.goal_changed`. The
   conduit turn stays open while the goal is active: close it on a goal state change or when no successor
   `turn/started` arrives within 30 s (state-driven, not t3code's fixed 5 s hold). `/compact` via
   `thread/compact/start`. MCP elicitation: consent forms as permission cards, others declined with a diagnostic.
3. **Usage.** P3, then a `codex` `UsageReader` (`account/rateLimits/read`, merge `account/rateLimits/updated`,
   main allowance separate from Spark), footer meter, `session.usage_limited` with `resetsAt`, resume at reset.
4. **Accounts.** Shadow `CODEX_HOME` per account: shared `sessions/`, `config.toml`, `skills/`, `AGENTS.md`;
   private `auth.json`, `models_cache.json`. Named accounts strip `OPENAI_API_KEY`, `CODEX_API_KEY`,
   `CODEX_ACCESS_TOKEN`. Managed sign-in through `account/login/start` (ChatGPT browser and device code). Shared
   sessions make cross-account continuation a plain `thread/resume`, so usage-limit account switching works.
5. **Fork, rollback, subagents, text generation.** Native fork via `thread/fork {lastTurnId}` seeded through
   `forkSource` in the identity file, digest fallback when the parent has no Codex thread. Rewind via
   `thread/revert {beforeTurnId}`, counting only turns with native refs. File changes remain in place;
   conduit has no checkpoint store. Native subagent threads as read-only child sessions. Text generation via
   `codex exec --ephemeral -s read-only --output-schema`, with each MCP server disabled individually (t3code `dc192851f0`).

## Prior art

- t3code `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts` (lifecycle, goals, Stop), `packages/effect-codex-app-server` (transport), replay testkit.
- monocode: mapper, Full Access via `on-request`, account env stripping.
- paseo: per-session process, mock Responses API tests, version gates.
- conduit Cursor: runner launch, identity store, trace player, digest fork.
