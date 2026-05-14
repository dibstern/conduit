import { Context, Data, Effect, Layer } from "effect";
import type { ProjectInfo } from "../../../shared-types.js";
import { ConfigTag, OpenCodeSettingsServiceTag } from "./services.js";

type ProjectOperation = "list" | "add" | "remove" | "rename" | "setInstance";

export interface AddProjectResult {
	readonly project: ProjectInfo;
	readonly projects: ReadonlyArray<ProjectInfo>;
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
	add(
		directory: string,
		instanceId?: string | undefined,
	): Effect.Effect<
		AddProjectResult,
		ProjectManagementServiceError | ProjectManagementNotSupported
	>;
	remove(
		slug: string,
	): Effect.Effect<
		ReadonlyArray<ProjectInfo>,
		ProjectManagementServiceError | ProjectManagementNotSupported
	>;
	rename(
		slug: string,
		title: string,
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
	ConfigTag | OpenCodeSettingsServiceTag
> = Layer.effect(
	ProjectManagementServiceTag,
	Effect.gen(function* () {
		const config = yield* ConfigTag;
		const settingsService = yield* OpenCodeSettingsServiceTag;

		const listConfigProjects = (): Effect.Effect<
			ReadonlyArray<ProjectInfo> | undefined,
			ProjectManagementServiceError
		> => {
			const getProjects = config.getProjects;
			if (getProjects == null) return Effect.succeed(undefined);
			return Effect.tryPromise({
				try: () => Promise.resolve(getProjects()),
				catch: toError("list"),
			});
		};
		const listProjects = () =>
			Effect.gen(function* () {
				const configProjects = yield* listConfigProjects();
				if (configProjects != null) return configProjects;
				const ocProjects = yield* settingsService
					.listProjects()
					.pipe(Effect.mapError(toError("list")));
				return ocProjects.map((project) => ({
					slug: project.id ?? "unknown",
					title: project.name ?? project.id ?? "Unknown",
					directory: project.path ?? "",
				}));
			});

		return {
			currentSlug: () => Effect.succeed(config.slug),
			list: listProjects,
			add: (directory, instanceId) =>
				Effect.gen(function* () {
					const addProject = config.addProject;
					if (addProject == null) {
						return yield* new ProjectManagementNotSupported({
							operation: "add",
							message: "Adding projects is not supported in this mode",
						});
					}
					const project = yield* Effect.tryPromise({
						try: () => addProject(directory, instanceId),
						catch: toError("add"),
					});
					const projects = (yield* listConfigProjects()) ?? [project];
					return { project, projects };
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
			rename: (slug, title) =>
				Effect.gen(function* () {
					const setProjectTitle = config.setProjectTitle;
					if (setProjectTitle == null) {
						return yield* new ProjectManagementNotSupported({
							operation: "rename",
							message: "Renaming projects is not supported in this mode",
						});
					}
					yield* Effect.try({
						try: () => setProjectTitle(slug, title),
						catch: toError("rename"),
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
