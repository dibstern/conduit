// Composer work in progress lives beside the event log. Subscriptions remain
// live-only so reconnecting cannot overwrite text typed while offline.
import { Context, Effect, Layer, PubSub, Stream } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import type { InputDraftEnvelope } from "../../../contracts/ws-rpc.js";

export type InputDraftKey =
	| { readonly session: string }
	| { readonly draft: string };

export interface InputDrafts {
	readonly read: (
		key: InputDraftKey,
	) => Effect.Effect<string | undefined, SqlError>;
	readonly write: (
		key: InputDraftKey,
		text: string,
		from?: string,
	) => Effect.Effect<void>;
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
	const sql = yield* SqlClient.SqlClient;
	const changes = yield* PubSub.unbounded<{
		readonly key: InputDraftKey;
		readonly text: string;
		readonly from?: string;
	}>();

	return {
		read: (key) =>
			sql<{ text: string }>`SELECT text FROM input_drafts
			WHERE draft_key = ${keyOf(key)} AND kind = ${kindOf(key)}`.pipe(
				Effect.map((rows) => rows[0]?.text),
			),
		write: (key, text, from) =>
			Effect.gen(function* () {
				if (Buffer.byteLength(text, "utf8") > 1024 * 1024) {
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
						text = excluded.text, updated_at = excluded.updated_at`.pipe(
						Effect.catch((cause) =>
							Effect.logError(
								`Could not store input draft ${key.session}: ${cause}`,
							),
						),
					);
				}
				yield* PubSub.publish(changes, {
					key,
					text,
					...(from !== undefined ? { from } : {}),
				});
			}),
		subscribe: (key) =>
			Stream.unwrap(
				Effect.map(PubSub.subscribe(changes), (dequeue) =>
					Stream.concat(
						Stream.make<[InputDraftEnvelope]>({ _tag: "synchronized" }),
						Stream.fromSubscription(dequeue).pipe(
							Stream.filter(
								(change) =>
									keyOf(change.key) === keyOf(key) &&
									kindOf(change.key) === kindOf(key),
							),
							Stream.map(({ text, from }) => ({
								_tag: "draft" as const,
								text,
								...(from !== undefined ? { from } : {}),
							})),
						),
					),
				),
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
