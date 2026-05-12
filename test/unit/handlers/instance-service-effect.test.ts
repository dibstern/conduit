import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import {
	type InstanceManagementService,
	InstanceManagementServiceError,
	InstanceManagementServiceTag,
} from "../../../src/lib/effect/instance-management-service.js";
import { WebSocketHandlerTag } from "../../../src/lib/effect/services.js";
import {
	handleInstanceAdd,
	handleInstanceStart,
} from "../../../src/lib/handlers/instance.js";
import type { OpenCodeInstance } from "../../../src/lib/shared-types.js";
import { makeMockWebSocketHandler } from "../../helpers/mock-factories.js";

const instance: OpenCodeInstance = {
	id: "test-instance",
	name: "Test Instance",
	port: 4096,
	status: "stopped",
	managed: true,
	restartCount: 0,
	createdAt: 1,
};

const makeService = (
	overrides: Partial<InstanceManagementService> = {},
): InstanceManagementService => ({
	list: vi.fn(() => Effect.succeed([instance])),
	add: vi.fn(() => Effect.succeed([instance])),
	remove: vi.fn(() => Effect.succeed([instance])),
	start: vi.fn(() => Effect.succeed([instance])),
	stop: vi.fn(() => Effect.succeed([instance])),
	update: vi.fn(() => Effect.succeed([instance])),
	rename: vi.fn(() => Effect.succeed([instance])),
	...overrides,
});

describe("instance handlers through InstanceManagementService", () => {
	it.effect(
		"adds an instance through the service without requiring legacy InstanceMgmtTag",
		() => {
			const service = makeService();
			const wsHandler = makeMockWebSocketHandler();
			const layer = Layer.mergeAll(
				Layer.succeed(InstanceManagementServiceTag, service),
				Layer.succeed(WebSocketHandlerTag, wsHandler),
			);

			return handleInstanceAdd("client-1", { name: "Test Instance" }).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(service.add).toHaveBeenCalledWith({
						name: "Test Instance",
					});
					expect(wsHandler.broadcast).toHaveBeenCalledWith({
						type: "instance_list",
						instances: [instance],
					});
				}),
			);
		},
	);

	it.effect("keeps the unavailable-service error envelope stable", () => {
		const wsHandler = makeMockWebSocketHandler();
		const layer = Layer.succeed(WebSocketHandlerTag, wsHandler);

		return handleInstanceAdd("client-1", { name: "Test Instance" }).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
					type: "system_error",
					code: "INSTANCE_ERROR",
					message: "Instance management not available",
				});
			}),
		);
	});

	it.effect("renders typed service failures as instance errors", () => {
		const wsHandler = makeMockWebSocketHandler();
		const service = makeService({
			start: vi.fn(() =>
				Effect.fail(
					new InstanceManagementServiceError({
						operation: "start",
						cause: new Error("spawn failed"),
					}),
				),
			),
		});
		const layer = Layer.mergeAll(
			Layer.succeed(InstanceManagementServiceTag, service),
			Layer.succeed(WebSocketHandlerTag, wsHandler),
		);

		return handleInstanceStart("client-1", { instanceId: "inst-1" }).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
					type: "system_error",
					code: "INSTANCE_ERROR",
					message: "spawn failed",
				});
				expect(wsHandler.broadcast).not.toHaveBeenCalled();
			}),
		);
	});
});
