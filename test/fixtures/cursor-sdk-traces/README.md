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
