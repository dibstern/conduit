import { Context, Effect, Layer, Semaphore } from "effect";
import { SqlClient } from "effect/sql";

/**
 * The one owner of the map between Conduit's session ids and OpenCode's own
 * (82tn.80, after t3code's `nativeThreadRef`). The map is `sessions.provider_sid`,
 * written by the session.created projector; a row without one, and an id no
 * row binds, map to themselves, so sessions Conduit adopted keep identity.
 * Message ids are identity inside one native session.
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
				Effect.map((rows) => rows[0]?.id),
				// An unreadable store routes as before the map: by the id itself.
				Effect.orElseSucceed(() => undefined),
			);
		return {
			native: (sessionId) =>
				sql<{ native: string }>`
					SELECT COALESCE(provider_sid, id) AS native FROM sessions
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
		};
	}),
);
