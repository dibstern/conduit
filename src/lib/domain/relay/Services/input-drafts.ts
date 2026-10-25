// Composer work in progress lives beside the event log. Each subscription
// opens with the stored text, followed by live changes.
import type { DatabaseSync } from "node:sqlite";
import {
	Context,
	Effect,
	Layer,
	Option,
	PubSub,
	Schema,
	Semaphore,
	Stream,
} from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import type { AttachmentValidationError } from "../../../attachment-data-url.js";
import {
	type AttachmentRef,
	AttachmentRefSchema,
} from "../../../contracts/attachment-ref.js";
import type {
	DraftAttachment,
	DraftListItem,
	InputDraftEnvelope,
	InputDraftKey,
} from "../../../contracts/ws-rpc.js";
import { DraftAttachmentMissing } from "../../../contracts/ws-rpc.js";
import { makeAttachmentStore } from "../../../persistence/attachment-store.js";
import { inputDraftClaimMarker } from "../../../persistence/input-drafts.js";

export type { InputDraftKey } from "../../../contracts/ws-rpc.js";

export interface DraftChange {
	readonly write: Effect.Effect<
		void,
		DraftAttachmentMissing,
		SqlClient.SqlClient
	>;
	readonly publish: Effect.Effect<void>;
}

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
	readonly addAttachment: (
		key: InputDraftKey,
		id: string,
		dataUrl: string,
		name?: string,
		projectId?: string,
	) => Effect.Effect<
		{ attachment: DraftAttachment } | { ended: "removed" | "sent" },
		SqlError | AttachmentValidationError
	>;
	readonly removeAttachment: (
		key: InputDraftKey,
		id: string,
		projectId?: string,
	) => Effect.Effect<void, SqlError>;
	readonly takeForSend: (
		key: InputDraftKey,
		ids: readonly string[],
	) => Effect.Effect<
		readonly AttachmentRef[],
		SqlError | DraftAttachmentMissing
	>;
	readonly sendChange: (
		key: InputDraftKey,
		sessionId: string,
		text: string,
		ids: readonly string[],
		refs: readonly AttachmentRef[],
	) => DraftChange;
	readonly restoreChange: (
		key: InputDraftKey,
		inputId: string,
		refs: readonly AttachmentRef[],
	) => DraftChange;
	/**
	 * Return a refused send to its session's composer, text and attachments,
	 * without overwriting a newer draft.
	 */
	readonly restore: (
		sessionId: string,
		inputId: string,
		text: string,
		refs: readonly AttachmentRef[],
	) => Effect.Effect<void>;
	readonly claim: (
		draftId: string,
		projectId: string,
	) => Effect.Effect<boolean, SqlError>;
	readonly releaseClaim: (draftId: string) => Effect.Effect<void, SqlError>;
	readonly promotionChange: (
		key: InputDraftKey,
		sessionId: string,
		text: string,
	) => DraftChange;
	readonly demote: (
		key: InputDraftKey,
		sessionId: string,
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

// Live rows count as content. Tombstones are retained separately for late Adds.
const hasDraftContent = `(input_drafts.text != '' OR EXISTS (
	SELECT 1 FROM draft_attachments
	WHERE draft_key = input_drafts.draft_key AND state = 'live'
))`;

/** No in-flight create can survive the daemon process that owned its claim. */
export const releaseInputDraftClaims = () =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql.withTransaction(
			Effect.gen(function* () {
				yield* sql`DELETE FROM input_drafts
					WHERE kind = 'draft' AND (promoted_session_id IS NULL OR promoted_session_id = ${inputDraftClaimMarker})
					AND NOT ${sql.literal(hasDraftContent)}
					AND NOT EXISTS (SELECT 1 FROM draft_attachments WHERE draft_key = input_drafts.draft_key)`;
				yield* sql`UPDATE input_drafts SET promoted_session_id = NULL
					WHERE promoted_session_id = ${inputDraftClaimMarker}`;
			}),
		);
	});

/** Import owns its transaction; only release claims copied by that import. */
export function releaseCopiedInputDraftClaims(
	db: Pick<DatabaseSync, "prepare">,
) {
	db.prepare(`DELETE FROM main.input_drafts
		WHERE kind = 'draft' AND (promoted_session_id IS NULL OR promoted_session_id = ?)
		AND NOT ${hasDraftContent}
		AND NOT EXISTS (SELECT 1 FROM main.draft_attachments WHERE draft_key = input_drafts.draft_key)
		AND draft_key IN (SELECT draft_key FROM source.input_drafts)`).run(
		inputDraftClaimMarker,
	);
	db.prepare(`UPDATE main.input_drafts SET promoted_session_id = NULL
		WHERE promoted_session_id = ?
		AND draft_key IN (SELECT draft_key FROM source.input_drafts)`).run(
		inputDraftClaimMarker,
	);
}

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
	const attachments = yield* makeAttachmentStore;
	const changes = yield* PubSub.unbounded<{
		readonly key: InputDraftKey;
		readonly envelope: InputDraftEnvelope;
	}>();
	const draftChanges = yield* PubSub.unbounded<void>();
	// A snapshot cannot observe a committed promotion before its live publication.
	const snapshotGate = yield* Semaphore.make(1);
	let promotionFailureInjected = false;
	const readRow = (key: InputDraftKey) =>
		sql<{
			text: string;
			project_id: string;
			promoted_session_id: string | null;
		}>`SELECT text, project_id, promoted_session_id FROM input_drafts
			WHERE draft_key = ${keyOf(key)} AND kind = ${kindOf(key)}`.pipe(
			Effect.map((rows) => rows[0]),
		);
	const resolveKey = (key: InputDraftKey) =>
		Effect.gen(function* () {
			const row = yield* readRow(key);
			return "draft" in key &&
				row?.promoted_session_id != null &&
				row.promoted_session_id !== inputDraftClaimMarker
				? { session: row.promoted_session_id }
				: key;
		});
	const readAttachments = (key: InputDraftKey) =>
		sql<{
			id: string;
			name: string | null;
			mime: AttachmentRef["mime"];
			size: number;
			hash: string;
		}>`SELECT attachment.id, attachment.name, blob.mime, blob.size, attachment.hash
			FROM draft_attachments attachment JOIN attachment_blobs blob ON blob.hash = attachment.hash
			WHERE attachment.draft_key = ${keyOf(key)} AND attachment.state = 'live'
			ORDER BY attachment.position, attachment.id`;
	const snapshotAttachments = (key: InputDraftKey) =>
		readAttachments(key).pipe(
			Effect.map((rows) =>
				rows.map((row) => ({ ...row, name: row.name ?? "attachment" })),
			),
		);
	// Ids derive from the input, so restoring the same refusal twice adds nothing.
	const restoreAttachments = (
		key: InputDraftKey,
		inputId: string,
		refs: readonly AttachmentRef[],
	) =>
		Effect.forEach(
			refs,
			(ref, index) =>
				sql`INSERT OR IGNORE INTO draft_attachments
				(id, draft_key, position, name, hash, state, created_at)
				SELECT ${`${inputId}:${index}`}, ${keyOf(key)}, COALESCE(MAX(position), -1) + 1,
				${ref.name ?? null}, ${ref.attachmentHash}, 'live', ${Date.now()}
				FROM draft_attachments WHERE draft_key = ${keyOf(key)}`,
			{ discard: true },
		);
	const ensureDraft = (key: InputDraftKey, projectId?: string) =>
		Effect.gen(function* () {
			if ("session" in key) {
				yield* sql`INSERT INTO input_drafts (draft_key, project_id, kind, text, updated_at)
					SELECT id, project_id, 'session', '', ${Date.now()} FROM sessions WHERE id = ${key.session}
					ON CONFLICT (draft_key) DO NOTHING`;
			} else if (projectId !== undefined) {
				yield* sql`INSERT OR IGNORE INTO input_drafts (draft_key, project_id, kind, text, updated_at)
					VALUES (${key.draft}, ${projectId}, 'draft', '', ${Date.now()})`;
			}
			return (yield* readRow(key)) !== undefined;
		});
	const publishDraft = (key: InputDraftKey, from?: string) =>
		Effect.gen(function* () {
			const row = yield* readRow(key).pipe(Effect.orDie);
			const liveAttachments = yield* snapshotAttachments(key).pipe(
				Effect.orDie,
			);
			yield* PubSub.publish(changes, {
				key,
				envelope: {
					_tag: "draft",
					text: row?.text ?? "",
					attachments: liveAttachments,
					...(from === undefined ? {} : { from }),
					...("draft" in key && row ? { projectId: row.project_id } : {}),
				},
			});
			if ("draft" in key) yield* PubSub.publish(draftChanges, undefined);
		});
	const selectedAttachments = (key: InputDraftKey, ids: readonly string[]) =>
		Effect.gen(function* () {
			const actualKey = yield* resolveKey(key);
			const rows = yield* readAttachments(actualKey);
			const byId = new Map(rows.map((row) => [row.id, row]));
			const missing = ids.filter((id) => !byId.has(id));
			if (missing.length > 0)
				return yield* new DraftAttachmentMissing({ ids: missing });
			return {
				actualKey,
				rows: ids.flatMap((id) => {
					const row = byId.get(id);
					return row === undefined ? [] : [row];
				}),
			};
		});
	const readDrafts = sql<DraftListItem>`SELECT draft_key AS draftId,
		project_id AS projectSlug, substr(text, 1, 160) AS firstLine,
		updated_at AS updatedAt,
		(SELECT COUNT(*) FROM draft_attachments attachment JOIN attachment_blobs blob ON blob.hash = attachment.hash
			WHERE attachment.draft_key = input_drafts.draft_key AND attachment.state = 'live' AND blob.mime LIKE 'image/%') AS imageCount,
		(SELECT COUNT(*) FROM draft_attachments attachment JOIN attachment_blobs blob ON blob.hash = attachment.hash
			WHERE attachment.draft_key = input_drafts.draft_key AND attachment.state = 'live' AND blob.mime NOT LIKE 'image/%') AS fileCount
		FROM input_drafts
		WHERE kind = 'draft' AND ${sql.literal(hasDraftContent)} AND promoted_session_id IS NULL
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
											AND promoted_session_id IS NULL
											AND NOT EXISTS (SELECT 1 FROM draft_attachments WHERE draft_key = input_drafts.draft_key)
											RETURNING draft_key`;
										const cleared = yield* sql<{
											draft_key: string;
										}>`UPDATE input_drafts
											SET text = '', updated_at = ${Date.now()}
											WHERE draft_key = ${key.draft} AND kind = 'draft'
											AND promoted_session_id IS NULL RETURNING draft_key`;
										const blocked = yield* sql<{ draft_key: string }>`
											SELECT draft_key FROM input_drafts
											WHERE draft_key = ${key.draft}
											AND promoted_session_id IS NOT NULL`;
										return {
											writable: blocked.length === 0,
											changed: deleted.length > 0 || cleared.length > 0,
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
				yield* snapshotGate.withPermits(1)(
					Effect.gen(function* () {
						yield* PubSub.publish(changes, {
							key,
							envelope: {
								_tag: "draft",
								text,
								attachments: yield* snapshotAttachments(key).pipe(Effect.orDie),
								...(from !== undefined ? { from } : {}),
								...("draft" in key && projectId !== undefined
									? { projectId }
									: {}),
							},
						});
					}),
				);
			}),
		addAttachment: (key, id, dataUrl, name, projectId) =>
			snapshotGate.withPermits(1)(
				Effect.gen(function* () {
					const result = yield* sql.withTransaction(
						Effect.gen(function* () {
							const actualKey = yield* resolveKey(key);
							const [existing] = yield* sql<{
								state: "live" | "removed" | "sent";
								draft_key: string;
							}>`
						SELECT state, draft_key FROM draft_attachments WHERE id = ${id}`;
							if (existing?.state === "removed" || existing?.state === "sent")
								return { ended: existing.state };
							if (!existing) {
								if (!(yield* ensureDraft(actualKey, projectId)))
									return { ended: "removed" as const };
								const ref = yield* attachments.put(dataUrl);
								yield* sql`INSERT INTO draft_attachments (id, draft_key, position, name, hash, state, created_at)
							SELECT ${id}, ${keyOf(actualKey)}, COALESCE(MAX(position), -1) + 1,
							${name ?? ref.name ?? null}, ${ref.attachmentHash}, 'live', ${Date.now()}
							FROM draft_attachments WHERE draft_key = ${keyOf(actualKey)}`;
								if ("draft" in actualKey)
									yield* sql`UPDATE input_drafts SET updated_at = ${Date.now()}
							WHERE draft_key = ${keyOf(actualKey)}`;
							}
							const item = (yield* snapshotAttachments(actualKey)).find(
								(row) => row.id === id,
							);
							return item === undefined
								? { ended: "removed" as const }
								: { attachment: item };
						}),
					);
					yield* publishDraft(yield* resolveKey(key).pipe(Effect.orDie));
					return result;
				}),
			),
		removeAttachment: (key, id, projectId) =>
			snapshotGate.withPermits(1)(
				Effect.gen(function* () {
					const actualKey = yield* resolveKey(key);
					yield* sql.withTransaction(
						Effect.gen(function* () {
							if (!(yield* ensureDraft(actualKey, projectId))) return;
							yield* sql`INSERT INTO draft_attachments (id, draft_key, position, name, hash, state, created_at)
						VALUES (${id}, ${keyOf(actualKey)}, 0, NULL, NULL, 'removed', ${Date.now()})
						ON CONFLICT (id) DO UPDATE SET state = 'removed', hash = NULL
						WHERE draft_attachments.draft_key = ${keyOf(actualKey)} AND draft_attachments.state = 'live'`;
						}),
					);
					yield* publishDraft(actualKey);
				}),
			),
		takeForSend: (key, ids) =>
			selectedAttachments(key, ids).pipe(
				Effect.map(({ rows }) =>
					rows.map((row) =>
						Schema.decodeUnknownSync(AttachmentRefSchema)({
							attachmentHash: row.hash,
							mime: row.mime,
							...(row.name === null ? {} : { name: row.name }),
						}),
					),
				),
			),
		sendChange: (key, sessionId, text, ids, refs) => ({
			write: Effect.gen(function* () {
				const { actualKey, rows } = yield* selectedAttachments(key, ids).pipe(
					Effect.catchTag("SqlError", Effect.die),
				);
				const missing = ids.filter(
					(_, index) => rows[index]?.hash !== refs[index]?.attachmentHash,
				);
				if (missing.length > 0)
					return yield* new DraftAttachmentMissing({ ids: missing });
				yield* sql`UPDATE input_drafts SET text = '', updated_at = ${Date.now()}
					WHERE draft_key IN (${keyOf(key)}, ${keyOf(actualKey)}, ${sessionId}) AND text = ${text}`.pipe(
					Effect.orDie,
				);
				for (const id of ids)
					yield* sql`UPDATE draft_attachments SET state = 'sent', hash = NULL
					WHERE id = ${id} AND draft_key = ${keyOf(actualKey)} AND state = 'live'`.pipe(
						Effect.orDie,
					);
			}),
			publish: snapshotGate.withPermits(1)(
				Effect.gen(function* () {
					const actualKey = yield* resolveKey(key).pipe(Effect.orDie);
					yield* publishDraft(key);
					if (keyOf(actualKey) !== keyOf(key)) yield* publishDraft(actualKey);
					if (sessionId !== keyOf(key) && sessionId !== keyOf(actualKey))
						yield* publishDraft({ session: sessionId });
				}),
			),
		}),
		restoreChange: (key, inputId, refs) => ({
			write: Effect.gen(function* () {
				const actualKey = yield* resolveKey(key).pipe(Effect.orDie);
				if (!(yield* ensureDraft(actualKey).pipe(Effect.orDie))) return;
				yield* restoreAttachments(actualKey, inputId, refs).pipe(Effect.orDie);
			}),
			publish: snapshotGate.withPermits(1)(
				Effect.gen(function* () {
					yield* publishDraft(yield* resolveKey(key).pipe(Effect.orDie));
				}),
			),
		}),
		restore: (sessionId, inputId, text, refs) =>
			Effect.gen(function* () {
				const key = { session: sessionId };
				const restored = yield* sql.withTransaction(
					Effect.gen(function* () {
						const rows = yield* sql<{
							text: string;
						}>`INSERT INTO input_drafts (draft_key, project_id, kind, text, updated_at)
							SELECT id, project_id, 'session', ${text}, ${Date.now()}
							FROM sessions WHERE id = ${sessionId}
							ON CONFLICT (draft_key) DO UPDATE SET
								text = excluded.text || CASE WHEN input_drafts.text != '' AND input_drafts.text != excluded.text
									THEN '\n\n' || input_drafts.text ELSE '' END,
								updated_at = excluded.updated_at
							WHERE input_drafts.kind = 'session' AND input_drafts.promoted_session_id IS NULL
							RETURNING text`;
						if (rows[0]) yield* restoreAttachments(key, inputId, refs);
						return rows[0]?.text;
					}),
				);
				if (restored === undefined) return;
				yield* snapshotGate.withPermits(1)(
					Effect.gen(function* () {
						const attachments = yield* snapshotAttachments(key);
						yield* PubSub.publish(changes, {
							key,
							envelope: {
								_tag: "draft",
								text: restored,
								attachments,
								restored: text,
							},
						});
					}),
				);
			}).pipe(
				Effect.catch((cause) =>
					Effect.logError(
						`Could not restore input draft ${sessionId}: ${cause}`,
					),
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
						AND promoted_session_id = ${inputDraftClaimMarker} AND NOT ${sql.literal(hasDraftContent)}
						AND NOT EXISTS (SELECT 1 FROM draft_attachments WHERE draft_key = input_drafts.draft_key)
						RETURNING draft_key`;
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
		promotionChange: (key, sessionId, text) => {
			let promoted = false;
			return {
				write: Effect.gen(function* () {
					promoted = false;
					const [claimed] = yield* sql<{ draft_key: string }>`
					SELECT draft_key FROM input_drafts WHERE draft_key = ${keyOf(key)} AND kind = 'draft'
					AND promoted_session_id = ${inputDraftClaimMarker}`.pipe(
						Effect.orDie,
					);
					if (!claimed) return;
					yield* sql`INSERT INTO input_drafts (draft_key, project_id, kind, text, updated_at)
					SELECT ${sessionId}, project_id, 'session', text, ${Date.now()} FROM input_drafts
					WHERE draft_key = ${keyOf(key)}
					ON CONFLICT (draft_key) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`.pipe(
						Effect.orDie,
					);
					// Move all states, including removed/sent ids, so a late Add stays ended.
					yield* sql`UPDATE draft_attachments SET draft_key = ${sessionId}
					WHERE draft_key = ${keyOf(key)}`.pipe(Effect.orDie);
					yield* sql`UPDATE input_drafts SET promoted_session_id = ${sessionId}, text = '', updated_at = ${Date.now()}
					WHERE draft_key = ${keyOf(key)}`.pipe(Effect.orDie);
					// One-shot, after the writes: the harness proves the whole create rolls back.
					if (
						process.env["NODE_ENV"] === "test" &&
						!promotionFailureInjected &&
						process.env["CONDUIT_TEST_DRAFT_PROMOTION_WRITE_FAILURE"] ===
							keyOf(key)
					) {
						promotionFailureInjected = true;
						yield* Effect.logError("Test Draft promotion write failure");
						return yield* Effect.die(
							new Error("Test Draft promotion write failure"),
						);
					}
					promoted = true;
				}),
				publish: snapshotGate.withPermits(1)(
					Effect.gen(function* () {
						if (!promoted) return;
						yield* PubSub.publish(draftChanges, undefined);
						yield* PubSub.publish(changes, {
							key,
							envelope: { _tag: "promoted", sessionId, text },
						});
					}),
				),
			};
		},
		demote: (key, sessionId) =>
			sql.withTransaction(
				Effect.gen(function* () {
					const restored = yield* sql<{ draft_key: string }>`UPDATE input_drafts
						SET text = (SELECT text FROM input_drafts WHERE draft_key = ${sessionId} AND kind = 'session'),
						promoted_session_id = ${inputDraftClaimMarker}, updated_at = ${Date.now()}
						WHERE draft_key = ${keyOf(key)} AND kind = 'draft' AND promoted_session_id = ${sessionId}
						RETURNING draft_key`;
					if (restored.length === 0) return;
					yield* sql`UPDATE draft_attachments SET draft_key = ${keyOf(key)} WHERE draft_key = ${sessionId}`;
					yield* sql`DELETE FROM input_drafts WHERE draft_key = ${sessionId} AND kind = 'session'`;
				}),
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
									attachments:
										promotedSessionId === undefined
											? yield* snapshotAttachments(key).pipe(Effect.orDie)
											: [],
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
			snapshotGate.withPermits(1)(
				PubSub.publish(draftChanges, undefined).pipe(
					Effect.andThen(publishDraft({ session: sessionId })),
					Effect.asVoid,
				),
			),
	} satisfies InputDrafts;
});

export const InputDraftsLive: Layer.Layer<
	InputDraftsTag,
	never,
	SqlClient.SqlClient
> = Layer.effect(InputDraftsTag, makeInputDrafts);
