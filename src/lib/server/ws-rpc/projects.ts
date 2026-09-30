import { Effect } from "effect";
import { type AttachProject, WsRpcError } from "../../contracts/ws-rpc.js";
import { ProjectManagementServiceTag } from "../../domain/relay/Services/project-management-service.js";
import { WebSocketHandlerTag } from "../../domain/relay/Services/services.js";
import { normalizeProjectTitle } from "../../handlers/settings.js";
import type { WsRpcHandlerMap } from "./shared.js";

export const projectsHandlers = {
	AttachProject: (_request: AttachProject) =>
		Effect.succeed({ ok: true as const }),
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
	AddProject: (request) =>
		Effect.gen(function* () {
			const projectService = yield* ProjectManagementServiceTag;
			const result = yield* projectService.add(
				request.directory,
				request.instanceId,
			);
			const current = yield* projectService.currentSlug();
			return {
				projectSlug: request.projectSlug,
				projects: result.projects,
				...(current ? { current } : {}),
				addedSlug: result.project.slug,
			};
		}).pipe(
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `AddProject failed: ${String(error)}`,
					}),
				),
			),
		),
	RemoveProject: (request) =>
		Effect.gen(function* () {
			const projectService = yield* ProjectManagementServiceTag;
			const wsHandler = yield* WebSocketHandlerTag;
			const projects = yield* projectService.remove(request.slug);
			const current = yield* projectService.currentSlug();
			const message = {
				type: "project_list" as const,
				projects,
				...(current ? { current } : {}),
			};
			wsHandler.broadcast(message);
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
	RenameProject: (request) =>
		Effect.gen(function* () {
			const projectService = yield* ProjectManagementServiceTag;
			const wsHandler = yield* WebSocketHandlerTag;
			const title = normalizeProjectTitle(request.title);
			if (!title) {
				return yield* Effect.fail(
					new WsRpcError({
						message: "RenameProject failed: title is required",
					}),
				);
			}
			const projects = yield* projectService.rename(request.slug, title);
			const current = yield* projectService.currentSlug();
			const message = {
				type: "project_list" as const,
				projects,
				...(current ? { current } : {}),
			};
			wsHandler.broadcast(message);
			return {
				projectSlug: request.projectSlug,
				projects,
				...(current ? { current } : {}),
			};
		}).pipe(
			Effect.catchAll((error) =>
				error instanceof WsRpcError
					? Effect.fail(error)
					: Effect.fail(
							new WsRpcError({
								message: `RenameProject failed: ${String(error)}`,
							}),
						),
			),
		),
	SetProjectInstance: (request) =>
		Effect.gen(function* () {
			const projectService = yield* ProjectManagementServiceTag;
			const wsHandler = yield* WebSocketHandlerTag;
			const projects = yield* projectService.setProjectInstance(
				request.slug,
				request.instanceId,
			);
			const current = yield* projectService.currentSlug();
			const message = {
				type: "project_list" as const,
				projects,
				...(current ? { current } : {}),
			};
			wsHandler.broadcast(message);
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
	| "AddProject"
	| "RemoveProject"
	| "RenameProject"
	| "SetProjectInstance"
>;
