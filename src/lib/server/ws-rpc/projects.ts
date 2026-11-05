import { Effect } from "effect";
import { ProjectSaveRejected, WsRpcError } from "../../contracts/ws-rpc.js";
import { ProjectManagementServiceTag } from "../../domain/relay/Services/project-management-service.js";
import { normalizeProjectTitle } from "../../handlers/settings.js";
import type { WsRpcHandlerMap } from "./shared.js";

export const projectsHandlers = {
	GetProjects: (request) =>
		Effect.gen(function* () {
			const projectService = yield* ProjectManagementServiceTag;
			const projects = yield* projectService.list();
			return { projectSlug: request.projectSlug, projects };
		}).pipe(
			Effect.catch((error) =>
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
				...(request.setupScript !== undefined && {
					setupScript: request.setupScript,
				}),
				...(request.sessionMode !== undefined && {
					sessionMode: request.sessionMode,
				}),
			});
			return {
				kind: result.kind,
				projectSlug: request.projectSlug,
				projects: result.projects,
				savedSlug: result.project.slug,
				warnings: result.warnings,
			};
		}).pipe(
			Effect.catch((error) =>
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
			return { projectSlug: request.projectSlug, projects };
		}).pipe(
			Effect.catch((error) =>
				Effect.fail(
					new WsRpcError({
						message: `RemoveProject failed: ${String(error)}`,
					}),
				),
			),
		),
} satisfies Pick<
	WsRpcHandlerMap,
	"GetProjects" | "SaveProject" | "RemoveProject"
>;
