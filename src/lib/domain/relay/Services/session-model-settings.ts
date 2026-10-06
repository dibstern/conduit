import { SqlClient } from "@effect/sql";
import { Effect } from "effect";
import { formatErrorDetail } from "../../../errors.js";
import { makeCommitAndSignal } from "../../../persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../persistence/effect/event-store-effect.js";
import { ProjectionRunnerEffectTag } from "../../../persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import {
	type CanonicalEventType,
	canonicalEvent,
	type EventPayloadMap,
} from "../../../persistence/events.js";
import { LoggerTag } from "./services.js";
import { SessionManagerError } from "./session-manager-error.js";
import { SessionManagerServiceTag } from "./session-manager-service.js";
import {
	type ModelOverride,
	setContextWindow,
	setModel,
	setModelDefault,
	setVariant,
} from "./session-overrides-state.js";

// A session's model, effort and context window live in OverridesState for the
// turn path, and on the session row for every tab (ni8.55). Each write goes
// through here so the two cannot drift: memory first, then the canonical event
// whose projection bumps the row version and reaches peers as a shell upsert.
// Child sessions are not shell rows, so their viewers get the change in the
// session_family push that follows.

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
		const sessionManager = yield* SessionManagerServiceTag;
		const log = yield* LoggerTag;
		yield* Effect.forkDaemon(
			sessionManager
				.pushViewerFamilies()
				.pipe(
					Effect.catchAll((error) =>
						Effect.sync(() =>
							log.warn(
								`session=${sessionId} Failed to push families after ${type}: ${formatErrorDetail(error)}`,
							),
						),
					),
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
	setModel(sessionId, model).pipe(
		Effect.andThen(commitModel(sessionId, model)),
	);

/** A model the relay chose for this session; the user did not pick it. */
export const inferSessionModel = (sessionId: string, model: ModelOverride) =>
	setModelDefault(sessionId, model).pipe(
		Effect.andThen(commitModel(sessionId, model)),
	);

/** "" clears the session's effort back to the default. */
export const selectSessionVariant = (sessionId: string, variant: string) =>
	setVariant(sessionId, variant).pipe(
		Effect.andThen(
			commitSessionSetting("session.variant_changed", sessionId, {
				sessionId,
				variant,
			}),
		),
	);

/** "" clears the session's context window back to the default. */
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
 * Load the projected settings back into memory after a restart. Runs after the
 * turns-table restore, so a setting changed since the last turn wins.
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
