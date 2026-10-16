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
  `status`, `text`) to pin stream progress. It renders as the generic
  `cursor.task` row; the subagent ticket (.10) owns child-session materialization.
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
