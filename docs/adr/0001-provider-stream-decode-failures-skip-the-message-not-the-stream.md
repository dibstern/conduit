# ADR-0001: Provider stream decode failures skip the message, not the stream

- Status: accepted
- Date: 2026-07-16
- Context: 2026-07-15 incident; fixed in 04f4a604

## Context

Conduit runtime-decodes every Provider Envelope at the provider boundary
(Claude Agent SDK messages against `ClaudeSDKMessageSchema`, OpenCode SSE
against its schemas) before adapter translation. Decode is strict by design:
we want to notice vocabulary we don't understand.

On 2026-07-15 the Claude Agent SDK passed an API SSE keepalive
(`stream_event` with `event.type: "ping"`) through to the message iterator.
`ping` is absent from the SDK's own TypeScript types and was absent from our
schema. The decode failure propagated out of the stream-consume loop, killed
the long-lived stream consumer, and the whole turn failed with "SDK stream
ended without result" — one unknown keepalive took down the session.

## Decision

At a **streaming** provider boundary, a message that fails schema decode is
**skipped and logged (with its payload), never fatal**. The stream consumer
in `claude-provider-runtime.ts` (`consumeStreamLoopEffect`) catches
`ClaudeSDKDecodeError` per message and continues; only non-decode errors
still fail the stream.

Strictness is preserved one level down: the schema still rejects unknown
vocabulary, the rejection is still logged loudly, and captured-trace replay
tests (ADR-0002) still fail CI-side when real traffic stops decoding. What
changed is the blast radius: unknown vocabulary degrades one message, not the
session.

This applies to *stream* boundaries where the next message is independent of
the failed one. Request/response boundaries (e.g. decoding a REST history
page) keep fail-closed semantics — there, a decode failure means the whole
response is unusable.

## Consequences

- A future "tighten decode handling" refactor must not restore fail-closed
  behavior in the stream consumer. The regression test
  ("skips malformed SDK stream messages instead of killing the stream" in
  `claude-provider-instance-send-turn.test.ts`) pins this.
- Skipped messages can silently drop content if the unknown type carried
  meaning. The mitigation is the logged payload plus trace-replay tests that
  force the schema to keep up with observed vocabulary.
