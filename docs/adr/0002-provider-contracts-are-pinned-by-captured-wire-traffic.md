# ADR-0002: Provider Contracts are pinned by captured wire traffic, not SDK types

- Status: accepted
- Date: 2026-07-16
- Context: 2026-07-15 Claude incident; earlier OpenCode permission-event
  divergence (npm `types.gen` disagreed with the live server wire)

## Context

Twice now, a provider SDK's published TypeScript types have disagreed with
what the provider actually emits on the wire:

- OpenCode `@opencode-ai/sdk` `types.gen` described permission events
  (`permission.updated`, `permissionID`/`response`) that the real server
  never emits; the live wire uses `permission.asked`/`permission.replied`
  with `requestID`/`reply`.
- The Claude Agent SDK's message union omits the `ping` keepalive and the
  per-block `assistant` snapshot behavior (content arrays re-indexed from 0,
  not aligned with wire `content_block` indexes) that
  `includePartialMessages` actually produces.

Hand-written test fixtures inherit these wrong beliefs: every fixture we
wrote from the SDK types encoded the same misunderstanding the bug did, so
the tests passed while production broke.

## Decision

The Provider Contract is what the wire says, verified two ways:

1. **Capture**: the Claude runtime tees raw SDK messages (pre-decode) to
   per-session JSONL Runtime Traces when `CONDUIT_CLAUDE_SDK_CAPTURE` is set
   (`src/lib/provider/claude/sdk-trace-capture.ts`). Capture is diagnostics:
   it may be disabled or fail without affecting the stream.
2. **Replay**: captured traces are committed under
   `test/fixtures/claude-sdk-traces/` and replayed by
   `claude-sdk-trace-replay.test.ts`, which asserts (a) every captured
   message still decodes — vocabulary drift fails the build — and (b) the
   translator's output satisfies the canonical stream invariants
   (`test/helpers/provider-runtime-stream-invariants.ts`).

**On SDK upgrades** (Claude Agent SDK or OpenCode SDK): capture a fresh trace
from a real turn, run the replay suite, and reconcile any divergence by
extending the schema — never by trusting the SDK's `.d.ts` over the capture,
and never by loosening the replay asserts. For OpenCode, the server's
`/doc` OpenAPI and live SSE remain the reference, not `types.gen`.

Redaction rule for committed traces: string *contents* that carry private
data (hook outputs, memory dumps) may be replaced; envelope fields and
structure must stay exactly as captured.

## Consequences

- New undocumented SDK behavior is caught by a failing decode on a real
  trace, not by a production session dying (ADR-0001 bounds the runtime
  blast radius; this ADR closes the loop at test time).
- Fixtures contain real model output and real (temp) paths; the redaction
  rule is the guard. Review a trace before committing it.
- The corpus only covers behaviors we've captured. When a bug reveals a new
  wire behavior, capture it and commit the trace as part of the fix.
