import { Context, Data, Effect, Layer } from "effect";
import {
	ProjectSaveRejected,
	type SaveProjectInput,
} from "../../../contracts/ws-rpc.js";
import { withCachedProjectGit } from "../../../git/session-git.js";
import type { FolderIssue } from "../../../project-folders.js";
import type { ProjectInfo } from "../../../shared-types.js";
import { ConfigTag } from "./services.js";

type ProjectOperation = "list" | "save" | "remove" | "setInstance";

export interface SaveProjectResult {
	readonly kind?: "existing" | undefined;
	readonly project: ProjectInfo;
	readonly projects: ReadonlyArray<ProjectInfo>;
	readonly warnings: readonly FolderIssue[];
}

export class ProjectManagementServiceError extends Data.TaggedError(
	"ProjectManagementServiceError",
)<{
	readonly operation: ProjectOperation;
	readonly cause: unknown;
}> {}

export class ProjectManagementNotSupported extends Data.TaggedError(
	"ProjectManagementNotSupported",
)<{
	readonly operation: Exclude<ProjectOperation, "list">;
	readonly message: string;
}> {}

export interface ProjectManagementService {
	currentSlug(): Effect.Effect<string>;
	list(): Effect.Effect<
		ReadonlyArray<ProjectInfo>,
		ProjectManagementServiceError
	>;
	save(
		input: SaveProjectInput,
	): Effect.Effect<
		SaveProjectResult,
		| ProjectManagementServiceError
		| ProjectManagementNotSupported
		| ProjectSaveRejected
	>;
	remove(
		slug: string,
	): Effect.Effect<
		ReadonlyArray<ProjectInfo>,
		ProjectManagementServiceError | ProjectManagementNotSupported
	>;
	setProjectInstance(
		slug: string,
		instanceId: string,
	): Effect.Effect<
		ReadonlyArray<ProjectInfo>,
		ProjectManagementServiceError | ProjectManagementNotSupported
	>;
}

export class ProjectManagementServiceTag extends Context.Tag(
	"ProjectManagementService",
)<ProjectManagementServiceTag, ProjectManagementService>() {}

const toError =
	(operation: ProjectOperation) =>
	(cause: unknown): ProjectManagementServiceError =>
		new ProjectManagementServiceError({ operation, cause });

export const ProjectManagementServiceLive: Layer.Layer<
	ProjectManagementServiceTag,
	never,
	ConfigTag
> = Layer.effect(
	ProjectManagementServiceTag,
	Effect.gen(function* () {
		const config = yield* ConfigTag;

		const listConfigProjects = (): Effect.Effect<
			ReadonlyArray<ProjectInfo> | undefined,
			ProjectManagementServiceError
		> => {
			const getProjects = config.getProjects;
			if (getProjects == null) return Effect.succeed(undefined);
			return Effect.tryPromise({
				try: () => Promise.resolve(getProjects()),
				catch: toError("list"),
			}).pipe(Effect.map((projects) => withCachedProjectGit(projects)));
		};

		return {
			currentSlug: () => Effect.succeed(config.slug),
			list: () =>
				listConfigProjects().pipe(Effect.map((projects) => projects ?? [])),
			save: (input) =>
				Effect.gen(function* () {
					const saveProject = config.saveProject;
					if (saveProject == null) {
						return yield* new ProjectManagementNotSupported({
							operation: "save",
							message: "Saving projects is not supported in this mode",
						});
					}
					const result = yield* Effect.tryPromise({
						try: () => saveProject(input),
						catch: (cause) =>
							cause instanceof ProjectSaveRejected
								? cause
								: toError("save")(cause),
					});
					const { project } = result;
					const projects =
						(yield* listConfigProjects()) ?? withCachedProjectGit([project]);
					return {
						kind: result.kind,
						project,
						projects,
						warnings: result.warnings,
					};
				}),
			remove: (slug) =>
				Effect.gen(function* () {
					const removeProject = config.removeProject;
					if (removeProject == null) {
						return yield* new ProjectManagementNotSupported({
							operation: "remove",
							message: "Removing projects is not supported in this mode",
						});
					}
					yield* Effect.tryPromise({
						try: () => Promise.resolve(removeProject(slug)),
						catch: toError("remove"),
					});
					return (yield* listConfigProjects()) ?? [];
				}),
			setProjectInstance: (slug, instanceId) =>
				Effect.gen(function* () {
					const setProjectInstance = config.setProjectInstance;
					const getProjects = config.getProjects;
					if (setProjectInstance == null || getProjects == null) {
						return yield* new ProjectManagementNotSupported({
							operation: "setInstance",
							message: "Project instance binding not available",
						});
					}
					yield* Effect.tryPromise({
						try: () => Promise.resolve(setProjectInstance(slug, instanceId)),
						catch: toError("setInstance"),
					});
					const projects = yield* listConfigProjects();
					return projects ?? [];
				}),
		};
	}),
);
