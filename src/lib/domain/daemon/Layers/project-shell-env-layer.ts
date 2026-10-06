import { Context, Effect, Layer, PubSub, Schedule, Stream } from "effect";
import { ProjectShellEnvResolver } from "../../../provider/project-shell-env.js";
import { DaemonEventBusTag } from "../Services/daemon-pubsub.js";
import {
	allProjects,
	type ProjectRegistryTag,
} from "../Services/project-registry-service.js";

export class ProjectShellEnvTag extends Context.Tag("ProjectShellEnv")<
	ProjectShellEnvTag,
	ProjectShellEnvResolver
>() {}

export const makeProjectShellEnvLive = (
	options?: ConstructorParameters<typeof ProjectShellEnvResolver>[0],
) =>
	Layer.scoped(
		ProjectShellEnvTag,
		Effect.acquireRelease(
			Effect.sync(() => new ProjectShellEnvResolver(options)),
			(resolver) => Effect.sync(() => resolver.close()),
		),
	);

/** Project relays are lazy; resolve environments as soon as registration exists. */
export const ProjectShellEnvWiringLive: Layer.Layer<
	never,
	never,
	ProjectShellEnvTag | ProjectRegistryTag | DaemonEventBusTag
> = Layer.scopedDiscard(
	Effect.gen(function* () {
		const resolver = yield* ProjectShellEnvTag;
		const bus = yield* DaemonEventBusTag;
		const sub = yield* PubSub.subscribe(bus);
		const reconcile = allProjects.pipe(
			Effect.flatMap((projects) =>
				Effect.sync(() => {
					const directories = new Set(
						projects.map((project) => project.folders[0]),
					);
					for (const directory of resolver.directories()) {
						if (!directories.has(directory)) resolver.remove(directory);
					}
					for (const project of projects)
						resolver.register(project.folders[0], project.shellEnv);
				}),
			),
		);
		// register() schedules subprocess I/O; no resolution is awaited here.
		yield* reconcile;
		yield* Effect.forkScoped(
			Stream.fromQueue(sub).pipe(
				Stream.filter(
					(event) =>
						event._tag === "InstanceAdded" ||
						event._tag === "InstanceRemoved" ||
						event._tag === "InstanceStatusChanged",
				),
				Stream.runForEach(() => reconcile),
			),
		);
		// Recover registration changes even if the sliding event bus dropped an event.
		yield* Effect.forkScoped(
			reconcile.pipe(Effect.repeat(Schedule.spaced("1 minute"))),
		);
	}),
);
