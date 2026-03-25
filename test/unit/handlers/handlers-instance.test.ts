// ─── Instance Handler Tests ──────────────────────────────────────────────────
// Verify instance_add, instance_remove, instance_start, instance_stop handlers
// correctly delegate to the InstanceManager methods on HandlerDeps and
// broadcast updated instance_list to all clients after mutations.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	handleInstanceAdd,
	handleInstanceRemove,
	handleInstanceStart,
	handleInstanceStop,
	handleSetProjectInstance,
} from "../../../src/lib/handlers/instance.js";
import type { PayloadMap } from "../../../src/lib/handlers/payloads.js";
import type { HandlerDeps } from "../../../src/lib/handlers/types.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import type { OpenCodeInstance } from "../../../src/lib/shared-types.js";
import { createMockHandlerDeps } from "../../helpers/mock-factories.js";

const MOCK_INSTANCES: OpenCodeInstance[] = [
	{
		id: "personal",
		name: "Personal",
		port: 4096,
		managed: true,
		status: "healthy",
		restartCount: 0,
		createdAt: Date.now(),
	},
	{
		id: "work",
		name: "Work",
		port: 4097,
		managed: true,
		status: "unhealthy",
		restartCount: 2,
		createdAt: Date.now(),
	},
];

describe("Instance handlers", () => {
	let deps: HandlerDeps;
	let broadcastCalls: unknown[];
	let sendToCalls: Array<{ clientId: string; msg: unknown }>;
	let instances: OpenCodeInstance[];

	beforeEach(() => {
		broadcastCalls = [];
		sendToCalls = [];
		instances = [...MOCK_INSTANCES];

		deps = createMockHandlerDeps({
			wsHandler: {
				broadcast: (msg: unknown) => broadcastCalls.push(msg),
				sendTo: (clientId: string, msg: unknown) =>
					sendToCalls.push({ clientId, msg }),
			} as unknown as HandlerDeps["wsHandler"],
			instanceMgmt: {
				getInstances: () => instances,
				addInstance: vi.fn((id: string, config) => {
					const inst: OpenCodeInstance = {
						id,
						name: config.name,
						port: config.port,
						managed: config.managed,
						status: "stopped",
						restartCount: 0,
						createdAt: Date.now(),
					};
					instances.push(inst);
					return inst;
				}),
				removeInstance: vi.fn((id: string) => {
					const idx = instances.findIndex((i) => i.id === id);
					if (idx === -1) throw new Error(`Instance "${id}" not found`);
					instances.splice(idx, 1);
				}),
				startInstance: vi.fn(),
				stopInstance: vi.fn(),
				updateInstance: vi.fn(),
				persistConfig: vi.fn(),
			},
			log: createSilentLogger(),
		});
	});

	// ─── instance_add ─────────────────────────────────────────────────────

	describe("handleInstanceAdd", () => {
		it("adds a managed instance and broadcasts updated list", async () => {
			await handleInstanceAdd(deps, "client-1", {
				name: "staging",
				port: 4098,
				managed: true,
			});

			expect(deps.instanceMgmt?.addInstance).toHaveBeenCalledWith("staging", {
				name: "staging",
				port: 4098,
				managed: true,
			});
			expect(broadcastCalls).toHaveLength(1);
			const msg = broadcastCalls[0] as { type: string; instances: unknown[] };
			expect(msg.type).toBe("instance_list");
			expect(msg.instances).toHaveLength(3); // 2 original + 1 new
		});

		it("calls persistConfig after adding instance", async () => {
			await handleInstanceAdd(deps, "client-1", {
				name: "staging",
				port: 4098,
				managed: true,
			});

			expect(deps.instanceMgmt?.persistConfig).toHaveBeenCalledTimes(1);
		});

		it("adds an external instance with URL (managed=false)", async () => {
			await handleInstanceAdd(deps, "client-1", {
				name: "remote",
				url: "http://remote.example.com:4096",
			});

			expect(deps.instanceMgmt?.addInstance).toHaveBeenCalledWith("remote", {
				name: "remote",
				port: 0,
				managed: false,
				url: "http://remote.example.com:4096",
			});
			expect(broadcastCalls).toHaveLength(1);
		});

		it("generates unique ID when name conflicts", async () => {
			await handleInstanceAdd(deps, "client-1", {
				name: "Personal",
				port: 4099,
				managed: true,
			});

			// "personal" is taken, so it should be "personal-2"
			expect(deps.instanceMgmt?.addInstance).toHaveBeenCalledWith(
				"personal-2",
				expect.objectContaining({ name: "Personal" }),
			);
		});

		it("sends error when name is missing", async () => {
			await handleInstanceAdd(deps, "client-1", {
				port: 4098,
			} as unknown as PayloadMap["instance_add"]);

			expect(deps.instanceMgmt?.addInstance).not.toHaveBeenCalled();
			expect(broadcastCalls).toHaveLength(0);
			expect(sendToCalls).toHaveLength(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
			expect(sendToCalls[0]!.msg).toMatchObject({
				type: "error",
				code: "INSTANCE_ERROR",
				message: "Instance name is required",
			});
		});

		it("sends error when instanceMgmt is not available", async () => {
			delete deps.instanceMgmt;

			await handleInstanceAdd(deps, "client-1", {
				name: "staging",
				port: 4098,
			});

			expect(broadcastCalls).toHaveLength(0);
			expect(sendToCalls).toHaveLength(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
			expect(sendToCalls[0]!.msg).toMatchObject({
				type: "error",
				message: "Instance management not available",
			});
		});
	});

	// ─── instance_remove ──────────────────────────────────────────────────

	describe("handleInstanceRemove", () => {
		it("removes instance and broadcasts updated list", async () => {
			await handleInstanceRemove(deps, "client-1", {
				instanceId: "work",
			});

			expect(deps.instanceMgmt?.removeInstance).toHaveBeenCalledWith("work");
			expect(broadcastCalls).toHaveLength(1);
			const msg = broadcastCalls[0] as { type: string; instances: unknown[] };
			expect(msg.type).toBe("instance_list");
			expect(msg.instances).toHaveLength(1); // only "personal" left
		});

		it("calls persistConfig after removing instance", async () => {
			await handleInstanceRemove(deps, "client-1", {
				instanceId: "work",
			});

			expect(deps.instanceMgmt?.persistConfig).toHaveBeenCalledTimes(1);
		});

		it("sends error when instanceId is missing", async () => {
			await handleInstanceRemove(
				deps,
				"client-1",
				{} as unknown as PayloadMap["instance_remove"],
			);

			expect(deps.instanceMgmt?.removeInstance).not.toHaveBeenCalled();
			expect(sendToCalls).toHaveLength(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
			expect(sendToCalls[0]!.msg).toMatchObject({
				type: "error",
				message: "instanceId is required",
			});
		});

		it("sends error when instance not found", async () => {
			await handleInstanceRemove(deps, "client-1", {
				instanceId: "nonexistent",
			});

			expect(sendToCalls).toHaveLength(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
			expect(sendToCalls[0]!.msg).toMatchObject({
				type: "error",
				code: "INSTANCE_ERROR",
			});
		});
	});

	// ─── instance_start ─────────────────────────────────────────────────

	describe("handleInstanceStart", () => {
		it("starts instance and broadcasts updated list", async () => {
			await handleInstanceStart(deps, "client-1", {
				instanceId: "work",
			});

			expect(deps.instanceMgmt?.startInstance).toHaveBeenCalledWith("work");
			expect(broadcastCalls).toHaveLength(1);
		});

		it("sends error when instanceId is missing", async () => {
			await handleInstanceStart(
				deps,
				"client-1",
				{} as unknown as PayloadMap["instance_start"],
			);

			expect(deps.instanceMgmt?.startInstance).not.toHaveBeenCalled();
			expect(sendToCalls).toHaveLength(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
			expect(sendToCalls[0]!.msg).toMatchObject({
				type: "error",
				message: "instanceId is required",
			});
		});
	});

	// ─── instance_stop ──────────────────────────────────────────────────

	describe("handleInstanceStop", () => {
		it("stops instance and broadcasts updated list", async () => {
			await handleInstanceStop(deps, "client-1", {
				instanceId: "personal",
			});

			expect(deps.instanceMgmt?.stopInstance).toHaveBeenCalledWith("personal");
			expect(broadcastCalls).toHaveLength(1);
		});

		it("sends error when instanceId is missing", async () => {
			await handleInstanceStop(
				deps,
				"client-1",
				{} as unknown as PayloadMap["instance_stop"],
			);

			expect(deps.instanceMgmt?.stopInstance).not.toHaveBeenCalled();
			expect(sendToCalls).toHaveLength(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
			expect(sendToCalls[0]!.msg).toMatchObject({
				type: "error",
				message: "instanceId is required",
			});
		});
	});

	// ─── set_project_instance ─────────────────────────────────────────────

	describe("handleSetProjectInstance", () => {
		it("calls setProjectInstance and broadcasts updated project_list", async () => {
			const projects = [
				{
					slug: "myapp",
					title: "myapp",
					directory: "/src/myapp",
					instanceId: "personal",
				},
			];
			const setProjectInstance = vi.fn((slug: string, instanceId: string) => {
				const p = projects.find((p) => p.slug === slug);
				if (p) p.instanceId = instanceId;
			});
			deps.projectMgmt = {
				setProjectInstance,
				getProjects: () => projects,
			};

			await handleSetProjectInstance(deps, "client-1", {
				slug: "myapp",
				instanceId: "work",
			});

			expect(setProjectInstance).toHaveBeenCalledWith("myapp", "work");
			// Should broadcast updated project_list
			expect(broadcastCalls).toHaveLength(1);
			const msg = broadcastCalls[0] as { type: string; projects: unknown[] };
			expect(msg.type).toBe("project_list");
			expect(msg.projects).toHaveLength(1);
		});

		it("sends error when slug is missing", async () => {
			deps.projectMgmt = {
				setProjectInstance: vi.fn(),
				getProjects: () => [],
			};

			await handleSetProjectInstance(deps, "client-1", {
				instanceId: "work",
			} as unknown as PayloadMap["set_project_instance"]);

			expect(sendToCalls).toHaveLength(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
			expect(sendToCalls[0]!.msg).toMatchObject({
				type: "error",
				code: "INSTANCE_ERROR",
			});
		});

		it("sends error when instanceId is missing", async () => {
			deps.projectMgmt = {
				setProjectInstance: vi.fn(),
				getProjects: () => [],
			};

			await handleSetProjectInstance(deps, "client-1", {
				slug: "myapp",
			} as unknown as PayloadMap["set_project_instance"]);

			expect(sendToCalls).toHaveLength(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
			expect(sendToCalls[0]!.msg).toMatchObject({
				type: "error",
				code: "INSTANCE_ERROR",
			});
		});

		it("sends error when projectMgmt is not available", async () => {
			// projectMgmt is undefined by default

			await handleSetProjectInstance(deps, "client-1", {
				slug: "myapp",
				instanceId: "work",
			});

			expect(sendToCalls).toHaveLength(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
			expect(sendToCalls[0]!.msg).toMatchObject({
				type: "error",
				message: "Project instance binding not available",
			});
		});

		it("calls setProjectInstance with slug and instanceId", async () => {
			const setProjectInstance = vi.fn();
			deps.projectMgmt = {
				setProjectInstance,
				getProjects: () => [],
			};

			await handleSetProjectInstance(deps, "client-1", {
				slug: "myapp",
				instanceId: "work",
			});

			expect(setProjectInstance).toHaveBeenCalledWith("myapp", "work");
		});
	});
});
