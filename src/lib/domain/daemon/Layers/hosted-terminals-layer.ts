import { Effect, Exit, Layer, PubSub, Stream } from "effect";
import { createLogger } from "../../../logger.js";
import type { StoredProject } from "../../../types.js";
import { LoggerTag } from "../../relay/Services/services.js";
import {
	LocalPtyServiceTag,
	makeLocalPtyServiceLive,
} from "../../relay/Services/terminal-service.js";
import { DaemonEventBusTag } from "../Services/daemon-pubsub.js";
import { OwnerScopes } from "../Services/owner-scopes.js";
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
		const closeHosted = (projectDir: string) =>
			localPty.list(projectDir).pipe(
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
		const bind = ({ slug, folders: [projectDir] }: StoredProject) =>
			projectDir === undefined
				? Effect.void
				: owners.projectScope(slug).pipe(
						Effect.flatMap((scope) =>
							scope.acquire(
								Effect.addFinalizer((exit) =>
									Exit.isSuccess(exit) && exit.value === "remove"
										? closeHosted(projectDir)
										: Effect.void,
								),
							),
						),
						Effect.ignore,
					);
		const registered = allProjects.pipe(
			Effect.provideService(ProjectRegistryTag, registry),
		);
		const added = yield* PubSub.subscribe(yield* DaemonEventBusTag);
		yield* Effect.forEach(yield* registered, bind, { discard: true });
		yield* Stream.fromSubscription(added).pipe(
			Stream.runForEach((event) =>
				event._tag === "InstanceAdded"
					? Effect.flatMap(registered, (projects) =>
							Effect.forEach(
								projects.filter(({ slug }) => slug === event.instanceId),
								bind,
								{ discard: true },
							),
						)
					: Effect.void,
			),
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
