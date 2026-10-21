# Background shell completion during another run

These are deterministic derived traces, not new live captures. They require no
Claude credentials. Sources are `background-shell-ends-between-turns.jsonl`
and `pong-thinking-text-turn.jsonl`.

Both keep the first capture through its first result, then insert the second
capture's queued/started input and streamed `p` before the first capture's three
background completion frames. The remaining `ong`, assistant snapshot and result
complete the second input. The second capture uses the first capture's session
id. Explicit queued/started/completed frames identify the older capture's first
input, and each result names its input with `user_message_uuid`.

The `-metadata-only` variant also omits the first capture's partial Bash block
(original lines 46-50 and 52) but retains its full `assistant` tool_use snapshot
(line 51). Its task_started frame (line 56) is delayed until the second input is
streaming. Thus the launching tool_use is observable in run 1 even though the
first canonical tool.started is emitted in run 2. This deliberately exercises
late task metadata without guessing an owner from the currently active run.

The process test holds each result using its isolated release file. It releases
run 1, removes the release file before submitting input 2, inspects the stored
completion while run 2 is still running, then releases run 2. No timing sleep or
live daemon is needed. The full-stream variant covers the ordinary late update
whose canonical tool part already exists.
