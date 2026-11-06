import { Context, Effect, Option, PubSub, Semaphore } from "effect";
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
import { type OwnerScope, OwnerScopes } from "../Services/owner-scopes.js";
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
	const owners = yield* OwnerScopes;
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
	// Once per project generation: a removed and re-added project opens a new owner scope. The
	// lock makes start return only once every registered project is cleared.
	const cleared = new WeakSet<OwnerScope>();
	const lock = yield* Semaphore.make(1);
	const clearRegistered = lock.withPermits(1)(
		Effect.flatMap(registered, (slugs) =>
			Effect.forEach(
				slugs,
				(slug) =>
					owners.projectScope(slug).pipe(
						Effect.flatMap((scope) => {
							if (cleared.has(scope)) return Effect.void;
							cleared.add(scope);
							return clear(slug);
						}),
						Effect.ignore,
					),
				{ discard: true },
			),
		),
	);
	// Subscribed now, so a project added during recovery is cleared once it is done. The bus
	// slides: a listener that is behind loses its oldest messages, a project's add among them,
	// but only to make room for newer ones. Re-reading the registry on every batch therefore
	// finds every added project (82tn.77).
	const added = yield* PubSub.subscribe(yield* DaemonEventBusTag);
	yield* adapters.recover.pipe(
		Effect.andThen(
			PubSub.takeAll(added).pipe(
				Effect.andThen(clearRegistered),
				Effect.forever,
			),
		),
		Effect.catchCause((cause) =>
			Effect.logWarning("Clearing added projects' orphaned asks ended", cause),
		),
		Effect.forkScoped,
	);
	/** Clear every registered project; call once runner recovery is done. */
	return clearRegistered;
});
