// ─── Tests: CLI Interface (Ticket 3.3) ──────────────────────────────────────
//
// Tests cover:
// T1: parseArgs — all flags parsed correctly, defaults, --help, unknown flags (AC1-AC8)
// T2: Default invocation — checks daemon, spawns if needed, registers project, outputs QR/URL (AC1)
// T3: --status — sends get_status, formats output (AC2)
// T4: --stop — sends shutdown, displays confirmation (AC3)
// T5: --pin — validates 4-8 digit, sends set_pin (AC4)
// T6: --add/--remove/--list/--title — correct IPC commands (AC5)
// T7: --port/--oc-port — passed through (AC6)
// T8: Error handling — daemon not reachable, IPC errors (AC8)
// T9: getNetworkAddress — returns first non-internal IPv4 (AC1)
// T10: QR generation — mock (AC7)
// T11: sendIPCCommand — rejects for non-existent socket (IPC client)
// PBT: Property-based arg parsing

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	type CLIOptions,
	generateQR,
	getNetworkAddress,
	type InteractiveContext,
	parseArgs,
	run,
	sendIPCCommand,
} from "../../../src/bin/cli-core.js";
import { HELP_TEXT } from "../../../src/bin/cli-utils.js";
import type { IPCCommand, IPCResponse } from "../../../src/lib/types.js";

const SEED = 42;
const NUM_RUNS = 100;

// ─── Test Helpers ────────────────────────────────────────────────────────────

/** Captured state from mock CLI */
interface MockCLIState {
	output: string;
	errors: string;
	exitCode: number | null;
	ipcCommands: IPCCommand[];
}

/** Create a mock CLIOptions with captured output.
 *  Access captured data via the returned `.state` property.
 */
function createMockCLI(
	overrides?: Partial<CLIOptions>,
): CLIOptions & { state: MockCLIState } {
	const state: MockCLIState = {
		output: "",
		errors: "",
		exitCode: null,
		ipcCommands: [],
	};

	const opts: CLIOptions & { state: MockCLIState } = {
		state,
		cwd: "/home/user/my-project",
		stdout: {
			write(s: string) {
				state.output += s;
			},
		},
		stderr: {
			write(s: string) {
				state.errors += s;
			},
		},
		exit: (code: number) => {
			state.exitCode = code;
		},
		sendIPC: async (cmd: IPCCommand): Promise<IPCResponse> => {
			state.ipcCommands.push(cmd);
			return { ok: true };
		},
		isDaemonRunning: async () => true,
		spawnDaemon: async () => ({ pid: 12345, port: 2633 }),
		generateQR: (url: string) => `[QR:${url}]`,
		getNetworkAddress: () => "192.168.1.100",
		getTailscaleIP: () => null,
		...overrides,
	};

	return opts;
}

// ─── T1: parseArgs ──────────────────────────────────────────────────────────

describe("Ticket 3.3 — CLI Interface", () => {
	describe("T1: parseArgs — all flags parsed correctly (AC1-AC8)", () => {
		it("default command with no args", () => {
			const args = parseArgs([]);
			expect(args.command).toBe("default");
			expect(args.port).toBe(2633);
			expect(args.ocPort).toBe(4096);
			expect(args.noUpdate).toBe(false);
			expect(args.debug).toBe(false);
		});

		it.each([
			["--daemon", "command", "daemon"],
			["--foreground", "command", "foreground"],
			["--status", "command", "status"],
			["--stop", "command", "stop"],
			["--remove", "command", "remove"],
			["--list", "command", "list"],
			["--help", "command", "help"],
			["-h", "command", "help"],
			["--no-update", "noUpdate", true],
			["--debug", "debug", true],
		] as const)("%s sets %s to %s", (flag, field, expected) => {
			const args = parseArgs([flag]);
			expect(args[field]).toBe(expected);
		});

		it.each([
			[["--pin", "123456"], { command: "pin", pin: "123456" }],
			[["--pin"], { command: "pin", pin: undefined }],
			[["--add", "/some/path"], { command: "add", addPath: "/some/path" }],
			[["--add"], { command: "add", addPath: undefined }],
			[["--title", "My Project"], { command: "title", title: "My Project" }],
			[["--port", "3000"], { port: 3000 }],
			[["-p", "8080"], { port: 8080 }],
			[["--oc-port", "5000"], { ocPort: 5000 }],
		] as const)("parseArgs(%j) sets expected fields", (argv, expected) => {
			const args = parseArgs(argv as unknown as string[]);
			for (const [key, value] of Object.entries(expected)) {
				expect(args[key as keyof typeof args]).toBe(value);
			}
		});

		it("unknown flags are ignored", () => {
			const args = parseArgs(["--unknown", "--foo"]);
			expect(args.command).toBe("default");
		});

		it("multiple flags combined", () => {
			const args = parseArgs([
				"--port",
				"3000",
				"--oc-port",
				"5000",
				"--debug",
				"--no-update",
			]);
			expect(args.port).toBe(3000);
			expect(args.ocPort).toBe(5000);
			expect(args.debug).toBe(true);
			expect(args.noUpdate).toBe(true);
		});

		it.each([
			[["--port", "not-a-number"], "port", 2633],
			[["--port", "99999"], "port", 2633],
			[["--port"], "port", 2633],
			[["--oc-port"], "ocPort", 4096],
		] as const)("keeps default when parseArgs(%j).%s should be %d", (argv, field, expected) => {
			const args = parseArgs(argv as unknown as string[]);
			expect(args[field]).toBe(expected);
		});
	});

	it("property: port is always a valid number", () => {
		fc.assert(
			fc.property(
				fc.array(fc.string({ minLength: 0, maxLength: 20 }), {
					minLength: 0,
					maxLength: 10,
				}),
				(argv) => {
					const args = parseArgs(argv);
					expect(args.port).toBeGreaterThanOrEqual(1);
					expect(args.port).toBeLessThanOrEqual(65535);
				},
			),
			{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
		);
	});

	it("property: ocPort is always a valid number", () => {
		fc.assert(
			fc.property(
				fc.array(fc.string({ minLength: 0, maxLength: 20 }), {
					minLength: 0,
					maxLength: 10,
				}),
				(argv) => {
					const args = parseArgs(argv);
					expect(args.ocPort).toBeGreaterThanOrEqual(1);
					expect(args.ocPort).toBeLessThanOrEqual(65535);
				},
			),
			{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
		);
	});

	it("property: --port N always sets port to N for valid N", () => {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 65535 }), (port) => {
				const args = parseArgs(["--port", String(port)]);
				expect(args.port).toBe(port);
			}),
			{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
		);
	});

	it("property: --oc-port N always sets ocPort to N for valid N", () => {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 65535 }), (port) => {
				const args = parseArgs(["--oc-port", String(port)]);
				expect(args.ocPort).toBe(port);
			}),
			{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
		);
	});

	it("property: noUpdate and debug are always booleans", () => {
		fc.assert(
			fc.property(
				fc.array(fc.string({ minLength: 0, maxLength: 20 }), {
					minLength: 0,
					maxLength: 10,
				}),
				(argv) => {
					const args = parseArgs(argv);
					expect(typeof args.noUpdate).toBe("boolean");
					expect(typeof args.debug).toBe("boolean");
				},
			),
			{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
		);
	});

	it("property: parseArgs never throws for arbitrary input", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.oneof(
						fc.string({ minLength: 0, maxLength: 50 }),
						fc.constantFrom(
							"--port",
							"--oc-port",
							"--pin",
							"--add",
							"--title",
							"--status",
							"--stop",
							"--help",
							"--list",
							"--remove",
							"--debug",
							"--no-update",
						),
					),
					{ minLength: 0, maxLength: 20 },
				),
				(argv) => {
					// Must not throw
					const result = parseArgs(argv);
					expect(result).toBeDefined();
				},
			),
			{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
		);
	});
});

// ─── T2: Default invocation ───────────────────────────────────────────

describe("T2: Default invocation — auto-start, register, display (AC1)", () => {
	it("starts daemon if not running, registers cwd, shows URL + QR", async () => {
		let spawnCalled = false;
		const cli = createMockCLI({
			isDaemonRunning: async () => false,
			spawnDaemon: async () => {
				spawnCalled = true;
				return { pid: 99, port: 2633 };
			},
			sendIPC: async (cmd) => {
				cli.state.ipcCommands.push(cmd);
				if (cmd.cmd === "add_project") {
					return { ok: true, slug: "my-project" };
				}
				return { ok: true };
			},
		});

		await run([], cli);

		expect(spawnCalled).toBe(true);
		expect(cli.state.output).toContain("Daemon started");
		expect(cli.state.output).toContain("192.168.1.100");
		expect(cli.state.output).toContain("my-project");
		expect(cli.state.output).toContain("[QR:");
	});

	it("skips spawning if daemon is already running", async () => {
		let spawnCalled = false;
		const cli = createMockCLI({
			isDaemonRunning: async () => true,
			spawnDaemon: async () => {
				spawnCalled = true;
				return { pid: 99, port: 2633 };
			},
			sendIPC: async (cmd) => {
				cli.state.ipcCommands.push(cmd);
				if (cmd.cmd === "add_project") {
					return { ok: true, slug: "my-project" };
				}
				return { ok: true };
			},
		});

		await run([], cli);

		expect(spawnCalled).toBe(false);
		expect(cli.state.output).not.toContain("Daemon started");
		expect(cli.state.output).toContain("192.168.1.100");
	});

	it("registers cwd via add_project IPC command", async () => {
		const cli = createMockCLI({
			sendIPC: async (cmd) => {
				cli.state.ipcCommands.push(cmd);
				if (cmd.cmd === "add_project") {
					return { ok: true, slug: "my-project" };
				}
				return { ok: true };
			},
		});

		await run([], cli);

		const addCmd = cli.state.ipcCommands.find((c) => c.cmd === "add_project");
		expect(addCmd).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(addCmd!.directory).toBe("/home/user/my-project");
	});

	it("uses localhost when no network address available", async () => {
		const cli = createMockCLI({
			getNetworkAddress: () => null,
			sendIPC: async (cmd) => {
				cli.state.ipcCommands.push(cmd);
				if (cmd.cmd === "add_project") return { ok: true, slug: "test" };
				return { ok: true };
			},
		});

		await run([], cli);

		expect(cli.state.output).toContain("localhost");
	});

	it("shows QR code in output", async () => {
		const cli = createMockCLI({
			sendIPC: async (cmd) => {
				cli.state.ipcCommands.push(cmd);
				if (cmd.cmd === "add_project") return { ok: true, slug: "test" };
				return { ok: true };
			},
		});

		await run([], cli);

		expect(cli.state.output).toContain("[QR:http://192.168.1.100:2633]");
	});

	it("shows PIN tip", async () => {
		const cli = createMockCLI({
			sendIPC: async (cmd) => {
				cli.state.ipcCommands.push(cmd);
				if (cmd.cmd === "add_project") return { ok: true, slug: "test" };
				return { ok: true };
			},
		});

		await run([], cli);

		expect(cli.state.output).toContain("PIN");
	});

	it("handles add_project returning ok: false gracefully (slug is undefined)", async () => {
		const cli = createMockCLI({
			sendIPC: async (cmd) => {
				cli.state.ipcCommands.push(cmd);
				// add_project fails
				return { ok: false, error: "disk full" };
			},
		});

		await run([], cli);

		// Should not crash; output should still contain the URL
		expect(cli.state.output).toContain("192.168.1.100");
		// But should not contain "Project:" since slug is undefined
		expect(cli.state.output).not.toContain("Project:");
	});
});

// ─── T3: --status ─────────────────────────────────────────────────────

describe("T3: --status — sends get_status, formats output (AC2)", () => {
	it("displays status when daemon is running", async () => {
		const cli = createMockCLI({
			sendIPC: async (cmd) => {
				cli.state.ipcCommands.push(cmd);
				if (cmd.cmd === "get_status") {
					return {
						ok: true,
						uptime: 3661,
						port: 2633,
						projectCount: 3,
						clientCount: 2,
					};
				}
				return { ok: true };
			},
		});

		await run(["--status"], cli);

		expect(cli.state.output).toContain("Daemon Status");
		expect(cli.state.output).toContain("1h 1m");
		expect(cli.state.output).toContain("2633");
		expect(cli.state.output).toContain("3");
		expect(cli.state.output).toContain("2");
		// Also verifies the correct IPC command was sent
		expect(cli.state.ipcCommands[0]!.cmd).toBe("get_status");
	});

	it.each([
		[45, "45s"],
		[125, "2m 5s"],
	])("formats uptime %ds as %s", async (uptime, expected) => {
		const cli = createMockCLI({
			sendIPC: async () => ({
				ok: true,
				uptime,
				port: 2633,
				projectCount: 0,
				clientCount: 0,
			}),
		});

		await run(["--status"], cli);

		expect(cli.state.output).toContain(expected);
	});
});

// ─── T4: --stop ───────────────────────────────────────────────────────

describe("T4: --stop — sends shutdown (AC3)", () => {
	it("sends shutdown command and displays confirmation", async () => {
		const cli = createMockCLI({
			sendIPC: async (cmd) => {
				cli.state.ipcCommands.push(cmd);
				return { ok: true };
			},
		});

		await run(["--stop"], cli);

		expect(cli.state.ipcCommands).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		expect(cli.state.ipcCommands[0]!.cmd).toBe("shutdown");
		expect(cli.state.output).toContain("Daemon stopped");
	});

	it("handles IPC error gracefully", async () => {
		const cli = createMockCLI({
			sendIPC: async () => {
				throw new Error("Connection refused");
			},
		});

		await run(["--stop"], cli);

		expect(cli.state.errors).toContain("Connection refused");
		expect(cli.state.exitCode).toBe(1);
	});
});

// ─── T5: --pin ────────────────────────────────────────────────────────

describe("T5: --pin — validates digit, sends set_pin (AC4)", () => {
	it.each([
		"1234",
		"123456",
		"12345678",
	])("accepts valid %s-digit PIN", async (pin) => {
		const cli = createMockCLI({
			sendIPC: async (cmd) => {
				cli.state.ipcCommands.push(cmd);
				return { ok: true };
			},
		});

		await run(["--pin", pin], cli);

		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		const pinCmd = cli.state.ipcCommands[0]!;
		expect(pinCmd.cmd === "set_pin" && pinCmd.pin).toBe(pin);
		expect(cli.state.output).toContain("PIN updated");
	});

	it.each([
		"abcdef",
		"123",
		"123456789",
		undefined,
	])("rejects invalid PIN: %s", async (pin) => {
		const cli = createMockCLI();

		const argv = pin ? ["--pin", pin] : ["--pin"];
		await run(argv, cli);

		expect(cli.state.errors).toContain("4-8 digits");
		expect(cli.state.exitCode).toBe(1);
	});

	it("shows error when set_pin IPC returns ok: false", async () => {
		const cli = createMockCLI({
			sendIPC: async (cmd) => {
				cli.state.ipcCommands.push(cmd);
				return { ok: false, error: "PIN storage failed" };
			},
		});

		await run(["--pin", "1234"], cli);

		expect(cli.state.errors).toContain("PIN storage failed");
		expect(cli.state.exitCode).toBe(1);
	});

	it("property: valid PINs (4-8 digits) are always accepted", () => {
		fc.assert(
			fc.asyncProperty(fc.stringMatching(/^\d{4,8}$/), async (pin) => {
				const cli = createMockCLI({
					sendIPC: async (cmd) => {
						cli.state.ipcCommands.push(cmd);
						return { ok: true };
					},
				});

				await run(["--pin", pin], cli);

				expect(cli.state.output).toContain("PIN updated");
				expect(cli.state.exitCode).toBeNull();
			}),
			{ seed: SEED, numRuns: 50, endOnFailure: true },
		);
	});
});

// ─── Daemon-not-running error (shared across all commands) ──────────

it.each([
	["--status"],
	["--stop"],
	["--pin", "123456"],
	["--add", "/tmp/test"],
	["--list"],
	["--instance", "list"],
])("%j shows 'not running' error when daemon is down", async (...argv) => {
	const cli = createMockCLI({
		isDaemonRunning: async () => false,
	});

	await run(argv.flat(), cli);

	expect(cli.state.errors).toContain("not running");
	expect(cli.state.exitCode).toBe(1);
});

// ─── T6: --add/--remove/--list/--title ────────────────────────────────

describe("T6: --add/--remove/--list/--title (AC5)", () => {
	describe("--add", () => {
		it("sends add_project with resolved path", async () => {
			const cli = createMockCLI({
				sendIPC: async (cmd) => {
					cli.state.ipcCommands.push(cmd);
					if (cmd.cmd === "add_project") {
						return { ok: true, slug: "test-project" };
					}
					return { ok: true };
				},
			});

			await run(["--add", "/tmp/test-project"], cli);

			const addCmd = cli.state.ipcCommands.find((c) => c.cmd === "add_project");
			expect(addCmd).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(addCmd!.directory).toBe("/tmp/test-project");
			expect(cli.state.output).toContain("Project added");
		});

		it("uses cwd when --add has no path", async () => {
			const cli = createMockCLI({
				sendIPC: async (cmd) => {
					cli.state.ipcCommands.push(cmd);
					if (cmd.cmd === "list_projects") {
						return {
							ok: true,
							projects: [
								{
									slug: "my-project",
									directory: "/home/user/my-project",
									title: "My Project",
								},
							],
						};
					}
					if (cmd.cmd === "remove_project") {
						return { ok: true };
					}
					return { ok: true };
				},
			});

			await run(["--remove"], cli);

			const removeCmd = cli.state.ipcCommands.find(
				(c) => c.cmd === "remove_project",
			);
			expect(removeCmd).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(removeCmd!.slug).toBe("my-project");
			expect(cli.state.output).toContain("Project removed");
		});

		it("shows error when cwd is not registered", async () => {
			const cli = createMockCLI({
				sendIPC: async (cmd) => {
					cli.state.ipcCommands.push(cmd);
					if (cmd.cmd === "list_projects") {
						return { ok: true, projects: [] };
					}
					return { ok: true };
				},
			});

			await run(["--remove"], cli);

			expect(cli.state.errors).toContain("not registered");
			expect(cli.state.exitCode).toBe(1);
		});

		it("shows error when list_projects IPC fails in --remove", async () => {
			const cli = createMockCLI({
				sendIPC: async (cmd) => {
					cli.state.ipcCommands.push(cmd);
					return { ok: false, error: "db locked" };
				},
			});

			await run(["--remove"], cli);

			expect(cli.state.errors).toContain("Failed to list");
			expect(cli.state.exitCode).toBe(1);
		});

		it("shows error when remove_project IPC returns ok: false", async () => {
			const cli = createMockCLI({
				sendIPC: async (cmd) => {
					cli.state.ipcCommands.push(cmd);
					if (cmd.cmd === "list_projects") {
						return {
							ok: true,
							projects: [
								{ slug: "my-project", directory: "/home/user/my-project" },
							],
						};
					}
					if (cmd.cmd === "remove_project") {
						return { ok: false, error: "permission denied" };
					}
					return { ok: true };
				},
			});

			await run(["--remove"], cli);

			expect(cli.state.errors).toContain("permission denied");
			expect(cli.state.exitCode).toBe(1);
		});
	});

	describe("--list", () => {
		it("sends list_projects and displays results", async () => {
			const cli = createMockCLI({
				sendIPC: async (cmd) => {
					cli.state.ipcCommands.push(cmd);
					if (cmd.cmd === "list_projects") {
						return {
							ok: true,
							projects: [
								{
									slug: "proj-a",
									directory: "/home/user/proj-a",
									title: "Project A",
								},
								{ slug: "proj-b", directory: "/home/user/proj-b" },
							],
						};
					}
					return { ok: true };
				},
			});

			await run(["--list"], cli);

			expect(cli.state.output).toContain("Projects (2)");
			expect(cli.state.output).toContain("proj-a (Project A)");
			expect(cli.state.output).toContain("proj-b");
			expect(cli.state.output).toContain("/home/user/proj-a");
			expect(cli.state.output).toContain("/home/user/proj-b");
		});

		it("shows message when no projects", async () => {
			const cli = createMockCLI({
				sendIPC: async () => ({ ok: true, projects: [] }),
			});

			await run(["--list"], cli);

			expect(cli.state.output).toContain("No projects registered");
		});
	});

	describe("--title", () => {
		it("sends list_projects then set_project_title", async () => {
			const cli = createMockCLI({
				sendIPC: async (cmd) => {
					cli.state.ipcCommands.push(cmd);
					if (cmd.cmd === "list_projects") {
						return {
							ok: true,
							projects: [
								{ slug: "my-project", directory: "/home/user/my-project" },
							],
						};
					}
					if (cmd.cmd === "set_project_title") {
						return { ok: true };
					}
					return { ok: true };
				},
			});

			await run(["--title", "New Title"], cli);

			const titleCmd = cli.state.ipcCommands.find(
				(c) => c.cmd === "set_project_title",
			);
			expect(titleCmd).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(titleCmd!.slug).toBe("my-project");
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(titleCmd!.title).toBe("New Title");
			expect(cli.state.output).toContain("Title updated");
		});

		it("shows error when --title is missing value", async () => {
			const cli = createMockCLI();

			await run(["--title"], cli);

			expect(cli.state.errors).toContain("required");
			expect(cli.state.exitCode).toBe(1);
		});

		it("shows error when cwd not registered", async () => {
			const cli = createMockCLI({
				sendIPC: async (cmd) => {
					cli.state.ipcCommands.push(cmd);
					if (cmd.cmd === "list_projects") {
						return { ok: true, projects: [] };
					}
					return { ok: true };
				},
			});

			await run(["--title", "Test"], cli);

			expect(cli.state.errors).toContain("not registered");
			expect(cli.state.exitCode).toBe(1);
		});

		it("shows error when list_projects IPC fails in --title", async () => {
			const cli = createMockCLI({
				sendIPC: async (cmd) => {
					cli.state.ipcCommands.push(cmd);
					return { ok: false, error: "db locked" };
				},
			});

			await run(["--title", "Test"], cli);

			expect(cli.state.errors).toContain("Failed to list");
			expect(cli.state.exitCode).toBe(1);
		});

		it("shows error when set_project_title IPC returns ok: false", async () => {
			const cli = createMockCLI({
				sendIPC: async (cmd) => {
					cli.state.ipcCommands.push(cmd);
					if (cmd.cmd === "list_projects") {
						return {
							ok: true,
							projects: [
								{ slug: "my-project", directory: "/home/user/my-project" },
							],
						};
					}
					if (cmd.cmd === "set_project_title") {
						return { ok: false, error: "title too long" };
					}
					return { ok: true };
				},
			});

			await run(["--title", "Test"], cli);

			expect(cli.state.errors).toContain("title too long");
			expect(cli.state.exitCode).toBe(1);
		});
	});
});

// ─── T7: --port/--oc-port passed through ──────────────────────────────

describe("T7: --port/--oc-port passed through (AC6)", () => {
	it("custom port is used in URL", async () => {
		const cli = createMockCLI({
			sendIPC: async (cmd) => {
				cli.state.ipcCommands.push(cmd);
				if (cmd.cmd === "add_project") return { ok: true, slug: "test" };
				return { ok: true };
			},
		});

		await run(["--port", "3000"], cli);

		expect(cli.state.output).toContain(":3000");
	});

	it("custom port is passed to spawnDaemon", async () => {
		let spawnPort: number | undefined;
		const cli = createMockCLI({
			isDaemonRunning: async () => false,
			spawnDaemon: async (opts) => {
				spawnPort = opts?.port;
				return { pid: 1, port: opts?.port ?? 2633 };
			},
			sendIPC: async (cmd) => {
				cli.state.ipcCommands.push(cmd);
				if (cmd.cmd === "add_project") return { ok: true, slug: "test" };
				return { ok: true };
			},
		});

		await run(["--port", "4000"], cli);

		expect(spawnPort).toBe(4000);
	});
});

// ─── T8: Error handling ───────────────────────────────────────────────

describe("T8: Error handling (AC8)", () => {
	it("handles EADDRINUSE when spawning daemon", async () => {
		const cli = createMockCLI({
			isDaemonRunning: async () => false,
			spawnDaemon: async () => {
				throw new Error("listen EADDRINUSE: address already in use");
			},
		});

		await run([], cli);

		expect(cli.state.errors).toContain("already in use");
		expect(cli.state.errors).toContain("different port");
		expect(cli.state.exitCode).toBe(1);
	});

	it("handles generic spawn errors", async () => {
		const cli = createMockCLI({
			isDaemonRunning: async () => false,
			spawnDaemon: async () => {
				throw new Error("Something went wrong");
			},
		});

		await run([], cli);

		expect(cli.state.errors).toContain("Something went wrong");
		expect(cli.state.exitCode).toBe(1);
	});

	it("handles IPC error in --status", async () => {
		const cli = createMockCLI({
			sendIPC: async () => ({ ok: false, error: "internal error" }),
		});

		await run(["--status"], cli);

		expect(cli.state.errors).toContain("internal error");
		expect(cli.state.exitCode).toBe(1);
	});

	it("handles IPC error in --add", async () => {
		const cli = createMockCLI({
			sendIPC: async () => ({ ok: false, error: "directory not found" }),
		});

		await run(["--add", "/nonexistent"], cli);

		expect(cli.state.errors).toContain("directory not found");
		expect(cli.state.exitCode).toBe(1);
	});

	it("--list failure shows error", async () => {
		const cli = createMockCLI({
			sendIPC: async () => ({ ok: false, error: "something broke" }),
		});

		await run(["--list"], cli);

		expect(cli.state.errors).toContain("Failed to list");
		expect(cli.state.exitCode).toBe(1);
	});
});

// ─── T9/T10: getNetworkAddress + QR generation ───────────────────────
// Network address injection and QR code injection are already tested in T2
// (default invocation). Only the real getNetworkAddress return type needs
// a standalone test since T2 uses a mock.

describe("T9/T10: getNetworkAddress and generateQR", () => {
	it("real getNetworkAddress returns string or null", () => {
		const result = getNetworkAddress();
		expect(result === null || typeof result === "string").toBe(true);
		if (result !== null) {
			expect(result).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
		}
	});

	it("generateQR returns a non-empty string", () => {
		const result = generateQR("http://example.com");
		expect(result.length).toBeGreaterThan(0);
	});
});

// ─── T11: sendIPCCommand ──────────────────────────────────────────────

describe("T11: sendIPCCommand", () => {
	it("sendIPCCommand rejects for non-existent socket path", async () => {
		await expect(
			sendIPCCommand("/tmp/nonexistent-cli-test-socket.sock", {
				cmd: "get_status",
			}),
		).rejects.toThrow();
	});

	it("sendIPCCommand retries and succeeds when server starts late", async () => {
		const { createServer } = await import("node:net");
		const { mkdtempSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");

		const dir = mkdtempSync(join(tmpdir(), "ipc-retry-"));
		const sockPath = join(dir, "relay.sock");

		// Start server after 800ms (will be caught by retry)
		const server = createServer((conn) => {
			let buf = "";
			conn.on("data", (d: Buffer) => {
				buf += d.toString();
				if (buf.includes("\n")) {
					conn.write('{"ok":true}\n');
					conn.destroy();
				}
			});
		});

		const startTimer = setTimeout(() => {
			server.listen(sockPath);
		}, 800);

		try {
			const result = await sendIPCCommand(sockPath, {
				cmd: "get_status",
			});
			expect(result).toEqual({ ok: true });
		} finally {
			clearTimeout(startTimer);
			server.close();
		}
	});
});

// ─── --help ───────────────────────────────────────────────────────────

describe("--help shows usage information", () => {
	it("displays all flags in help text", async () => {
		const cli = createMockCLI();

		await run(["--help"], cli);

		expect(cli.state.output).toContain("--status");
		expect(cli.state.output).toContain("--stop");
		expect(cli.state.output).toContain("--pin");
		expect(cli.state.output).toContain("--add");
		expect(cli.state.output).toContain("--remove");
		expect(cli.state.output).toContain("--list");
		expect(cli.state.output).toContain("--title");
		expect(cli.state.output).toContain("--port");
		expect(cli.state.output).toContain("--oc-port");
		expect(cli.state.output).toContain("--no-update");
		expect(cli.state.output).toContain("--debug");
		expect(cli.state.output).toContain("--help");
	});

	it("does not exit or call IPC", async () => {
		const cli = createMockCLI();

		await run(["--help"], cli);

		expect(cli.state.exitCode).toBeNull();
		expect(cli.state.ipcCommands).toHaveLength(0);
	});

	it("displays new flags in help text", async () => {
		const cli = createMockCLI();

		await run(["--help"], cli);

		expect(cli.state.output).toContain("--yes");
		expect(cli.state.output).toContain("-y");
		expect(cli.state.output).toContain("--no-https");
		expect(cli.state.output).toContain("--dangerously-skip-permissions");
	});
});

// ─── T12: New flags (Ticket 8.15) ─────────────────────────────────

describe("T12: parseArgs — new flags -y, --no-https, --dangerously-skip-permissions", () => {
	it.each([
		["-y", "yes", true],
		["--yes", "yes", true],
		["--no-https", "noHttps", true],
		["--dangerously-skip-permissions", "skipPerms", true],
	] as const)("%s sets %s to %s", (flag, field, expected) => {
		const args = parseArgs([flag]);
		expect(args[field]).toBe(expected);
	});

	it("new flags combined with existing flags", () => {
		const args = parseArgs(["--port", "3000", "-y", "--no-https", "--debug"]);
		expect(args.port).toBe(3000);
		expect(args.yes).toBe(true);
		expect(args.noHttps).toBe(true);
		expect(args.debug).toBe(true);
		expect(args.command).toBe("default");
	});

	it("property: yes, noHttps, skipPerms are always booleans", () => {
		fc.assert(
			fc.property(
				fc.array(fc.string({ minLength: 0, maxLength: 20 }), {
					minLength: 0,
					maxLength: 10,
				}),
				(argv) => {
					const args = parseArgs(argv);
					expect(typeof args.yes).toBe("boolean");
					expect(typeof args.noHttps).toBe("boolean");
					expect(typeof args.skipPerms).toBe("boolean");
				},
			),
			{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
		);
	});
});

// ─── T13: --dangerously-skip-permissions requires --pin ──────────

describe("T13: --dangerously-skip-permissions requires --pin (Ticket 8.15)", () => {
	it("errors when --dangerously-skip-permissions used without --pin", async () => {
		const cli = createMockCLI();

		await run(["--dangerously-skip-permissions"], cli);

		expect(cli.state.errors).toContain(
			"--dangerously-skip-permissions requires --pin",
		);
		expect(cli.state.exitCode).toBe(1);
	});

	it("does not error when --dangerously-skip-permissions used with --pin", async () => {
		// With --pin, the command becomes "pin" and skipPerms validation is skipped
		const cli = createMockCLI({
			sendIPC: async (cmd) => {
				cli.state.ipcCommands.push(cmd);
				return { ok: true };
			},
		});

		await run(["--dangerously-skip-permissions", "--pin", "1234"], cli);

		// --pin handler runs (PIN is valid, daemon is running) → "PIN updated"
		expect(cli.state.output).toContain("PIN updated");
		expect(cli.state.exitCode).toBeNull();
	});
});

// ─── T14: Interactive mode (Ticket 8.15) ─────────────────────────

describe("T14: Interactive mode — showInteractiveMenu injectable (Ticket 8.15)", () => {
	it("enters interactive mode when showInteractiveMenu is injected", async () => {
		let interactiveCalled = false;
		let capturedCtx: InteractiveContext | null = null;

		const cli = createMockCLI({
			showInteractiveMenu: async (ctx) => {
				interactiveCalled = true;
				capturedCtx = ctx;
			},
		});

		await run([], cli);

		expect(interactiveCalled).toBe(true);
		expect(capturedCtx).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(capturedCtx!.cwd).toBe("/home/user/my-project");
	});

	it("passes args to interactive context", async () => {
		let capturedCtx: InteractiveContext | null = null;

		const cli = createMockCLI({
			showInteractiveMenu: async (ctx) => {
				capturedCtx = ctx;
			},
		});

		await run(["--port", "4000", "-y", "--no-https"], cli);

		expect(capturedCtx).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(capturedCtx!.args.port).toBe(4000);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(capturedCtx!.args.yes).toBe(true);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(capturedCtx!.args.noHttps).toBe(true);
	});

	it("interactive context has ipcSend, checkDaemon, spawnDaemon", async () => {
		let capturedCtx: InteractiveContext | null = null;

		const cli = createMockCLI({
			showInteractiveMenu: async (ctx) => {
				capturedCtx = ctx;
			},
		});

		await run([], cli);

		expect(capturedCtx).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(typeof capturedCtx!.ipcSend).toBe("function");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(typeof capturedCtx!.checkDaemon).toBe("function");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(typeof capturedCtx!.spawnDaemon).toBe("function");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(typeof capturedCtx!.getAddr).toBe("function");
	});

	it("uses showInteractiveMenu for default command only (not --status)", async () => {
		let interactiveCalled = false;

		const cli = createMockCLI({
			showInteractiveMenu: async () => {
				interactiveCalled = true;
			},
			sendIPC: async () => ({
				ok: true,
				uptime: 0,
				port: 2633,
				projectCount: 0,
				clientCount: 0,
			}),
		});

		await run(["--status"], cli);

		expect(interactiveCalled).toBe(false);
	});

	it("uses showInteractiveMenu for default command only (not --stop)", async () => {
		let interactiveCalled = false;

		const cli = createMockCLI({
			showInteractiveMenu: async () => {
				interactiveCalled = true;
			},
		});

		await run(["--stop"], cli);

		expect(interactiveCalled).toBe(false);
	});

	it("non-interactive fallback when no showInteractiveMenu and non-TTY stdin", async () => {
		// The default createMockCLI does NOT provide showInteractiveMenu
		// and does NOT provide stdin, so stdin falls back to process.stdin
		// which in tests is not a TTY → legacy behavior
		const cli = createMockCLI({
			sendIPC: async (cmd) => {
				cli.state.ipcCommands.push(cmd);
				if (cmd.cmd === "add_project") {
					return { ok: true, slug: "my-project" };
				}
				return { ok: true };
			},
		});

		await run([], cli);

		// Legacy behavior: shows URL and QR
		expect(cli.state.output).toContain("192.168.1.100");
		expect(cli.state.output).toContain("[QR:");
	});

	it("--dangerously-skip-permissions validation runs before interactive mode", async () => {
		let interactiveCalled = false;

		const cli = createMockCLI({
			showInteractiveMenu: async () => {
				interactiveCalled = true;
			},
		});

		await run(["--dangerously-skip-permissions"], cli);

		expect(interactiveCalled).toBe(false);
		expect(cli.state.errors).toContain(
			"--dangerously-skip-permissions requires --pin",
		);
		expect(cli.state.exitCode).toBe(1);
	});

	it("interactive mode receives stdin from options", async () => {
		let capturedCtx: InteractiveContext | null = null;
		const mockStdin = {
			on: () => {},
			isTTY: true,
		} as unknown as NodeJS.ReadStream & {
			setRawMode?: (mode: boolean) => void;
		};

		const cli = createMockCLI({
			stdin: mockStdin,
			showInteractiveMenu: async (ctx) => {
				capturedCtx = ctx;
			},
		});

		await run([], cli);

		expect(capturedCtx).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(capturedCtx!.stdin).toBe(mockStdin);
	});
});

// ─── T16: Instance subcommands ─────────────────────────────────────

describe("instance subcommands", () => {
	it.each([
		"list",
		"remove",
		"start",
		"stop",
		"status",
	] as const)("parseArgs parses --instance %s", (action) => {
		const args = parseArgs(["--instance", action, "work"]);
		expect(args.command).toBe("instance");
		expect(args.instanceAction).toBe(action);
		if (action !== "list") expect(args.instanceName).toBe("work");
	});

	it("parseArgs parses --instance add with name, port, and --managed", () => {
		const args = parseArgs([
			"--instance",
			"add",
			"work",
			"--port",
			"4097",
			"--managed",
		]);
		expect(args.command).toBe("instance");
		expect(args.instanceAction).toBe("add");
		expect(args.instanceName).toBe("work");
		expect(args.instancePort).toBe(4097);
		expect(args.instanceManaged).toBe(true);
	});

	it("parseArgs --instance with no action", () => {
		const args = parseArgs(["--instance"]);
		expect(args.command).toBe("instance");
		expect(args.instanceAction).toBeUndefined();
	});

	it("--port sets instancePort when command is instance", () => {
		const args = parseArgs(["--instance", "add", "foo", "--port", "5000"]);
		expect(args.instancePort).toBe(5000);
		// relay port should remain default
		expect(args.port).toBe(2633);
	});

	it("--port before --instance still sets instancePort", () => {
		const args = parseArgs(["--port", "4097", "--instance", "add", "work"]);
		expect(args.instancePort).toBe(4097);
		// relay port should be reset to default
		expect(args.port).toBe(2633);
	});

	it("--port DEFAULT_PORT before --instance still sets instancePort (Fix #9)", () => {
		// Edge case: explicitly passing the default port value (2633) should still
		// set instancePort, not be silently ignored.
		const args = parseArgs(["--port", "2633", "--instance", "add", "work"]);
		expect(args.instancePort).toBe(2633);
		expect(args.port).toBe(2633);
	});

	it("portExplicit is set when --port is provided (Fix #9)", () => {
		const args = parseArgs(["--port", "2633"]);
		expect(args.portExplicit).toBe(true);
	});

	it("portExplicit is undefined when --port is not provided (Fix #9)", () => {
		const args = parseArgs(["--instance", "add", "work"]);
		expect(args.portExplicit).toBeUndefined();
	});

	it("instance list sends instance_list IPC", async () => {
		const cli = createMockCLI({
			sendIPC: async (cmd) => {
				cli.state.ipcCommands.push(cmd);
				return { ok: true, instances: [] };
			},
		});
		await run(["--instance", "list"], cli);
		expect(cli.state.ipcCommands).toContainEqual({ cmd: "instance_list" });
		expect(cli.state.output).toContain("No instances");
	});

	it("instance list displays instances", async () => {
		const cli = createMockCLI({
			sendIPC: async (cmd) => {
				cli.state.ipcCommands.push(cmd);
				return {
					ok: true,
					instances: [
						{
							id: "work",
							name: "Work",
							port: 4097,
							managed: true,
							status: "healthy",
						},
					],
				};
			},
		});
		await run(["--instance", "list"], cli);
		expect(cli.state.output).toContain("Instances (1)");
		expect(cli.state.output).toContain("Work");
	});

	it("instance add sends instance_add IPC", async () => {
		const cli = createMockCLI({
			sendIPC: async (cmd) => {
				cli.state.ipcCommands.push(cmd);
				return { ok: true, instance: { id: "work" } };
			},
		});
		await run(
			["--instance", "add", "work", "--port", "4097", "--managed"],
			cli,
		);
		expect(cli.state.ipcCommands).toContainEqual(
			expect.objectContaining({ cmd: "instance_add", name: "work" }),
		);
		expect(cli.state.output).toContain("Instance added");
	});

	it("instance add without name shows error", async () => {
		const cli = createMockCLI();
		await run(["--instance", "add"], cli);
		expect(cli.state.errors).toContain("name is required");
		expect(cli.state.exitCode).toBe(1);
	});

	it.each([
		["remove", "instance_remove"],
		["start", "instance_start"],
		["stop", "instance_stop"],
	] as const)("instance %s sends %s IPC", async (action, expectedCmd) => {
		const cli = createMockCLI({
			sendIPC: async (cmd) => {
				cli.state.ipcCommands.push(cmd);
				return { ok: true };
			},
		});
		await run(["--instance", action, "work"], cli);
		expect(cli.state.ipcCommands).toContainEqual(
			expect.objectContaining({ cmd: expectedCmd, id: "work" }),
		);
	});

	it("instance status sends instance_status IPC", async () => {
		const cli = createMockCLI({
			sendIPC: async (cmd) => {
				cli.state.ipcCommands.push(cmd);
				return {
					ok: true,
					instance: {
						id: "work",
						name: "Work",
						port: 4097,
						managed: true,
						status: "healthy",
					},
				};
			},
		});
		await run(["--instance", "status", "work"], cli);
		expect(cli.state.ipcCommands).toContainEqual(
			expect.objectContaining({ cmd: "instance_status", id: "work" }),
		);
		expect(cli.state.output).toContain("Work");
		expect(cli.state.output).toContain("4097");
		expect(cli.state.output).toContain("healthy");
	});

	it("instance with no action shows error", async () => {
		const cli = createMockCLI();
		await run(["--instance"], cli);
		expect(cli.state.errors).toContain("Unknown instance action");
		expect(cli.state.exitCode).toBe(1);
	});

	it("instance add with duplicate name reports error from IPC", async () => {
		const cli = createMockCLI({
			sendIPC: async (cmd) => {
				cli.state.ipcCommands.push(cmd);
				return { ok: false, error: 'Instance "work" already exists' };
			},
		});
		await run(
			["--instance", "add", "work", "--port", "4097", "--managed"],
			cli,
		);
		expect(cli.state.errors).toContain("already exists");
		expect(cli.state.exitCode).toBe(1);
	});

	it("parseArgs ignores invalid instance action", () => {
		const args = parseArgs(["--instance", "invalid-action"]);
		expect(args.command).toBe("instance");
		expect(args.instanceAction).toBeUndefined();
	});

	it("--instance appears in help text", () => {
		expect(HELP_TEXT).toContain("--instance");
		expect(HELP_TEXT).toContain("--managed");
	});

	it("--url appears in help text for unmanaged instances", () => {
		expect(HELP_TEXT).toContain("--url");
		expect(HELP_TEXT).toContain("unmanaged");
	});

	it("parseArgs parses --url flag into instanceUrl", () => {
		const args = parseArgs([
			"--instance",
			"add",
			"ext",
			"--url",
			"http://host:4096",
		]);
		expect(args.instanceUrl).toBe("http://host:4096");
	});

	it("parseArgs parses --url before --instance", () => {
		const args = parseArgs([
			"--url",
			"http://host:4096",
			"--instance",
			"add",
			"ext",
		]);
		expect(args.instanceUrl).toBe("http://host:4096");
	});

	it("--url is not consumed when its value starts with --", () => {
		const args = parseArgs(["--url", "--instance"]);
		expect(args.instanceUrl).toBeUndefined();
	});

	it("instance add with --url sends url in IPC command", async () => {
		const cli = createMockCLI({
			sendIPC: async (cmd) => {
				cli.state.ipcCommands.push(cmd);
				return { ok: true, instance: { id: "ext" } };
			},
		});
		await run(["--instance", "add", "ext", "--url", "http://host:4096"], cli);
		expect(cli.state.ipcCommands).toContainEqual(
			expect.objectContaining({
				cmd: "instance_add",
				name: "ext",
				url: "http://host:4096",
				managed: false,
			}),
		);
		expect(cli.state.output).toContain("Instance added");
	});

	it("instance add without --url sends undefined url in IPC command", async () => {
		const cli = createMockCLI({
			sendIPC: async (cmd) => {
				cli.state.ipcCommands.push(cmd);
				return { ok: true, instance: { id: "work" } };
			},
		});
		await run(
			["--instance", "add", "work", "--port", "4097", "--managed"],
			cli,
		);
		const addCmd = cli.state.ipcCommands.find((c) => c.cmd === "instance_add");
		expect(addCmd).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(addCmd!.url).toBeUndefined();
	});
});

// ─── T17: --log-level parsing ──────────────────────────────────────

// ─── T17-T20: Value-accepting flags ────────────────────────────────
// These test the distinct branching in parseArgs for flags that accept
// a value (valid value, invalid value, missing value).

describe("T17-T20: --log-level, --log-format, --host, --restart-daemon", () => {
	it.each([
		"debug",
		"error",
		"warn",
		"verbose",
		"info",
	] as const)("--log-level %s sets logLevel", (level) => {
		expect(parseArgs(["--log-level", level]).logLevel).toBe(level);
	});

	it.each([
		[["--log-level", "trace"], "info"],
		[["--log-level"], "info"],
	] as const)("--log-level rejects invalid/missing value: %j → %s", (argv, expected) => {
		expect(parseArgs(argv as unknown as string[]).logLevel).toBe(expected);
	});

	it.each([
		"json",
		"pretty",
	] as const)("--log-format %s sets logFormat", (fmt) => {
		expect(parseArgs(["--log-format", fmt]).logFormat).toBe(fmt);
	});

	it.each([
		[["--log-format", "csv"]],
		[["--log-format"]],
	] as const)("--log-format rejects invalid/missing value: %j", (argv) => {
		expect(parseArgs(argv as unknown as string[]).logFormat).toBeUndefined();
	});

	it.each([
		["--host", "0.0.0.0"],
		["-H", "127.0.0.1"],
		["--host", "::1"],
		["--host", "localhost"],
	] as const)("%s %s sets host", (flag, value) => {
		expect(parseArgs([flag, value]).host).toBe(value);
	});

	it("--host followed by flag does not consume the flag as value", () => {
		const args = parseArgs(["--host", "--stop"]);
		expect(args.command).toBe("stop");
	});

	it("--restart-daemon sets restartDaemon to true", () => {
		expect(parseArgs(["--restart-daemon"]).restartDaemon).toBe(true);
	});

	it("flags combine correctly", () => {
		const args = parseArgs([
			"--port",
			"3000",
			"--log-level",
			"debug",
			"--log-format",
			"json",
			"--host",
			"0.0.0.0",
			"--foreground",
			"--restart-daemon",
		]);
		expect(args.logLevel).toBe("debug");
		expect(args.logFormat).toBe("json");
		expect(args.host).toBe("0.0.0.0");
		expect(args.port).toBe(3000);
		expect(args.command).toBe("foreground");
		expect(args.restartDaemon).toBe(true);
	});
});

// ─── T21: HELP_TEXT ↔ parseArgs cross-check ───────────────────────

describe("T21: HELP_TEXT documents all parseArgs flags (and vice versa)", () => {
	// Canonical list of all flags handled by the parseArgs switch statement.
	// When you add a new flag to parseArgs, add it here too — that's the
	// entire point of this test.
	const PARSED_FLAGS = [
		"--daemon",
		"--foreground",
		"--restart-daemon",
		"--status",
		"--stop",
		"--pin",
		"--add",
		"--remove",
		"--list",
		"--title",
		"--port",
		"-p",
		"--host",
		"-H",
		"--oc-port",
		"--no-update",
		"--debug",
		"-y",
		"--yes",
		"--no-https",
		"--dangerously-skip-permissions",
		"--managed",
		"--url",
		"--instance",
		"--log-level",
		"--log-format",
		"--help",
		"-h",
	];

	// Flags that are intentionally omitted from HELP_TEXT.
	// --daemon is an internal flag used by Daemon.spawn() to launch the
	// child process; users should never type it directly.
	const INTERNAL_FLAGS = new Set(["--daemon"]);

	// Short aliases are documented inline with their long form
	// (e.g. "-p, --port") so we check the long form covers them.
	const SHORT_ALIASES: Record<string, string> = {
		"-p": "--port",
		"-H": "--host",
		"-y": "--yes",
		"-h": "--help",
	};

	// ── Forward: every parsed flag appears in HELP_TEXT ──────────

	for (const flag of PARSED_FLAGS) {
		if (INTERNAL_FLAGS.has(flag)) continue;

		const longForm = SHORT_ALIASES[flag];
		if (longForm) {
			it(`HELP_TEXT documents short alias ${flag} (via ${longForm})`, () => {
				// Short aliases appear as "-p, --port" in the help text
				expect(HELP_TEXT).toContain(flag);
			});
		} else {
			it(`HELP_TEXT documents ${flag}`, () => {
				expect(HELP_TEXT).toContain(flag);
			});
		}
	}

	// ── Reverse: every --flag in HELP_TEXT is handled by parseArgs ──

	it("every --flag in HELP_TEXT is in the parsed flags list", () => {
		// Extract all --flag tokens from HELP_TEXT
		const helpFlags = new Set(
			Array.from(HELP_TEXT.matchAll(/(--[\w-]+)/g), (m) => m[1] as string),
		);

		const parsedSet = new Set(PARSED_FLAGS);

		for (const flag of helpFlags) {
			expect(
				parsedSet.has(flag),
				`HELP_TEXT mentions ${flag} but parseArgs does not handle it`,
			).toBe(true);
		}
	});

	// ── Internal flags are NOT in HELP_TEXT ─────────────────────

	for (const flag of INTERNAL_FLAGS) {
		it(`HELP_TEXT does not expose internal flag ${flag}`, () => {
			// Match as a standalone flag definition, not as a substring.
			// --daemon shouldn't appear as "  --daemon" in the options list.
			// It could appear inside a description string (e.g. "--restart-daemon")
			// so we check it doesn't appear as a standalone option line.
			const asOptionLine = new RegExp(
				`^\\s+${flag.replace(/-/g, "\\-")}\\s`,
				"m",
			);
			expect(HELP_TEXT).not.toMatch(asOptionLine);
		});
	}
});
