import { Context, Effect, Layer, Ref, Semaphore } from "effect";
import { SqlClient } from "effect/sql";
import { SessionManagerError } from "../../project-services/Services/session-manager-error.js";
import {
	emptySessionManagerState,
	forgetSession,
	makeSessionManagerCoordination,
	type SessionManagerCoordination,
	type SessionManagerState,
} from "../../project-services/Services/session-manager-state.js";
import {
	type OwnerScopeClosedError,
	type OwnerScopeProjectNotRegisteredError,
	OwnerScopes,
} from "./owner-scopes.js";

export interface ProjectSessionManager {
	readonly state: Ref.Ref<SessionManagerState>;
	readonly coordination: SessionManagerCoordination;
}

/** Each project's session manager state, held by the daemon so a reopened project keeps it. */
export class SessionManagerOwner extends Context.Service<
	SessionManagerOwner,
	{
		/** Made once per project generation; dropped when the project's owner scope closes. */
		readonly project: (
			projectId: string,
		) => Effect.Effect<
			ProjectSessionManager,
			OwnerScopeClosedError | OwnerScopeProjectNotRegisteredError
		>;
	}
>()("SessionManagerOwner") {}

export const SessionManagerOwnerLive = Layer.effect(
	SessionManagerOwner,
	Effect.gen(function* () {
		const owners = yield* OwnerScopes;
		const sql = yield* SqlClient.SqlClient;
		const projects = new Map<string, ProjectSessionManager>();
		const lock = yield* Semaphore.make(1);
		return {
			project: (projectId) =>
				lock.withPermits(1)(
					Effect.gen(function* () {
						const existing = projects.get(projectId);
						if (existing) return existing;
						const scope = yield* owners.projectScope(projectId);
						return yield* scope.acquire<ProjectSessionManager, never, never>(
							Effect.acquireRelease(
								Effect.gen(function* () {
									const state = yield* Ref.make(emptySessionManagerState());
									const held = new Set<string>();
									const hold = (sessionId: string) =>
										held.has(sessionId)
											? Effect.succeed(true)
											: owners.sessionScope(sessionId).pipe(
													Effect.flatMap((scope) =>
														scope.acquire<Set<string>, never, never>(
															Effect.acquireRelease(
																Effect.sync(() => held.add(sessionId)),
																() =>
																	Ref.update(
																		state,
																		forgetSession(sessionId),
																	).pipe(
																		Effect.andThen(
																			Effect.sync(() => held.delete(sessionId)),
																		),
																	),
															),
														),
													),
													Effect.as(true),
													Effect.catchTag("OwnerScopeClosedError", () =>
														Effect.succeed(false),
													),
													// No row yet: write as an open project would. Anything else fails the write.
													Effect.catchTag(
														"OwnerScopeProvenanceError",
														(error) =>
															sql`SELECT 1 FROM sessions WHERE id = ${sessionId}`.pipe(
																Effect.flatMap((rows) =>
																	rows.length === 0
																		? Effect.succeed(true)
																		: Effect.fail(error),
																),
															),
													),
													Effect.mapError(
														(cause) =>
															new SessionManagerError({
																operation: "holdSession",
																cause,
															}),
													),
												);
									const created = {
										state,
										coordination: yield* makeSessionManagerCoordination(hold),
									};
									projects.set(projectId, created);
									return created;
								}),
								() => Effect.sync(() => projects.delete(projectId)),
							),
						);
					}),
				),
		};
	}),
);
