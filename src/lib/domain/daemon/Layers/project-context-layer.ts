import { Effect, HashMap, Layer, Option, Ref } from "effect";
import {
	ProjectContext,
	type ProjectContextOptions,
	SessionProjectNotFound,
} from "../Services/project-context.js";
import {
	ProjectNotFound,
	ProjectRegistryTag,
} from "../Services/project-registry-service.js";
import { SessionDirectory } from "../Services/session-directory.js";
import { ProjectShellEnvTag } from "./project-shell-env-layer.js";

/** Keep owners and settings live; no relay construction snapshot is consulted. */
export const ProjectContextLive = Layer.effect(
	ProjectContext,
	Effect.gen(function* () {
		const registry = yield* ProjectRegistryTag;
		const directory = yield* SessionDirectory;
		const environments = yield* ProjectShellEnvTag;
		const forProject = (slug: string, options?: ProjectContextOptions) =>
			Effect.gen(function* () {
				const entry = HashMap.get(yield* Ref.get(registry), slug);
				if (Option.isNone(entry)) return yield* new ProjectNotFound({ slug });
				const project = entry.value.project;
				const mainFolder = project.folders[0];
				// Registration is synchronous, so a call need not wait for the
				// shell-env event subscriber to observe the latest settings.
				environments.register(mainFolder, project.shellEnv, slug);
				const effectiveDirectory = options?.directory ?? mainFolder;
				if (options?.prepareShellEnv)
					yield* Effect.tryPromise(() =>
						environments.waitUntilReady(effectiveDirectory, slug),
					).pipe(
						Effect.timeoutOption("10 seconds"),
						Effect.catch(() => Effect.void),
					);
				return {
					projectId: slug,
					mainFolder,
					extraFolders: Object.freeze(project.folders.slice(1)),
					shellEnv: Object.freeze({
						...environments.get(effectiveDirectory, slug),
					}),
				};
			});
		return {
			forProject,
			forSession: (id, options) =>
				Effect.gen(function* () {
					const owner = yield* directory.projectOf(id);
					if (Option.isNone(owner))
						return yield* new SessionProjectNotFound({ sessionId: id });
					return yield* forProject(owner.value, options);
				}),
		};
	}),
);
