import { SqlClient } from "@effect/sql";
import { Effect } from "effect";
import { makeCommitAndSignal } from "../../../persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../persistence/effect/event-store-effect.js";
import { ProjectionRunnerEffectTag } from "../../../persistence/effect/projection-runner-effect.js";
import { canonicalEvent } from "../../../persistence/events.js";
import type { SessionPermissionMode } from "../../../shared-types.js";
import { SessionManagerError } from "./session-manager-error.js";

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
