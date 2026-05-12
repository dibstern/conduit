import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import {
	ProjectManagementNotSupported,
	type ProjectManagementService,
	ProjectManagementServiceError,
	ProjectManagementServiceTag,
} from "../../../src/lib/effect/project-management-service.js";
import { WebSocketHandlerTag } from "../../../src/lib/effect/services.js";
import { handleSetProjectInstance } from "../../../src/lib/handlers/instance.js";
import {
	handleAddProject,
	handleGetProjects,
	handleRemoveProject,
	handleRenameProject,
} from "../../../src/lib/handlers/settings.js";
import { makeMockWebSocketHandler } from "../../helpers/mock-factories.js";

const projects = [
	{
		slug: "proj-1",
		title: "Project 1",
		directory: "/work/proj-1",
		instanceId: "inst-1",
	},
] as const;

const makeService = (
	overrides: Partial<ProjectManagementService> = {},
): ProjectManagementService => ({
	currentSlug: vi.fn(() => Effect.succeed("proj-1")),
	list: vi.fn(() => Effect.succeed(projects)),
	add: vi.fn(() =>
		Effect.succeed({
			project: projects[0],
			projects,
		}),
	),
	remove: vi.fn(() => Effect.succeed(projects)),
	rename: vi.fn(() => Effect.succeed(projects)),
	setProjectInstance: vi.fn(() => Effect.succeed(projects)),
	...overrides,
});

describe("project management handlers through ProjectManagementService", () => {
	it.effect(
		"lists projects through the service and preserves current slug",
		() => {
			const service = makeService();
			const wsHandler = makeMockWebSocketHandler();
			const layer = Layer.mergeAll(
				Layer.succeed(ProjectManagementServiceTag, service),
				Layer.succeed(WebSocketHandlerTag, wsHandler),
			);

			return handleGetProjects("client-1", {}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(service.list).toHaveBeenCalledOnce();
					expect(service.currentSlug).toHaveBeenCalledOnce();
					expect(wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
						type: "project_list",
						projects,
						current: "proj-1",
					});
				}),
			);
		},
	);

	it.effect(
		"adds a project through the service without raw config project callbacks",
		() => {
			const service = makeService();
			const wsHandler = makeMockWebSocketHandler();
			const layer = Layer.mergeAll(
				Layer.succeed(ProjectManagementServiceTag, service),
				Layer.succeed(WebSocketHandlerTag, wsHandler),
			);

			return handleAddProject("client-1", {
				directory: "/work/proj-1",
				instanceId: "inst-1",
			}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(service.add).toHaveBeenCalledWith("/work/proj-1", "inst-1");
					expect(wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
						type: "project_list",
						projects,
						current: "proj-1",
						addedSlug: "proj-1",
					});
				}),
			);
		},
	);

	it.effect(
		"renders unsupported project additions with the stable code",
		() => {
			const service = makeService({
				add: vi.fn(() =>
					Effect.fail(
						new ProjectManagementNotSupported({
							operation: "add",
							message: "Adding projects is not supported in this mode",
						}),
					),
				),
			});
			const wsHandler = makeMockWebSocketHandler();
			const layer = Layer.mergeAll(
				Layer.succeed(ProjectManagementServiceTag, service),
				Layer.succeed(WebSocketHandlerTag, wsHandler),
			);

			return handleAddProject("client-1", { directory: "/work/proj-1" }).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
						type: "system_error",
						code: "NOT_SUPPORTED",
						message: "Adding projects is not supported in this mode",
					});
				}),
			);
		},
	);

	it.effect(
		"renders service failures with operation-specific project codes",
		() => {
			const service = makeService({
				remove: vi.fn(() =>
					Effect.fail(
						new ProjectManagementServiceError({
							operation: "remove",
							cause: new Error("cannot remove active project"),
						}),
					),
				),
			});
			const wsHandler = makeMockWebSocketHandler();
			const layer = Layer.mergeAll(
				Layer.succeed(ProjectManagementServiceTag, service),
				Layer.succeed(WebSocketHandlerTag, wsHandler),
			);

			return handleRemoveProject("client-1", { slug: "proj-1" }).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
						type: "system_error",
						code: "REMOVE_PROJECT_FAILED",
						message: "cannot remove active project",
					});
					expect(wsHandler.broadcast).not.toHaveBeenCalled();
				}),
			);
		},
	);

	it.effect(
		"renames a project through the service after boundary validation",
		() => {
			const service = makeService();
			const wsHandler = makeMockWebSocketHandler();
			const layer = Layer.mergeAll(
				Layer.succeed(ProjectManagementServiceTag, service),
				Layer.succeed(WebSocketHandlerTag, wsHandler),
			);
			const longTitle = `  ${"x".repeat(120)}  `;

			return handleRenameProject("client-1", {
				slug: "proj-1",
				title: longTitle,
			}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(service.rename).toHaveBeenCalledWith(
						"proj-1",
						"x".repeat(100),
					);
					expect(wsHandler.broadcast).toHaveBeenCalledWith({
						type: "project_list",
						projects,
						current: "proj-1",
					});
				}),
			);
		},
	);

	it.effect(
		"sets a project instance through the project service and preserves the broadcast envelope",
		() => {
			const service = makeService();
			const wsHandler = makeMockWebSocketHandler();
			const layer = Layer.mergeAll(
				Layer.succeed(ProjectManagementServiceTag, service),
				Layer.succeed(WebSocketHandlerTag, wsHandler),
			);

			return handleSetProjectInstance("client-1", {
				slug: "proj-1",
				instanceId: "inst-2",
			}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(service.setProjectInstance).toHaveBeenCalledWith(
						"proj-1",
						"inst-2",
					);
					expect(wsHandler.broadcast).toHaveBeenCalledWith({
						type: "project_list",
						projects,
					});
				}),
			);
		},
	);

	it.effect("keeps set-project-instance unavailable envelope stable", () => {
		const wsHandler = makeMockWebSocketHandler();
		const layer = Layer.succeed(WebSocketHandlerTag, wsHandler);

		return handleSetProjectInstance("client-1", {
			slug: "proj-1",
			instanceId: "inst-2",
		}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
					type: "system_error",
					code: "INSTANCE_ERROR",
					message: "Project instance binding not available",
				});
			}),
		);
	});

	it.effect(
		"renders set-project-instance service failures as instance errors",
		() => {
			const service = makeService({
				setProjectInstance: vi.fn(() =>
					Effect.fail(
						new ProjectManagementServiceError({
							operation: "setInstance",
							cause: new Error("bind failed"),
						}),
					),
				),
			});
			const wsHandler = makeMockWebSocketHandler();
			const layer = Layer.mergeAll(
				Layer.succeed(ProjectManagementServiceTag, service),
				Layer.succeed(WebSocketHandlerTag, wsHandler),
			);

			return handleSetProjectInstance("client-1", {
				slug: "proj-1",
				instanceId: "inst-2",
			}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
						type: "system_error",
						code: "INSTANCE_ERROR",
						message: "bind failed",
					});
					expect(wsHandler.broadcast).not.toHaveBeenCalled();
				}),
			);
		},
	);
});
