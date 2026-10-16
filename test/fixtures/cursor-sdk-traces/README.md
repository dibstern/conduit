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

- `subagent-reconcile.jsonl` removes the first whole live child assistant text
  span, leaving its completion snapshot unchanged, and repeats the Task's
  completed delta once. It removes
  `args.model` from the initial partial Task, then sets the started/completed
  Task's model to `composer-2.5-fast`, a value observed in the spike's excluded
  `subagent-background-default.jsonl`. This pins a later SDK-reported model
  replacing the initial inherited parent pick, plus idempotent reconciliation.
- `subagent-reconcile-partial.jsonl` drops only the first child text delta,
  `Executing`, and repeats the completed Task delta. Its untouched snapshot
  pins repairing a missing prefix within a live part without duplicating the
  remaining text. Canonical snapshot replacement also restores part order and
  preserves the mapped live tools' timings, status and media.
- `subagent-background-follow-up.jsonl` sets the completed Task's declared
  `isBackground` field to true, including its duplicate stream envelope, and
  copies the capture's existing `turn-ended` delta immediately after the Task
  completion. The subsequent, unchanged parent thinking and `done` text thus
  arrive as a follow-up turn on that same run. After that text, three copied
  child taskUpdates (thinking, thinking-completed, and text `Executing`) pin
  live child continuation after the background Task returned. The first child
  text delta `Executing` is omitted, and the identical completed background
  Task delta is repeated after the late child updates. Together these edits
  pin missing-prefix repair plus later continuation and duplicate completion,
  while preserving the original receipt-time text offsets. This is a scheduling
  example derived from foreground data. The spike did not observe successful background
  follow-up ordering, terminal status or final usage ordering. The mapper keeps
  the child busy until authoritative `Run.wait()` resolution.
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
