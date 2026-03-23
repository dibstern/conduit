// ─── Tests: --foreground handler in run() ────────────────────────────────────
//
// The --foreground handler creates a Daemon internally (no DI seam).
// We mock the Daemon class at the module level to test the handler logic
// without starting real HTTP/IPC servers.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mock Daemon ─────────────────────────────────────────────────────────────

// vi.hoisted runs before vi.mock hoisting, so these are available in the factory
const { mockStart, mockAddProject, MockDaemonClass, mockEnv } = vi.hoisted(
	() => {
		const mockStart = vi.fn().mockResolvedValue(undefined);
		const mockStop = vi.fn().mockResolvedValue(undefined);
		const mockAddProject = vi
			.fn()
			.mockResolvedValue({ slug: "test-project", directory: "/test/project" });
		const mockDiscoverProjects = vi.fn().mockResolvedValue(undefined);

		const MockDaemonClass = Object.assign(
			vi.fn().mockImplementation((opts: { port?: number }) => ({
				start: mockStart,
				stop: mockStop,
				addProject: mockAddProject,
				discoverProjects: mockDiscoverProjects,
				getStatus: vi
					.fn()
					.mockReturnValue({ tlsEnabled: true, host: "0.0.0.0" }),
				port: opts?.port ?? 2633,
			})),
			{
				// Preserve static methods used by run() for default wiring
				isRunning: vi.fn().mockResolvedValue(false),
				spawn: vi.fn().mockResolvedValue({ pid: 1, port: 2633 }),
				buildSpawnConfig: vi.fn(),
			},
		);

		// Mutable ENV override — defaults to undefined (no override)
		const mockEnv = { opencodeUrl: undefined as string | undefined };

		return { mockStart, mockStop, mockAddProject, MockDaemonClass, mockEnv };
	},
);

vi.mock("../../../src/lib/daemon/daemon.js", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../../../src/lib/daemon/daemon.js")>();
	return {
		...original,
		Daemon: MockDaemonClass,
	};
});

vi.mock("../../../src/lib/env.js", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../../../src/lib/env.js")>();
	return {
		...original,
		ENV: new Proxy(original.ENV, {
			get(target, prop, receiver) {
				if (prop === "opencodeUrl" && mockEnv.opencodeUrl !== undefined) {
					return mockEnv.opencodeUrl;
				}
				return Reflect.get(target, prop, receiver);
			},
		}),
	};
});

// Import AFTER vi.mock (vitest hoists the mock)
import { run } from "../../../src/bin/cli-core.js";
import { Daemon } from "../../../src/lib/daemon/daemon.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createMockIO(cwd = "/test/project") {
	const output: string[] = [];
	const errors: string[] = [];
	return {
		output,
		errors,
		cwd,
		stdout: {
			write: (s: string) => {
				output.push(s);
			},
		},
		stderr: {
			write: (s: string) => {
				errors.push(s);
			},
		},
		exit: vi.fn(),
		// Provide these so run() doesn't try to connect to real sockets
		isDaemonRunning: vi.fn().mockResolvedValue(false),
		sendIPC: vi.fn().mockResolvedValue({ ok: true }),
		spawnDaemon: vi.fn().mockResolvedValue({ pid: 1, port: 2633 }),
		generateQR: (url: string) => `[QR:${url}]`,
		getNetworkAddress: () => "192.168.1.100",
	};
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("--foreground handler", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		mockEnv.opencodeUrl = undefined;
	});

	it("starts daemon in foreground and writes expected output", async () => {
		const io = createMockIO("/test/project");

		await run(["--foreground", "--port", "19876"], io);

		const joined = io.output.join("");

		// Verify banner output
		expect(joined).toContain("Conduit (foreground)");
		expect(joined).toContain("https://0.0.0.0:19876");
		expect(joined).toContain("/test/project");
		expect(joined).toContain("Ready.");
	});

	it("creates Daemon with correct port and opencodeUrl from --oc-port", async () => {
		const io = createMockIO("/my/project");

		await run(["--foreground", "--port", "3000", "--oc-port", "5000"], io);

		// Verify Daemon was constructed with correct options
		// host is omitted when not explicitly set (daemon auto-selects based on TLS)
		expect(Daemon).toHaveBeenCalledWith({
			port: 3000,
			opencodeUrl: "http://localhost:5000",
			tlsEnabled: true,
			logLevel: "info",
			logFormat: "pretty",
		});
	});

	it("uses OPENCODE_URL env var over --oc-port fallback", async () => {
		mockEnv.opencodeUrl = "http://opencode:4096";
		const io = createMockIO("/my/project");

		await run(["--foreground", "--port", "3000", "--oc-port", "9999"], io);

		// Verify Daemon was constructed with env var URL, not --oc-port
		expect(Daemon).toHaveBeenCalledWith({
			port: 3000,
			opencodeUrl: "http://opencode:4096",
			tlsEnabled: true,
			logLevel: "info",
			logFormat: "pretty",
		});

		// Verify output shows the env var URL
		const joined = io.output.join("");
		expect(joined).toContain("http://opencode:4096");
	});

	it("calls daemon.start() then daemon.addProject(cwd)", async () => {
		const io = createMockIO("/workspace/app");

		await run(["--foreground"], io);

		// Verify lifecycle: start() called before addProject()
		expect(mockStart).toHaveBeenCalledOnce();
		expect(mockAddProject).toHaveBeenCalledWith("/workspace/app");

		// Verify ordering: start was called before addProject
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		const startOrder = mockStart.mock.invocationCallOrder[0]!;
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		const addOrder = mockAddProject.mock.invocationCallOrder[0]!;
		expect(startOrder).toBeLessThan(addOrder);
	});

	it("outputs OpenCode URL and Relay URL", async () => {
		const io = createMockIO("/home/user/app");

		await run(["--foreground", "--port", "2633", "--oc-port", "4096"], io);

		const joined = io.output.join("");
		expect(joined).toContain("OpenCode: http://localhost:4096");
		expect(joined).toContain("Relay:    https://0.0.0.0:2633");
		expect(joined).toContain("Project:  /home/user/app");
	});

	it("does not call exit()", async () => {
		const io = createMockIO("/test");

		await run(["--foreground"], io);

		// The handler should return, not call exit
		expect(io.exit).not.toHaveBeenCalled();
	});

	it("uses default ports when none specified and enables TLS", async () => {
		const io = createMockIO("/test");

		await run(["--foreground"], io);

		// Default port is 2633, default oc-port is 4096
		// host is omitted when not explicitly set (daemon auto-selects based on TLS)
		expect(Daemon).toHaveBeenCalledWith({
			port: 2633,
			opencodeUrl: "http://localhost:4096",
			tlsEnabled: true,
			logLevel: "info",
			logFormat: "pretty",
		});
	});
});
