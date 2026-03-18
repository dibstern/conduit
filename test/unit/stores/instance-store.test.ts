// ─── Instance Store Tests ────────────────────────────────────────────────────
import { beforeEach, describe, expect, it } from "vitest";
import {
	clearInstanceState,
	getHealthyInstances,
	getInstanceById,
	handleInstanceList,
	handleInstanceStatus,
	instanceState,
	instanceStatusColor,
} from "../../../src/lib/frontend/stores/instance.svelte.js";
import type {
	OpenCodeInstance,
	RelayMessage,
} from "../../../src/lib/frontend/types.js";

// ─── Helper ─────────────────────────────────────────────────────────────────

function makeInstance(
	overrides: Partial<OpenCodeInstance> & { id: string },
): OpenCodeInstance {
	return {
		name: overrides.id,
		port: 4096,
		managed: false,
		status: "healthy",
		restartCount: 0,
		createdAt: Date.now(),
		...overrides,
	};
}

// ─── Reset state before each test ───────────────────────────────────────────

beforeEach(() => {
	clearInstanceState();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Instance Store", () => {
	it("initializes with empty state", () => {
		expect(instanceState.instances).toEqual([]);
	});

	it("handleInstanceList populates instances", () => {
		const instances = [
			makeInstance({ id: "default", port: 4096 }),
			makeInstance({ id: "work", port: 4097, status: "stopped" }),
		];

		handleInstanceList({
			type: "instance_list",
			instances,
		});

		expect(instanceState.instances).toHaveLength(2);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(instanceState.instances[0]!.id).toBe("default");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(instanceState.instances[1]!.id).toBe("work");
	});

	it("handleInstanceList ignores non-array instances", () => {
		// Populate first
		handleInstanceList({
			type: "instance_list",
			instances: [makeInstance({ id: "a" })],
		});
		expect(instanceState.instances).toHaveLength(1);

		// Send a malformed message (cast to bypass type check)
		handleInstanceList({
			type: "instance_list",
			instances: "not-an-array",
		} as unknown as Extract<RelayMessage, { type: "instance_list" }>);

		// Should remain unchanged
		expect(instanceState.instances).toHaveLength(1);
	});

	it("handleInstanceStatus updates a single instance status", () => {
		handleInstanceList({
			type: "instance_list",
			instances: [
				makeInstance({ id: "default", status: "healthy" }),
				makeInstance({ id: "work", status: "healthy" }),
			],
		});

		handleInstanceStatus({
			type: "instance_status",
			instanceId: "work",
			status: "unhealthy",
		});

		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(instanceState.instances[0]!.status).toBe("healthy");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(instanceState.instances[1]!.status).toBe("unhealthy");
	});

	it("handleInstanceStatus is a no-op for unknown instanceId", () => {
		handleInstanceList({
			type: "instance_list",
			instances: [makeInstance({ id: "default", status: "healthy" })],
		});

		handleInstanceStatus({
			type: "instance_status",
			instanceId: "nonexistent",
			status: "stopped",
		});

		// Should remain unchanged
		expect(instanceState.instances).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(instanceState.instances[0]!.status).toBe("healthy");
	});

	it("getInstanceById returns matching instance", () => {
		handleInstanceList({
			type: "instance_list",
			instances: [
				makeInstance({ id: "a", name: "Alpha" }),
				makeInstance({ id: "b", name: "Beta" }),
			],
		});

		const found = getInstanceById("b");
		expect(found).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(found!.name).toBe("Beta");
	});

	it("getInstanceById returns undefined for nonexistent", () => {
		handleInstanceList({
			type: "instance_list",
			instances: [makeInstance({ id: "a" })],
		});

		expect(getInstanceById("zzz")).toBeUndefined();
	});

	it("getHealthyInstances filters by status", () => {
		handleInstanceList({
			type: "instance_list",
			instances: [
				makeInstance({ id: "a", status: "healthy" }),
				makeInstance({ id: "b", status: "unhealthy" }),
				makeInstance({ id: "c", status: "healthy" }),
				makeInstance({ id: "d", status: "stopped" }),
			],
		});

		const healthy = getHealthyInstances();
		expect(healthy).toHaveLength(2);
		expect(healthy.map((i) => i.id)).toEqual(["a", "c"]);
	});

	it("clearInstanceState resets everything", () => {
		handleInstanceList({
			type: "instance_list",
			instances: [makeInstance({ id: "x" })],
		});

		expect(instanceState.instances).toHaveLength(1);

		clearInstanceState();

		expect(instanceState.instances).toEqual([]);
	});

	describe("instanceStatusColor", () => {
		it("returns green for healthy", () => {
			expect(instanceStatusColor("healthy")).toBe("bg-green-500");
		});

		it("returns yellow for starting", () => {
			expect(instanceStatusColor("starting")).toBe("bg-yellow-500");
		});

		it("returns red for unhealthy", () => {
			expect(instanceStatusColor("unhealthy")).toBe("bg-red-500");
		});

		it("returns zinc for stopped", () => {
			expect(instanceStatusColor("stopped")).toBe("bg-zinc-500");
		});

		it("returns zinc for undefined", () => {
			expect(instanceStatusColor(undefined)).toBe("bg-zinc-500");
		});
	});
});
