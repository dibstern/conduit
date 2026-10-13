import { SqlClient } from "@effect/sql";
import { Effect, Ref, Schema } from "effect";
import { makeCommitAndSignal } from "../../../persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../persistence/effect/event-store-effect.js";
import { ProjectionRunnerEffectTag } from "../../../persistence/effect/projection-runner-effect.js";
import {
	type CanonicalEventType,
	canonicalEvent,
	type EventPayloadMap,
} from "../../../persistence/events.js";
import type { SessionRow } from "../../../persistence/read-model-types.js";
import { SessionPermissionModeSchema } from "../../../shared-types.js";
import { SessionManagerError } from "./session-manager-error.js";
import {
	type ModelOverride,
	OverridesStateTag,
	type SessionState,
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
export const restoreSessionSettings = () =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const projectionRunner = yield* ProjectionRunnerEffectTag;
		if (!(yield* projectionRunner.isRecovered()))
			yield* projectionRunner.recover().pipe(
				Effect.mapError(
					(cause) =>
						new SessionManagerError({
							operation: "restoreSessionSettings.recover",
							cause,
						}),
				),
			);
		const rows = yield* sql<
			Pick<
				SessionRow,
				| "id"
				| "model_id"
				| "model_provider"
				| "variant"
				| "context_window"
				| "permission_mode"
			>
		>`SELECT id, model_id, model_provider, variant, context_window, permission_mode
			FROM sessions WHERE model_id IS NOT NULL OR model_provider IS NOT NULL
				OR variant IS NOT NULL OR context_window IS NOT NULL OR permission_mode IS NOT NULL`.pipe(
			Effect.mapError(
				(cause) =>
					new SessionManagerError({
						operation: "restoreSessionSettings.read",
						cause,
					}),
			),
		);
		const isPermissionMode = Schema.is(SessionPermissionModeSchema);
		const ref = yield* OverridesStateTag;
		return yield* Ref.modify(ref, (state) => {
			const sessions = new Map(state.sessions);
			let modelSettings = 0;
			let permissionModes = 0;
			for (const row of rows) {
				const hasModel = row.model_id != null && row.model_provider != null;
				const hasPermissionMode = isPermissionMode(row.permission_mode);
				if (
					row.model_id != null ||
					row.variant != null ||
					row.context_window != null
				)
					modelSettings += 1;
				if (hasPermissionMode) permissionModes += 1;
				if (
					!hasModel &&
					row.variant == null &&
					row.context_window == null &&
					!hasPermissionMode
				)
					continue;
				const entry: SessionState = { ...sessions.get(row.id) };
				if (row.model_id != null && row.model_provider != null)
					entry.model = {
						modelID: row.model_id,
						providerID: row.model_provider,
					};
				if (row.variant != null) entry.variant = row.variant;
				if (row.context_window != null)
					entry.contextWindow = row.context_window;
				if (isPermissionMode(row.permission_mode))
					entry.permissionMode = row.permission_mode;
				sessions.set(row.id, entry);
			}
			return [
				{ modelSettings, permissionModes },
				{ ...state, sessions },
			] as const;
		});
	});
