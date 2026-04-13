// ─── Instance Wiring Integration Tests ──────────────────────────────────────
// Verifies the full wiring chain that delivers instance data to browser clients:
//
//   Daemon.getInstances()
//     → ProjectRelayConfig.getInstances
//       → ClientInitDeps.getInstances
//         → handleClientConnected sends instance_list
//
//   Daemon.getProjects() (with instanceId)
//     → ProjectRelayConfig.getProjects
//       → handleGetProjects sends project_list with instanceId
//
// These tests target the most likely failure modes — gaps in the data
// threading chain where a field is defined in one layer but not propagated
// to the next.

import { describe, expect, it, vi } from "vitest";
import {
	type ClientInitDeps,
	handleClientConnected,
} from "../../../src/lib/bridges/client-init.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import type { ProjectRelayConfig } from "../../../src/lib/types.js";
import { createMockClientInitDeps } from "../../helpers/mock-factories.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Extract messages of a given type from sendTo calls */
function getSentMessages(
	sendTo: ReturnType<typeof vi.fn>,
	type: string,
): unknown[] {
	return sendTo.mock.calls
		.filter((c: unknown[]) => (c[1] as { type: string }).type === type)
		.map((c: unknown[]) => c[1]);
}

/** Type-safe cast for vi.fn mocks */
function asMock(fn: unknown): ReturnType<typeof vi.fn> {
	return fn as ReturnType<typeof vi.fn>;
}

// ─── Test: instance_list delivered on client connect ─────────────────────────
// This is the PRIMARY bug that was broken — getInstances was never threaded
// from daemon → relay → client-init, so instance_list was never sent.

describe("instance_list delivery on client connect", () => {
	it("sends instance_list when getInstances returns multiple instances", async () => {
		const instances = [
			{
				id: "default",
				name: "Default",
				port: 4096,
				managed: false,
				status: "healthy" as const,
				restartCount: 0,
				createdAt: 1000,
			},
			{
				id: "work",
				name: "Work",
				port: 4097,
				managed: true,
				status: "stopped" as const,
				restartCount: 0,
				createdAt: 2000,
			},
		];
		const deps = createMockClientInitDeps({
			getInstances: () => instances,
		});

		await handleClientConnected(deps, "client-1");

		const msgs = getSentMessages(
			asMock(deps.wsHandler.sendTo),
			"instance_list",
		);
		expect(msgs).toHaveLength(1);
		expect(msgs[0]).toEqual({ type: "instance_list", instances });
	});

	it("sends instance_list with empty array when getInstances returns []", async () => {
		const deps = createMockClientInitDeps({
			getInstances: () => [],
		});

		await handleClientConnected(deps, "client-1");

		const msgs = getSentMessages(
			asMock(deps.wsHandler.sendTo),
			"instance_list",
		);
		expect(msgs).toHaveLength(1);
		expect(msgs[0]).toEqual({ type: "instance_list", instances: [] });
	});

	it("does NOT send instance_list when getInstances is undefined (standalone mode)", async () => {
		const deps = createMockClientInitDeps();
		// getInstances not set — simulates standalone relay without daemon

		await handleClientConnected(deps, "client-1");

		const msgs = getSentMessages(
			asMock(deps.wsHandler.sendTo),
			"instance_list",
		);
		expect(msgs).toHaveLength(0);
	});

	it("instance_list is sent via sendTo (unicast) not broadcast", async () => {
		const deps = createMockClientInitDeps({
			getInstances: () => [
				{
					id: "default",
					name: "Default",
					port: 4096,
					managed: false,
					status: "healthy" as const,
					restartCount: 0,
					createdAt: 1000,
				},
			],
		});

		await handleClientConnected(deps, "client-42");

		// sendTo should have instance_list for this specific client
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-42",
			expect.objectContaining({ type: "instance_list" }),
		);
		// broadcast should NOT have instance_list
		const broadcastMsgs = asMock(deps.wsHandler.broadcast).mock.calls.filter(
			(c: unknown[]) => (c[0] as { type: string }).type === "instance_list",
		);
		expect(broadcastMsgs).toHaveLength(0);
	});

	it("instance_list preserves all instance fields through the chain", async () => {
		const instance = {
			id: "prod",
			name: "Production",
			port: 8080,
			managed: true,
			status: "healthy" as const,
			restartCount: 3,
			createdAt: Date.now(),
			pid: 12345,
			url: "http://prod.example.com:8080",
		};
		const deps = createMockClientInitDeps({
			getInstances: () => [instance],
		});

		await handleClientConnected(deps, "client-1");

		const msgs = getSentMessages(
			asMock(deps.wsHandler.sendTo),
			"instance_list",
		);
		const sent = (msgs[0] as { instances: unknown[] }).instances[0];
		// Verify all fields survive the trip
		expect(sent).toMatchObject({
			id: "prod",
			name: "Production",
			port: 8080,
			managed: true,
			status: "healthy",
			restartCount: 3,
			pid: 12345,
			url: "http://prod.example.com:8080",
		});
	});
});

// ─── Test: ProjectRelayConfig type includes getInstances ─────────────────────
// The root cause was that ProjectRelayConfig didn't have getInstances, so
// the daemon couldn't pass it to createProjectRelay.

describe("ProjectRelayConfig type contract", () => {
	it("accepts getInstances as an optional field", () => {
		// This is a compile-time test — if ProjectRelayConfig doesn't have
		// getInstances, this file won't compile. But we also verify runtime.
		const config: Partial<ProjectRelayConfig> = {
			getInstances: () => [
				{
					id: "test",
					name: "Test",
					port: 4096,
					managed: false,
					status: "stopped" as const,
					restartCount: 0,
					createdAt: 0,
				},
			],
		};
		expect(config.getInstances).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(config.getInstances!()).toHaveLength(1);
	});

	it("allows getProjects to return objects with instanceId", () => {
		const config: Partial<ProjectRelayConfig> = {
			getProjects: () => [
				{
					slug: "my-app",
					title: "My App",
					directory: "/home/user/app",
					instanceId: "default",
				},
			],
		};
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		const projects = config.getProjects!();
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		expect(projects[0]!.instanceId).toBe("default");
	});

	it("allows getProjects to omit instanceId (backward compat)", () => {
		const config: Partial<ProjectRelayConfig> = {
			getProjects: () => [
				{
					slug: "solo",
					title: "Solo",
					directory: "/home/user/solo",
				},
			],
		};
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		const projects = config.getProjects!();
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		expect(projects[0]!.instanceId).toBeUndefined();
	});
});

// ─── Test: project_list includes instanceId ──────────────────────────────────
// The second gap: project_list messages had the instanceId stripped by the
// explicit type annotation in handleGetProjects.

describe("project_list includes instanceId", () => {
	it("handleGetProjects threads instanceId from getProjects to client", async () => {
		// Import the handler
		const { handleGetProjects } = await import(
			"../../../src/lib/handlers/settings.js"
		);

		const mockDeps = {
			wsHandler: {
				sendTo: vi.fn(),
				broadcast: vi.fn(),
				setClientSession: vi.fn(),
				getClientSession: vi.fn(),
				getClientsForSession: vi.fn().mockReturnValue([]),
				sendToSession: vi.fn(),
			},
			client: {
				app: { projects: vi.fn() },
			},
			config: {
				slug: "current-project",
				getProjects: () => [
					{
						slug: "app-a",
						title: "App A",
						directory: "/apps/a",
						instanceId: "inst-1",
					},
					{
						slug: "app-b",
						title: "App B",
						directory: "/apps/b",
						instanceId: "inst-2",
					},
					{
						slug: "app-c",
						title: "App C",
						directory: "/apps/c",
						// no instanceId — should be absent, not null
					},
				],
			},
			log: createSilentLogger(),
		};

		await handleGetProjects(
			mockDeps as unknown as Parameters<typeof handleGetProjects>[0],
			"client-1",
			{},
		);

		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		const sent = mockDeps.wsHandler.sendTo.mock.calls[0]![1] as {
			type: string;
			projects: Array<{
				slug: string;
				instanceId?: string;
			}>;
		};
		expect(sent.type).toBe("project_list");
		expect(sent.projects).toHaveLength(3);
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		expect(sent.projects[0]!.instanceId).toBe("inst-1");
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		expect(sent.projects[1]!.instanceId).toBe("inst-2");
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		expect(sent.projects[2]!.instanceId).toBeUndefined();
	});

	it("project_list from OpenCode API fallback has no instanceId (expected)", async () => {
		const { handleGetProjects } = await import(
			"../../../src/lib/handlers/settings.js"
		);

		const mockDeps = {
			wsHandler: {
				sendTo: vi.fn(),
				broadcast: vi.fn(),
				setClientSession: vi.fn(),
				getClientSession: vi.fn(),
				getClientsForSession: vi.fn().mockReturnValue([]),
				sendToSession: vi.fn(),
			},
			client: {
				app: {
					projects: vi
						.fn()
						.mockResolvedValue([{ id: "proj-1", name: "Proj 1", path: "/p1" }]),
				},
			},
			config: {
				slug: "proj-1",
				// No getProjects — forces OpenCode API fallback
			},
			log: createSilentLogger(),
		};

		await handleGetProjects(
			mockDeps as unknown as Parameters<typeof handleGetProjects>[0],
			"client-1",
			{},
		);

		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		const sent = mockDeps.wsHandler.sendTo.mock.calls[0]![1] as {
			type: string;
			projects: Array<{ slug: string; instanceId?: string }>;
		};
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		expect(sent.projects[0]!.instanceId).toBeUndefined();
	});
});

// ─── Test: end-to-end daemon → client-init → instance_list ──────────────────
// Simulates the full chain: daemon constructs instances, passes getInstances
// to relay config, relay threads it to clientInitDeps, client connect receives it.

describe("end-to-end instance wiring", () => {
	it("daemon with opencodeUrl provides instances to client on connect", async () => {
		// Simulate what the daemon does: create instances and provide getInstances
		const instances = [
			{
				id: "default",
				name: "Default",
				port: 4096,
				managed: false,
				status: "stopped" as const,
				restartCount: 0,
				createdAt: Date.now(),
			},
		];

		// This is what createProjectRelay would receive from the daemon
		const getInstances = () => instances;

		// And this is what clientInitDeps would get
		const deps = createMockClientInitDeps({ getInstances });

		await handleClientConnected(deps, "browser-client");

		// Browser client should receive instance_list with the daemon's instances
		const msgs = getSentMessages(
			asMock(deps.wsHandler.sendTo),
			"instance_list",
		);
		expect(msgs).toHaveLength(1);
		expect((msgs[0] as { instances: unknown[] }).instances).toEqual(instances);
	});

	it("daemon with no instances does not send instance_list", async () => {
		// Standalone mode — no daemon, no instances
		const deps = createMockClientInitDeps();

		await handleClientConnected(deps, "browser-client");

		const msgs = getSentMessages(
			asMock(deps.wsHandler.sendTo),
			"instance_list",
		);
		expect(msgs).toHaveLength(0);
	});

	it("getInstances reflects live instance state changes", async () => {
		// Simulate instances changing between connects (e.g., instance started)
		const instances: Array<{
			id: string;
			name: string;
			port: number;
			managed: boolean;
			status: string;
			restartCount: number;
			createdAt: number;
		}> = [
			{
				id: "default",
				name: "Default",
				port: 4096,
				managed: true,
				status: "stopped",
				restartCount: 0,
				createdAt: 1000,
			},
		];

		const deps = createMockClientInitDeps({
			getInstances: () =>
				instances as ClientInitDeps["getInstances"] extends () => infer R
					? R
					: never,
		});

		// First connect — stopped
		await handleClientConnected(deps, "client-1");
		let msgs = getSentMessages(asMock(deps.wsHandler.sendTo), "instance_list");
		expect(
			// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
			(msgs[0] as { instances: Array<{ status: string }> }).instances[0]!
				.status,
		).toBe("stopped");

		// Simulate instance starting
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		instances[0]!.status = "healthy";

		// Second connect — should see updated status
		asMock(deps.wsHandler.sendTo).mockClear();
		await handleClientConnected(deps, "client-2");
		msgs = getSentMessages(asMock(deps.wsHandler.sendTo), "instance_list");
		expect(
			// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
			(msgs[0] as { instances: Array<{ status: string }> }).instances[0]!
				.status,
		).toBe("healthy");
	});

	it("multiple clients each receive their own instance_list", async () => {
		const instances = [
			{
				id: "default",
				name: "Default",
				port: 4096,
				managed: false,
				status: "healthy" as const,
				restartCount: 0,
				createdAt: 1000,
			},
		];
		const deps = createMockClientInitDeps({
			getInstances: () => instances,
		});

		await handleClientConnected(deps, "client-A");
		await handleClientConnected(deps, "client-B");

		// Each client should get instance_list via sendTo
		const allCalls = asMock(deps.wsHandler.sendTo).mock.calls;
		const instanceListCalls = allCalls.filter(
			(c: unknown[]) => (c[1] as { type: string }).type === "instance_list",
		);
		expect(instanceListCalls).toHaveLength(2);
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		expect(instanceListCalls[0]![0]).toBe("client-A");
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		expect(instanceListCalls[1]![0]).toBe("client-B");
	});
});

// ─── Test: instance_list not blocked by other init failures ─────────────────
// instance_list is sent at the end of handleClientConnected. If earlier steps
// throw, instance_list should still be sent (error resilience).

describe("instance_list resilience", () => {
	it("sends instance_list even when session/model init fails", async () => {
		const deps = createMockClientInitDeps({
			getInstances: () => [
				{
					id: "default",
					name: "Default",
					port: 4096,
					managed: false,
					status: "healthy" as const,
					restartCount: 0,
					createdAt: 1000,
				},
			],
		});

		// Make earlier init steps fail
		vi.mocked(deps.client.session.get).mockRejectedValue(new Error("fail"));
		vi.mocked(deps.sessionMgr.listSessions).mockRejectedValue(
			new Error("fail"),
		);
		vi.mocked(deps.client.app.agents).mockRejectedValue(new Error("fail"));
		vi.mocked(deps.client.provider.list).mockRejectedValue(new Error("fail"));

		// Should not throw
		await handleClientConnected(deps, "client-1");

		// instance_list should STILL be sent despite all the failures above
		const msgs = getSentMessages(
			asMock(deps.wsHandler.sendTo),
			"instance_list",
		);
		expect(msgs).toHaveLength(1);
	});
});
