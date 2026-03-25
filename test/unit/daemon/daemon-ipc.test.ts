// ─── Tests: daemon-ipc buildIPCHandlers ──────────────────────────────────────
//
// Tests cover:
// T1: instanceAdd — basic add
// T2: instanceAdd — slug collision handled with numeric suffix (fix #6)

import { describe, expect, it, vi } from "vitest";
import {
	buildIPCHandlers,
	type DaemonIPCContext,
} from "../../../src/lib/daemon/daemon-ipc.js";
import type {
	InstanceConfig,
	OpenCodeInstance,
} from "../../../src/lib/types.js";

// ─── Minimal context mock ─────────────────────────────────────────────────────

function makeContext(
	overrides: Partial<DaemonIPCContext> = {},
): DaemonIPCContext {
	const instances = new Map<string, OpenCodeInstance>();

	const ctx: DaemonIPCContext = {
		addProject: vi.fn(),
		removeProject: vi.fn(),
		getProjects: vi.fn().mockReturnValue([]),
		setProjectTitle: vi.fn(),
		getPinHash: vi.fn().mockReturnValue(null),
		setPinHash: vi.fn(),
		getKeepAwake: vi.fn().mockReturnValue(false),
		setKeepAwake: vi.fn().mockReturnValue({ supported: false, active: false }),
		setKeepAwakeCommand: vi.fn(),
		persistConfig: vi.fn(),
		scheduleShutdown: vi.fn(),
		getInstances: vi.fn().mockReturnValue([]),
		getInstance: vi.fn().mockImplementation((id: string) => instances.get(id)),
		addInstance: vi
			.fn()
			.mockImplementation((id: string, config: InstanceConfig) => {
				if (instances.has(id))
					throw new Error(`Instance "${id}" already exists`);
				const inst: OpenCodeInstance = {
					id,
					name: config.name,
					port: config.port,
					managed: config.managed,
					status: "stopped",
					restartCount: 0,
					createdAt: Date.now(),
				};
				instances.set(id, inst);
				return inst;
			}),
		removeInstance: vi.fn(),
		startInstance: vi.fn(),
		stopInstance: vi.fn(),
		updateInstance: vi.fn(),
		...overrides,
	};

	return ctx;
}

function makeHandlers(ctx: DaemonIPCContext) {
	return buildIPCHandlers(ctx, () => ({
		ok: true,
		uptime: 0,
		port: 3000,
		host: "127.0.0.1",
		projectCount: 0, sessionCount: 0,
		clientCount: 0,
		pinEnabled: false,
		tlsEnabled: false,
		keepAwake: false,
		projects: [],
	}));
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("buildIPCHandlers", () => {
	describe("instanceAdd", () => {
		it("creates instance with slugified name", async () => {
			const ctx = makeContext();
			const handlers = makeHandlers(ctx);

			const result = await handlers.instanceAdd("My Work", 4096, true);

			expect(result.ok).toBe(true);
			expect(ctx.addInstance).toHaveBeenCalledWith(
				"my-work",
				expect.objectContaining({ name: "My Work" }),
			);
		});

		it("returns ok with the created instance", async () => {
			const ctx = makeContext();
			const handlers = makeHandlers(ctx);

			const result = await handlers.instanceAdd("dev", 4096, true);

			expect(result.ok).toBe(true);
			expect(result.instance).toBeDefined();
			expect((result.instance as OpenCodeInstance).id).toBe("dev");
		});

		it("falls back to 'instance' for names that slugify to empty string", async () => {
			const ctx = makeContext();
			const handlers = makeHandlers(ctx);

			const result = await handlers.instanceAdd("---", 4096, true);

			expect(result.ok).toBe(true);
			expect(ctx.addInstance).toHaveBeenCalledWith(
				"instance",
				expect.anything(),
			);
		});

		// ─── Fix #6: slug collision with numeric suffix ─────────────────────

		it("appends -2 suffix when base slug is already taken", async () => {
			const ctx = makeContext();
			const handlers = makeHandlers(ctx);

			// Add "My Work" first — slug: "my-work"
			await handlers.instanceAdd("My Work", 4096, true);

			// Add "My Work!" — same slug "my-work", should become "my-work-2"
			const result = await handlers.instanceAdd("My Work!", 4097, true);

			expect(result.ok).toBe(true);
			expect(ctx.addInstance).toHaveBeenLastCalledWith(
				"my-work-2",
				expect.objectContaining({ name: "My Work!" }),
			);
		});

		it("increments suffix counter beyond 2 for repeated collisions", async () => {
			const ctx = makeContext();
			const handlers = makeHandlers(ctx);

			// Three instances with the same slug
			await handlers.instanceAdd("My Work", 4096, true); // my-work
			await handlers.instanceAdd("My Work!", 4097, true); // my-work-2
			await handlers.instanceAdd("My.Work", 4098, true); // my-work-3

			expect(ctx.addInstance).toHaveBeenNthCalledWith(
				3,
				"my-work-3",
				expect.objectContaining({ name: "My.Work" }),
			);
		});

		it("returns ok:false on other addInstance errors", async () => {
			const ctx = makeContext({
				addInstance: vi.fn().mockImplementation(() => {
					throw new Error("Max instances reached");
				}),
				getInstance: vi.fn().mockReturnValue(undefined),
			});
			const handlers = makeHandlers(ctx);

			const result = await handlers.instanceAdd("dev", 4096, true);

			expect(result.ok).toBe(false);
			expect((result as { error: string }).error).toMatch(/max instances/i);
		});
	});

	describe("setKeepAwake", () => {
		it("returns supported and active from context result", async () => {
			const ctx = makeContext({
				setKeepAwake: vi.fn().mockReturnValue({
					supported: true,
					active: true,
				}),
			});
			const handlers = makeHandlers(ctx);

			const result = await handlers.setKeepAwake(true);

			expect(result.ok).toBe(true);
			expect((result as unknown as { supported: boolean }).supported).toBe(
				true,
			);
			expect((result as unknown as { active: boolean }).active).toBe(true);
			expect(ctx.setKeepAwake).toHaveBeenCalledWith(true);
		});

		it("returns supported:false active:false when unsupported", async () => {
			const ctx = makeContext({
				setKeepAwake: vi.fn().mockReturnValue({
					supported: false,
					active: false,
				}),
			});
			const handlers = makeHandlers(ctx);

			const result = await handlers.setKeepAwake(false);

			expect(result.ok).toBe(true);
			expect((result as unknown as { supported: boolean }).supported).toBe(
				false,
			);
			expect((result as unknown as { active: boolean }).active).toBe(false);
		});
	});

	describe("setKeepAwakeCommand", () => {
		it("persists command and args via context", async () => {
			let storedCommand: string | undefined;
			let storedArgs: string[] | undefined;
			const ctx = makeContext({
				setKeepAwakeCommand: (command: string, args: string[]) => {
					storedCommand = command;
					storedArgs = args;
				},
			});
			const handlers = makeHandlers(ctx);

			const result = await handlers.setKeepAwakeCommand("my-tool", ["--flag"]);

			expect(result).toEqual({ ok: true });
			expect(storedCommand).toBe("my-tool");
			expect(storedArgs).toEqual(["--flag"]);
		});

		it("returns ok:false when context throws", async () => {
			const ctx = makeContext({
				setKeepAwakeCommand: () => {
					throw new Error("Something went wrong");
				},
			});
			const handlers = makeHandlers(ctx);

			const result = await handlers.setKeepAwakeCommand("bad-cmd", []);

			expect(result.ok).toBe(false);
			expect((result as { error: string }).error).toContain(
				"Something went wrong",
			);
		});
	});

	describe("instanceStop", () => {
		it("calls ctx.stopInstance and returns ok", async () => {
			const ctx = makeContext();
			const handlers = makeHandlers(ctx);

			const result = await handlers.instanceStop("some-id");

			expect(result.ok).toBe(true);
			expect(ctx.stopInstance).toHaveBeenCalledWith("some-id");
		});

		it("returns ok:false when stopInstance throws", async () => {
			const ctx = makeContext({
				stopInstance: vi.fn().mockImplementation(() => {
					throw new Error('Instance "nope" not found');
				}),
			});
			const handlers = makeHandlers(ctx);

			const result = await handlers.instanceStop("nope");

			expect(result.ok).toBe(false);
			expect((result as { error: string }).error).toContain("not found");
		});
	});

	describe("instanceStatus", () => {
		it("returns instance data for known ID", async () => {
			const inst: OpenCodeInstance = {
				id: "test",
				name: "Test",
				port: 4096,
				managed: true,
				status: "healthy",
				restartCount: 0,
				createdAt: Date.now(),
			};
			const ctx = makeContext({
				getInstance: vi.fn().mockReturnValue(inst),
			});
			const handlers = makeHandlers(ctx);

			const result = await handlers.instanceStatus("test");

			expect(result.ok).toBe(true);
			expect(
				(result as unknown as { instance: OpenCodeInstance }).instance.id,
			).toBe("test");
		});

		it("returns ok:false for unknown ID", async () => {
			const ctx = makeContext({
				getInstance: vi.fn().mockReturnValue(undefined),
			});
			const handlers = makeHandlers(ctx);

			const result = await handlers.instanceStatus("nonexistent");

			expect(result.ok).toBe(false);
			expect((result as { error: string }).error).toContain("not found");
		});
	});
});
