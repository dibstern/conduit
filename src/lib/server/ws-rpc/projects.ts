import { Effect } from "effect";
import {
	type AttachProject,
	ProjectSaveRejected,
	WsRpcError,
} from "../../contracts/ws-rpc.js";
import { ProjectManagementServiceTag } from "../../domain/relay/Services/project-management-service.js";
import { normalizeProjectTitle } from "../../handlers/settings.js";
import type { WsRpcHandlerMap } from "./shared.js";

export const projectsHandlers = {
	// A standalone relay serves one project, so every tab attaches to it.
	AttachProject: (_request: AttachProject) =>
		Effect.flatMap(ProjectManagementServiceTag, (projectService) =>
			projectService.currentSlug(),
		).pipe(
			Effect.map((projectSlug): { readonly projectSlug: string | null } => ({
				projectSlug,
			})),
		),
	GetProjects: (request) =>
		Effect.gen(function* () {
			const projectService = yield* ProjectManagementServiceTag;
			const projects = yield* projectService.list();
			const current = yield* projectService.currentSlug();
			return {
				projectSlug: request.projectSlug,
				projects,
				...(current ? { current } : {}),
			};
		}).pipe(
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `GetProjects failed: ${String(error)}`,
					}),
				),
			),
		),
	SaveProject: (request) =>
		Effect.gen(function* () {
			const projectService = yield* ProjectManagementServiceTag;
			const title =
				request.title === undefined
					? undefined
					: normalizeProjectTitle(request.title);
			if (title === "")
				return yield* new WsRpcError({
					message: "SaveProject failed: title is required",
				});
			const result = yield* projectService.save({
				folders: request.folders,
				...(request.slug !== undefined && { slug: request.slug }),
				...(title !== undefined && { title }),
				...(request.instanceId !== undefined && {
					instanceId: request.instanceId,
				}),
			});
			const current = yield* projectService.currentSlug();
			return {
				kind: result.kind,
				projectSlug: request.projectSlug,
				projects: result.projects,
				...(current ? { current } : {}),
				savedSlug: result.project.slug,
				warnings: result.warnings,
			};
		}).pipe(
			Effect.catchAll((error) =>
				error instanceof ProjectSaveRejected || error instanceof WsRpcError
					? Effect.fail(error)
					: Effect.fail(
							new WsRpcError({
								message: `SaveProject failed: ${String(error)}`,
							}),
						),
			),
		),
	RemoveProject: (request) =>
		Effect.gen(function* () {
			const projectService = yield* ProjectManagementServiceTag;
			const projects = yield* projectService.remove(request.slug);
			const current = yield* projectService.currentSlug();
			return {
				projectSlug: request.projectSlug,
				projects,
				...(current ? { current } : {}),
			};
		}).pipe(
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `RemoveProject failed: ${String(error)}`,
					}),
				),
			),
		),
	SetProjectInstance: (request) =>
		Effect.gen(function* () {
			const projectService = yield* ProjectManagementServiceTag;
			const projects = yield* projectService.setProjectInstance(
				request.slug,
				request.instanceId,
			);
			const current = yield* projectService.currentSlug();
			return {
				projectSlug: request.projectSlug,
				projects,
				...(current ? { current } : {}),
			};
		}).pipe(
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `SetProjectInstance failed: ${String(error)}`,
					}),
				),
			),
		),
} satisfies Pick<
	WsRpcHandlerMap,
	| "AttachProject"
	| "GetProjects"
	| "SaveProject"
	| "RemoveProject"
	| "SetProjectInstance"
>;
