import { Effect, Exit, Layer, PubSub } from "effect";
import { createLogger } from "../../../logger.js";
import type { StoredProject } from "../../../types.js";
import { LoggerTag } from "../../project-services/Services/services.js";
import {
	LocalPtyServiceTag,
	makeLocalPtyServiceLive,
} from "../../project-services/Services/terminal-service.js";
import { DaemonEventBusTag } from "../Services/daemon-pubsub.js";
import { type OwnerScope, OwnerScopes } from "../Services/owner-scopes.js";
import {
	allProjects,
	ProjectRegistryTag,
} from "../Services/project-registry-service.js";

/**
 * Closes a removed project's hosted terminals, in every registered project and in each one
 * added later, though nothing serves it (82tn.16). A detach (daemon shutdown) keeps them in
 * the host for the next daemon.
 */
const RemovedProjectTerminalsLive = Layer.effectDiscard(
	Effect.gen(function* () {
		const localPty = yield* LocalPtyServiceTag;
		const owners = yield* OwnerScopes;
		const registry = yield* ProjectRegistryTag;
		// Projects can share a folder: close only this project's terminals (82tn.78).
		const closeHosted = (slug: string, projectDir: string) =>
			localPty.list(projectDir, false, slug).pipe(
				Effect.flatMap((hosted) =>
					Effect.forEach(
						hosted,
						({ id }) =>
							localPty
								.attach(id, projectDir)
								.pipe(
									Effect.map(({ upstream }) =>
										upstream.close(1000, "Project removed"),
									),
								),
						{ discard: true },
					),
				),
				Effect.catchCause((cause) =>
					Effect.logWarning(
						"Could not close a removed project's terminals",
						cause,
					),
				),
			);
		// One watch per project generation: a removed and re-added project opens a new owner scope.
		const bound = new WeakSet<OwnerScope>();
		const bind = ({ slug, folders: [projectDir] }: StoredProject) =>
			projectDir === undefined
				? Effect.void
				: owners.projectScope(slug).pipe(
						Effect.flatMap((scope) => {
							if (bound.has(scope)) return Effect.void;
							bound.add(scope);
							return scope.acquire(
								Effect.addFinalizer((exit) =>
									Exit.isSuccess(exit) && exit.value === "remove"
										? closeHosted(slug, projectDir)
										: Effect.void,
								),
							);
						}),
						Effect.ignore,
					);
		const bindRegistered = allProjects.pipe(
			Effect.provideService(ProjectRegistryTag, registry),
			Effect.flatMap((projects) =>
				Effect.forEach(projects, bind, { discard: true }),
			),
		);
		// The bus slides: a listener that is behind loses its oldest messages, a project's add
		// among them, but only to make room for newer ones. Re-reading the registry on every batch
		// therefore finds every added project (82tn.77).
		const added = yield* PubSub.subscribe(yield* DaemonEventBusTag);
		yield* bindRegistered;
		yield* PubSub.takeAll(added).pipe(
			Effect.andThen(bindRegistered),
			Effect.forever,
			Effect.forkScoped,
		);
	}),
);

/** The PTY host's one client for the daemon, which every served project borrows. */
export const makeHostedTerminalsLive = (configDir: string) =>
	RemovedProjectTerminalsLive.pipe(
		Layer.provideMerge(
			makeLocalPtyServiceLive(configDir).pipe(
				Layer.provide(Layer.succeed(LoggerTag, createLogger("pty"))),
			),
		),
	);
