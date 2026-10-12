import { createServer } from "node:http";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { InstanceMgmtTag } from "../../../src/lib/domain/daemon/Services/management-service.js";
import {
	InstanceManagementServiceFromConfigLive,
	InstanceManagementServiceLive,
	InstanceManagementServiceTag,
} from "../../../src/lib/domain/relay/Services/instance-management-service.js";
import { ConfigTag } from "../../../src/lib/domain/relay/Services/services.js";
import type { InstanceManagementDeps } from "../../../src/lib/handlers/types.js";
import type { OpenCodeInstance } from "../../../src/lib/shared-types.js";
import type { ProjectRelayConfig } from "../../../src/lib/types.js";
import { tempEventsDbPath } from "../../helpers/temp-events-db.js";

const makeInstance = (
	overrides: Partial<OpenCodeInstance> = {},
): OpenCodeInstance => ({
	id: "instance-1",
	name: "Instance 1",
	port: 4096,
	status: "stopped",
	managed: true,
	restartCount: 0,
	createdAt: 1,
	...overrides,
});

const makeInstanceMgmt = (
	initial: OpenCodeInstance[] = [],
): InstanceManagementDeps => {
	const instances = [...initial];
	return {
		getInstances: vi.fn(() => [...instances]),
		addInstance: vi.fn((input) => {
			const instance = makeInstance({
				...input,
				id: "allocated-account",
				port: input.port ?? 4096,
				managed: input.managed ?? true,
			});
			instances.push(instance);
			return instance;
		}),
		removeInstance: vi.fn((id) => {
			const index = instances.findIndex((instance) => instance.id === id);
			if (index >= 0) instances.splice(index, 1);
		}),
		startInstance: vi.fn(async () => undefined),
		stopInstance: vi.fn(),
		updateInstance: vi.fn((id, updates) => {
			const instance = instances.find((candidate) => candidate.id === id);
			if (instance == null) throw new Error(`Instance "${id}" not found`);
			Object.assign(instance, updates);
			return instance;
		}),
		persistConfig: vi.fn(),
	};
};

const makeLayer = (instanceMgmt: InstanceManagementDeps) =>
	InstanceManagementServiceLive.pipe(
		Layer.provide(Layer.succeed(InstanceMgmtTag, instanceMgmt)),
	);

const makeConfigLayer = (instanceMgmt: InstanceManagementDeps) =>
	InstanceManagementServiceFromConfigLive.pipe(
		Layer.provide(
			Layer.succeed(ConfigTag, {
				httpServer: createServer(),
				opencodeUrl: "http://127.0.0.1:4096",
				projectDir: process.cwd(),
				slug: "test-project",
				persistenceDbPath: tempEventsDbPath(),
				publishGlobalSetting: () => Effect.void,
				getInstances: instanceMgmt.getInstances,
				addInstance: instanceMgmt.addInstance,
				removeInstance: instanceMgmt.removeInstance,
				startInstance: instanceMgmt.startInstance,
				stopInstance: instanceMgmt.stopInstance,
				updateInstance: instanceMgmt.updateInstance,
				persistConfig: instanceMgmt.persistConfig,
			} satisfies ProjectRelayConfig),
		),
	);

describe("InstanceManagementServiceLive", () => {
	it.effect("delegates account allocation and raw input, then persists", () => {
		const instanceMgmt = makeInstanceMgmt();

		return Effect.gen(function* () {
			const service = yield* InstanceManagementServiceTag;
			const instances = yield* service.add({
				name: "  Test Instance  ",
				port: 4096,
				managed: true,
			});

			expect(instanceMgmt.addInstance).toHaveBeenCalledWith({
				name: "  Test Instance  ",
				port: 4096,
				managed: true,
			});
			expect(instanceMgmt.persistConfig).toHaveBeenCalledOnce();
			expect(instances).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ id: "allocated-account" }),
				]),
			);
		}).pipe(Effect.provide(makeLayer(instanceMgmt)));
	});

	it.effect("forwards configured URLs and persists", () => {
		const instanceMgmt = makeInstanceMgmt();

		return Effect.gen(function* () {
			const service = yield* InstanceManagementServiceTag;
			yield* service.add({
				name: "Remote",
				url: "https://opencode.example.test",
			});

			expect(instanceMgmt.addInstance).toHaveBeenCalledWith({
				name: "Remote",
				url: "https://opencode.example.test",
			});
			expect(instanceMgmt.persistConfig).toHaveBeenCalledOnce();
		}).pipe(Effect.provide(makeLayer(instanceMgmt)));
	});

	it.effect("sends an instance error when start fails", () => {
		const instanceMgmt = makeInstanceMgmt([makeInstance()]);
		vi.mocked(instanceMgmt.startInstance).mockRejectedValue(
			new Error("spawn failed"),
		);

		return Effect.gen(function* () {
			const service = yield* InstanceManagementServiceTag;
			const result = yield* Effect.either(service.start("instance-1"));

			expect(result).toMatchObject({
				_tag: "Left",
				left: {
					_tag: "InstanceManagementServiceError",
					operation: "start",
					cause: expect.any(Error),
				},
			});
		}).pipe(Effect.provide(makeLayer(instanceMgmt)));
	});

	it.effect("forwards rename input and persists", () => {
		const instanceMgmt = makeInstanceMgmt([makeInstance()]);

		return Effect.gen(function* () {
			const service = yield* InstanceManagementServiceTag;
			const instances = yield* service.rename("instance-1", "  Renamed  ");

			expect(instanceMgmt.updateInstance).toHaveBeenCalledWith("instance-1", {
				name: "  Renamed  ",
			});
			expect(instanceMgmt.persistConfig).toHaveBeenCalledOnce();
			expect(instances).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ id: "instance-1", name: "  Renamed  " }),
				]),
			);
		}).pipe(Effect.provide(makeLayer(instanceMgmt)));
	});

	it.effect(
		"can derive the relay instance service from ProjectRelayConfig",
		() => {
			const instanceMgmt = makeInstanceMgmt();

			return Effect.gen(function* () {
				const service = yield* InstanceManagementServiceTag;
				const instances = yield* service.add({
					name: "Config Instance",
					port: 4096,
				});

				expect(instanceMgmt.addInstance).toHaveBeenCalledWith({
					name: "Config Instance",
					port: 4096,
				});
				expect(instanceMgmt.persistConfig).toHaveBeenCalledOnce();
				expect(instances).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ id: "allocated-account" }),
					]),
				);
			}).pipe(Effect.provide(makeConfigLayer(instanceMgmt)));
		},
	);
});
