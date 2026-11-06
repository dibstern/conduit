import { Context, Effect, Layer, Semaphore } from "effect";
import { SqlClient } from "effect/sql";
import type { OpenCodeRebind } from "../../../instance/opencode-api.js";
import {
	OPENCODE_NATIVES_KEY,
	readOpenCodeHolders,
	readOpenCodeNatives,
} from "../../../persistence/effect/head-realignment.js";

/**
 * The one owner of the map between Conduit's session ids and OpenCode's own
 * (82tn.80, after t3code's `nativeThreadRef`). The map is `sessions.provider_sid`,
 * written by the session.created projector; a row without one, and an id no
 * row binds, map to themselves, so sessions Conduit adopted keep identity.
 * A Conduit session can run on several native sessions (82tn.52, after t3code's
 * rollbackThread): provider_state `opencode.natives` names the current one and,
 * for each, the copies OpenCode re-ided, so message ids read as Conduit's.
 */
export class OpenCodeSessionIds extends Context.Service<
	OpenCodeSessionIds,
	{
		/** The native session a Conduit session runs on. */
		readonly native: (sessionId: string) => Effect.Effect<string>;
		/** The Conduit session an instance's native session belongs to. */
		readonly conduit: (
			instanceId: string,
			nativeId: string,
		) => Effect.Effect<string>;
		/**
		 * Create a native session and write its binding as one step: a native id
		 * no row knows yet waits here, so its first events and listings cannot
		 * adopt it under its own id.
		 */
		readonly binding: <A, E, R>(
			create: Effect.Effect<A, E, R>,
		) => Effect.Effect<A, E, R>;
		/** Each copied message or part id in a native session -> the Conduit id it copies. */
		readonly copies: (
			sessionId: string,
			nativeId: string,
		) => Effect.Effect<Readonly<Record<string, string>>>;
		/** Native sessions the Conduit session left whose path holds the message. */
		readonly holders: (
			sessionId: string,
			messageId: string,
		) => Effect.Effect<ReadonlyArray<{ native: string; tip: string }>>;
		/**
		 * Run `step` inside the gate, then record the move it returns as one write: a
		 * crash between a copy and its record leaves the session where it was, and the
		 * copy's events wait here instead of adopting it.
		 */
		readonly rebind: <E, R>(
			sessionId: string,
			step: Effect.Effect<OpenCodeRebind | undefined, E, R>,
		) => Effect.Effect<void, E, R>;
	}
>()("OpenCodeSessionIds") {}

export const OpenCodeSessionIdsLive = Layer.effect(
	OpenCodeSessionIds,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const gate = yield* Semaphore.make(1);
		const bound = (instanceId: string, nativeId: string) =>
			sql<{ id: string }>`
				SELECT id FROM sessions
				WHERE (provider = ${instanceId} AND provider_sid = ${nativeId})
					OR id = ${nativeId}
				ORDER BY id = ${nativeId}
				LIMIT 1`.pipe(
				Effect.flatMap(([row]) =>
					row
						? Effect.succeed(row.id)
						: sql<{ id: string }>`
								SELECT p.session_id AS id
								FROM provider_state p JOIN sessions s ON s.id = p.session_id,
									json_each(p.value, '$.sessions') e
								WHERE p.key = ${OPENCODE_NATIVES_KEY} AND s.provider = ${instanceId}
									AND e.key = ${nativeId}
								LIMIT 1`.pipe(Effect.map((rows) => rows[0]?.id)),
				),
				// An unreadable store routes as before the map: by the id itself.
				Effect.orElseSucceed(() => undefined),
			);
		return {
			native: (sessionId) =>
				sql<{ native: string }>`
					SELECT COALESCE((SELECT json_extract(value, '$.current') FROM provider_state
						WHERE session_id = ${sessionId} AND key = ${OPENCODE_NATIVES_KEY}),
						provider_sid, id) AS native FROM sessions
					WHERE id = ${sessionId}`.pipe(
					Effect.flatMap(([row]) =>
						row
							? Effect.succeed(row.native)
							: // A deleted session's row is gone before its delete reaches
								// OpenCode; its creation event still names the binding.
								sql<{ native: string | null }>`
									SELECT json_extract(data, '$.providerSessionId') AS native
									FROM events WHERE session_id = ${sessionId} AND type = 'session.created'
									ORDER BY sequence LIMIT 1`.pipe(
									Effect.map((rows) => rows[0]?.native ?? sessionId),
								),
					),
					Effect.orDie,
				),
			conduit: (instanceId, nativeId) =>
				bound(instanceId, nativeId).pipe(
					Effect.flatMap((id) =>
						id === undefined
							? gate.withPermits(1)(bound(instanceId, nativeId))
							: Effect.succeed(id),
					),
					Effect.map((id) => id ?? nativeId),
				),
			binding: (create) => gate.withPermits(1)(create),
			copies: (sessionId, nativeId) =>
				readOpenCodeNatives(sql, sessionId).pipe(
					Effect.map(({ sessions }) => sessions[nativeId]?.copies ?? {}),
					Effect.orDie,
				),
			holders: (sessionId, messageId) =>
				sql<{ node: string | null }>`
					SELECT history_node_id AS node FROM messages WHERE id = ${messageId}
					UNION ALL SELECT node_id FROM history_off_head
					WHERE source_table = 'messages' AND row_key = ${messageId}`.pipe(
					Effect.flatMap(([row]) =>
						row?.node
							? readOpenCodeHolders(sql, sessionId, row.node)
							: Effect.succeed([]),
					),
					Effect.orDie,
				),
			rebind: (sessionId, step) =>
				gate
					.withPermits(1)(
						Effect.gen(function* () {
							const move = yield* step;
							if (!move) return;
							// A test holds here to crash between OpenCode's copy and a move onto another session.
							if (
								move.left &&
								process.env["NODE_ENV"] === "test" &&
								process.env["CONDUIT_TEST_OPENCODE_FORK_PAUSE_AT"] === "rebind"
							)
								yield* Effect.never;
							const { sessions } = yield* readOpenCodeNatives(
								sql,
								sessionId,
							).pipe(Effect.orDie);
							const value = JSON.stringify({
								current: move.current,
								sessions: {
									...sessions,
									[move.current]: sessions[move.current] ?? { copies: {} },
									...(move.left && {
										[move.left.native]: {
											copies: sessions[move.left.native]?.copies ?? {},
											tip: move.left.tip,
										},
									}),
									...(move.archive && {
										[move.archive.native]: {
											copies: move.archive.copies,
											tip: move.archive.tip,
										},
									}),
								},
							});
							yield* sql`
							INSERT INTO provider_state (session_id, key, value)
							VALUES (${sessionId}, ${OPENCODE_NATIVES_KEY}, ${value})
							ON CONFLICT (session_id, key) DO UPDATE SET value = excluded.value`.pipe(
								Effect.orDie,
							);
						}),
					)
					.pipe(Effect.uninterruptible),
		};
	}),
);
