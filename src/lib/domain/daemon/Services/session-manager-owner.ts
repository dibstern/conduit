import { Context, Effect, Layer, Ref, Semaphore } from "effect";
import {
	emptySessionManagerState,
	makeSessionManagerCoordination,
	type SessionManagerCoordination,
	type SessionManagerState,
} from "../../relay/Services/session-manager-state.js";
import {
	type OwnerScopeClosedError,
	type OwnerScopeProjectNotRegisteredError,
	OwnerScopes,
} from "./owner-scopes.js";

export interface ProjectSessionManager {
	readonly state: Ref.Ref<SessionManagerState>;
	readonly coordination: SessionManagerCoordination;
}

/** Each project's session manager state, held by the daemon so relay rebuilds keep it. */
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
									const created = {
										state: yield* Ref.make(emptySessionManagerState()),
										coordination: yield* makeSessionManagerCoordination,
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
