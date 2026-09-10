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
half of this: a direct `api.session.create|update|delete` call anywhere in
`src/` fails the build unless it is on a reviewed allowlist. The allowlist
shrinks to the sync adapter as each mutation migrates.

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
- Migration is incremental. Delete moved onto the seam first as a tracer bullet
  (conduit-test-48mo.6); rename and create follow (conduit-test-48mo.7). Until
  then the allowlist carries the un-migrated call sites explicitly, so the gap
  is visible rather than assumed.
