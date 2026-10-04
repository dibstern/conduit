# Claude process runners

The production server uses one independent process per Claude session. The
in-process session engine runs inside that child and remains available through
an explicit dependency for tests that inject a query factory.

Opening a session or focusing its composer pre-warms its runner. Both triggers
apply by default. A session that has never been pre-warmed still spawns its
runner on the first send. The recorded real-SDK timings were about 3.8 seconds
cold versus about 17 ms pre-warmed. Sending before warming finishes pays the
remaining initialization time. Failed warming or changes to launch options and
inherited settings can discard the warm SDK query. An exited runner also makes
the next send spawn a fresh process unless another open or focus hint warms it.

The project runtime directory is `<config>/r/<project-path-sha256-prefix>/`.
Each runner has a short Unix socket name, a matching `.json` registration with
its runner ID, session ID, build ID and PID, and a `.spool` file. The directory
is private and the socket and files are owner-only. Socket names stay outside
the project tree to fit the Unix socket path limit.

On relay startup, Conduit checks each registered PID for liveness and verifies
the runner's identity through its socket hello. Adoption never signals an
unverified PID. Invalid registrations and entries whose PID is
verifiably dead are removed without signalling their listed PID. A rejected
hello from a live or unverified PID preserves its files and retries with
100/200/400/800 ms backoff. Exhausting these retries fails startup before pending
approvals can be marked orphaned. An inaccessible PID is not proof of death.

Runners keep the warm SDK query, command-ID deduplication, and pending Session
Approval callbacks alive when their parent or server socket disappears. Each
outgoing output has a runner-local sequence. Unacknowledged outputs stay in
memory while connected; on disconnect they are written to the spool, and later
outputs append there. Reconnection replays from the server's durable cursor.
Acknowledgment removes the covered records from memory. The spool compacts when
at least half its bytes are acknowledged, using a temporary file and atomic
rename, and becomes empty after full acknowledgment. A transient ingestion
failure requests replay with backoff while keeping output waiters pending.
Operations that need a data reply wait for reconnection.
The idle status at the end of a turn and sink cleanup remain sequenced and
retained, but do not delay the next prompt while waiting for acknowledgment.
Turn completion is acknowledged after its event and cursor commit, allowing
the SDK to settle the turn while the server finishes ordered publication.
Explicit shutdown drains pending outputs for up to 500 ms before exiting.

The server remains the only SQLite writer. It appends translated events and
claims the sequence in `claude_runner_cursors` before appending, in the same
existing ingestion transaction. Already committed sequences succeed without
another append or publication. Each verified attachment claims a new identity in
the cursor's `attachment_id`; the transaction fences pending writes from an older
attachment. A crash after commit but before acknowledgment therefore cannot
duplicate an event on replay. Data replies are retained in `claude_runner_replies` so a lost
reply does not strand a history or subagent operation. These tables are created
when Claude runner persistence is initialized.

Full approval replies are saved in `claude_runner_permission_replies` in the
same transaction as the resolution event, preserving remembered permission
rules if the server crashes before delivering the answer to the runner.

Recovery restores output sinks and pending approval waiters before opening the
command gate. The server replays running outbox commands with their original
command IDs and attempt numbers. The surviving runner attaches them to the
existing execution or returns its cached result. Completion settles the outbox
and command receipt and applies provider-state updates without sending the
prompt again.
An intentional outbox retry advances the attempt number and can execute again.
Each attempt has its own output sink, so replayed cleanup from an older attempt
cannot remove the retry's sink, approval waiter or abort ownership.

## Stop and restart

- Each runner owns its lifetime. Its on-disk registration records its existence;
  the server only attaches. Closing a relay detaches started runners, including
  failed startup and invalidation. Children still starting before listening are
  stopped; the runner writes its registration before reporting listening.
- Unexpected attachment loss while the server is running fails the session's
  turns and stops that runner. This fault path does not retry the connection.
- `RestartWithConfig` preserves runners, turns and approvals during graceful
  server disposal. A fresh server rediscovers them. This matches the managed
  OpenCode policy: restart preserves, explicit stop kills.
- A server crash, including `SIGKILL`, preserves independent runner processes.
- `conduit serve` handles `SIGTERM` and `SIGINT` as restarts. They flush and
  dispose the server while preserving runners, the PTY host and managed OpenCode.
  Start another `conduit serve` to re-adopt them. A second `SIGINT` during
  shutdown exits immediately.
- `conduit stop`, `Shutdown` RPC and the foreground handle's `stop()` are full
  stops. After relays drain, they stop every registered runner for each project,
  including runners whose relay never started, and terminate the PTY host and
  managed OpenCode. Project removal disposes its relay, then stops that directory's
  registered runners. These explicit intents use the private registration as
  authority for bounded termination even if a suspended runner cannot answer
  its hello. Deleting a session also kills its runner.

A disconnected runner has no reattachment deadline. It waits for a server to
return until an explicit stop, project removal, session deletion, or idle exit.
When a terminated runner leaves an undelivered turn, the next relay startup
fails the running turn and outbox admission unless a live registration claims
that session. Undelivered output can be lost on full stop; the SDK transcript
retains the conversation history.

Attached and detached runners use the active config directory's
`autoSettleAfterDays` inactivity policy. In-flight turns, background work,
pending approvals, and unacknowledged outputs prevent idle exit until that work
settles or replays. Idle exit refuses new commands before acceptance, so a racing send retries
on a fresh runner. Pre-warm counts as activity without admitting a turn, including
after adoption, and becomes a no-op when racing exit or end-session.
Protocol mismatches still refuse adoption. A different build with the same
protocol is adopted and scheduled for upgrade after a turn ends. An adopted idle
runner upgrades without waiting for another prompt.

Project folder changes rebuild the relay. At send admission, the server compares
an existing runner's launch snapshot with the current main and extra folders.
An idle, quiescent runner with different folders drains through end-session;
the send starts a new runner with its last reported resume cursor. A busy runner
serves the current send and switches on a later send after it becomes idle.
Pre-warm skips an existing runner with different folders. An adopted runner
without a launch snapshot continues normally. Changing the main folder also
stops runners registered under the old folder, since their runtime directory
uses its hash.
File mentions, the file browser, terminal cwd and Conduit's Claude settings lookup
continue to use only the main folder.

## Runner upgrades

Upgrades reuse the ordinary spawn and pre-warm paths. The old runner keeps serving
while the replacement resolves its launch environment and initializes its SDK
query. A send during warming invalidates that attempt, uses the old query, and
schedules another attempt at the following turn end. Replacement warm failures
are logged without failing the user's turn; retries at later turn boundaries use
bounded backoff.

The runner reports quiescence only after its turns, background work, subagent
finalizers, approval waiters, and unacknowledged outputs settle. Before the server
swaps its session route, the old runner atomically verifies that state and its
activity revision. Retirement then uses the existing stop path. Shutdown notices from the retired
query cannot clear the replacement's state; sink-specific releases still reach
the server and dispose their retained sinks, abort fibers and history.

The original launch input, SDK query options and resolved file settings form
the session's in-memory Effective Settings Snapshot. Re-adoption recovers it
from the live runner, and replacement passes it unchanged. Mutable model,
effort and permission mode travel separately so replacement warming matches
the next send. The resume cursor comes from live context, including an
interrupted first turn. Snapshots are never written to registrations or the
event store.

SDK 0.3.280 exposes `resolveSettings`, but cannot replay individual trust tiers.
When files are unchanged, replacement retains native sources and merge rules.
Changed ordinary settings (the displayable settings, thinking summaries and
hooks) can be replayed with file sources disabled in a settings-only workspace.
Their object/array merging retains Conduit's original flag overrides. Managed,
unknown or trust-sensitive settings, once hooks, repositories/worktrees,
unreadable files, global configuration files, and filesystem customization or
instruction assets prevent this fallback. The old runner keeps serving and the upgrade is deferred; security
settings are never promoted to the flag tier or filesystem discovery silently
removed. This conservative limitation remains until the SDK supports replaying
the original source tiers.

Multi-folder sessions also defer upgrades when ordinary settings files change:
`claude-runner-settings.ts` refuses settings replay when `additionalDirectories`
is set. Folder changes use the send-time restart above, so they still take
effect on the next idle turn without replaying an old settings snapshot.

Registrations distinguish warming candidates and retiring runners. After a
server crash during replacement, recovery prefers the active runner and stops
abandoned candidates only after verifying their socket identity.

## Repeatable verification

```sh
export npm_config_verify_deps_before_run=false pnpm_config_verify_deps_before_run=false
pnpm build
CONDUIT_TEST_DIST=dist npx --no-install vitest run --config vitest.integration.config.ts \
  test/integration/daemon/claude-runner-upgrade.test.ts \
  test/integration/daemon/claude-runner-restart.test.ts \
  test/integration/daemon/claude-process-runner.test.ts \
  test/integration/daemon/process-harness.test.ts \
  test/integration/daemon/process-harness-build.test.ts
CONDUIT_PREWARM_E2E_DIST=dist npx --no-install vitest run --config vitest.integration.config.ts \
  test/integration/daemon/claude-prewarm.test.ts
pnpm bench:send-path --dist /tmp/85kb-15-baseline-dist --candidate dist \
  --output test-results/85kb-15-gate.json
```

Each benchmark build uses its default runner path. Preserve a pre-.15 build
before making changes to compare its in-process default with the current
process default. The synthetic first-send benchmark also takes a separate
baseline directory:

```sh
node --import tsx test/bench/claude-prewarm.ts \
  --baseline-dist /tmp/85kb-15-baseline-dist --dist dist \
  --output test-results/85kb-15-prewarm.json
```

The real-SDK smoke is opt-in and uses the user's existing Claude login with an
isolated server config and project. Its session query uses the real SDK, while
title generation and capability probing use fakes. It sends one small prompt,
verifies the turn ran in a separate runner PID, and writes spawn, first-event
and turn-end timings to `test-results/85kb-15-real-sdk.json`.

```sh
RUN_EXPENSIVE_E2E=1 npx --no-install vitest run --config vitest.e2e.config.ts \
  test/e2e/provider/claude-runner-real-sdk.test.ts
```

The restart harness uses an isolated HOME, config and project with the fake SDK.
It compares complete persisted turns with uninterrupted execution, deliberately
loses an acknowledgment after a durable delta, answers an approval raised before
restart, verifies one SDK prompt delivery, and checks spool truncation. Evidence
is written to `test-results/85kb-9-*.json`.
Approval scenarios also cover graceful restart, an ask not yet committed, and
an already committed "Always Allow" answer not yet delivered to the runner.
It also verifies recovery after more than 60 seconds disconnected. Teardown
shuts down surviving registered runners after verifying socket identity and
kills any tracked test runner PIDs still alive. It asserts every spawned runner
PID has exited, then removes the isolated config. `85kb-9-cleanup.json` records
the assertion for each test config directory.
Focused adoption, connection and spool regression tests are in
`test/unit/provider/claude/claude-runner-*.test.ts`; their before-and-after results
and compaction measurements are recorded under `test-results/85kb-9-*.json`.
