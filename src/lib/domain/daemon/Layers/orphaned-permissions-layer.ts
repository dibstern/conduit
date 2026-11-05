import { Context, Effect, Option, PubSub, Stream } from "effect";
import { formatErrorDetail } from "../../../errors.js";
import { bindEventStoreEffect } from "../../../persistence/effect/bind-event-store-effect.js";
import {
	EventStoreEffectTag,
	makeUnboundEventStoreEffect,
} from "../../../persistence/effect/event-store-effect.js";
import { PersistenceStore } from "../../../persistence/effect/live.js";
import { ProviderRegistryTag } from "../../../provider/provider-registry.js";
import { PendingInteractionServiceTag } from "../../relay/Services/pending-interaction-service.js";
import { resolveOrphanedClaudePermissions } from "../../relay/Services/resolve-orphaned-claude-permissions.js";
import { DaemonEventBusTag } from "../Services/daemon-pubsub.js";
import {
	allProjects,
	ProjectRegistryTag,
} from "../Services/project-registry-service.js";
import { ProviderAdapters } from "../Services/provider-adapters.js";

/**
 * Rejects the Claude asks a crash left pending, in every registered project and in each
 * project added later: none waits for a tab to open its project (82tn.16). Clearing runs
 * after runner recovery, since a recovered runner's ask is not orphaned.
 */
export const makeOrphanedClaudePermissions = Effect.gen(function* () {
	const store = yield* PersistenceStore;
	const adapters = yield* ProviderAdapters;
	const registry = yield* ProjectRegistryTag;
	const unbound = yield* makeUnboundEventStoreEffect.pipe(
		Effect.provide(store),
	);
	const registered = allProjects.pipe(
		Effect.map((projects) => projects.map(({ slug }) => slug)),
		Effect.provideService(ProjectRegistryTag, registry),
	);
	const clear = (projectId: string) =>
		Effect.gen(function* () {
			// A served project's waiting asks are live, not orphaned.
			const pending = Option.flatMap(
				adapters.projectContext(projectId),
				(context) => Context.getOption(context, PendingInteractionServiceTag),
			);
			const rejected = yield* resolveOrphanedClaudePermissions.pipe(
				Effect.provideService(
					EventStoreEffectTag,
					bindEventStoreEffect(unbound, projectId),
				),
				Effect.provideService(ProviderRegistryTag, adapters.registry),
				Option.isSome(pending)
					? Effect.provideService(PendingInteractionServiceTag, pending.value)
					: (effect) => effect,
				Effect.provide(store),
			);
			if (rejected > 0)
				yield* Effect.logInfo(
					`Rejected ${rejected} Claude permission(s) left pending by a crash`,
				);
		}).pipe(
			Effect.catch((error) =>
				Effect.logWarning(
					`Could not reject Claude permissions left pending by a crash: ${formatErrorDetail(error)}`,
				),
			),
			Effect.annotateLogs("slug", projectId),
		);
	// Subscribed now, so a project added during recovery is cleared once it is done.
	const added = yield* PubSub.subscribe(yield* DaemonEventBusTag);
	yield* Effect.gen(function* () {
		yield* adapters.recover;
		yield* Stream.fromSubscription(added).pipe(
			Stream.runForEach((event) =>
				event._tag === "InstanceAdded"
					? Effect.flatMap(registered, (slugs) =>
							slugs.includes(event.instanceId)
								? clear(event.instanceId)
								: Effect.void,
						)
					: Effect.void,
			),
		);
	}).pipe(
		Effect.catchCause((cause) =>
			Effect.logWarning("Clearing added projects' orphaned asks ended", cause),
		),
		Effect.forkScoped,
	);
	/** Clear every registered project; call once runner recovery is done. */
	return Effect.flatMap(registered, (slugs) =>
		Effect.forEach(slugs, clear, { discard: true }),
	);
});
