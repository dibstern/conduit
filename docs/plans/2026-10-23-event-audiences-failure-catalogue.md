# Event audiences failure catalogue

The typed subscription table decides Audience at open. The delivery seam checks
coverage once and interrupts when Interests stop covering that Audience. Mixed
streams carry typed row Audiences and filter whole chunks. Interests describe the
connection's current views and terminal attachments. Session ownership comes from
Session Directory at open, never the relay cache. Projects remain distinct even when their folders share
Repository Identity. A Session Workspace move does not change its Project.

The Run Ledger catalogue named in the task is absent from this checkout. This
table follows the existing shared-store failure-mode records and adds stable ids
and observable tests. Tests exercise the two pure functions and the shared
delivery seam, including its RPC and legacy session-presence callers.

| Id | Interleaving and failure | Required behavior | Test |
| --- | --- | --- | --- |
| EA01 | Two projects stream runs concurrently; a session id alone admits foreign output. | Session delivery requires both the viewed session and its current Project. | `EA01 session output requires the session and its project` |
| EA02 | A connection views one project while another emits settings or rows. | Project events reach only connections viewing that Project. | `EA02 project events cannot cross project interests` |
| EA03 | A permission or question arrives during a run in another project, or before views restore. | Approvals and questions have global Audience. | `EA03 approvals and questions remain global` |
| EA04 | A session disappears, its project is removed, or provenance cannot be resolved during a broadcast. | Unknown session ownership fails closed, never widens to global. | `EA04 unknown session provenance fails closed` |
| EA05 | A producer outlives a Project or Session view. | The pure classifier resolves the owner supplied by its caller; subscriptions fix producer provenance at open and cancel when Interests disappear. | `EA05 delivery rechecks ownership between emissions`; `EA05 subscription ownership is resolved once at open` |
| EA06 | Interests change during a broadcast. | Each delivery decision uses one current Interests value; subsequent delivery observes the update. | `EA06 interest changes take effect at the next delivery` |
| EA07 | A subscription scope closes with output queued or a run still producing. | Closed views receive no later output. | `EA07 closing a scope revokes queued run output` |
| EA08 | Two views share a session or project; one scope closes. | The remaining view retains its Interests until it closes. | `EA08 overlapping scopes retain the remaining interests` |
| EA09 | Browser reconnects before its subscriptions restore. | New connections start with empty Interests; only global events can pass. | `EA09 reconnect starts empty and restores explicitly` |
| EA10 | Daemon restarts while a run survives and a browser reconnects. | No Interests survive from the old connection or daemon lifetime. | `EA10 restart discards old connection interests` |
| EA11 | PTY detaches while output is queued; terminal ids collide across projects. | Output requires an active attachment and its project interest; detach revokes it immediately. | `EA11 PTY detach revokes output without crossing projects` |
| EA12 | Session selection changes through either a normal view or provider materialization. | Every setClientSession call updates Interests and replaces the old selected session. | `EA12 setClientSession replaces selected interests` |
| EA13 | A late release from an old selection races a new view, or the old project's relay closes after navigation. | Releasing old Interests cannot erase newer or independently held Interests. | `EA13 late cleanup cannot erase a newer selection` |
| EA14 | Daemon streams, routed relay streams and standalone relay streams deliver equivalent events. | Every stream uses the same typed subscription Audience and delivers seam. RPC control and unary replies retain their request semantics. | `EA14 daemon and relay streams share the delivery seam` |
| EA15 | Generated events, connections, ownership and view changes combine the cases above. | Actual delivery equals delivers; non-global events never leave the connection's Projects. | `EA15 generated deliveries match policy and never leak projects` |
| EA16 | A mixed-project shell emits a foreign upsert after its snapshot, or a row with missing provenance. | Every row shape uses its Project Audience; absent provenance fails closed. | `EA16 shell upserts cannot bypass row provenance` |
| EA17 | A daemon-owned input draft reconnects without a relay context or project argument. | Unsent draft subscriptions remain directed global feeds; session drafts resolve their Project and hold session Interests. | `EA17 daemon input drafts restore without a relay context` |
| EA18 | A viewed family member is deleted while its root and siblings keep changing. | The anchored family view keeps its Project Audience and receives removals and later family rows. | `EA18 family delivery survives deletion of the requested member` |
| EA19 | A browser reconnects after a fixture deletes a session but leaves its sidebar row, selecting an unknown session. | Unknown detail provenance stays closed; the fixture must remove the deleted session's projection and retain Project Provenance on re-created rows. | `Scenario 11: Session deleted while busy → no phantom effects` |
| EA20 | Delivery splits a producer batch and RPC waits for an acknowledgement per event. | One multi-event upstream chunk remains one chunk at the RPC delivery seam. | `EA20 delivery preserves a multi-event RPC chunk` |
| EA21 | A standalone request names Project B while its producer belongs to Project A. | Refuse with a typed project mismatch error before opening the producer; never relabel it. | `EA21 standalone producer rejects another requested project` |
| EA22 | Session Directory fails on the first read, then would recover. | Fail opening with a client-visible typed error; never leave an empty-interest subscription running. | `EA22 ownership lookup failure fails subscription opening` |
| EA23 | Draft subscription fixtures subscribe before creating owned session rows. | Seed owned sessions; preserve ownership enforcement and delivery to the matching session. | `a draft typed in one tab reaches every tab on that session`; `a cleared draft reaches open tabs as empty text` |
| EA24 | Interests disappear while the producer is suspended in a chunk. | Interrupt the subscription and finalize the producer without waiting for its next event. | `EA24 session switch interrupts a producer mid-chunk` |
| EA25 | A subscribe method is added to the RPC group without an audience decision. | An incomplete audience table fails type checking. | `EA25 every subscribe method requires an audience entry` |
| EA26 | One PTY batch removes an attachment, emits output, then reattaches the same id. | Decide each typed row against Interests at its position in the batch; later attachments cannot authorize earlier output. Preserve the upstream chunk. | `EA26 PTY detach and reattach within one chunk retain row order` |
| EA27 | A routed subscription forks its producer before an ownership lookup fails during Audience setup. | Fail opening before acquiring the producer. | `EA27 routed ownership failure is refused before producer acquisition` |
| EA28 | The session handler repeats the current selection while a subscription waits for output. | Replace selection atomically; an unchanged Audience must stay covered without a transient cancellation. | `EA28 repeating a session selection keeps its subscription open` |
| EA29 | A shell catalogue removes a Project and its scope closes before another view opens. | Catalogue restrictions end with their scope; a fresh producer can establish a new view. | `EA29 closed shell catalogues do not strand later subscriptions` |
| EA30 | Daemon Shell resumes with a deletion tombstone for a row this stream has never seen. | The producer carries retained Project Provenance through the tombstone; delivery admits the owned removal and rejects a foreign one. | `EA30 resumed shell tombstones retain their producer-owned project`; `EA30 resumed daemon Shell retains Project Provenance for a deleted row` |
| EA31 | Coverage disappears before the interruption watcher starts, possibly returning in the same tick before a multi-event first chunk. | Latch revocation before opening the producer and check it after the interruption merge; drop the whole uncovered chunk and keep the revoked subscription closed after re-coverage. | `EA31 startup revocation drops the first chunk even after same-tick re-coverage` |
| EA32 | Repeated idle subscriptions revoke successfully and their scopes close, but completed Interests listeners remain registered. | Finalize pending producer work and release each listener on successful revocation; later Interests changes must not call completed subscriptions. | `EA32 revoked subscriptions release their Interests listeners` |

Ownership lookup failures at open use the typed RPC error channel. Fixed streams
pass events through unchanged, preserving upstream chunks and RPC acknowledgements.
Interest changes interrupt pending producer pulls. Typed PTY inventory snapshots
establish attachments before live output; snapshot and synchronization frames keep
their subscription's Project Audience.
An all-project Session list explicitly views the registered projects. It does
not give unrelated session-detail or terminal streams permission to emit.
