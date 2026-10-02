// Tests: CLI Interface (Ticket 3.3)
//
// Tests cover:
// T1: parseArgs — all flags parsed correctly, defaults, --help, unknown flags (AC1-AC8)
// T2: Default invocation — connects to server, registers project, outputs QR/URL (AC1)
// T3: --status — sends GetStatus, formats output (AC2)
// T4: --stop — sends shutdown, displays confirmation (AC3)
// T5: --pin — validates 4-8 digit, sends SetPin (AC4)
// T6: --add/--remove/--list/--title — correct RPC commands (AC5)
// T7: --port/--oc-port — passed through (AC6)
// T8: Error handling — daemon not reachable, RPC errors (AC8)
// T9: getNetworkAddress — returns first non-internal IPv4 (AC1)
// T10: QR generation — mock (AC7)
// T11: daemon RPC transport has dedicated socket tests
// PBT: Property-based arg parsing

import fc from "fast-check";
import { assert, describe, expect, it } from "vitest";
import {
	type CLIOptions,
	generateQR,
	getNetworkAddress,
	parseArgs,
	run,
} from "../../../src/bin/cli-core.js";
import { HELP_TEXT } from "../../../src/bin/cli-utils.js";
import {
	WsRpcError,
	type WsRpcRequest,
} from "../../../src/lib/contracts/ws-rpc.js";
import type { SendRPC } from "../../../src/lib/daemon/daemon-rpc-client.js";

const SEED = 42;
const NUM_RUNS = 100;

/** Captured state from mock CLI */
interface MockCLIState {
	output: string;
	errors: string;
	exitCode: number | null;
	rpcRequests: WsRpcRequest[];
}

/** Create a mock CLIOptions with captured output.
 *  Access captured data via the returned `.state` property.
 */
function createMockCLI(
	overrides?: Partial<Omit<CLIOptions, "sendRPC">> & {
		sendRPC?: (request: WsRpcRequest) => Promise<unknown>;
	},
): CLIOptions & { state: MockCLIState } {
	const { sendRPC, ...otherOverrides } = overrides ?? {};
	const state: MockCLIState = {
		output: "",
		errors: "",
		exitCode: null,
		rpcRequests: [],
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
		sendRPC: (async (request: WsRpcRequest) => {
			state.rpcRequests.push(request);
			return {};
		}) as SendRPC,
		isDaemonRunning: async () => true,
		generateQR: (url: string) => `[QR:${url}]`,
		getNetworkAddress: () => "192.168.1.100",
		getTailscaleIP: () => null,
		...otherOverrides,
		...(sendRPC && { sendRPC: sendRPC as SendRPC }),
	};

	return opts;
}

describe("Ticket 3.3 — CLI Interface", () => {
	describe("T1: parseArgs — all flags parsed correctly (AC1-AC8)", () => {
		it("default command with no args", () => {
			const args = parseArgs([]);
			expect(args.command).toBe("default");
			expect(args.port).toBe(2633);
			expect(args.ocPort).toBe(4096);
		});

		it.each([
			["serve", "command", "serve"],
			["--foreground", "command", "serve"],
			["stop", "command", "stop"],
			["--status", "command", "status"],
			["--stop", "command", "stop"],
			["--remove", "command", "remove"],
			["--list", "command", "list"],
			["--help", "command", "help"],
			["-h", "command", "help"],
		] as const)("%s sets %s to %s", (flag, field, expected) => {
			const args = parseArgs([flag]);
			expect(args[field]).toBe(expected);
		});

		const parseCases: Array<[string[], Record<string, unknown>]> = [
			[["--pin", "123456"], { command: "pin", pin: "123456" }],
			[["--pin"], { command: "pin", pin: undefined }],
			[["--add", "/some/path"], { command: "add", addPath: "/some/path" }],
			[["--add"], { command: "add", addPath: undefined }],
			[["--title", "My Project"], { command: "title", title: "My Project" }],
			[["--port", "3000"], { port: 3000 }],
			[["-p", "8080"], { port: 8080 }],
			[["--oc-port", "5000"], { ocPort: 5000 }],
		];
		it.each(
			parseCases,
		)("parseArgs(%j) sets expected fields", (argv, expected) => {
			const args = parseArgs(argv);
			for (const [key, value] of Object.entries(expected)) {
				expect(args[key as keyof typeof args]).toBe(value);
			}
		});

		it("unknown flags are ignored", () => {
			const args = parseArgs(["--unknown", "--foo"]);
			expect(args.command).toBe("default");
		});

		it("multiple flags combined", () => {
			const args = parseArgs(["--port", "3000", "--oc-port", "5000"]);
			expect(args.port).toBe(3000);
			expect(args.ocPort).toBe(5000);
		});

		const defaultCases: Array<[string[], "port" | "ocPort", number]> = [
			[["--port", "not-a-number"], "port", 2633],
			[["--port", "99999"], "port", 2633],
			[["--port"], "port", 2633],
			[["--oc-port"], "ocPort", 4096],
		];
		it.each(
			defaultCases,
		)("keeps default when parseArgs(%j).%s should be %d", (argv, field, expected) => {
			const args = parseArgs(argv);
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

describe("T2: Default invocation — register and display (AC1)", () => {
	it("prints one guidance line when the server is unavailable", async () => {
		const cli = createMockCLI({
			isDaemonRunning: async () => false,
		});
		await run([], cli);
		expect(cli.state.errors).toBe(
			"Server is not running. Run conduit serve or conduit service install.\n",
		);
		expect(cli.state.output).toBe("");
		expect(cli.state.rpcRequests).toHaveLength(0);
		expect(cli.state.exitCode).toBe(1);
	});

	it("registers cwd and prints its URL without opening a menu", async () => {
		const cli = createMockCLI({
			sendRPC: async (cmd) => {
				cli.state.rpcRequests.push(cmd);
				if (cmd._tag === "AddProject") return { addedSlug: "my-project" };
				return { port: 4000, tlsEnabled: false };
			},
		});
		await run([], cli);
		expect(cli.state.output).toContain("http://192.168.1.100:4000");
		expect(cli.state.output).toContain("my-project");
		expect(cli.state.rpcRequests.map((cmd) => cmd._tag)).toEqual([
			"AddProject",
			"GetStatus",
		]);
	});

	it("registers cwd via AddProject RPC command", async () => {
		const cli = createMockCLI({
			sendRPC: async (cmd) => {
				cli.state.rpcRequests.push(cmd);
				if (cmd._tag === "AddProject") {
					return { addedSlug: "my-project" };
				}
				return { ok: true };
			},
		});

		await run([], cli);

		const addCmd = cli.state.rpcRequests.find((c) => c._tag === "AddProject");
		expect(addCmd).toBeDefined();
		assert.exists(addCmd, "expected add command");
		expect(addCmd.directory).toBe("/home/user/my-project");
	});

	it("uses localhost when no network address available", async () => {
		const cli = createMockCLI({
			getNetworkAddress: () => null,
			sendRPC: async (cmd) => {
				cli.state.rpcRequests.push(cmd);
				if (cmd._tag === "AddProject") return { addedSlug: "test" };
				return { ok: true };
			},
		});

		await run([], cli);

		expect(cli.state.output).toContain("localhost");
	});

	it("shows QR code in output", async () => {
		const cli = createMockCLI({
			sendRPC: async (cmd) => {
				cli.state.rpcRequests.push(cmd);
				if (cmd._tag === "AddProject") return { addedSlug: "test" };
				return { ok: true };
			},
		});

		await run([], cli);

		expect(cli.state.output).toContain("[QR:http://192.168.1.100:2633]");
	});

	it("shows PIN tip", async () => {
		const cli = createMockCLI({
			sendRPC: async (cmd) => {
				cli.state.rpcRequests.push(cmd);
				if (cmd._tag === "AddProject") return { addedSlug: "test" };
				return { ok: true };
			},
		});

		await run([], cli);

		expect(cli.state.output).toContain("PIN");
	});

	it("keeps the default URL when AddProject fails", async () => {
		const cli = createMockCLI({
			sendRPC: async (cmd) => {
				cli.state.rpcRequests.push(cmd);
				if (cmd._tag === "AddProject") throw new Error("disk full");
				return { port: 2633, tlsEnabled: false };
			},
		});

		await run([], cli);

		// Should not crash; output should still contain the URL
		expect(cli.state.output).toContain("192.168.1.100");
		// But should not contain "Project:" since slug is undefined
		expect(cli.state.output).not.toContain("Project:");
	});
});

describe("T3: --status — sends GetStatus, formats output (AC2)", () => {
	it("displays status when daemon is running", async () => {
		const cli = createMockCLI({
			sendRPC: async (cmd) => {
				cli.state.rpcRequests.push(cmd);
				if (cmd._tag === "GetStatus") {
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
		// Also verifies the correct RPC command was sent
		expect(cli.state.rpcRequests[0]?._tag).toBe("GetStatus");
	});

	it.each([
		[45, "45s"],
		[125, "2m 5s"],
	])("formats uptime %ds as %s", async (uptime, expected) => {
		const cli = createMockCLI({
			sendRPC: async () => ({
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

describe("T4: stop — sends shutdown (AC3)", () => {
	it.each([
		"stop",
		"--stop",
	])("%s succeeds when the server is absent", async (command) => {
		const cli = createMockCLI({ isDaemonRunning: async () => false });
		await run([command], cli);
		expect(cli.state.output).toBe("Server is not running.\n");
		expect(cli.state.exitCode).toBe(0);
		expect(cli.state.rpcRequests).toHaveLength(0);
	});

	it("sends shutdown command and displays confirmation", async () => {
		const cli = createMockCLI({
			sendRPC: async (cmd) => {
				cli.state.rpcRequests.push(cmd);
				return { ok: true };
			},
		});

		await run(["--stop"], cli);

		expect(cli.state.rpcRequests).toHaveLength(1);
		const command = cli.state.rpcRequests[0];
		assert.exists(command, "expected RPC command");
		expect(command._tag).toBe("Shutdown");
		expect(cli.state.output).toContain("Server stopped");
	});

	it("handles RPC error gracefully", async () => {
		const cli = createMockCLI({
			sendRPC: async () => {
				throw new Error("Connection refused");
			},
		});

		await run(["--stop"], cli);

		expect(cli.state.errors).toContain("Connection refused");
		expect(cli.state.exitCode).toBe(1);
	});
});

describe("T5: --pin — validates digit, sends SetPin (AC4)", () => {
	it.each([
		"1234",
		"123456",
		"12345678",
	])("accepts valid %s-digit PIN", async (pin) => {
		const cli = createMockCLI({
			sendRPC: async (cmd) => {
				cli.state.rpcRequests.push(cmd);
				return { ok: true };
			},
		});

		await run(["--pin", pin], cli);

		const pinCmd = cli.state.rpcRequests[0];
		assert.exists(pinCmd, "expected pin command");
		expect(pinCmd._tag === "SetPin" && pinCmd.pin).toBe(pin);
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

	it("shows error when SetPin RPC fails", async () => {
		const cli = createMockCLI({
			sendRPC: async (cmd) => {
				cli.state.rpcRequests.push(cmd);
				throw new Error("PIN storage failed");
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
					sendRPC: async (cmd) => {
						cli.state.rpcRequests.push(cmd);
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

// Daemon-not-running error (shared across all commands)

it.each([
	["--status"],
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

describe("T6: --add/--remove/--list/--title (AC5)", () => {
	describe("--add", () => {
		it("sends AddProject with resolved path", async () => {
			const cli = createMockCLI({
				sendRPC: async (cmd) => {
					cli.state.rpcRequests.push(cmd);
					if (cmd._tag === "AddProject") {
						return { addedSlug: "test-project" };
					}
					return { ok: true };
				},
			});

			await run(["--add", "/tmp/test-project"], cli);

			const addCmd = cli.state.rpcRequests.find((c) => c._tag === "AddProject");
			expect(addCmd).toBeDefined();
			assert.exists(addCmd, "expected add command");
			expect(addCmd.directory).toBe("/tmp/test-project");
			expect(cli.state.output).toBe("Project added: test-project\n");
		});

		it("uses cwd when --add has no path", async () => {
			const cli = createMockCLI({
				sendRPC: async (cmd) => {
					cli.state.rpcRequests.push(cmd);
					if (cmd._tag === "GetProjects") {
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
					if (cmd._tag === "RemoveProject") {
						return { ok: true };
					}
					return { ok: true };
				},
			});

			await run(["--remove"], cli);

			const removeCmd = cli.state.rpcRequests.find(
				(c) => c._tag === "RemoveProject",
			);
			expect(removeCmd).toBeDefined();
			assert.exists(removeCmd, "expected remove command");
			expect(removeCmd.slug).toBe("my-project");
			expect(cli.state.output).toContain("Project removed");
		});

		it("shows error when cwd is not registered", async () => {
			const cli = createMockCLI({
				sendRPC: async (cmd) => {
					cli.state.rpcRequests.push(cmd);
					if (cmd._tag === "GetProjects") {
						return { projects: [] };
					}
					return { ok: true };
				},
			});

			await run(["--remove"], cli);

			expect(cli.state.errors).toContain("not registered");
			expect(cli.state.exitCode).toBe(1);
		});

		it("shows error when GetProjects RPC fails in --remove", async () => {
			const cli = createMockCLI({
				sendRPC: async (cmd) => {
					cli.state.rpcRequests.push(cmd);
					throw new Error("db locked");
				},
			});

			await run(["--remove"], cli);

			expect(cli.state.errors).toContain("Failed to list");
			expect(cli.state.exitCode).toBe(1);
		});

		it("shows error when RemoveProject RPC fails", async () => {
			const cli = createMockCLI({
				sendRPC: async (cmd) => {
					cli.state.rpcRequests.push(cmd);
					if (cmd._tag === "GetProjects") {
						return {
							ok: true,
							projects: [
								{
									slug: "my-project",
									directory: "/home/user/my-project",
									title: "",
								},
							],
						};
					}
					if (cmd._tag === "RemoveProject") {
						throw new Error("permission denied");
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
		it("sends GetProjects and displays results", async () => {
			const cli = createMockCLI({
				sendRPC: async (cmd) => {
					cli.state.rpcRequests.push(cmd);
					if (cmd._tag === "GetProjects") {
						return {
							ok: true,
							projects: [
								{
									slug: "proj-a",
									directory: "/home/user/proj-a",
									title: "Project A",
								},
								{ slug: "proj-b", directory: "/home/user/proj-b", title: "" },
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
				sendRPC: async () => ({ projects: [] }),
			});

			await run(["--list"], cli);

			expect(cli.state.output).toContain("No projects registered");
		});
	});

	describe("--title", () => {
		it("sends GetProjects then RenameProject", async () => {
			const cli = createMockCLI({
				sendRPC: async (cmd) => {
					cli.state.rpcRequests.push(cmd);
					if (cmd._tag === "GetProjects") {
						return {
							ok: true,
							projects: [
								{
									slug: "my-project",
									directory: "/home/user/my-project",
									title: "",
								},
							],
						};
					}
					if (cmd._tag === "RenameProject") {
						return { ok: true };
					}
					return { ok: true };
				},
			});

			await run(["--title", "New Title"], cli);

			const titleCmd = cli.state.rpcRequests.find(
				(c) => c._tag === "RenameProject",
			);
			expect(titleCmd).toBeDefined();
			assert.exists(titleCmd, "expected title command");
			expect(titleCmd.slug).toBe("my-project");
			expect(titleCmd.title).toBe("New Title");
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
				sendRPC: async (cmd) => {
					cli.state.rpcRequests.push(cmd);
					if (cmd._tag === "GetProjects") {
						return { projects: [] };
					}
					return { ok: true };
				},
			});

			await run(["--title", "Test"], cli);

			expect(cli.state.errors).toContain("not registered");
			expect(cli.state.exitCode).toBe(1);
		});

		it("shows error when GetProjects RPC fails in --title", async () => {
			const cli = createMockCLI({
				sendRPC: async (cmd) => {
					cli.state.rpcRequests.push(cmd);
					throw new Error("db locked");
				},
			});

			await run(["--title", "Test"], cli);

			expect(cli.state.errors).toContain("Failed to list");
			expect(cli.state.exitCode).toBe(1);
		});

		it("shows error when RenameProject RPC fails", async () => {
			const cli = createMockCLI({
				sendRPC: async (cmd) => {
					cli.state.rpcRequests.push(cmd);
					if (cmd._tag === "GetProjects") {
						return {
							ok: true,
							projects: [
								{
									slug: "my-project",
									directory: "/home/user/my-project",
									title: "",
								},
							],
						};
					}
					if (cmd._tag === "RenameProject") {
						throw new Error("title too long");
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

describe("T7: --port/--oc-port passed through (AC6)", () => {
	it("custom port is used in URL", async () => {
		const cli = createMockCLI({
			sendRPC: async (cmd) => {
				cli.state.rpcRequests.push(cmd);
				if (cmd._tag === "AddProject") return { addedSlug: "test" };
				return { ok: true };
			},
		});

		await run(["--port", "3000"], cli);

		expect(cli.state.output).toContain(":3000");
	});
});

describe("T8: Error handling (AC8)", () => {
	it("prints guidance when the server becomes unreachable before GetStatus", async () => {
		const cli = createMockCLI({
			sendRPC: async (cmd) => {
				if (cmd._tag === "AddProject") return { addedSlug: "project" };
				throw new Error("Connection refused");
			},
		});
		await run([], cli);
		expect(cli.state.errors).toBe(
			"Server is not running. Run conduit serve or conduit service install.\n",
		);
		expect(cli.state.exitCode).toBe(1);
	});

	it("handles RPC error in --status", async () => {
		const cli = createMockCLI({
			sendRPC: async () => {
				throw new WsRpcError({ message: "internal error" });
			},
		});

		await run(["--status"], cli);

		expect(cli.state.errors).toContain("internal error");
		expect(cli.state.exitCode).toBe(1);
	});

	it("handles RPC error in --add", async () => {
		const cli = createMockCLI({
			sendRPC: async () => {
				throw new Error("directory not found");
			},
		});

		await run(["--add", "/nonexistent"], cli);

		expect(cli.state.errors).toContain("directory not found");
		expect(cli.state.exitCode).toBe(1);
	});

	it("--list failure shows error", async () => {
		const cli = createMockCLI({
			sendRPC: async () => {
				throw new Error("something broke");
			},
		});

		await run(["--list"], cli);

		expect(cli.state.errors).toContain("Failed to list");
		expect(cli.state.exitCode).toBe(1);
	});
});

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
		expect(cli.state.output).toContain("--help");
	});

	it("does not exit or call RPC", async () => {
		const cli = createMockCLI();

		await run(["--help"], cli);

		expect(cli.state.exitCode).toBeNull();
		expect(cli.state.rpcRequests).toHaveLength(0);
	});

	it("displays new flags in help text", async () => {
		const cli = createMockCLI();

		await run(["--help"], cli);

		expect(cli.state.output).toContain("--no-https");
		expect(cli.state.output).toContain("--dangerously-skip-permissions");
	});
});

// T12: New flags (Ticket 8.15)

describe("T12: parseArgs — --no-https, --dangerously-skip-permissions", () => {
	it.each([
		["--no-https", "noHttps", true],
		["--dangerously-skip-permissions", "skipPerms", true],
	] as const)("%s sets %s to %s", (flag, field, expected) => {
		const args = parseArgs([flag]);
		expect(args[field]).toBe(expected);
	});

	it("new flags combined with existing flags", () => {
		const args = parseArgs(["--port", "3000", "--no-https"]);
		expect(args.port).toBe(3000);
		expect(args.noHttps).toBe(true);
		expect(args.command).toBe("default");
	});

	it("property: noHttps and skipPerms are always booleans", () => {
		fc.assert(
			fc.property(
				fc.array(fc.string({ minLength: 0, maxLength: 20 }), {
					minLength: 0,
					maxLength: 10,
				}),
				(argv) => {
					const args = parseArgs(argv);
					expect(typeof args.noHttps).toBe("boolean");
					expect(typeof args.skipPerms).toBe("boolean");
				},
			),
			{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
		);
	});
});

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
			sendRPC: async (cmd) => {
				cli.state.rpcRequests.push(cmd);
				return { ok: true };
			},
		});

		await run(["--dangerously-skip-permissions", "--pin", "1234"], cli);

		// --pin handler runs (PIN is valid, daemon is running) → "PIN updated"
		expect(cli.state.output).toContain("PIN updated");
		expect(cli.state.exitCode).toBeNull();
	});
});

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

	it("instance list sends GetInstances RPC", async () => {
		const cli = createMockCLI({
			sendRPC: async (cmd) => {
				cli.state.rpcRequests.push(cmd);
				return { instances: [] };
			},
		});
		await run(["--instance", "list"], cli);
		expect(cli.state.rpcRequests).toContainEqual({ _tag: "GetInstances" });
		expect(cli.state.output).toContain("No instances");
	});

	it("instance list displays instances", async () => {
		const cli = createMockCLI({
			sendRPC: async (cmd) => {
				cli.state.rpcRequests.push(cmd);
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

	it("instance add sends AddInstance RPC", async () => {
		const cli = createMockCLI({
			sendRPC: async (cmd) => {
				cli.state.rpcRequests.push(cmd);
				return { addedInstanceId: "instance-123", instances: [] };
			},
		});
		await run(
			["--instance", "add", "work", "--port", "4097", "--managed"],
			cli,
		);
		expect(cli.state.rpcRequests).toContainEqual(
			expect.objectContaining({ _tag: "AddInstance", name: "work" }),
		);
		expect(cli.state.output).toBe("Instance added: instance-123\n");
	});

	it("instance add without name shows error", async () => {
		const cli = createMockCLI();
		await run(["--instance", "add"], cli);
		expect(cli.state.errors).toContain("name is required");
		expect(cli.state.exitCode).toBe(1);
	});

	it.each([
		["remove", "RemoveInstance"],
		["start", "StartInstance"],
		["stop", "StopInstance"],
	] as const)("instance %s sends %s RPC", async (action, expectedTag) => {
		const cli = createMockCLI({
			sendRPC: async (cmd) => {
				cli.state.rpcRequests.push(cmd);
				return { ok: true };
			},
		});
		await run(["--instance", action, "work"], cli);
		expect(cli.state.rpcRequests).toContainEqual(
			expect.objectContaining({ _tag: expectedTag, instanceId: "work" }),
		);
	});

	it("instance status sends GetInstanceStatus RPC", async () => {
		const cli = createMockCLI({
			sendRPC: async (cmd) => {
				cli.state.rpcRequests.push(cmd);
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
		expect(cli.state.rpcRequests).toContainEqual(
			expect.objectContaining({
				_tag: "GetInstanceStatus",
				instanceId: "work",
			}),
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

	it("instance add with duplicate name reports error from RPC", async () => {
		const cli = createMockCLI({
			sendRPC: async (cmd) => {
				cli.state.rpcRequests.push(cmd);
				throw new Error('Instance "work" already exists');
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

	it("instance add with --url sends url in RPC command", async () => {
		const cli = createMockCLI({
			sendRPC: async (cmd) => {
				cli.state.rpcRequests.push(cmd);
				return { addedInstanceId: "ext", instances: [] };
			},
		});
		await run(["--instance", "add", "ext", "--url", "http://host:4096"], cli);
		expect(cli.state.rpcRequests).toContainEqual(
			expect.objectContaining({
				_tag: "AddInstance",
				name: "ext",
				url: "http://host:4096",
				managed: false,
			}),
		);
		expect(cli.state.output).toContain("Instance added");
	});

	it("instance add without --url sends undefined url in RPC command", async () => {
		const cli = createMockCLI({
			sendRPC: async (cmd) => {
				cli.state.rpcRequests.push(cmd);
				return { addedInstanceId: "work", instances: [] };
			},
		});
		await run(
			["--instance", "add", "work", "--port", "4097", "--managed"],
			cli,
		);
		const addCmd = cli.state.rpcRequests.find((c) => c._tag === "AddInstance");
		expect(addCmd).toBeDefined();
		assert.exists(addCmd, "expected add command");
		expect(addCmd.url).toBeUndefined();
	});
});

// These test the distinct branching in parseArgs for flags that accept
// a value (valid value, invalid value, missing value).

describe("T17-T20: --log-level, --log-format, --host", () => {
	it.each([
		"debug",
		"error",
		"warn",
		"verbose",
		"info",
	] as const)("--log-level %s sets logLevel", (level) => {
		expect(parseArgs(["--log-level", level]).logLevel).toBe(level);
	});

	const invalidLogLevelCases: Array<[string[], string]> = [
		[["--log-level", "trace"], "info"],
		[["--log-level"], "info"],
	];
	it.each(
		invalidLogLevelCases,
	)("--log-level rejects invalid/missing value: %j → %s", (argv, expected) => {
		expect(parseArgs(argv).logLevel).toBe(expected);
	});

	it.each([
		"json",
		"pretty",
	] as const)("--log-format %s sets logFormat", (fmt) => {
		expect(parseArgs(["--log-format", fmt]).logFormat).toBe(fmt);
	});

	const invalidLogFormatCases: Array<[string[]]> = [
		[["--log-format", "csv"]],
		[["--log-format"]],
	];
	it.each(
		invalidLogFormatCases,
	)("--log-format rejects invalid/missing value: %j", (argv) => {
		expect(parseArgs(argv).logFormat).toBeUndefined();
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
		]);
		expect(args.logLevel).toBe("debug");
		expect(args.logFormat).toBe("json");
		expect(args.host).toBe("0.0.0.0");
		expect(args.port).toBe(3000);
		expect(args.command).toBe("serve");
	});
});

describe("T21: HELP_TEXT documents all parseArgs flags (and vice versa)", () => {
	// Canonical list of all flags handled by the parseArgs switch statement.
	// When you add a new flag to parseArgs, add it here too — that's the
	// entire point of this test.
	const PARSED_FLAGS = [
		"--foreground",
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
		"--claude-config-dir",
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

	// Older installed services can still pass this hidden alias.
	const INTERNAL_FLAGS = new Set(["--foreground"]);

	// Short aliases are documented inline with their long form
	// (e.g. "-p, --port") so we check the long form covers them.
	const SHORT_ALIASES: Record<string, string> = {
		"-p": "--port",
		"-H": "--host",
		"-h": "--help",
	};

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

	for (const flag of INTERNAL_FLAGS) {
		it(`HELP_TEXT does not expose internal flag ${flag}`, () => {
			const asOptionLine = new RegExp(
				`^\\s+${flag.replace(/-/g, "\\-")}\\s`,
				"m",
			);
			expect(HELP_TEXT).not.toMatch(asOptionLine);
		});
	}
});
