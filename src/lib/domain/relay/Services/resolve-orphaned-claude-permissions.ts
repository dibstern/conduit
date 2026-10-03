import { SqlClient } from "@effect/sql";
import { Effect, Option } from "effect";
import { makeCommitAndSignal } from "../../../persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../persistence/effect/event-store-effect.js";
import { ProjectionRunnerEffectTag } from "../../../persistence/effect/projection-runner-effect.js";
import { canonicalEvent } from "../../../persistence/events.js";
import { PendingInteractionServiceTag } from "./pending-interaction-service.js";

/**
 * Reject the Claude permissions a crash left pending.
 *
 * Live runner callbacks are restored before this runs. Only asks without a
 * restored waiter are orphaned; leaving them pending would keep the session
 * "needing you". OpenCode's permissions are recovered from OpenCode, so the
 * owner is read from the provider that recorded the ask, not from whichever
 * provider the session uses now.
 *
 * Runs at relay startup, before the command gate opens, so it cannot reach an
 * ask a new turn registered.
 */
export const resolveOrphanedClaudePermissions = Effect.gen(function* () {
	const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
	const eventStore = yield* Effect.serviceOption(EventStoreEffectTag);
	const projectionRunner = yield* Effect.serviceOption(
		ProjectionRunnerEffectTag,
	);
	if (
		Option.isNone(sql) ||
		Option.isNone(eventStore) ||
		Option.isNone(projectionRunner)
	)
		return 0;

	// The query reads the read model, so it has to be caught up first.
	if (!(yield* projectionRunner.value.isRecovered()))
		yield* projectionRunner.value
			.recover()
			.pipe(Effect.provideService(SqlClient.SqlClient, sql.value));

	const orphans = yield* sql.value<{ id: string; session_id: string }>`
		SELECT pa.id, pa.session_id
		FROM pending_approvals pa
		WHERE pa.type = 'permission'
			AND pa.status = 'pending'
			AND EXISTS (
				SELECT 1 FROM events e
				WHERE e.session_id = pa.session_id
					AND e.type = 'permission.asked'
					AND e.provider = 'claude'
					AND json_extract(e.data, '$.id') = pa.id
			)`;
	const pending = yield* Effect.serviceOption(PendingInteractionServiceTag);
	const liveRequests = Option.isSome(pending)
		? new Set(
				(yield* pending.value.listPendingPermissions()).map(
					(request) => `${request.sessionId}:${request.requestId}`,
				),
			)
		: new Set<string>();
	const stale = orphans.filter(
		(row) => !liveRequests.has(`${row.session_id}:${row.id}`),
	);
	if (stale.length === 0) return 0;

	const commitAndSignal = yield* makeCommitAndSignal.pipe(
		Effect.provideService(SqlClient.SqlClient, sql.value),
		Effect.provideService(EventStoreEffectTag, eventStore.value),
		Effect.provideService(ProjectionRunnerEffectTag, projectionRunner.value),
	);
	yield* commitAndSignal(
		stale.map((row) =>
			canonicalEvent(
				"permission.resolved",
				row.session_id,
				{ id: row.id, decision: "reject" },
				{ provider: "claude" },
			),
		),
	);
	return stale.length;
});
