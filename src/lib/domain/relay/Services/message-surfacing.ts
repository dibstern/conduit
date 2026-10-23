import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { sessionJevEnabled } from "../../../contracts/message-surfacing.js";
import type { CanonicalEvent } from "../../../contracts/stored-event.js";
import { makeCommitAndSignal } from "../../../persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../persistence/effect/event-store-effect.js";
import { CategorySet } from "../../daemon/Services/category-set.js";
import { JEV_MODEL, judge } from "../../daemon/Services/jev-client.js";
import { MessageSurfacingSettings } from "../../daemon/Services/message-surfacing-settings.js";

type Part = { readonly messageId: string; readonly partId: string };

/**
 * Judges each mid-turn text part once, when the next text, thinking or tool
 * block of its turn folds it. Ingestion calls `observe` after each live commit;
 * projection replay and history import never pass through it.
 */
export const makeMessageSurfacing = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const store = yield* EventStoreEffectTag;
	const commit = yield* makeCommitAndSignal;
	const settings = yield* MessageSurfacingSettings;
	const categories = yield* CategorySet;
	const scope = yield* Effect.scope;
	const open = new Map<string, Part>();
	const inFlight = new Set<string>();

	const surface = (sessionId: string, provider: string, part: Part) =>
		Effect.gen(function* () {
			const eventId = `text-surfaced:${part.partId}`;
			const [row] = yield* sql<{
				text: string;
				request: string;
				judged: number;
			}>`SELECT COALESCE(mp.text, '') AS text,
				COALESCE(u.text, (SELECT text FROM messages WHERE session_id = m.session_id
					AND role = 'user' AND created_at <= m.created_at
					ORDER BY created_at DESC LIMIT 1), '') AS request,
				(mp.surfacing_ordinal IS NOT NULL OR EXISTS (SELECT 1 FROM events WHERE event_id = ${eventId})) AS judged
				FROM message_parts mp JOIN messages m ON m.id = mp.message_id
				LEFT JOIN turns t ON t.id = m.turn_id AND t.session_id = m.session_id
				LEFT JOIN messages u ON u.id = t.user_message_id AND u.session_id = m.session_id
				WHERE mp.id = ${part.partId} AND m.id = ${part.messageId}
				AND m.session_id = ${sessionId} AND m.role = 'assistant'
				AND mp.type = 'text' AND m.is_backfilled = 0`;
			if (!row || row.judged) return;
			// Every earlier text part of the turn was folded by its successor.
			const order = yield* sql<{ id: string }>`SELECT mp.id
				FROM message_parts mp JOIN messages m ON m.id = mp.message_id
				JOIN messages target ON target.id = ${part.messageId}
				WHERE m.session_id = target.session_id AND m.role = 'assistant'
				AND mp.type = 'text'
				AND (m.turn_id = target.turn_id OR (target.turn_id IS NULL AND m.id = target.id))
				ORDER BY m.created_at, mp.sort_order, mp.created_at, mp.id`;
			const ordinal = order.findIndex(({ id }) => id === part.partId) + 1;
			const set = yield* categories.current();
			const probabilities = yield* judge(
				{ request: row.request, message: row.text },
				set,
			).pipe(
				Effect.provideService(MessageSurfacingSettings, settings),
				Effect.catch((error) =>
					Effect.logWarning(`Jev could not judge ${part.partId}`, error).pipe(
						Effect.as(null),
					),
				),
			);
			yield* commit.write((project) =>
				Effect.gen(function* () {
					const existing =
						yield* sql`SELECT 1 FROM events WHERE event_id = ${eventId}`;
					if (existing.length > 0) return;
					const stored = yield* store.append({
						eventId,
						sessionId,
						type: "text.surfaced",
						data: {
							messageId: part.messageId,
							partId: part.partId,
							ordinal,
							categorySetVersion: set.version,
							model: JEV_MODEL,
							probabilities,
						},
						metadata: { source: "message-surfacing" },
						provider,
						createdAt: Date.now(),
					});
					yield* project([stored]);
				}),
			);
		}).pipe(
			Effect.catchCause((cause) =>
				Effect.logWarning(`Jev verdict for ${part.partId} failed`, cause),
			),
			Effect.ensuring(Effect.sync(() => inFlight.delete(part.partId))),
		);

	// The Jev switch is read at the fold; a call already forked still finishes.
	const fold = (sessionId: string, part: Part) =>
		Effect.gen(function* () {
			if (inFlight.has(part.partId)) return;
			const [session] = yield* sql<{
				jev: "on" | "off" | null;
				provider: string;
			}>`SELECT jev, provider FROM sessions WHERE id = ${sessionId}`;
			if (!session || !sessionJevEnabled(session, yield* settings.get)) return;
			inFlight.add(part.partId);
			yield* Effect.forkIn(surface(sessionId, session.provider, part), scope);
		});

	return {
		observe: (events: readonly CanonicalEvent[]) =>
			Effect.gen(function* () {
				for (const event of events) {
					const current = open.get(event.sessionId);
					if (event.type === "text.delta") {
						if (current && current.partId !== event.data.partId)
							yield* fold(event.sessionId, current);
						open.set(event.sessionId, {
							messageId: event.data.messageId,
							partId: event.data.partId,
						});
					} else if (
						event.type === "tool.started" ||
						event.type === "thinking.start"
					) {
						if (current) yield* fold(event.sessionId, current);
						open.delete(event.sessionId);
					} else if (
						event.type === "turn.completed" ||
						event.type === "turn.error" ||
						event.type === "turn.interrupted" ||
						event.type === "session.deleted" ||
						(event.type === "message.created" && event.data.role === "user")
					)
						// The final reply is never folded.
						open.delete(event.sessionId);
				}
			}).pipe(
				Effect.catchCause((cause) =>
					Effect.logWarning("Jev fold detection failed", cause),
				),
			),
	};
});
