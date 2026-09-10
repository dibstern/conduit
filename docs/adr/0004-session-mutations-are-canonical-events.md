# ADR-0004: Session mutations are canonical events; upstream providers are synced from them

- Status: accepted
- Date: 2026-09-10
- Context: conduit-test-42k7 (deleted sessions reappeared in the sidebar);
  hardening epic conduit-test-48mo

## Context

`listSessions` reads the SQLite read model, which is projected from the event
store. Session mutations, however, each picked their own backends:

- `renameSession` wrote the event store for Claude-backed sessions and called
  `api.session.update` for the rest.
- `deleteSession` called `api.session.delete` and nothing else.
- `createSession` called `api.session.create` and nothing else.

No interface anywhere stated that a session mutation has to reach the read
model. Parity between the write paths and the read path was convention, held up
by whoever last edited the method — and delete never got the memo. A user
deleted a session, OpenCode forgot it, the `sessions` row stayed, and the next
`listSessions` put it straight back in the sidebar.

The failure was invisible for a second reason. When the FK constraint from the
half-finished delete did surface, the projection runner swallowed it and
returned success, so the mutation reported that it had worked.

Three things had to be true at once for this bug to exist: mutations could
choose a backend, nothing typed the choice, and the error channel lied.

## Decision

**A session mutation is a canonical `session.*` event.** Mutations go through
one module, `src/lib/domain/relay/Services/session-command.ts`, whose interface
is `applySessionCommand(command)` plus the `SessionCommand` type. The pipeline
behind it is fixed:

1. append the canonical event to the event store,
2. project it into the read model, strictly,
3. sync upstream, best-effort.

**Commands are typed as the event payloads they become.** `SessionCommand`
indexes `EventPayloadMap`, so a mutation with no corresponding `session.*` event
cannot be expressed at all. This is what makes the conduit-test-42k7 class of
bug unrepresentable rather than merely tested for: there is no way to write a
mutation that skips the read model, because the command *is* the thing the read
model is projected from.

**Upstream providers are synced FROM events, never written directly.** Upstream
sync is an adapter — `SessionUpstreamAdapter` — with two implementations:
OpenCode maps `session.deleted` to `api.session.delete` and `session.renamed`
to `api.session.update`; Claude is a no-op, because the Claude Agent SDK has no
server-side session registry to keep in step. Two adapters, so the seam is real
rather than hypothetical. Provider branching happens once, at adapter selection,
instead of inside every mutating method.

**The local write is authoritative; upstream sync is best-effort.** A projection
failure fails the command, because a user told a session was deleted must not
find it still listed. An upstream failure is logged with operation, session id,
and cause, and the command still succeeds — Conduit's durable state is the
source of truth, and the provider is a cache of it.

`test/unit/effect/session-mutation-boundary-grep.test.ts` enforces the second
half of this structurally: a direct `api.session.create|update|delete` call
anywhere in `src/` outside `session-command.ts` fails the build. There is no
allowlist to curate — the rule is the architecture, stated once. A companion
assertion pins the calls that are supposed to be inside the seam, so deleting
the adapter cannot make the rule pass vacuously.

## Consequences

- Adding a session mutation means adding a `session.*` canonical event and a
  projector handler for it. That is more ceremony than calling the provider
  SDK, and it is the point: the ceremony is what keeps the read model honest.
- Mutations that upstream must learn about get an adapter branch. The compiler
  requires the mapping to be total over `SessionCommand`, so a new command
  cannot silently skip upstream.
- Creation stays asymmetric. The session id has to exist before an event can
  reference it — chosen by OpenCode for OpenCode-backed sessions, locally for
  the rest — so `session.created` has no upstream sync to perform. The event is
  still appended, which is what closes the parity gap.
- Migration was incremental. Delete moved onto the seam first as a tracer
  bullet (conduit-test-48mo.6), rename and create followed
  (conduit-test-48mo.7), and the per-call-site allowlist collapsed into the
  single path rule once nothing was left on it (conduit-test-48mo.8).
- `api.session.create` stays a direct call, but it lives in the seam module
  rather than at a call site. It is id-generating, and
  `sync: (command) => Effect<void>` cannot express "return the id the provider
  chose" — a command needs the session id before it can be built. So
  `createOpenCodeSession` calls OpenCode and applies `session.created` in the
  same function. Folding the two together is what matters: creating a session
  upstream and forgetting to record it locally is no longer expressible from
  outside this module, which is precisely the bug that started this.
- Upstream sync is skipped entirely when no OpenCode API is wired. The seam
  takes `OpenCodeAPITag` as an optional service: a Claude-only relay has no
  session registry anywhere, and requiring the tag would put OpenCode in the
  type of every local session create.
