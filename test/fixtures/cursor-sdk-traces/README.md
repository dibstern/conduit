# Cursor SDK traces

These 41 JSONL captures came from the Cursor SDK 1.0.37 local-mode spike in
`cursor-spike/fixtures`. They contain 8,000 rows,
including headers. The source findings and artifact index describe each capture.
`sandbox-anchored.jsonl` and `sandbox-anchored-escape.jsonl` are the two successful
helper-layout probes documented in the findings addendum.

Excluded captures:

- `subagent-background-default.jsonl`: a child selected composer-2.5-fast.
- `subagent-foreground-inherit.jsonl`: a child selected composer-2.5-fast.
- `subagent-background-inherit.jsonl`: interrupted before a Task result.
- `subagent-foreground-default.jsonl`: interrupted exploratory attempt.

`crashed-run.jsonl` is an intentional killed-controller recovery probe, with no
invented wait result. Failed preflights and unavailable-tool probes remain useful
wire evidence. The copies retain the source JSONL envelopes and redaction
markers. Private home paths and encoded home slugs were replaced with
`/home/test` and `home-test`; no fields, rows or values of other types changed.
Every copied file was parsed and scanned for key-like strings and unredacted
credential fields. The scan found zero matches and zero invalid headers.
Repeat the scan with `mise exec -- node scripts/check-cursor-sdk-traces.mjs`.
It writes counts and file names to
`test-results/xqsg-22-cursor-trace-audit.json`, without reading an API key.

Each file starts with `{scenario, model, sdkVersion, recordedAt}`. Subsequent rows
are `{kind, at, data}`. `delta`, `stream`, `wait.result`, `create.options`,
`resume.options` and `send.options` preserve the captured envelopes. Private
string contents may be redacted, as required by ADR-0002.

The discovery port's real adapter and trace player share `CursorSdkPort`.
`CONDUIT_CURSOR_SDK_TRACE=<file.jsonl>` selects playback without reading a real
API key. It accepts the spike's `models.list` shape `{count, models}` and the
tee's direct model array. Discovery fixtures can also provide `runtime.probe`
and `credential.store` rows. A null credential row means no credential. A
credential row uses `[REDACTED]`, never a working key. A `<method>.error` row
replays a failure. Each method consumes its matching rows in order, then repeats
the final result for later discovery refreshes.
Replacing a trace file resets its method cursors so process-seam tests can
exercise availability changes without restarting the daemon.

`CONDUIT_CURSOR_SDK_CAPTURE=<file.jsonl>` tees calls and results to an explicit
path. Capture failures do not change the call's outcome. New files use mode 0600.
Credential field names and known secret contents are redacted before writing.
The turn port also replays store open/dispose, sandbox priming, agent
create/resume/close, send, stream, wait and cancel. Sends consume captured turns
in order and repeat the final captured turn for subsequent sends. A captured
cancelled wait stays pending until the caller cancels the run. Delta callbacks
and the stream are replayed as separate SDK channels; terminal truth comes
from the captured wait result.

## Turn replay cases (conduit-test-xqsg.5)

The following are derived fixtures, not new live captures. Each retains its
source's SDK version, model, timestamps, IDs and wire envelopes; only the
scenario header and the edits listed here differ.

- `turn-decode-failure.jsonl`: `basic.jsonl`, with the first
  `thinking-delta.text` changed from a string to the number `7`. The malformed
  known field tests skipping and reporting a decode failure while later text
  and the captured wait result still complete the turn.
- `turn-no-terminal.jsonl`: `basic.jsonl`, with its sole `wait.result` row
  removed. Its completed delta and stream hints remain, so they cannot mask a
  missing authoritative wait result.
- `turn-unknown-tool.jsonl`: `tools-project.jsonl`, with the first shell call's
  `toolCall.type` changed to `future-tool` in the started and completed deltas.
  The call ID, arguments, result and all other calls remain captured values.

`cursor-turn.test.ts` also produces reproducible temporary derivatives of these
captures. It adds the SDK credential-store operation's redacted result (the
same shape used by discovery replay). Captures without a `models.list` row
also receive the unchanged catalog row from `basic.jsonl`, so the real daemon
can validate the selected model. The missing-auth case changes only that
result to null after session creation; the credential-rotation case changes
only its key redaction marker from `[REDACTED]` to `[REDACTED:rotated]` after
the first turn. These markers are inert replay identities, never API keys.
The temporary paths are under the process harness's isolated root, and are
removed with the harness. All transcript and delta fields still come from the
named source capture. Repeated basic turns reuse its final captured run.
The process suite writes scenario counts, stored turn states, lifecycle calls
and cleanup invariants to `test-results/conduit-test-xqsg.5.json`.

The sandbox-failure process case temporarily copies the first `sandbox.error`
row from `sandbox-unprimed.jsonl` into basic replay and changes only its method
wrapper kind to `sandbox.prime.error`. The captured error data is unchanged.
Removing that row restores successful playback, allowing the case to prove a
failed sandbox check terminates its runner and the retry uses a fresh runner.

The queued-turn regression uses the unchanged `workspace-resume.jsonl`
conversation. With `NODE_ENV=test`, `CONDUIT_TEST_CURSOR_CLOSE_DELAY_MS` and
`CONDUIT_TEST_CURSOR_DISPOSE_DELAY_MS` delay playback cleanup. They change
scheduling only, without adding or modifying SDK wire fields. The test submits
its second input after the tee's `close.call` marker and before agent disposal,
then verifies both turns and the remembered code word reach durable history.

## Usage replay cases (conduit-test-xqsg.15)

`cursor-usage.test.ts` makes a temporary copy of `basic.jsonl` under its
isolated process-harness root. It adds only the redacted `credential.store`
result used by turn replay, leaving the captured catalogue, deltas, messages
and wait result unchanged. The copy is removed with the harness.

Usage itself does not come from the SDK: a local HTTP server supplies dashboard
responses, and a test-only JSON file supplies synthetic Keychain JWTs and read
counts. These are explicit boundary stubs, not SDK capture shapes. The suite
writes readings, request counts, credential labels and cleanup observations to
`test-results/conduit-test-xqsg.15.json`, without tokens or JWT subjects.

## Recovery replay cases (conduit-test-xqsg.6)

`turn-never-sent.jsonl` derives from `basic.jsonl`. It adds the captured
`store.runs.before_send` envelope from `never-sent.jsonl`, with only its agentId
rebound to basic's captured agentId, and changes the scenario header. The queued
run retains its captured null requestId/startedAt and runId. This pins the
persisted document distinction even though public listRuns reports running.

`cursor-recovery.test.ts` temporarily adds the same redacted credential-store
and captured model-catalog rows described above. The basic, workspace-resume
and crashed-run SDK deltas, messages and outcomes remain unchanged. Test-only file gates pause
after local send bookkeeping or the first delta; they alter scheduling only.
The trace player persists captured agent/run identities and turn position in
the harness's owned store, projecting active run documents from `crashed-run`
and terminal states from captured wait results. This lets separate runner
processes replay the same agent without fabricating SDK messages. The
live-controller refusal case copies that held store and identity into a second
session, then proves no force or SDK send occurs while the first PID is alive.
All paths are isolated under the process harness and removed at cleanup.

The suite writes event sequences, restart/rebuild parity, command and turn
states, SDK call counts and process cleanup to
`test-results/conduit-test-xqsg.6.json`. The shared-host Claude crash-during-send
regression writes its companion evidence separately.

## Auth replay cases (conduit-test-xqsg.11)

`auth-login.jsonl` retains every catalogue and turn row from `basic.jsonl`.
Its added auth rows are derived from SDK 1.0.37's declared
`SdkLoginOptions.onLoginUrl`, `SdkAuthStatus`, `StoredSdkCredentials` and
`SdkLogoutOptions` contracts, not a real browser login capture. The login URL
uses inert challenge and UUID values; the email is an example.test address.
The key is `[REDACTED]`. `auth.login` and `auth.logout` contain null because
the port returns void and discards the SDK login result at the real boundary.
The expiry is a fixed future epoch so ordinary playback does not age out.
Tests replace the public expiry to exercise warning and expired states.

With `NODE_ENV=test`, `CONDUIT_TEST_CURSOR_AUTH_STATE` selects a temporary
replay-only file shared by daemon and runners. Its shape is
`{status: {status: "logged-out"}, credential: null}` before login. Completion
writes the fixture's public auth status and redacted credential; logout writes
the logged-out state. Every read reloads that file. It is not the production
credential store and never contains a usable API key.
`CONDUIT_TEST_CURSOR_LOGIN_DELAY_MS` delays completion while respecting the
abort signal. `CONDUIT_TEST_CURSOR_LOGIN_URL_DELAY_MS` delays the callback even
after cancellation, to prove the daemon ignores a late URL. These controls
change scheduling without inventing SDK wire fields.
The tee records `auth.login.call` with the browser and key-name options,
`auth.loginUrl` with the callback value, and `auth.login.abort` with the signal's
actual aborted state. These are port observations, not SDK message variants.
Replay ignores `CURSOR_API_KEY` except the exact inert
`[REDACTED:environment]` marker with `NODE_ENV=test`, used to prove environment
precedence without consuming a developer's key.

The installed SDK's bundled `getDefaultSdkAuthPath` uses
`join(homedir(), ".cursor", "sdk", "auth.json")`; it does not read
`CURSOR_DATA_DIR`. Real-adapter tests must set `HOME` to their temporary harness
home before SDK import. Replay tests use only the explicit state path above.

`cursor-auth.test.ts` derives rejected-credential cases in its temporary copy:
it inserts `send.error` or `sandbox.prime.error` port error envelopes with
`authRequired: true`, or replaces `models.list` with `models.list.error`.
These are the tee's error observations, not new SDK message kinds. A separate
variant changes only `basic.jsonl`'s `wait.result` to `status: "error"` and
`error: {code: "unauthenticated", message: "Cursor credentials were rejected"}`.
`RunResult.error` is public; SDK 1.0.37's `toRunError` preserves the
`unauthenticated` code produced for Connect's `Code.Unauthenticated`.

## Question replay cases (conduit-test-xqsg.9)

These are minimal derivatives of real SDK captures. The source headers, wire
envelopes, IDs, timestamps, results and unrelated tools remain unchanged, apart
from the scenario name. The custom-tools option key `human` and every MCP
`custom-user-tools` call's `toolName` become `ask_user`. Existing MCP `args`
fields and the matching `custom.start.args` become one question: "Which deployment?",
header "Deployment", options Blue / "Blue deployment" and Green / "Green
deployment", `multiSelect: false`, `custom: true`.

- `question-basic.jsonl` comes from `custom-auto-block-minutes.jsonl`.
- `question-subagent.jsonl` comes from
  `subagent-foreground-default-fixed.jsonl`. The asking tool call remains an
  `mcp` nested under the Task's `tool-call-delta.taskUpdate`; its context's
  `sessionId` still equals the parent ID. The Task retains `subagentType.name`
  `spike`, so the expected question header is "spike: Deployment".
- `question-cancel.jsonl` comes from `cancel.jsonl`. Its cancelled wait and
  followup turns remain captured values.

`cursor-question.test.ts` adds an unchanged `models.list` row from `basic.jsonl`
and the redacted `credential.store` result to temporary replay files, as the
text-turn process suite does. The tool callback result is the actual answer
recorded by the tee's `custom.result`, not the source capture's old human reply.
The suite writes assertions, SDK operations, durable question events, daemon
generations and owned-runner cleanup to `test-results/conduit-test-xqsg.9.json`.

The temporary basic replay appends its captured send segment a second time,
changing only the custom tool call ID to `<captured-id>-second`. This keeps
two turns' durable requests distinct while preserving the same SDK field
shapes. The malformed/duplicate case changes the first segment's question
arguments to `{questions: []}` and duplicates the second segment's unchanged
`custom.start` row. It asserts an invalid call makes no pending question, then
one answer settles both deliveries of the same valid tool call.

## Model parameter and reroute replay (conduit-test-xqsg.18)

These are derived protocol fixtures, not live proof of plan entitlement or
server rerouting. Both retain `basic.jsonl`'s transcript, IDs, timestamps,
catalog and envelopes. Their scenario and model headers describe the replay:

- `turn-model-parameters.jsonl`: changes the existing `send.options` model and
  `wait.result.model` to `grok-4.7` with the catalog's existing `context=256k`,
  `reasoning_effort=low`, `fast=false` combination. The process test reuses the
  turn while changing the requested next-send combination; the tee verifies
  the native ids and values actually passed to send, independently of replay.
- `turn-model-reroute.jsonl`: changes only the requested `send.options` model
  id to retired `composer-2`. The unchanged captured `wait.result.model.id`
  remains `composer-2.5`, providing the actual-model projection oracle.

`cursor-model-parameters.test.ts` adds the same redacted credential-store row
as discovery/turn tests in temporary harness traces. Its cache cases replace
only the catalog response with an empty array or a `models.list.error` wrapper,
or rotate the inert redaction marker to `[REDACTED:rotated]`. A test-only positive
`CONDUIT_TEST_CURSOR_CATALOG_TTL_MS` override shortens catalog expiry without
changing SDK fields. The run writes `test-results/conduit-test-xqsg.18.json`.
Auto resolution reuses `basic.jsonl` unchanged while requesting `default`; its
captured `wait.result.model.id` proves that choosing an actual model is not drift.

## Tool replay cases (conduit-test-xqsg.7)

The 23 `tool-*.jsonl` files are derived fixtures, not live captures. They use
`tools-project.jsonl`'s header, create/send/run envelopes, tool delta wrappers,
tool-requests-listed update, authoritative wait result and disposal markers.
Unrelated text/thinking, hooks, tool calls and duplicated stream content are
omitted so each file isolates one kind. Call IDs receive the scenario prefix
to prevent independent replay turns from sharing a projected tool part.

- `tool-shell`, `tool-read`, `tool-edit`, and `tool-mcp` retain the native first
  started/completed tool payloads from `tools-project.jsonl` unchanged.
- `tool-delete` retains the native delete payload unchanged. Its declared
  success value contains only `fileSize`, never a diff or removed text.
- `tool-write`, `tool-glob`, `tool-grep`, `tool-ls`, `tool-readLints`,
  `tool-semSearch`, `tool-updateTodos`, `tool-createPlan`, `tool-generateImage`,
  `tool-recordScreen`, `tool-computerUse`, and `tool-task` replace the first
  shell call's type, arguments and success value with the corresponding
  **public `ToolCall` union** member in installed `@cursor/sdk` 1.0.37.
  These are declaration-derived examples; there is no claim of live execution.
  The write path is `created.txt`; the success value supplies `linesCreated`
  and `fileSize`. No prior read or before-content is added. Glob's declared
  `clientTruncated` is true. Todos include the declared `inProgress` status.
  Image data is a one-pixel PNG. Screen media paths are relative to the isolated
  workspace, where the process test creates deterministic PNG/video bytes.
- `tool-shell` additionally exercises streamed stdout/stderr with
  `shell-output-delta.event = {case, value: {content}}`. No live native capture
  emitted these deltas. The public delta declares an open event record; the
  installed SDK's public-message serializer emits the case/value envelope and
  stdout/stderr's JSON `content` field. The final result remains the real
  captured shell result.
- `tool-task` adds a declared `SDKTaskMessage` (`type`, `agent_id`, `run_id`,
  `status`, `text`) to pin stream progress. Ticket .10 maps it to the canonical
  Task card and materializes its child through the runner's existing seam.
- `tool-nested-computerUse` wraps the declared computer-use started/completed
  deltas in the declared `tool-call-delta.taskUpdate` wrapper beneath the task,
  plus a nested text delta. Actions, error/success values and screenshot paths
  use public declarations only, not internal tool names. A live computer-use
  capture is still unavailable on this host, as recorded in the spike findings.
- `tool-unknown` changes only the native shell type to `future-tool`, pinning
  forward-compatible generic rendering without inventing a known tool schema.
  SDK 1.0.37's public union declares neither `webSearch` nor `webFetch`; no
  fixtures claim wire shapes for those names. They use the generic fallback.
- `tool-shell-error` changes the shell's declared `exitCode` to 2 and `stderr`
  to a failure line. `tool-computerUse-error` replaces its result with the
  declared error fields (`message`, `actionCount`, `durationMs`, `screenshotPath`,
  `log`) to pin failed actions and their screenshot attachment.
- `tool-stream-truncated` removes glob's result-level truncation flag and adds
  the declared `SDKToolUseMessage.truncated.result` after completion, proving a
  late stream marker survives in stored history without creating another row.
- `tool-early-stream-truncated` moves that same stream marker before its
  started delta, pinning truncation when the SDK channels arrive in that order.

`cursor-tools.test.ts` supplies the same redacted credential-store and captured
model-catalog rows as the text-turn process tests. It drives the built daemon
and detached runner without an API key and writes each stored started/completed
payload, absence of duplicate file attachments, terminal outcome, process identity and cleanup proof
to `test-results/conduit-test-xqsg.7.json`.
It replays an identical captured call ID again and verifies all earlier tools
remain attached to their original message; stored part IDs include the owning
message ID while provider references keep the SDK call ID.

Returned screenshot/recording files are read only within the workspace or OS
temporary directories, after resolving symlinks, with a 10 MiB attachment limit.
Unavailable/out-of-scope media is marked in metadata; `.cursor` paths are never
read. Tool media lives only in the tool row's `metadata.media`; no duplicate
`file.attached` events are emitted. File changes use only declared SDK values:
edit's `diffString`, `linesAdded` and `linesRemoved`; write's canonical input
content and `linesCreated`; delete's path and returned `fileSize`. Write and
delete have no before-content in the SDK result, so no diff or removed-line
count is reconstructed, cached or read from the filesystem.


## Subagent replay cases (conduit-test-xqsg.10)

`subagent-foreground-default-fixed.jsonl` is the unmodified, redacted real
foreground capture. Its nested `taskUpdate` deltas stream child text, thinking
and seven public tool calls. Its completion snapshot repeats that content and
also contains three `getMcpToolsToolCall` steps absent from the public live
updates. Those three steps stay generic; they are not claimed as public tool
union members. Child identity uses the parent Conduit ID and Task call ID,
never the SDK child agent ID or a custom-tool context's parent session ID.

The following are replay derivatives, not new live observations. Each uses the
foreground capture's complete rows and envelopes except for these edits:

- `subagent-reconcile.jsonl` repeats the Task's completed delta once, keeping
  all live child content and the completion snapshot unchanged. It removes
  `args.model` from the initial partial Task, then sets the started/completed
  Task's model to `composer-2.5-fast`, a value observed in the spike's excluded
  `subagent-background-default.jsonl`. This pins a later SDK-reported model
  replacing the initial inherited parent pick, plus idempotent reconciliation.
  Foreground reconciliation reuses live text and thinking part IDs positionally
  by kind and fills the three snapshot-only generic tools in snapshot order.
  There is no derived callback-gap case: the spike did not observe missing
  live text callbacks.
- `subagent-background-follow-up.jsonl` sets the completed Task's declared
  `isBackground` field to true, including its duplicate stream envelope, and
  copies the capture's existing `turn-ended` delta immediately after the Task
  completion. The subsequent, unchanged parent thinking and `done` text thus
  arrive as a follow-up turn on that same run. After that text, three copied
  child taskUpdates (thinking, thinking-completed, and text `Executing`) pin
  live child continuation after the background Task returned. All original
  live updates remain. The stale background snapshot is never reconciled.
  This is a scheduling example derived from foreground data. The spike did not
  observe successful background follow-up ordering, terminal status or final
  usage ordering. The mapper keeps the child busy until authoritative
  `Run.wait()` resolution and trusts its
  live content, without adding snapshot-only steps.
- `subagent-interrupt.jsonl` retains foreground rows through the first child
  text span, then substitutes its original wait result's status with
  `cancelled` and removes the finished response text. The captured `stream.end`
  follows it. Playback gates that wait on the host's cancel call. This pins
  cancelling all locally materialized children when the run is interrupted,
  without claiming a newly observed live background cancellation timeline.

The process test inserts the same inert credential-store and captured model
catalog rows as `.5`. `CONDUIT_TEST_CURSOR_DELTA_DELAY_MS` slows replay callbacks
and `CONDUIT_TEST_CURSOR_WAIT_DELAY_MS` delays only the replay wait result;
these are test-only scheduling controls, never SDK wire fields. They make live
child visibility and the gap before `Run.wait()` deterministic. The test writes
child events, no-duplicate assertions, child/account/model identity, terminal
states and owned process cleanup to `test-results/conduit-test-xqsg.10.json`.
## Usage, error and interrupt replay cases (conduit-test-xqsg.19)

These derivatives keep `basic.jsonl`'s wire envelopes and change only their
scenario header and the edits below. They are synthetic reconciliation cases,
not evidence that a live background task produced a particular sequence.

- `turn-usage-followup.jsonl`: duplicates the basic usage stream row, replacing
  only its token counts with the first usage row's counts from
  `workspace-resume.jsonl`. Both messages retain the basic agent and run IDs.
  The final `RunResult.usage` is the field-wise sum of these two messages. This
  represents two per-turn usage messages, such as a background follow-up on
  the same run, using the public SDKUsageMessage shape without inventing a
  background-only stream kind. The latest request owns context fill.
- `turn-usage-final-extra.jsonl`: doubles the basic final RunResult's usage
  counts, leaving its single streamed usage row unchanged. The unstreamed
  remainder must be reconciled without counting the original message twice.

`cursor-usage-errors.test.ts` also writes temporary derivatives in the isolated
process root. It inserts the redacted credential result and missing model
catalog exactly as the turn suite does. Error cases insert `send.error`
operation wrappers containing the installed SDK's declared error class name,
code, message and retry flag. Those wrappers inject operation failures, not
new stream union members. All eight cases preserve the diagnostic string and
require exactly one send for one input.

Three further temporary derivatives exercise errors after a send succeeds.
The first changes the captured `wait.result` status to `error` and adds only
the declared RunError fields `{message, code: "connection_stalled"}`. The
second replaces that row with `wait.result.error`, wrapping a declared
`NetworkError` with code `unavailable`. The third removes `wait.result` and
inserts `stream.error` before the captured `stream.end`, wrapping a declared
`NetworkError` with code `connection_stalled`. The multiline diagnostics must
survive exactly. All failure cases inspect the durable command outbox to
require one failed attempt and no scheduled retry.

Optional-cost cases insert `usage` and `usage.error` operation replies, whose
shape comes from SDK 1.0.37's `AgentUsage` and declared SDK error classes.
There is no live getUsage capture in this corpus. The six synthetic cases
cover missing cost, denied access with `feature_unavailable`, aggregate-only
cost growth, late billing for an earlier usage entry, a new matching billed
entry and a new matching plan-included entry. The first four omit Conduit
cost. The last two report $0.255 and $0 from per-turn `chargedCents` values
of 25.5 and 0. Deliberately different `rawCostCents` values ensure the actual
charge, rather than the undiscounted total, is used.

The local per-turn billing UUIDs differ from SDK run-handle IDs. The public
SDK exposes no direct link between them. Attribution therefore requires new
entries whose summed usage matches both the turn and the whole-agent usage
delta, unchanged earlier entries and matching charged-cost deltas. This is a
conservative inference, not live correlation proof. A previously unseen late
bill with identical token counts remains indistinguishable from current usage.

Interrupt cases use unchanged `cancel.jsonl`. Test-only playback scheduling
delays its first cancelled wait by 10,500 ms, or never settles that first run.
This preserves the captured wire result rather than inventing a terminal
status. A late wait is captured after the 10-second fallback and must not
reopen the stored turn. In the never-settling case the next input arrives
while the original runner is alive; replacing that controller and resuming
with `local.force` selects the capture's next actual send and answer. These
schedules model a failure the live spike did not reproduce. A force resume
within the same playback process still fails while its old run is live, and
closing that agent does not settle it.

The suite writes stored events, terminal states, actual SDK-port calls,
process identities, assertions and failures to
`test-results/conduit-test-xqsg.19.json`.

## Skill command process replay (conduit-test-xqsg.13)

`cursor-skills.test.ts` derives a temporary replay from `basic.jsonl` by adding
only the redacted `credential.store` result described above. Its tee records the
actual `/nested release` prompt received by the runner. The filesystem skills
are created under the harness's isolated workspace and home; the JSON evidence
is `test-results/conduit-test-xqsg.13.json`. This proves command discovery and
prompt delivery through Conduit, not SDK skill activation. None of the original
captures contains a skill scenario. The opt-in `cursor-skills-real-sdk.test.ts`
checks real activation separately and records a new trace when explicitly run.

## Steer process replay (conduit-test-xqsg.12)

`steer-shell.jsonl` is the real spike capture of steering a running shell.
It was copied from `cursor-spike/fixtures/steer-shell.jsonl`, replacing only
the private home prefix with `/home/test` and its encoded slug with `home-test`.
The original shell reports success, exit 0 and empty output shortly before
the delivered steer acknowledgement. It actually moved to a background
terminal. Later captured read-only shell calls poll that terminal and the
side-effect log, whose captured contents are exactly `ran\n`. No repeat of
the mutating shell was observed. Conduit's moved-to-background marker is a
conservative inference from this ordering, not an SDK field.

`cursor-steer.test.ts` writes temporary derivatives beneath its isolated
process root. Every derivative inserts the same inert credential-store result
and unchanged `basic.jsonl` model catalogue used by the other process suites.
The delivered and shell cases replay their real captures unchanged. The
following cases are derived protocol/scheduling evidence, not live Cursor
observations:

- Declined: `steer.jsonl`, changing the acknowledgement outcome to the
  captured post-terminal `revert_to_followup` value and removing the captured
  steered `user-message-appended` delta and duplicate user stream message.
- Pending at terminal: the same source, removing its steer acknowledgement
  and both steered user-message rows. The captured terminal ends the pending
  promise. The landed-before-terminal race removes only the acknowledgement,
  retaining both captured user-message channels.
- Delivered error: `steer.jsonl`, changing only `wait.result.status` to the
  public `error` value and adding declared RunError `message` and
  `code: connection_stalled`. The delivered input must own the error and
  session's latest-turn pointer, with no requeue or second SDK send.
- Identical text: `steer.jsonl`, copying its steer.call immediately after
  itself while retaining only the original acknowledgement and user-message
  channels. The replay gates both operations before delivering the original
  receipt. It must consume only the first input, with the second declined at
  terminal and run once by the inbox.
- Images and missing method: the declined variant without `steer.call` or
  `steer.ack` operation wrappers. Missing method also removes `run.handle.steer`.
  The image is an explicit one-pixel PNG input to Conduit, never an invented
  SDK steer field. A test-only wait delay keeps the turn running long enough
  to submit these inputs and verify that neither invokes the SDK operation.
- Pending interrupt: the pending variant changes only `wait.result.status`
  to its public `cancelled` value and moves the original delivered
  acknowledgement after that wait row. Replay gates cancelled waits on the
  caller's cancel operation. The late acknowledgement races the settled
  decline and must not deliver the input again. Stop keeps the inbox paused;
  the test explicitly resumes its queued input and verifies one retry send.
- Pending runner crash: the interrupt variant without the acknowledgement.
  Its cancelled wait stays pending until cancellation, so the test kills only
  its verified owned runner PID while the steer remains pending. Before
  resuming the recovered input, it replaces the temporary trace with a basic
  captured turn. This proves inbox recovery and exactly-once resubmission.
- Background child wait: `subagent-background-follow-up.jsonl`, inserting
  `steer.jsonl`'s real call, acknowledgement, user delta and user stream rows
  immediately after the background Task completes. Only the user rows'
  agent/run identities are changed to those of the parent capture, and
  `run.handle.steer` is set to its captured `function` value. All child
  content and Task fields stay from ticket .10's fixture. This proves
  conduit's child-session and steer path together, but the spike did not
  verify live steering during a background-child wait.

All declined variants append the unchanged send-through-disposal segment of
`basic.jsonl` for subsequent inbox-driven turns. The late-start case submits
delivery `steer` after the missing-method run has completed, proving an idle
session starts a normal turn without calling native steer. Playback gates the
captured `steer.call` until Conduit invokes the operation. Missing acknowledgements
leave its promise pending while the captured stream continues; they add no SDK
wire fields. The suite writes durable input/turn/message state, actual port
operations, capture provenance and owned-process cleanup to
`test-results/conduit-test-xqsg.12.json`.
The existing projector splits one native run at a delivered user's message.
Delivered cases therefore assert two Conduit turn segments, the stored
`steered` flag and subsequent assistant ownership, alongside exactly one SDK
send. The extra transcript segment does not imply another native turn.

## Fork process replay (conduit-test-xqsg.14)

`cursor-fork.test.ts` uses `basic.jsonl` and `tools-project.jsonl`, adding the
same inert credential-store result and captured model catalog as the turn
suite. After completing the source session, it rebinds that capture's agent ID
to a fresh UUID in the temporary replay file. No SDK envelope or event kind
changes. This lets the test distinguish a newly created fork agent from a
resume of the source while retaining the captured turn contents.

The suite checks copied history, explicit cutoffs, source event equality,
separate stores, bounded redacted context, restart before the first fork input,
and delivery of the hidden digest until the first accepted input. The rejected
first-send case temporarily inserts the existing `send.error` port envelope
with `authRequired: true`, as the auth suite does. It removes that envelope and
restarts the owned fork runner before submitting a new input. This injects an
operation failure without adding a stream kind. Scenario invariants
and owned-process cleanup go to `test-results/conduit-test-xqsg.14.json`.
The separate `cursor-fork-live-sdk.test.ts` requires both an explicit
`CURSOR_API_KEY` and `RUN_CURSOR_LIVE_SMOKE=1`. It asks a fresh fork to recall a
random marker present only in the source conversation and writes
`test-results/conduit-test-xqsg.14-live.json` plus a redacted SDK trace.
