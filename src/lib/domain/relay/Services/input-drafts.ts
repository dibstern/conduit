// Composer work in progress lives beside the event log. Each subscription
// opens with the stored text, followed by live changes.
import { Context, Effect, Layer, Option, PubSub, Stream } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import type {
	InputDraftEnvelope,
	InputDraftKey,
} from "../../../contracts/ws-rpc.js";

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
	readonly subscribe: (key: InputDraftKey) => Stream.Stream<InputDraftEnvelope>;
	readonly forget: (sessionId: string) => Effect.Effect<void, SqlError>;
}

export class InputDraftsTag extends Context.Service<
	InputDraftsTag,
	InputDrafts
>()("InputDrafts") {}

const keyOf = (key: InputDraftKey) =>
	"session" in key ? key.session : key.draft;
const kindOf = (key: InputDraftKey) => ("session" in key ? "session" : "draft");

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
		readonly text: string;
		readonly from?: string;
		readonly projectId?: string;
	}>();
	const readRow = (key: InputDraftKey) =>
		sql<{
			text: string;
			project_id: string;
		}>`SELECT text, project_id FROM input_drafts
			WHERE draft_key = ${keyOf(key)} AND kind = ${kindOf(key)}
			AND promoted_session_id IS NULL`.pipe(Effect.map((rows) => rows[0]));

	return {
		read: (key) => readRow(key).pipe(Effect.map((row) => row?.text)),
		write: (key, text, from, projectId) =>
			Effect.gen(function* () {
				const oversized = Buffer.byteLength(text, "utf8") > 1024 * 1024;
				if ("draft" in key && (text === "" || oversized)) {
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
					const writable = yield* (
						text === ""
							? sql<{ draft_key: string }>`DELETE FROM input_drafts
							WHERE draft_key = ${key.draft} AND kind = 'draft'
							AND promoted_session_id IS NULL RETURNING draft_key`
							: sql<{ draft_key: string }>`INSERT INTO input_drafts
							(draft_key, project_id, kind, text, updated_at)
							VALUES (${key.draft}, ${projectId}, 'draft', ${text}, ${Date.now()})
							ON CONFLICT (draft_key) DO UPDATE SET
								project_id = excluded.project_id, text = excluded.text,
								updated_at = excluded.updated_at
							WHERE input_drafts.kind = 'draft'
							AND input_drafts.promoted_session_id IS NULL
							RETURNING draft_key`
					).pipe(
						Effect.catch((cause) =>
							Effect.logError(
								`Could not store input draft ${key.draft}: ${cause}`,
							).pipe(Effect.as(undefined)),
						),
					);
					// A promoted id cannot become writable or emit fresh draft text.
					if (text !== "" && writable?.length === 0) return;
				} else {
					return;
				}
				yield* PubSub.publish(changes, {
					key,
					text,
					...(from !== undefined ? { from } : {}),
					...("draft" in key && projectId !== undefined ? { projectId } : {}),
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
						? PubSub.publish(changes, { key: { session: sessionId }, text: "" })
						: Effect.void,
				),
				Effect.asVoid,
				Effect.catch((cause) =>
					Effect.logError(`Could not clear input draft ${sessionId}: ${cause}`),
				),
			),
		subscribe: (key) =>
			Stream.unwrap(
				Effect.gen(function* () {
					// Buffer writes made during the read so the snapshot has no gap.
					const dequeue = yield* PubSub.subscribe(changes);
					const row = yield* readRow(key).pipe(
						Effect.catch((cause) =>
							Effect.logError(
								`Could not read input draft ${keyOf(key)}: ${cause}`,
							).pipe(Effect.as(undefined)),
						),
					);
					return Stream.concat(
						Stream.make<[InputDraftEnvelope]>({
							_tag: "synchronized",
							...(row === undefined ? {} : { text: row.text }),
							...("draft" in key && row !== undefined
								? { projectId: row.project_id }
								: {}),
						}),
						Stream.fromSubscription(dequeue).pipe(
							Stream.filter(
								(change) =>
									keyOf(change.key) === keyOf(key) &&
									kindOf(change.key) === kindOf(key),
							),
							Stream.map(({ text, from, projectId }) => ({
								_tag: "draft" as const,
								text,
								...(from !== undefined ? { from } : {}),
								...(projectId !== undefined ? { projectId } : {}),
							})),
						),
					);
				}),
			),
		forget: (sessionId) =>
			sql`DELETE FROM input_drafts WHERE draft_key = ${sessionId} AND kind = 'session'`.pipe(
				Effect.asVoid,
			),
	} satisfies InputDrafts;
});

export const InputDraftsLive: Layer.Layer<
	InputDraftsTag,
	never,
	SqlClient.SqlClient
> = Layer.effect(InputDraftsTag, makeInputDrafts);
