# Claude process runners

`CONDUIT_CLAUDE_RUNNER=process` enables one independent process per Claude
session. The default in-process path retains its existing lifecycle.

The project runtime directory is `<config>/r/<project-path-sha256-prefix>/`.
Each runner has a short Unix socket name, a matching `.json` registration with
its runner ID, session ID, build ID and PID, and a `.spool` file. The directory
is private and the socket and files are owner-only. Socket names stay outside
the project tree to fit the Unix socket path limit.

On relay startup, Conduit checks each registered PID for liveness and verifies
the runner's identity through its socket hello. A registration alone never
authorizes signalling a PID. Invalid registrations and entries whose PID is
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
only by the enabled process-runner path.

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

- `RestartWithConfig` preserves runners, turns and approvals during graceful
  server disposal. A fresh server rediscovers them. This matches the managed
  OpenCode policy: restart preserves, explicit stop kills.
- A server crash, including `SIGKILL`, preserves independent runner processes.
- `Shutdown`, ordinary foreground `stop()`, `SIGTERM` and `SIGINT` are explicit
  stops. They interrupt turns, settle approvals and terminate verified runners
  within the existing shutdown deadline. Deleting a session also kills its runner.
- An external restart controller that wants graceful preservation must use
  `RestartWithConfig` before starting the replacement server.

A disconnected runner waits up to 60 seconds for a verified server handshake
and replay attachment. Set `CONDUIT_CLAUDE_RUNNER_REATTACH_GRACE_MS` to a positive
integer to choose a different grace period. Rejected connections do not extend
the deadline. If the server never reattaches, the runner closes its SDK session
and removes its registration, socket and spool; shutdown has a two-second
fallback deadline. A reattached runner has no disconnected deadline.

Connected idle exit, crash-mid-turn failure reporting, protocol-mismatch UX and pre-warm
remain separate tickets. Runners with a mismatched build or protocol are not
adopted by this recovery path.

## Repeatable verification

```sh
export npm_config_verify_deps_before_run=false pnpm_config_verify_deps_before_run=false
pnpm build
CONDUIT_TEST_DIST=dist npx --no-install vitest run --config vitest.integration.config.ts \
  test/integration/daemon/claude-runner-restart.test.ts \
  test/integration/daemon/claude-process-runner.test.ts
pnpm bench:send-path --dist dist --candidate dist --candidate-runner process \
  --output test-results/85kb-9-gate2.json
```

The restart harness uses an isolated HOME, config and project with the fake SDK.
It compares complete persisted turns with uninterrupted execution, deliberately
loses an acknowledgment after a durable delta, answers an approval raised before
restart, verifies one SDK prompt delivery, and checks spool truncation. Evidence
is written to `test-results/85kb-9-*.json`.
Approval scenarios also cover graceful restart, an ask not yet committed, and
an already committed "Always Allow" answer not yet delivered to the runner.
It also verifies orphan grace expiry. Teardown shuts down surviving registered
runners only after verifying socket identity, asserts every spawned runner PID
has exited, and then removes the isolated config. `85kb-9-cleanup.json` records
the assertion for each test config directory.
Focused adoption, connection and spool regression tests are in
`test/unit/provider/claude/claude-runner-*.test.ts`; their before-and-after results
and compaction measurements are recorded under `test-results/85kb-9-*.json`.
