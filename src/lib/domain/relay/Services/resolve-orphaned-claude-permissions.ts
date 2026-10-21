import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql";
import { makeCommitAndSignal } from "../../../persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../persistence/effect/event-store-effect.js";
import { ProjectionRunnerEffectTag } from "../../../persistence/effect/projection-runner-effect.js";
import { canonicalEvent } from "../../../persistence/events.js";
import { ProviderRegistryTag } from "../../../provider/provider-registry.js";
import { RunnerProviderInstance } from "../../../provider/runner/runner-provider-instance.js";
import { PendingInteractionServiceTag } from "./pending-interaction-service.js";

/**
 * Reject the Claude permissions a crash left pending.
 *
 * Live runner callbacks are restored before this runs. A quarantined live
 * process still owns its asks even without a restored waiter. Leaving orphaned
 * asks pending would keep the session "needing you". OpenCode recovers its own
 * permissions, so ownership comes from the provider that recorded the ask,
 * regardless of the session's current provider.
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
		JOIN sessions s ON s.id = pa.session_id
		WHERE s.project_id = ${eventStore.value.projectId}
			AND pa.type = 'permission'
			AND pa.status = 'pending'
			AND EXISTS (
				SELECT 1 FROM events e
				WHERE e.session_id = pa.session_id
					AND e.project_id = ${eventStore.value.projectId}
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
	const registry = yield* Effect.serviceOption(ProviderRegistryTag);
	const claude = Option.getOrUndefined(registry)?.getInstance("claude");
	const stale: (typeof orphans)[number][] = [];
	for (const row of orphans) {
		if (liveRequests.has(`${row.session_id}:${row.id}`)) continue;
		if (
			claude instanceof RunnerProviderInstance &&
			(yield* claude.getSessionFailureEffect(row.session_id))
		)
			continue;
		stale.push(row);
	}
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
