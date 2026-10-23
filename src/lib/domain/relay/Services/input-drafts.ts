// Composer work in progress lives beside the event log. Each subscription
// opens with the stored text, followed by live changes.
import {
	Context,
	Effect,
	Layer,
	Option,
	PubSub,
	Semaphore,
	Stream,
} from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import type {
	DraftListItem,
	InputDraftEnvelope,
	InputDraftKey,
} from "../../../contracts/ws-rpc.js";
import { inputDraftClaimMarker } from "../../../persistence/input-drafts.js";

export type { InputDraftKey } from "../../../contracts/ws-rpc.js";

export interface InputDrafts {
	readonly read: (
		key: InputDraftKey,
	) => Effect.Effect<string | undefined, SqlError>;
	readonly write: (
		key: InputDraftKey,
		text: string,
		from?: string,
		projectId?: string,
	) => Effect.Effect<void>;
	/** Empty a session draft only if it still holds the text that was sent. */
	readonly clearSent: (sessionId: string, sent: string) => Effect.Effect<void>;
	readonly claim: (
		draftId: string,
		projectId: string,
	) => Effect.Effect<boolean, SqlError>;
	readonly releaseClaim: (draftId: string) => Effect.Effect<void, SqlError>;
	readonly promote: (
		draftId: string,
		sessionId: string,
		sentText: string,
	) => Effect.Effect<void, SqlError>;
	readonly subscribe: (key: InputDraftKey) => Stream.Stream<InputDraftEnvelope>;
	readonly listDrafts: () => Stream.Stream<readonly DraftListItem[], SqlError>;
	readonly invalidateList: () => Effect.Effect<void>;
	readonly forget: (sessionId: string) => Effect.Effect<void, SqlError>;
}

export class InputDraftsTag extends Context.Service<
	InputDraftsTag,
	InputDrafts
>()("InputDrafts") {}

const keyOf = (key: InputDraftKey) =>
	"session" in key ? key.session : key.draft;
const kindOf = (key: InputDraftKey) => ("session" in key ? "session" : "draft");

/** No in-flight create can survive the daemon process that owned its claim. */
export const releaseInputDraftClaims = () =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql.withTransaction(
			Effect.gen(function* () {
				yield* sql`DELETE FROM input_drafts
					WHERE promoted_session_id = ${inputDraftClaimMarker} AND text = ''
					AND NOT EXISTS (SELECT 1 FROM draft_attachments WHERE draft_key = input_drafts.draft_key)`;
				yield* sql`UPDATE input_drafts SET promoted_session_id = NULL
					WHERE promoted_session_id = ${inputDraftClaimMarker}`;
			}),
		);
	});

export const makeInputDrafts: Effect.Effect<
	InputDrafts,
	never,
	SqlClient.SqlClient
> = Effect.gen(function* () {
	// Daemon relays borrow one service so moving a draft between projects also
	// reaches subscribers still attached to its previous project.
	const shared = yield* Effect.serviceOption(InputDraftsTag);
	if (Option.isSome(shared)) return shared.value;
	const sql = yield* SqlClient.SqlClient;
	const changes = yield* PubSub.unbounded<{
		readonly key: InputDraftKey;
		readonly envelope: InputDraftEnvelope;
	}>();
	const draftChanges = yield* PubSub.unbounded<void>();
	// A snapshot cannot observe a committed promotion before its live publication.
	const snapshotGate = yield* Semaphore.make(1);
	const readRow = (key: InputDraftKey) =>
		sql<{
			text: string;
			project_id: string;
			promoted_session_id: string | null;
		}>`SELECT text, project_id, promoted_session_id FROM input_drafts
			WHERE draft_key = ${keyOf(key)} AND kind = ${kindOf(key)}`.pipe(
			Effect.map((rows) => rows[0]),
		);
	const readDrafts = sql<DraftListItem>`SELECT draft_key AS draftId,
		project_id AS projectSlug, substr(text, 1, 160) AS firstLine,
		updated_at AS updatedAt FROM input_drafts
		WHERE kind = 'draft' AND text != '' AND promoted_session_id IS NULL
		ORDER BY updated_at DESC, draft_key ASC`.pipe(
		Effect.map((rows) =>
			rows.map((row) => ({
				...row,
				firstLine: row.firstLine.split(/[\r\n]/, 1)[0] ?? "",
			})),
		),
	);

	return {
		read: (key) =>
			readRow(key).pipe(
				Effect.map((row) =>
					row?.promoted_session_id != null &&
					row.promoted_session_id !== inputDraftClaimMarker
						? undefined
						: row?.text,
				),
			),
		write: (key, text, from, projectId) =>
			Effect.gen(function* () {
				const oversized = Buffer.byteLength(text, "utf8") > 1024 * 1024;
				if ("draft" in key && oversized) {
					const promoted = yield* sql<{ promoted_session_id: string }>`
						SELECT promoted_session_id FROM input_drafts
						WHERE draft_key = ${key.draft} AND promoted_session_id IS NOT NULL`.pipe(
						Effect.catch((cause) =>
							Effect.logError(
								`Could not read input draft ${key.draft}: ${cause}`,
							).pipe(Effect.as([])),
						),
					);
					if (promoted.length > 0) return;
				}
				if (oversized) {
					yield* Effect.logWarning(
						`Input draft ${keyOf(key)} exceeds 1 MiB; skipped storage`,
					);
				} else if ("session" in key) {
					// One statement resolves ownership and writes without the event commit
					// permit. A deleted session cannot recreate its draft through a late sync.
					yield* sql`INSERT INTO input_drafts (draft_key, project_id, kind, text, updated_at)
					SELECT id, project_id, 'session', ${text}, ${Date.now()}
					FROM sessions WHERE id = ${key.session}
					ON CONFLICT (draft_key) DO UPDATE SET
						project_id = excluded.project_id, kind = excluded.kind,
						text = excluded.text, updated_at = excluded.updated_at
					WHERE input_drafts.promoted_session_id IS NULL`.pipe(
						Effect.catch((cause) =>
							Effect.logError(
								`Could not store input draft ${key.session}: ${cause}`,
							),
						),
					);
				} else if (projectId !== undefined) {
					const stored = yield* (
						text === ""
							? sql.withTransaction(
									Effect.gen(function* () {
										const deleted = yield* sql<{
											draft_key: string;
										}>`DELETE FROM input_drafts
											WHERE draft_key = ${key.draft} AND kind = 'draft'
											AND promoted_session_id IS NULL RETURNING draft_key`;
										const blocked = yield* sql<{ draft_key: string }>`
											SELECT draft_key FROM input_drafts
											WHERE draft_key = ${key.draft}
											AND promoted_session_id IS NOT NULL`;
										return {
											writable: blocked.length === 0,
											changed: deleted.length > 0,
										};
									}),
								)
							: sql<{ draft_key: string }>`INSERT INTO input_drafts
							(draft_key, project_id, kind, text, updated_at)
							VALUES (${key.draft}, ${projectId}, 'draft', ${text}, ${Date.now()})
							ON CONFLICT (draft_key) DO UPDATE SET
								project_id = excluded.project_id, text = excluded.text,
								updated_at = excluded.updated_at
							WHERE input_drafts.kind = 'draft'
							AND input_drafts.promoted_session_id IS NULL
							RETURNING draft_key`.pipe(
									Effect.map((rows) => ({
										writable: rows.length > 0,
										changed: rows.length > 0,
									})),
								)
					).pipe(
						Effect.catch((cause) =>
							Effect.logError(
								`Could not store input draft ${key.draft}: ${cause}`,
							).pipe(Effect.as(undefined)),
						),
					);
					// A promoted id cannot become writable or emit fresh draft text.
					if (stored?.writable === false) return;
					if (stored?.changed) yield* PubSub.publish(draftChanges, undefined);
				} else {
					return;
				}
				yield* PubSub.publish(changes, {
					key,
					envelope: {
						_tag: "draft",
						text,
						...(from !== undefined ? { from } : {}),
						...("draft" in key && projectId !== undefined ? { projectId } : {}),
					},
				});
			}),
		// A send's clear can land after the user has typed and synced the next
		// message; an unconditional write would erase it.
		clearSent: (sessionId, sent) =>
			sql<{
				draft_key: string;
			}>`UPDATE input_drafts SET text = '', updated_at = ${Date.now()}
				WHERE draft_key = ${sessionId} AND kind = 'session' AND text = ${sent}
				RETURNING draft_key`.pipe(
				Effect.flatMap((rows) =>
					rows.length > 0
						? PubSub.publish(changes, {
								key: { session: sessionId },
								envelope: { _tag: "draft", text: "" },
							})
						: Effect.void,
				),
				Effect.asVoid,
				Effect.catch((cause) =>
					Effect.logError(`Could not clear input draft ${sessionId}: ${cause}`),
				),
			),
		claim: (draftId, projectId) =>
			sql<{ text: string }>`INSERT INTO input_drafts
				(draft_key, project_id, kind, text, updated_at, promoted_session_id)
				VALUES (${draftId}, ${projectId}, 'draft', '', ${Date.now()}, ${inputDraftClaimMarker})
				ON CONFLICT (draft_key) DO UPDATE SET promoted_session_id = ${inputDraftClaimMarker}
				WHERE input_drafts.kind = 'draft' AND input_drafts.promoted_session_id IS NULL
				RETURNING text`.pipe(
				Effect.tap((rows) =>
					rows.length > 0
						? PubSub.publish(draftChanges, undefined)
						: Effect.void,
				),
				Effect.map((rows) => rows.length > 0),
			),
		releaseClaim: (draftId) =>
			sql
				.withTransaction(
					Effect.gen(function* () {
						const deleted = yield* sql<{
							draft_key: string;
						}>`DELETE FROM input_drafts WHERE draft_key = ${draftId}
						AND promoted_session_id = ${inputDraftClaimMarker} AND text = '' RETURNING draft_key`;
						const released = yield* sql<{
							draft_key: string;
						}>`UPDATE input_drafts SET promoted_session_id = NULL
						WHERE draft_key = ${draftId} AND promoted_session_id = ${inputDraftClaimMarker} RETURNING draft_key`;
						return deleted.length > 0 || released.length > 0;
					}),
				)
				.pipe(
					Effect.flatMap((changed) =>
						changed ? PubSub.publish(draftChanges, undefined) : Effect.void,
					),
					Effect.asVoid,
				),
		promote: (draftId, sessionId, sentText) =>
			snapshotGate.withPermits(1)(
				sql<{ draft_key: string }>`UPDATE input_drafts
				SET promoted_session_id = ${sessionId}, text = '', updated_at = ${Date.now()}
				WHERE draft_key = ${draftId} AND kind = 'draft'
				AND promoted_session_id = ${inputDraftClaimMarker} RETURNING draft_key`.pipe(
					Effect.tap((rows) =>
						rows.length > 0
							? PubSub.publish(draftChanges, undefined)
							: Effect.void,
					),
					Effect.flatMap((rows) =>
						rows.length > 0
							? PubSub.publish(changes, {
									key: { draft: draftId },
									envelope: { _tag: "promoted", sessionId, text: sentText },
								})
							: Effect.void,
					),
					Effect.asVoid,
				),
			),
		subscribe: (key) =>
			Stream.unwrap(
				Effect.gen(function* () {
					// Buffer writes made during the read so the snapshot has no gap.
					const dequeue = yield* PubSub.subscribe(changes);
					return yield* snapshotGate.withPermits(1)(
						Effect.gen(function* () {
							const row = yield* readRow(key).pipe(
								Effect.catch((cause) =>
									Effect.logError(
										`Could not read input draft ${keyOf(key)}: ${cause}`,
									).pipe(Effect.as(undefined)),
								),
							);
							const promotedSessionId =
								"draft" in key &&
								row?.promoted_session_id != null &&
								row.promoted_session_id !== inputDraftClaimMarker
									? row.promoted_session_id
									: undefined;
							const sameKey = (change: { readonly key: InputDraftKey }) =>
								keyOf(change.key) === keyOf(key) &&
								kindOf(change.key) === kindOf(key);
							const buffered = (yield* PubSub.takeUpTo(
								dequeue,
								Infinity,
							)).filter(sameKey);
							const live = Stream.concat(
								Stream.fromIterable(buffered),
								Stream.fromSubscription(dequeue).pipe(Stream.filter(sameKey)),
							).pipe(Stream.map(({ envelope }) => envelope));
							// A promotion concurrent with this read has the exact sent text.
							// Deliver it before retirement metadata can discard that comparison.
							if (buffered.some(({ envelope }) => envelope._tag === "promoted"))
								return live;
							return Stream.concat(
								Stream.make<[InputDraftEnvelope]>({
									_tag: "synchronized",
									...(row === undefined || promotedSessionId !== undefined
										? {}
										: { text: row.text }),
									...("draft" in key && row !== undefined
										? { projectId: row.project_id }
										: {}),
									...(promotedSessionId === undefined
										? {}
										: { promotedSessionId }),
								}),
								live,
							);
						}),
					);
				}),
			),
		invalidateList: () =>
			PubSub.publish(draftChanges, undefined).pipe(Effect.asVoid),
		listDrafts: () =>
			Stream.unwrap(
				Effect.gen(function* () {
					// Subscribe first so a mutation during the initial read gets re-queried.
					const changed = yield* PubSub.subscribe(draftChanges);
					return Stream.concat(
						Stream.fromEffect(readDrafts),
						Stream.fromSubscription(changed).pipe(
							Stream.groupedWithin(Infinity, "1 second"),
							Stream.mapEffect(() => readDrafts),
						),
					);
				}),
			),
		forget: (sessionId) =>
			sql<{ kind: string }>`DELETE FROM input_drafts
				WHERE (draft_key = ${sessionId} AND kind = 'session')
				OR promoted_session_id = ${sessionId} RETURNING kind`.pipe(
				Effect.flatMap((rows) =>
					rows.some((row) => row.kind === "draft")
						? PubSub.publish(draftChanges, undefined)
						: Effect.void,
				),
				Effect.asVoid,
			),
	} satisfies InputDrafts;
});

export const InputDraftsLive: Layer.Layer<
	InputDraftsTag,
	never,
	SqlClient.SqlClient
> = Layer.effect(InputDraftsTag, makeInputDrafts);
