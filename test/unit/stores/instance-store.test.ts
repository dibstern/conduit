import { assert, beforeEach, describe, expect, it } from "vitest";
import {
	applyInstanceListResponse,
	clearInstanceState,
	getHealthyInstances,
	getInstanceById,
	instanceState,
	instanceStatusColor,
} from "../../../src/lib/frontend/stores/instance.svelte.js";
import type { OpenCodeInstance } from "../../../src/lib/frontend/types.js";

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

beforeEach(() => {
	clearInstanceState();
});

describe("Instance Store", () => {
	it("initializes with empty state", () => {
		expect(instanceState.instances).toEqual([]);
	});

	it("applyInstanceListResponse populates instances", () => {
		const instances = [
			makeInstance({ id: "default", port: 4096 }),
			makeInstance({ id: "work", port: 4097, status: "stopped" }),
		];

		applyInstanceListResponse({
			instances,
		});

		expect(instanceState.instances).toHaveLength(2);
		const firstInstance = instanceState.instances[0];
		const secondInstance = instanceState.instances[1];
		assert.exists(firstInstance, "expected default instance");
		assert.exists(secondInstance, "expected work instance");
		expect(firstInstance.id).toBe("default");
		expect(secondInstance.id).toBe("work");
	});

	it("carries driver and configDir through an RPC instance list", () => {
		applyInstanceListResponse({
			instances: [
				{
					id: "work-claude",
					name: "Work Claude",
					port: 0,
					managed: false,
					status: "healthy",
					driver: "claude",
					configDir: "/profiles/work",
					restartCount: 0,
					createdAt: 1,
				},
				{
					id: "remote-opencode",
					name: "Remote OpenCode",
					port: 0,
					managed: false,
					status: "healthy",
					driver: "opencode",
					url: "https://opencode.example.test",
					restartCount: 0,
					createdAt: 1,
				},
			],
		});

		expect(getInstanceById("work-claude")).toMatchObject({
			driver: "claude",
			configDir: "/profiles/work",
		});
		expect(getInstanceById("remote-opencode")).toMatchObject({
			driver: "opencode",
			url: "https://opencode.example.test",
		});
	});

	it("getInstanceById returns matching instance", () => {
		applyInstanceListResponse({
			instances: [
				makeInstance({ id: "a", name: "Alpha" }),
				makeInstance({ id: "b", name: "Beta" }),
			],
		});

		const found = getInstanceById("b");
		expect(found).toBeDefined();
		assert.exists(found, "expected Beta instance");
		expect(found.name).toBe("Beta");
	});

	it("getInstanceById returns undefined for nonexistent", () => {
		applyInstanceListResponse({
			instances: [makeInstance({ id: "a" })],
		});

		expect(getInstanceById("zzz")).toBeUndefined();
	});

	it("getHealthyInstances filters by status", () => {
		applyInstanceListResponse({
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
		applyInstanceListResponse({
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
