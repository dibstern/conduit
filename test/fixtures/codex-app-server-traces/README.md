# Codex app-server traces

These JSONL traces exercise the standalone app-server module with a real Codex
CLI and a local mock OpenAI Responses API. The recorder uses a throwaway
`CODEX_HOME`, workspace and home directory, an allowlist of child environment
variables, and no API credentials. Only `127.0.0.1` receives model requests.
The trace header records the CLI version used for each capture.

Each file begins with `{scenario, codexVersion, recordedAt}`. Message rows are
`{dir, at, message}`, with `out` for client-to-server messages and `in` for
server-to-client messages. `at` is milliseconds since capture began. An
optional final `{dir: "exit", at, code, signal}` records child termination.
Messages retain the JSON-RPC wire envelopes, request IDs and ordering.

The recorder replaces its throwaway Codex home with `/codex-home`, its workspace
with `/workspace`, other temporary paths with `/trace-root`, and the user's home
with `/home/test`. It refuses to write any fixture containing credential-like
strings, including API key prefixes, JWT prefixes, bearer tokens or token field
names. Capture and fixture files use mode 0600.

## Scenarios

- `usage-read.jsonl` derives the handshake from `basic`, then supplies
  schema-defined `account/read` and `account/rateLimits/read` responses from
  CLI 0.162.1. `rateLimits` mirrors the main bucket in `rateLimitsByLimitId`;
  the second bucket has the backend label `Spark`. Bucket IDs are opaque sample
  values, not a claim about a fixed production Spark ID. Both primary and
  secondary windows carry independent Unix-second resets.
- `usage-updated.jsonl` derives from `basic` and inserts a sparse Spark
  `account/rateLimits/updated` notification mid-turn. Its null name/reset must
  preserve the previous reading and the main allowance. The timestamp gate
  holds completion back while the daemon test checks `SubscribeUsage` without
  another read.
- `usage-limit.jsonl` and `usage-limit-429.jsonl` derive from `basic`, insert a
  main-allowance update with a reset, and end with schema-defined
  `usageLimitExceeded` and `responseTooManyFailedAttempts.httpStatusCode: 429`
  errors respectively. These are derived payloads, not live quota exhaustion.
- `usage-resume.jsonl` derives from the recorded `resume-after-crash` trace.
  The daemon test substitutes the limited thread ID and a near-future reset,
  then proves one `thread/resume`, no replacement thread, and the shared
  `session.resume_scheduled` / `session.resumed` path. Cross-account Codex
  continuation remains disabled. Evidence is under `test-results/codex-usage/`.
- The recorded `turn-command.jsonl` has two model responses with cumulative
  totals 32 and 64. Replay and daemon tests assert 38 input and 26 output tokens
  for the turn, with 19 context tokens from `last`. The daemon test duplicates
  a cumulative update to verify idempotent accounting.

- `compact-manual.jsonl` records real CLI 0.162.1 `thread/compact/start`
  against the local mock Responses API. Its empty acknowledgement precedes
  `turn/started`, a `contextCompaction` item start/completion and one turn end.
  `compact-auto.jsonl` records a real inline compaction inside an ordinary
  turn: the first mock response calls `update_plan` and reports 150,013 tokens
  against a 100,000-token threshold; the next two responses provide a compact
  summary and the final answer. It adds only the deprecated schema-defined
  `thread/compacted` notification after item completion. Replay requires one
  boundary, ignoring that notification. `compact-failed.jsonl` records a real
  HTTP 400 during native compaction with `Fixture compaction failed` in the
  response body. It emits item start, error and a failed turn, without item
  completion. Compaction items have no status/error fields.
- `elicitation-consent.jsonl`, `elicitation-form.jsonl`,
  `elicitation-url-declined.jsonl` and `elicitation-interrupt.jsonl` derive from
  `basic` with `mcpServer/elicitation/request` payloads copied from the generated
  CLI 0.162.1 schema. No real MCP server runs. Consent has an empty form;
  the form covers string, titled/legacy enum, boolean, number, integer and
  titled multi-select fields. Replies use `action` and typed `content`.
  URL mode declines, and interrupt sends `cancel` after `turn/interrupt`.
  Each request has a matching `serverRequest/resolved`. Daemon tests also
  exercise rejection, invalid/missing answers, other allowed modes, plain
  enums, nullable correlation and resolution elsewhere. Evidence lives under
  `test-results/codex-turn/` and `test-results/codex-interactions/`.
  Unsupported string formats, empty enums and ambiguous multi-select labels
  decline with a diagnostic before asking for data.

- `goal-chain.jsonl` records one `turn/start` followed by three native turns
  on the same thread. The per-scenario mock response sequence calls the real
  `update_goal` tool with `complete` after the third streamed greeting. Goals
  start paused, and activate after `turn/start` accepts, so they cannot start
  work before the runner owns it. CLI 0.162.1 emits `thread/goal/updated`
  accounting facts before each turn end and a final `complete` fact.
- `goal-paused.jsonl` and `goal-cleared.jsonl` record user-origin
  `thread/goal/set` and `thread/goal/clear` during a native turn, including the
  native notifications. `goal-stop.jsonl` records pausing during the second
  native turn, then `turn/interrupt` targeting that successor. Conduit reports
  `pausedReason: "Interrupted"` for Stop, matching Claude.
- `goal-successor-timeout.jsonl` derives from `goal-chain` by ending after the
  first native `turn/completed`. Replay advances the lifecycle's clock to
  assert it stays open at 29,999 ms and closes at 30,000 ms. The daemon test
  exercises the real 30-second wait. Other goal traces are real captures.
  Replay asserts one conduit terminal per goal run; daemon tests also assert
  durable goal facts and goal details. Repeatable evidence is saved under
  `test-results/codex-goals/`, including wire captures, persisted events,
  fully consumed trace reports, and runner cleanup results.
- `steer.jsonl` records a second send during a slowly streamed real turn.
  `turn/steer` uses the executing ID and a `clientUserMessageId`; both item
  notifications echo that ID as `userMessage.clientId`. Only that echo
  acknowledges delivery. The steered input appears once on the original turn.
- `steer-race.jsonl` records completion followed by a rejected `turn/steer`
  (`-32600`, `no active turn to steer`) and a new turn carrying the same input.
  Daemon tests move completion behind the outgoing steer to exercise the
  in-flight completion race, without changing its captured wire payloads.
- `steer-mismatch.jsonl` records a steer with a stale expected turn ID while
  the first response is still streaming, followed by one new turn with the
  rejected input. Daemon tests cover rejection before completion as well as
  completion before the rejection is handled.
- `stop-queued.jsonl` derives from `basic`: its real `turn/start` response has
  `startedAt: null`. It inserts the schema-defined `turn/interrupt` request
  after `turn/started`, and changes the terminal status to `interrupted`.
- `stop-startup.jsonl` stops the basic trace at the unanswered `thread/start`
  request. Cancelling this stalled initialization must close the child and
  settle interrupted without ever sending `turn/start`.
- `resume-after-crash.jsonl` records `thread/resume` and a turn in a fresh
  app-server child after a previous child created and used the thread. The
  daemon tests also kill a runner and restart the daemon before replaying it.
- `resume-unarchive.jsonl` records resuming a real archived rollout: `-32600`
  with `session … is archived`, one `thread/unarchive`, then successful resume
  and a turn. `resume-missing.jsonl` records a nonexistent UUID: resume fails,
  unarchive returns `no archived rollout found`, and the sole resume retry
  returns `no rollout found`. The runner must preserve the native identity and
  report `codex_thread_missing`.
- `error-usage_limited-429.jsonl`, `error-provider_unavailable.jsonl`, and
  `error-provider_error.jsonl` record real HTTP 429, 503 and 400 mock responses.
  They produce `responseTooManyFailedAttempts.httpStatusCode: 429`,
  `httpConnectionFailed.httpStatusCode: 503`, and `other`, respectively.
- `error-auth_required.jsonl`, `error-usage_limited.jsonl`,
  `error-context_overflow.jsonl`, and
  `error-provider_unavailable-disconnected.jsonl` derive from `basic`, using
  CLI 0.162.1 schema payloads `unauthorized`, `usageLimitExceeded`,
  `contextWindowExceeded`, and
  `{responseStreamDisconnected: {httpStatusCode: null}}`. The mock custom
  provider reports a 401 as `httpConnectionFailed` and a context-length HTTP
  400 as `other`; it cannot directly provoke those account/model variants.
  Replay asserts each mapped error code and retryable flag through the turn
  lifecycle, and daemon tests pin the persisted terminal events.
  Control test artifacts are written under `test-results/codex-control/`,
  including captures, full-consumption reports, persisted events and process
  cleanup evidence.
- `basic.jsonl` captures `initialize`, `initialized`, `thread/start` and
  `turn/start` with `Say hello`. The mock emits a reasoning output item, a
  reasoning summary and streamed `Hello from the mock model.` text, followed by
  a completed turn and non-zero token usage.
- `model-list.jsonl` captures initialization, `account/read` and `model/list` with
  `includeHidden: true`, followed by `skills/list` with `cwds: ["/workspace"]`.
  A page size of two exercises cursor pagination. Its workspace has no repo
  skills; the response still includes the CLI's bundled system skills.
- `skills-list.jsonl` records the same discovery requests after creating
  `/workspace/.agents/skills/fixture-skill/SKILL.md` in the throwaway workspace.
  The real response includes the enabled `fixture-skill` descriptor with scope
  `repo`, description `Answer fixture greetings directly.` and its absolute
  `SKILL.md` path. Replay checks the request root and descriptor against the
  generated CLI 0.162.1 `SkillsListResponse` schema.
- `turn-skill.jsonl` records `/fixture-skill Say hello` as unchanged text plus
  `{type: "skill", name: "fixture-skill", path:
  "/workspace/.agents/skills/fixture-skill/SKILL.md"}` in `turn/start.input`.
  The skill exists in the throwaway workspace during recording. The real
  app-server processes it and completes through the mock Responses API.
- `fork-seed.jsonl` records two real turns on one fresh thread. The first input
  contains a separate text item with a Conduit transcript digest, then
  `Say hello`. The second input contains only `Say hello again`. Replay checks
  the exact digest and that it appears only on the first turn. Daemon tests
  replace the fixture digest with the fork's actual inherited transcript.
- `fork-native.jsonl` and `fork-in-progress.jsonl` record two parent turns,
  `thread/fork` through the first turn's `lastTurnId`, and a turn on the new
  thread. The latter forks while the second parent response is streaming.
  The mock inspects the fork's Responses request to prove the first prompt is
  present and the second is absent. Both use real CLI 0.162.1 captures.
- `fork-of-fork.jsonl` records a turn on A, forks A into B, runs a turn on B,
  then forks B using the turn ID inherited from A. CLI 0.162.1 accepts that
  inherited ID. The mock verifies that C retains A's prompt and excludes B's
  later prompt. The daemon test repeats the fork through inherited messages.
- `fork-native-missing-source.jsonl` records real errors for a nonexistent
  source thread and a missing source turn, then `thread/start` and a turn with a bounded
  transcript digest. The mock verifies that only the selected first turn is
  seeded. Daemon tests substitute the fork's original source ID to model a
  deleted rollout or turn and derive an unrelated storage-error response,
  and check that only missing sources use the digest, once. The fallback
  persists `continuationKind: "transcript-digest"` through the normal handoff.
  Shared and unshared account-home moves preserve the pending fork's frozen digest.
- `rewind-revert.jsonl` and `rewind-start-over.jsonl` record three turns,
  `thread/revert` before the second or first native turn, `thread/reverted`,
  and a new turn on the same thread. `rewind-revert-failed.jsonl` records a real
  missing-turn RPC error and no subsequent `turn/start`. Daemon tests reuse
  that error with a known turn boundary to exercise a failed persisted revert.
  All five scenarios use the recorder's per-scenario mock response sequence.
  The rewind mock also verifies that discarded prompts are absent from the
  next Responses request and that start-over retains none of the old prompts.
  Revert changes conversation history only, without restoring local files.
  Repeatable daemon evidence, wire captures and full-consumption reports live
  under `test-results/codex-fork/`.
- `two-turns.jsonl` captures one initialization and `thread/start`, followed by
  `Say hello` and `Say hello again` turns on the same thread and live child.
  Both receive the mock text, reasoning summary and usage. It was recorded
  through Codex CLI 0.162.1 against the mock Responses API, not spliced from
  independent captures.
- `turn-decode-failure.jsonl` derives from `basic.jsonl` by changing the first
  `item/agentMessage/delta` payload's `delta` to the number `7`. Replay requires
  that notification to decode as malformed while later notifications complete.
- `turn-unknown-item.jsonl` derives from `basic.jsonl` by changing the first
  item's `type` to `futureItem` in its `item/started` and `item/completed` rows.
  Replay requires the generic item representation to retain `raw`.
- `turn-raw-reasoning.jsonl` derives from `basic.jsonl` by changing reasoning
  summary deltas to `item/reasoning/textDelta` with `contentIndex`, dropping
  summary-part notifications, and moving reasoning item summaries into
  `content`. Replay requires known raw reasoning deltas, no malformed
  notifications, and the same agent text.
- `turn-command.jsonl` records an `exec_command` function call that prints three
  lines, with sleeps between them, and exits with code `7`. The real app-server
  emits two `item/commandExecution/outputDelta` notifications and a completed
  `commandExecution` item with status `failed`, all three lines and exit code `7`.
  The next mock response supplies the final assistant message after receiving
  the command's output.
- `turn-file-change.jsonl` records one freeform `apply_patch` call that creates
  `alpha.txt` and `beta.txt`. Its `fileChange` item contains both paths and their
  diffs. The recorder also checks both files' contents before removing its
  throwaway workspace, and the next mock response supplies the final message.
  This capture uses `gpt-5.5`, whose bundled CLI model definition enables the
  freeform patch tool. The other captures use `gpt-5.4`; CLI 0.162.1 treats that
  older name as a fallback model and does not expose `apply_patch` for it.
- `turn-plan.jsonl` records an `update_plan` function call with three steps in
  `completed`, `in_progress` and `pending` states, followed by the final message.
  The app-server's `turn/plan/updated` notification uses `inProgress` on the wire.
  The recorder enables `[tools.update_plan]` in its throwaway Codex config.
- `approval-command-once.jsonl`, `approval-command-always.jsonl` and
  `approval-command-reject.jsonl` record command approvals in ask mode. The
  recorder answers with `accept`, `acceptForSession` when offered, or `decline`,
  and checks the matching `serverRequest/resolved` and final assistant message.
  CLI 0.162.1 offers an exec-policy amendment instead of `acceptForSession` for
  this command, so the recorded always decision falls back to `accept`. Daemon
  tests derive the offered-session branch from this real approval envelope.
- `approval-file-once.jsonl` and `approval-file-reject.jsonl` record an ask-mode
  `apply_patch` approval for `alpha.txt` and `beta.txt`, followed by `accept` or
  `decline`. The earlier `fileChange` item retains both paths. The accepted
  operation reports `failed` inside the recorder's nested macOS sandbox; the
  rejected operation reports `declined`. Both turns continue to the final
  assistant message. The unrestricted `turn-file-change` capture separately
  verifies actual writes and both files' contents.
- `approval-permissions.jsonl` derives from `basic.jsonl` by inserting a
  schema-shaped `item/permissions/requestApproval`, granting the requested
  network and two-file write permissions for the turn, and resolving the
  request. The local mock does not reliably expose this experimental tool.
- `question-blocking.jsonl` derives from a real plan-mode capture by inserting
  `item/tool/requestUserInput`. Its `plan` question has `Fast` and `Safe`
  options with `isOther: true`; its `secret` question has `isSecret: true`.
  The response is `{answers: {plan: {answers: ["Safe"]}, secret: {answers:
  ["fixture-secret"]}}}`. Both request and response follow the generated
  experimental CLI schema; the fixture secret is synthetic.
- `async-question.jsonl` derives from a real basic turn by attaching schema-shaped
  `delivery: "async"` and two `AsyncUserInputQuestion` values to its completed
  `agentMessage`, one with options and one with `options: null`. The turn then
  completes without a native reply request. The local Responses mock does not
  expose async delivery metadata; these payloads follow the generated CLI
  0.162.1 `AgentMessageThreadItem` and `AsyncUserInputQuestion` schemas.
- `async-question-answer.jsonl` derives from a real steer capture by inserting
  that async message before `turn/steer`. The answer is ordinary text, one
  title and answer per block with a blank line between questions. The first
  answer contains two choices joined with `, `.
- `async-question-idle-answer.jsonl` derives from a real two-turn capture. The
  first turn asks the async questions and completes; its answer arrives through
  the second `turn/start`. Neither answer trace uses a server-request response.
- `mode-accept-edits.jsonl`, `mode-auto.jsonl` and `mode-plan.jsonl` record
  completed turns with their mapped policies. `mode-full.jsonl` records a real
  full-mode turn and command with `sandbox_permissions: "require_escalated"`.
  CLI 0.162.1 executes that command without emitting an approval request under
  `dangerFullAccess`, so the recorder inserts the real ask-mode command
  approval envelope with the full turn's thread, turn and item identifiers.
  Its `accept` response verifies runner auto-approval without a browser prompt.
  Every turn capture sends and checks `approvalPolicy`, `sandboxPolicy`,
  `approvalsReviewer` and `collaborationMode`, including default collaboration
  settings so leaving plan mode clears its sticky state. Workspace-write roots
  contain `/workspace`; the auto reviewer is `auto_review`.
- `turn-mcp-tool.jsonl` derives from a fresh basic capture by replacing the
  user item's start and completion with a schema-shaped `mcpToolCall` for
  `fixture.lookup`, arguments `{query: "fixture lookup"}` and a text result.
- `turn-web-search.jsonl` derives from the same fresh basic capture by replacing
  the user item's start and completion with a schema-shaped `webSearch` for
  `conduit tool cards`.
- `turn-image-view.jsonl` derives from a fresh basic capture by replacing the
  user item's start and completion with an `imageView` for
  `/workspace/chart.png`.
- `turn-collab-tool.jsonl` derives from the same fresh basic capture by replacing
  the user item's start and completion with a `collabAgentToolCall` for
  `spawnAgent`, prompt `Inspect the patch`, the recorded sender thread and a
  synthetic receiver thread's agent state. All fields in these four derived
  item payloads come from the generated v2 `ThreadItem` schema. No MCP server,
  web request, image read or child agent runs while deriving them.
- `subagent-spawn.jsonl`, `subagent-wait.jsonl`, `subagent-approval.jsonl` and
  `subagent-stop.jsonl` derive from `basic.jsonl`. Their child lifecycle fields
  copy CLI 0.162.1's generated `ThreadItem`, `CollabAgentTool`, `CollabAgentState`,
  `CollabAgentStatus`, `SessionSource`, `SubAgentSource`, and notification schemas.
  A real app-server probe against the local Responses mock confirmed that the
  CLI defers multi-agent tools behind `tool_search`; the existing mock cannot
  discover those tools. These are protocol fixtures, not recorded child runs.
  Only a temporary `CODEX_HOME` was used for that probe.
  Each fixture has one `fixture-subagent` native child with `source.subAgent`
  `thread_spawn` metadata linking its parent. Child `thread/started` and
  `turn/started` arrive before the parent's spawn item completes. Child user,
  reasoning, command and assistant items retain the child's own `threadId` and
  `turnId` on the shared transport. The child finishes before its parent.
  `subAgentActivity` items also link the native child from the parent turn.
  The wait fixture starts a wait while the child runs, then sends `sendInput`
  and `closeAgent` updates for that same receiver. The approval fixture places
  `item/commandExecution/requestApproval` on the child and requires the matching
  `accept` response and child `serverRequest/resolved`. The stop fixture requires
  parent `turn/interrupt` followed by child `turn/interrupt`, then interrupted
  completion for both turns. Child command completion and later rows begin at
  logical timestamp `10000`, allowing daemon tests to inspect a running child.
  Replay asserts these relationships and requires every row consumed with zero
  mismatches. No child agent runs during derivation.
- `version-unsupported.jsonl` derives from `basic.jsonl` by changing the
  initialize response's `userAgent` version to `0.150.0`. It ends at that
  response because connecting rejects the version before `initialized` or
  further requests can be sent.

Derived traces retain the source's timestamps, IDs, version header and other
wire values. They are deliberate protocol mutations, not live observations of
a broken server. Regeneration applies the same mutations each time.

The older `turn-command` and `turn-file-change` scenarios now explicitly select
conduit's full mode. This lets their subprocess run inside an already sandboxed
recorder without nesting macOS `sandbox-exec`, which otherwise fails before
command execution. The approval scenarios explicitly select ask mode. Only the
throwaway `CODEX_HOME` changes; user Codex configuration is untouched.

## Recording and replay

Account captures for slice `q4sw.10` use a separate, empty temporary home.
`login-cancel.jsonl` records real `account/read`, browser
`account/login/start` and `account/login/cancel` requests and responses from
CLI 0.162.1. `logout.jsonl` records real `account/logout`, `account/updated`
and a signed-out `account/read`. OAuth URL state and PKCE query values are
replaced with a fixture URL before writing either capture.

`login-browser.jsonl` retains the recorded browser start envelope, then derives
a successful `account/login/completed`, `account/updated` and signed-in
`account/read`. `login-device-code.jsonl` derives the device-code start request
and response from that envelope, using `type: "chatgptDeviceCode"`, `loginId`,
`userCode` and `verificationUrl`. The completion and account fields are copied
from the generated CLI 0.162.1 schemas. The synthetic code is `ABCD-EFGH`.
Completing OAuth requires real credentials, so these success rows are declared
protocol fixtures rather than live authentication captures. No real credential
file is opened, printed or copied.

`account-switch-resume.jsonl` is a real capture. The recorder creates a native
thread in one temporary home, starts a second app-server with another home
whose `sessions/` and `config.toml` symlink to the first, then sends
`thread/resume` for the existing native ID and completes a turn. Both homes
have private authentication paths. Replay asserts one resume of that ID and
no `thread/start` in the second child.

Refresh and replay the account captures with:

```sh
pnpm codex:record-traces --scenario=login-device-code --scenario=login-browser --scenario=login-cancel --scenario=logout --scenario=account-switch-resume
pnpm codex:replay-traces --scenario=login-device-code --scenario=login-browser --scenario=login-cancel --scenario=logout --scenario=account-switch-resume
```

`test/integration/daemon/codex-accounts.test.ts` uses these captures through the
built daemon, RPC, detached runner and event store. Its temporary trace map
selects each home and operation independently. The transport report stores
only environment variable names so the tests can verify named accounts receive
no inherited OpenAI keys. Every child must consume its full trace with zero
mismatches. Repeatable evidence, captures and cleanup results are saved under
`test-results/codex-accounts/`.

Run from the repository root with Codex CLI 0.162.1 available on PATH, or set
`CONDUIT_CODEX_BINARY` to the desired binary:

```sh
pnpm codex:record-traces
pnpm codex:replay-traces
pnpm codex:schema-drift
```

The direct recorder command is
`pnpm exec tsx scripts/record-codex-app-server-trace.ts`; add `--replay` to replay.
To refresh selected captures without changing the others, repeat `--scenario`:

```sh
pnpm exec tsx scripts/record-codex-app-server-trace.ts --scenario=model-list --scenario=two-turns
```

Refresh skills and digest captures together with discovery:

```sh
pnpm codex:record-traces --scenario=model-list --scenario=skills-list --scenario=turn-skill --scenario=fork-seed
```

The tool fixtures can also be refreshed selectively:

```sh
pnpm codex:record-traces --scenario=turn-command --scenario=turn-file-change --scenario=turn-plan --scenario=turn-mcp-tool --scenario=turn-web-search
pnpm codex:record-traces --scenario=turn-image-view --scenario=turn-collab-tool
```

Regenerate or replay the subagent protocol fixtures with:

```sh
pnpm codex:record-traces --scenario=subagent-spawn --scenario=subagent-wait --scenario=subagent-approval --scenario=subagent-stop
pnpm codex:replay-traces --scenario=subagent-spawn --scenario=subagent-wait --scenario=subagent-approval --scenario=subagent-stop
```

`--replay` also supports `--scenario`. Each live scenario gets its own response
sequence, with one response consumed per model request. Tool scenarios require
the second request to contain the tool's output before the mock sends its final
answer; unexpected additional requests fail the recording.

Recording needs permission to spawn `codex app-server` and bind a loopback
listener. Replay needs neither the CLI nor a listener and makes no model calls.

The player and child share `AppServerTransport`.
`CONDUIT_CODEX_APP_SERVER_TRACE=<file.jsonl>` selects the player, and
`CONDUIT_CODEX_APP_SERVER_CAPTURE=<file.jsonl>` tees either transport. On close,
`CONDUIT_CODEX_APP_SERVER_TRACE_REPORT=<file.jsonl>` appends a consumption report.
The replay command drives every scenario through `connectAppServer`, compares
the decoded notification sequence against its trace, and requires all rows
consumed with zero mismatches. Malformed notifications compare their formatted
schema issue too. The player remaps recorded JSON-RPC request IDs and
`clientUserMessageId` echoes so `userMessage.clientId` confirms the live input.
Reports live in an isolated temporary directory and are
removed after verification.

`test/integration/daemon/codex-turn.test.ts` also replays these captures through
the daemon, detached runner and SQLite event store. Its temporary discovery
trace changes only the recorded `account/read` result from `account: null` to a
signed-in ChatGPT account with a test email and Plus plan. The recorder's
throwaway home has no login, so this deliberate mutation exercises default
account auto-add without using credentials. Every transport must consume its
whole trace with zero mismatches. Artifacts are written to
`test-results/codex-turn/`.

`test/integration/daemon/codex-skills-fork.test.ts` uses the skills and digest
captures to check workspace command discovery, known and unknown slash input,
and digest forks into and out of Codex, including restart before the first
seeded turn. Each replay must consume all rows with zero mismatches.
Cross-provider cases pass the destination account as `ForkSession.instanceId`
and use saved model defaults for the destination harness. The restart case
reconstructs a pending identity from a recorded thread, kills its owned runner
before any turn, then verifies the replacement runner resumes and seeds once.

The daemon tests also make temporary protocol mutations for authoritative text
correction and missing suffixes, unfinished item settlement, failed turns, and
child exit. The exit case truncates the first turn after a text delta, adds an
unsuccessful exit, then replays the recorded second turn after changing the
captured thread creation request to `thread/resume`. This verifies conduit
resumes its stored thread after a dead child; it is not a recorded server crash.

For one real turn using the default Codex login, opt in explicitly:

```sh
CONDUIT_CODEX_LIVE=1 pnpm exec vitest run --config vitest.e2e.config.ts test/e2e/provider/codex-live.test.ts
```

The smoke captures the app-server wire messages and dumps the session's stored
events under `test-results/codex-live/`. `CONDUIT_CODEX_LIVE_MODEL` selects a
different available model. Neither replay nor recording uses the live smoke.
