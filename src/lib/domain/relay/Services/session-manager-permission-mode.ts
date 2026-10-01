import { SqlClient } from "@effect/sql";
import { Effect, Schema } from "effect";
import { makeCommitAndSignal } from "../../../persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../persistence/effect/event-store-effect.js";
import { ProjectionRunnerEffectTag } from "../../../persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../persistence/events.js";
import {
	type SessionPermissionMode,
	SessionPermissionModeSchema,
} from "../../../shared-types.js";
import { SessionManagerError } from "./session-manager-error.js";
import { setPermissionMode } from "./session-overrides-state.js";

export const persistSessionPermissionMode = (
	sessionId: string,
	mode: SessionPermissionMode,
) =>
	Effect.gen(function* () {
		const eventStore = yield* EventStoreEffectTag;
		const projectionRunner = yield* ProjectionRunnerEffectTag;
		const sql = yield* SqlClient.SqlClient;

		const commitAndSignal = yield* makeCommitAndSignal.pipe(
			Effect.provideService(SqlClient.SqlClient, sql),
			Effect.provideService(EventStoreEffectTag, eventStore),
			Effect.provideService(ProjectionRunnerEffectTag, projectionRunner),
		);
		yield* commitAndSignal([
			canonicalEvent(
				"session.permission_mode_changed",
				sessionId,
				{ sessionId, mode },
				{
					createdAt: Date.now(),
					metadata: { source: "relay" },
				},
			),
		]).pipe(
			Effect.mapError(
				(cause) =>
					new SessionManagerError({
						operation: "persistPermissionMode.commit",
						cause,
					}),
			),
		);
	});

export const restoreSessionPermissionModes = () =>
	Effect.gen(function* () {
		const readQuery = yield* ReadQueryEffectTag;
		const projectionRunner = yield* ProjectionRunnerEffectTag;
		const sql = yield* SqlClient.SqlClient;

		const withSql = <A, E>(
			effect: Effect.Effect<A, E, SqlClient.SqlClient>,
		): Effect.Effect<A, E> =>
			effect.pipe(Effect.provideService(SqlClient.SqlClient, sql));

		const recovered = yield* projectionRunner.isRecovered();
		if (!recovered) {
			yield* withSql(projectionRunner.recover()).pipe(
				Effect.mapError(
					(cause) =>
						new SessionManagerError({
							operation: "restorePermissionModes.recover",
							cause,
						}),
				),
				Effect.asVoid,
			);
		}

		const rows = yield* readQuery.listSessions().pipe(
			Effect.mapError(
				(cause) =>
					new SessionManagerError({
						operation: "restorePermissionModes.listSessions",
						cause,
					}),
			),
		);
		const isSessionPermissionMode = Schema.is(SessionPermissionModeSchema);
		let restored = 0;
		for (const row of rows) {
			const mode = row.permission_mode;
			if (mode === null || !isSessionPermissionMode(mode)) continue;
			yield* setPermissionMode(row.id, mode);
			restored += 1;
		}
		return restored;
	});
