import { SqlClient } from "@effect/sql";
import { Effect } from "effect";
import { makeCommitAndSignal } from "../../../persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../persistence/effect/event-store-effect.js";
import { ProjectionRunnerEffectTag } from "../../../persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import {
	type CanonicalEventType,
	canonicalEvent,
	type EventPayloadMap,
} from "../../../persistence/events.js";
import { SessionManagerError } from "./session-manager-error.js";
import {
	type ModelOverride,
	setContextWindow,
	setModel,
	setVariant,
} from "./session-overrides-state.js";

// A session's model, effort and context window live in OverridesState for the
// picker, and on the session row for dispatch and every tab (ni8.55). The
// canonical event bumps the row version and reaches peers as a shell upsert.
// Child sessions are not shell rows; the same version bump reaches their
// viewers as a family-feed upsert (ni8.28).

const commitSessionSetting = <T extends CanonicalEventType>(
	type: T,
	sessionId: string,
	data: EventPayloadMap[T],
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const eventStore = yield* EventStoreEffectTag;
		const projectionRunner = yield* ProjectionRunnerEffectTag;
		const commitAndSignal = yield* makeCommitAndSignal.pipe(
			Effect.provideService(SqlClient.SqlClient, sql),
			Effect.provideService(EventStoreEffectTag, eventStore),
			Effect.provideService(ProjectionRunnerEffectTag, projectionRunner),
		);
		yield* commitAndSignal([
			canonicalEvent(type, sessionId, data, {
				createdAt: Date.now(),
				metadata: { source: "relay" },
			}),
		]).pipe(
			Effect.mapError(
				(cause) =>
					new SessionManagerError({ operation: `commit.${type}`, cause }),
			),
		);
	});

const commitModel = (sessionId: string, model: ModelOverride) =>
	commitSessionSetting("session.model_changed", sessionId, {
		sessionId,
		modelId: model.modelID,
		providerId: model.providerID,
	});

/** A model the user picked for this session. */
export const selectSessionModel = (sessionId: string, model: ModelOverride) =>
	commitModel(sessionId, model).pipe(
		Effect.andThen(setModel(sessionId, model)),
	);

/** "" explicitly chooses the model's default effort. */
export const selectSessionVariant = (sessionId: string, variant: string) =>
	setVariant(sessionId, variant).pipe(
		Effect.andThen(
			commitSessionSetting("session.variant_changed", sessionId, {
				sessionId,
				variant,
			}),
		),
	);

/** "" explicitly chooses the model's default context window. */
export const selectSessionContextWindow = (
	sessionId: string,
	contextWindow: string,
) =>
	setContextWindow(sessionId, contextWindow).pipe(
		Effect.andThen(
			commitSessionSetting("session.context_window_changed", sessionId, {
				sessionId,
				contextWindow,
			}),
		),
	);

/**
 * Load the projected settings back into memory after a restart. The session row
 * is the durable pick, including choices changed after the last turn.
 */
export const restoreSessionModelSettings = () =>
	Effect.gen(function* () {
		const readQuery = yield* ReadQueryEffectTag;
		const rows = yield* readQuery.listSessions().pipe(
			Effect.mapError(
				(cause) =>
					new SessionManagerError({
						operation: "restoreModelSettings.listSessions",
						cause,
					}),
			),
		);
		let restored = 0;
		for (const row of rows) {
			if (row.model_id != null && row.model_provider != null)
				yield* setModel(row.id, {
					modelID: row.model_id,
					providerID: row.model_provider,
				});
			if (row.variant != null) yield* setVariant(row.id, row.variant);
			if (row.context_window != null)
				yield* setContextWindow(row.id, row.context_window);
			if (
				row.model_id != null ||
				row.variant != null ||
				row.context_window != null
			)
				restored += 1;
		}
		return restored;
	});
