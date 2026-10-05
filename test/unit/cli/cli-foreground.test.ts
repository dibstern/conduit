// Tests: serve and its hidden --foreground alias in run()
//
// The serve handler uses an injectable daemon starter facade so the
// handler logic can be tested without starting real HTTP/RPC servers.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted runs before vi.mock hoisting, so these are available in the factory
const { mockRegisterProject, mockStartForegroundDaemon, mockEnv } = vi.hoisted(
	() => {
		const mockRegisterProject = vi
			.fn()
			.mockResolvedValue({ slug: "test-project", directory: "/test/project" });

		const mockStartForegroundDaemon = vi
			.fn()
			.mockImplementation((opts: { port?: number }) =>
				Promise.resolve({
					addProject: mockRegisterProject,
					stopped: Promise.resolve(),
					stop: vi.fn().mockResolvedValue(undefined),
					getStatus: vi
						.fn()
						.mockReturnValue({ tlsEnabled: true, host: "0.0.0.0" }),
					port: opts?.port ?? 2633,
				}),
			);

		// Mutable ENV override — defaults to undefined (no override)
		const mockEnv = { opencodeUrl: undefined as string | undefined };

		return { mockRegisterProject, mockStartForegroundDaemon, mockEnv };
	},
);

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
		sendRPC: vi.fn().mockResolvedValue({ ok: true }),
		startForegroundDaemon: mockStartForegroundDaemon,
		generateQR: (url: string) => `[QR:${url}]`,
		getNetworkAddress: () => "192.168.1.100",
	};
}

describe("serve handler", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		mockEnv.opencodeUrl = undefined;
	});

	it.each([
		true,
		false,
	])("forwards an explicit Serve choice (%s)", async (enabled) => {
		await run(
			["serve", enabled ? "--tailscale-serve" : "--no-tailscale-serve"],
			createMockIO(),
		);
		expect(mockStartForegroundDaemon).toHaveBeenCalledWith(
			expect.objectContaining({ tailscaleServe: enabled }),
		);
	});

	it("prints and encodes the ts.net URL after Serve succeeds", async () => {
		const url = "https://machine.example.ts.net";
		mockStartForegroundDaemon.mockResolvedValueOnce({
			port: 2633,
			stopped: Promise.resolve(),
			getStatus: () => ({
				tlsEnabled: false,
				host: "127.0.0.1",
				tailscaleServe: { url },
			}),
		});
		const io = createMockIO();
		await run(["serve", "--tailscale-serve"], io);
		expect(io.output.join("")).toContain(`Relay:    ${url}`);
		expect(io.output.join("")).toContain(`[QR:${url}]`);
		expect(io.errors).toEqual([]);
	});

	it("prints a Serve error and still reports the running loopback server", async () => {
		const error =
			"HTTPS certificates are disabled. Enable them in the tailnet DNS page.";
		mockStartForegroundDaemon.mockResolvedValueOnce({
			port: 2633,
			stopped: Promise.resolve(),
			getStatus: () => ({
				tlsEnabled: false,
				host: "127.0.0.1",
				tailscaleServe: { error },
			}),
		});
		const io = createMockIO();
		await run(["serve", "--tailscale-serve"], io);
		expect(io.output.join("")).toContain("http://127.0.0.1:2633");
		expect(io.output.join("")).toContain("Ready.");
		expect(io.errors.join("")).toContain(error);
		expect(io.exit).toHaveBeenCalledWith(0);
	});

	it("suggests Serve in the foreground banner when Tailscale is detected", async () => {
		const io = { ...createMockIO(), getTailscaleIP: () => "100.64.1.5" };
		await run(["serve"], io);
		expect(io.output.join("")).toContain("--tailscale-serve");
	});

	it("starts daemon in foreground and writes expected output", async () => {
		const io = createMockIO("/test/project");

		await run(["serve", "--port", "19876"], io);

		const joined = io.output.join("");

		// Verify banner output
		expect(joined).toContain("Conduit (foreground)");
		expect(joined).toContain("https://0.0.0.0:19876");
		expect(joined).toContain("Ready.");
	});

	it("calls foreground starter with correct port and opencodeUrl from --oc-port", async () => {
		const io = createMockIO("/my/project");

		await run(["serve", "--port", "3000", "--oc-port", "5000"], io);

		// Verify foreground starter was called with correct options
		// host is omitted when not explicitly set (daemon auto-selects based on TLS)
		expect(mockStartForegroundDaemon).toHaveBeenCalledWith({
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

		await run(["serve", "--port", "3000", "--oc-port", "9999"], io);

		// Verify foreground starter was called with env var URL, not --oc-port
		expect(mockStartForegroundDaemon).toHaveBeenCalledWith({
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

	it("leaves project registration to the default command", async () => {
		const io = createMockIO("/workspace/app");

		await run(["serve"], io);

		expect(mockStartForegroundDaemon).toHaveBeenCalledOnce();
		expect(mockRegisterProject).not.toHaveBeenCalled();
	});

	it("outputs OpenCode URL and Relay URL", async () => {
		const io = createMockIO("/home/user/app");

		await run(["serve", "--port", "2633", "--oc-port", "4096"], io);

		const joined = io.output.join("");
		expect(joined).toContain("OpenCode: http://localhost:4096");
		expect(joined).toContain("Relay:    https://0.0.0.0:2633");
	});

	it("awaits shutdown before resolving and exiting successfully", async () => {
		const io = createMockIO("/test");
		let stop: () => void = () => {};
		const stopped = new Promise<void>((resolve) => {
			stop = resolve;
		});
		mockStartForegroundDaemon.mockImplementationOnce(() =>
			Promise.resolve({
				addProject: mockRegisterProject,
				stopped,
				stop: vi.fn().mockResolvedValue(undefined),
				getStatus: () => ({ tlsEnabled: false, host: "127.0.0.1" }),
				port: 2633,
			}),
		);
		let returned = false;
		const running = run(["serve"], io).then(() => {
			returned = true;
		});
		await vi.waitFor(() => expect(io.output.join("")).toContain("Ready."));
		expect(returned).toBe(false);
		expect(io.exit).not.toHaveBeenCalled();

		stop();
		await running;
		expect(io.exit).toHaveBeenCalledExactlyOnceWith(0);
	});

	it("uses persisted server port when none specified and enables TLS", async () => {
		const io = createMockIO("/test");

		await run(["--foreground"], io);

		expect(mockStartForegroundDaemon).toHaveBeenCalledWith({
			opencodeUrl: "http://localhost:4096",
			tlsEnabled: true,
			logLevel: "info",
			logFormat: "pretty",
		});
		expect(io.exit).toHaveBeenCalledExactlyOnceWith(0);
	});

	it("reports a bound port without shutting down the existing server", async () => {
		const io = createMockIO();
		io.isDaemonRunning.mockResolvedValue(true);
		mockStartForegroundDaemon.mockRejectedValueOnce(
			Object.assign(new Error("Port 2633 is already in use"), {
				code: "EADDRINUSE",
			}),
		);
		await run(["serve"], io);
		expect(io.errors.join("")).toContain("already in use");
		expect(io.exit).toHaveBeenCalledExactlyOnceWith(1);
		expect(io.sendRPC).not.toHaveBeenCalled();
	});

	it("exits with failure when startup fails", async () => {
		const io = createMockIO();
		mockStartForegroundDaemon.mockRejectedValueOnce(
			new Error("Startup failed"),
		);
		await run(["serve"], io);
		expect(io.errors.join("")).toContain("Startup failed");
		expect(io.exit).toHaveBeenCalledExactlyOnceWith(1);
	});

	it("exits with failure when shutdown fails", async () => {
		const io = createMockIO();
		mockStartForegroundDaemon.mockImplementationOnce(() =>
			Promise.resolve({
				addProject: mockRegisterProject,
				stopped: Promise.reject(new Error("Shutdown failed")),
				stop: vi.fn().mockResolvedValue(undefined),
				getStatus: () => ({ tlsEnabled: false, host: "127.0.0.1" }),
				port: 2633,
			}),
		);
		await run(["serve"], io);
		expect(io.errors.join("")).toContain("Shutdown failed");
		expect(io.exit).toHaveBeenCalledExactlyOnceWith(1);
	});
});
