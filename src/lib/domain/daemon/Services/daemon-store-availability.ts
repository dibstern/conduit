import { Context, Effect } from "effect";

/** Shared import failures. Runtime registration adds failures before publication. */
export const DaemonStoreAvailability = Context.Reference<Map<string, string>>(
	"DaemonStoreAvailability",
	{
		defaultValue: (): Map<string, string> => new Map(),
	},
);

const cleanup = new WeakMap<
	Map<string, string>,
	(projectId: string) => Effect.Effect<void>
>();

/** Adapters are built before orchestration; bind cleanup once drafts exist. */
export const onProjectUnavailable = (
	unavailable: Map<string, string>,
	discardProject: (projectId: string) => Effect.Effect<void>,
) =>
	Effect.acquireRelease(
		Effect.sync(() => cleanup.set(unavailable, discardProject)),
		() =>
			Effect.sync(() => {
				if (cleanup.get(unavailable) === discardProject)
					cleanup.delete(unavailable);
			}),
	).pipe(Effect.asVoid);

/** Both persistent failures and retryable relay errors retire the same drafts. */
export const transitionProjectUnavailable = <A, E, R>(
	unavailable: Map<string, string>,
	projectId: string,
	transition: Effect.Effect<A, E, R>,
) =>
	transition.pipe(
		Effect.tap(() => cleanup.get(unavailable)?.(projectId) ?? Effect.void),
		Effect.uninterruptible,
	);

export const markProjectUnavailable = (
	unavailable: Map<string, string>,
	projectId: string,
	reason: string,
) =>
	transitionProjectUnavailable(
		unavailable,
		projectId,
		Effect.sync(() => {
			unavailable.set(projectId, reason);
		}),
	);
