import { describe, expect, it, vi } from "vitest";
import { handleInstanceRename } from "../../../src/lib/handlers/instance.js";
import { createMockHandlerDeps } from "../../helpers/mock-factories.js";

describe("handleInstanceRename", () => {
	it("renames an existing instance and broadcasts", async () => {
		const deps = createMockHandlerDeps({
			instanceMgmt: {
				updateInstance: vi.fn().mockReturnValue({ id: "inst-1", name: "work" }),
				getInstances: vi.fn().mockReturnValue([{ id: "inst-1", name: "work" }]),
				persistConfig: vi.fn(),
				addInstance: vi.fn(),
				removeInstance: vi.fn(),
				startInstance: vi.fn(),
				stopInstance: vi.fn(),
			},
		});

		await handleInstanceRename(deps, "client-1", {
			instanceId: "inst-1",
			name: "work",
		});

		expect(deps.instanceMgmt?.updateInstance).toHaveBeenCalledWith("inst-1", {
			name: "work",
		});
		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({ type: "instance_list" }),
		);
		expect(deps.instanceMgmt?.persistConfig).toHaveBeenCalled();
	});

	it("rejects empty name", async () => {
		const deps = createMockHandlerDeps({
			instanceMgmt: {
				updateInstance: vi.fn(),
				getInstances: vi.fn().mockReturnValue([]),
				persistConfig: vi.fn(),
				addInstance: vi.fn(),
				removeInstance: vi.fn(),
				startInstance: vi.fn(),
				stopInstance: vi.fn(),
			},
		});

		await handleInstanceRename(deps, "client-1", {
			instanceId: "inst-1",
			name: "",
		});

		expect(deps.instanceMgmt?.updateInstance).not.toHaveBeenCalled();
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "error",
			code: "INSTANCE_ERROR",
			message: "name is required and cannot be empty",
		});
	});

	it("rejects whitespace-only name", async () => {
		const deps = createMockHandlerDeps({
			instanceMgmt: {
				updateInstance: vi.fn(),
				getInstances: vi.fn().mockReturnValue([]),
				persistConfig: vi.fn(),
				addInstance: vi.fn(),
				removeInstance: vi.fn(),
				startInstance: vi.fn(),
				stopInstance: vi.fn(),
			},
		});

		await handleInstanceRename(deps, "client-1", {
			instanceId: "inst-1",
			name: "   ",
		});

		expect(deps.instanceMgmt?.updateInstance).not.toHaveBeenCalled();
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "error",
			code: "INSTANCE_ERROR",
			message: "name is required and cannot be empty",
		});
	});

	it("rejects missing instanceId", async () => {
		const deps = createMockHandlerDeps({
			instanceMgmt: {
				updateInstance: vi.fn(),
				getInstances: vi.fn().mockReturnValue([]),
				persistConfig: vi.fn(),
				addInstance: vi.fn(),
				removeInstance: vi.fn(),
				startInstance: vi.fn(),
				stopInstance: vi.fn(),
			},
		});

		await handleInstanceRename(deps, "client-1", {
			instanceId: "",
			name: "work",
		});

		expect(deps.instanceMgmt?.updateInstance).not.toHaveBeenCalled();
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "error",
			code: "INSTANCE_ERROR",
			message: "instanceId is required",
		});
	});

	it("sends error when instanceMgmt not available", async () => {
		const deps = createMockHandlerDeps();
		// instanceMgmt is undefined by default in mock

		await handleInstanceRename(deps, "client-1", {
			instanceId: "inst-1",
			name: "work",
		});

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "error",
			code: "INSTANCE_ERROR",
			message: "Instance management not available",
		});
	});

	it("trims name before saving", async () => {
		const deps = createMockHandlerDeps({
			instanceMgmt: {
				updateInstance: vi.fn().mockReturnValue({ id: "inst-1", name: "work" }),
				getInstances: vi.fn().mockReturnValue([{ id: "inst-1", name: "work" }]),
				persistConfig: vi.fn(),
				addInstance: vi.fn(),
				removeInstance: vi.fn(),
				startInstance: vi.fn(),
				stopInstance: vi.fn(),
			},
		});

		await handleInstanceRename(deps, "client-1", {
			instanceId: "inst-1",
			name: "  work  ",
		});

		expect(deps.instanceMgmt?.updateInstance).toHaveBeenCalledWith("inst-1", {
			name: "work",
		});
	});
});
