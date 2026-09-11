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
- The delete cascade belongs to the schema, not the handler. Every foreign key
  into `sessions` and `turns` carries `ON DELETE CASCADE`, so the
  `session.deleted` handler is one `DELETE FROM sessions`. It used to resolve
  descendants with a recursive CTE and issue nine deletes per descendant,
  deepest-first, because `sessions.parent_id` had no `ON DELETE` rule: get the
  order wrong and the parent delete trips the foreign key, the projection
  runner swallows the failure, and the session stays in the sidebar. Ordering
  that must be correct in two projectors and an eviction path is ordering that
  will eventually be wrong in one of them (conduit-test-48mo.5, which also
  closed conduit-test-wxwn, where the eviction path iterated a flat session-id
  list and never resolved descendants at all).
- The two session projectors are one handler table. `sessions` is written by a
  sync projector and an Effect projector that implemented the same nine event
  types twice as parallel if-chains, kept in step by hand and checked only at
  runtime by `assertHandledOrIgnored` plus a snapshot. Adding `session.deleted`
  meant editing four places, none of which the compiler checked. They now share
  `Record<SessionHandledType, Handler>`, so a missing handler is a type error
  and `handles` is derived from the table rather than maintained alongside it
  (conduit-test-48mo.4).
- The handlers return statements instead of executing them. A handler is
  `(event) => readonly SessionStatement[]`, a pure function; each runtime then
  runs the list its own way. Sharing the *execution* instead would have meant
  abstracting over `void` and `Effect<void>`, which TypeScript cannot express
  without higher-kinded types — the reason an earlier attempt at this stalled.
  Nothing effectful crosses the interface, so the problem does not arise, and
  the two projectors collapse to a three-line loop each. `assertHandledOrIgnored`
  stays where it is still earning its keep: the projectors that remain
  imperative if-chains.
- `events` deliberately has no foreign key to `sessions`, so no cascade can
  reach it. The event log outlives the read-model rows projected from it; that
  is what makes a rebuild possible, and it is why 0004 dropped that key.
- `api.session.create` stays a direct call, but it lives in the seam module
  rather than at a call site. It is id-generating, and
  `sync: (command) => Effect<void>` cannot express "return the id the provider
  chose" — a command needs the session id before it can be built. So
  `createOpenCodeSession` calls OpenCode and applies `session.created` in the
  same function. Folding the two together is what matters: creating a session
  upstream and forgetting to record it locally is no longer expressible from
  outside this module, which is precisely the bug that started this.
- Fork lineage is a canonical event too, and a separate one. `setForkEntry`
  wrote relay state and `fork-metadata.json` and nothing else, so
  `sessions.parent_id` stayed null for every fork — and the root-session query
  filters on exactly that column, so a fork surfaced in the sidebar as a
  top-level session (conduit-test-o5vp). The alternative the ticket raised,
  making the sidecar the acknowledged source of truth and dropping the columns,
  is not available: `getSession` and `client-init` read `parent_id` with no
  fallback. So lineage is `session.forked`, distinct from `session.created`
  because Conduit learns the two facts from different places — the forked
  session's existence off the provider event stream, its fork point from the
  fork call — and because a lineage-only payload is all `setForkEntry` has.
  The sidecar survives as a cache, and as the only home for the display-only
  fork-point timestamp, which has no column.
- `api.session.fork` moved into the seam for the same reason `api.session.create`
  is there: it is id-generating. It also had to. `session.forked` projects as an
  `UPDATE`, and nothing appended `session.created` for a forked session — the
  row appeared only if the provider event stream happened to mention it — so the
  lineage write would have found no row and reported success. `forkOpenCodeSession`
  applies `session.created` in the same function as the fork call, and the
  boundary rule now matches `fork` alongside `create|update|delete`; it did not,
  which is how this call site sat outside the seam unnoticed.
- Upstream sync is skipped entirely when no OpenCode API is wired. The seam
  takes `OpenCodeAPITag` as an optional service: a Claude-only relay has no
  session registry anywhere, and requiring the tag would put OpenCode in the
  type of every local session create.
