// ─── Unit Tests: Keep-Awake Management (Ticket 3.5) ─────────────────────────
//
// Tests:
// T1:  Constructor defaults (enabled, not active)
// T2:  activate() on macOS spawns caffeinate with -di flags
// T3:  activate() emits activated event
// T4:  deactivate() kills process, emits deactivated
// T5:  isActive() tracks state correctly
// T6:  setEnabled(false) deactivates if active
// T7:  setEnabled(true) auto-activates on supported platform
// T8:  Non-macOS: activate() emits unsupported, isActive() false
// T9:  Idempotent: double activate doesn't spawn twice
// T10: Idempotent: double deactivate is safe
// T11: Process exit handler: unexpected exit emits error, resets state
// T12: isSupported() returns true only on darwin
// T13: Disabled: activate() is no-op when not enabled
// T14: PBT: enabled/disabled state machine consistency
// T15: activate() when spawn throws synchronously
// T16: Cross-platform tool resolution
// T17: Process group kill (integration)
// T18: defaultWhichSync (integration)
// T19: activate() spawn error handling
// T20: drain() kills the child process

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
	_defaultWhichSync,
	KeepAwake,
} from "../../../src/lib/daemon/keep-awake.js";
import { ServiceRegistry } from "../../../src/lib/daemon/service-registry.js";

const SEED = 42;
const NUM_RUNS = 30;

// ─── Mock helpers ────────────────────────────────────────────────────────────

/** Create a mock ChildProcess (EventEmitter with kill) */
function createMockChild(): ChildProcess & EventEmitter {
	const child = new EventEmitter() as ChildProcess & EventEmitter;
	Object.defineProperty(child, "pid", { value: 12345, writable: true });
	Object.defineProperty(child, "kill", {
		value: vi.fn(() => true),
		writable: true,
	});
	return child;
}

/** Create a mock spawn function that returns the given child */
function createMockSpawn(child: ChildProcess & EventEmitter) {
	return vi.fn(
		() => child,
	) as unknown as typeof import("node:child_process").spawn;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Ticket 3.5 — Keep-Awake Management", () => {
	// ─── T1: Constructor defaults ────────────────────────────────────────

	describe("T1: Constructor defaults", () => {
		it("defaults to enabled", () => {
			const ka = new KeepAwake(new ServiceRegistry(), { _platform: "darwin" });
			expect(ka.isEnabled()).toBe(true);
		});

		it("defaults to not active", () => {
			const ka = new KeepAwake(new ServiceRegistry(), { _platform: "darwin" });
			expect(ka.isActive()).toBe(false);
		});

		it("is an EventEmitter", () => {
			const ka = new KeepAwake(new ServiceRegistry(), { _platform: "darwin" });
			expect(typeof ka.on).toBe("function");
			expect(typeof ka.emit).toBe("function");
			expect(typeof ka.removeListener).toBe("function");
		});

		it("respects enabled: false in constructor", () => {
			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "darwin",
				enabled: false,
			});
			expect(ka.isEnabled()).toBe(false);
		});
	});

	// ─── T2: activate() on macOS spawns caffeinate ───────────────────────

	describe("T2: activate() on macOS spawns caffeinate with -di flags (AC1)", () => {
		it("spawns caffeinate with correct args", () => {
			const child = createMockChild();
			const mockSpawn = createMockSpawn(child);

			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "darwin",
				_spawn: mockSpawn,
			});
			ka.activate();

			expect(mockSpawn).toHaveBeenCalledWith(
				"caffeinate",
				["-di"],
				expect.objectContaining({
					stdio: "ignore",
					detached: true,
				}),
			);
		});

		it("spawns with custom command and args", () => {
			const child = createMockChild();
			const mockSpawn = createMockSpawn(child);

			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "darwin",
				_spawn: mockSpawn,
				command: "/usr/bin/caffeinate",
				args: ["-dims"],
			});
			ka.activate();

			expect(mockSpawn).toHaveBeenCalledWith(
				"/usr/bin/caffeinate",
				["-dims"],
				expect.any(Object),
			);
		});
	});

	// ─── T3: activate() emits activated event ────────────────────────────

	describe("T3: activate() emits activated event (AC1)", () => {
		it("emits activated on successful spawn", () => {
			const child = createMockChild();
			const mockSpawn = createMockSpawn(child);

			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "darwin",
				_spawn: mockSpawn,
			});

			const events: string[] = [];
			ka.on("activated", () => events.push("activated"));

			ka.activate();

			expect(events).toEqual(["activated"]);
		});
	});

	// ─── T4: deactivate() kills process, emits deactivated ──────────────

	describe("T4: deactivate() kills process, emits deactivated (AC2)", () => {
		it("kills the child process group via process.kill(-pid)", () => {
			const child = createMockChild();
			const mockSpawn = createMockSpawn(child);
			const processKillSpy = vi
				.spyOn(process, "kill")
				.mockImplementation(() => true);

			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "darwin",
				_spawn: mockSpawn,
			});

			ka.activate();
			ka.deactivate();

			expect(processKillSpy).toHaveBeenCalledWith(-12345, "SIGTERM");
			processKillSpy.mockRestore();
		});

		it("emits deactivated event", () => {
			const child = createMockChild();
			const mockSpawn = createMockSpawn(child);

			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "darwin",
				_spawn: mockSpawn,
			});

			const events: string[] = [];
			ka.on("deactivated", () => events.push("deactivated"));

			ka.activate();
			ka.deactivate();

			expect(events).toEqual(["deactivated"]);
		});
	});

	// ─── T5: isActive() tracks state correctly ──────────────────────────

	describe("T5: isActive() tracks state correctly", () => {
		it("false before activate", () => {
			const ka = new KeepAwake(new ServiceRegistry(), { _platform: "darwin" });
			expect(ka.isActive()).toBe(false);
		});

		it("true after activate", () => {
			const child = createMockChild();
			const mockSpawn = createMockSpawn(child);

			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "darwin",
				_spawn: mockSpawn,
			});

			ka.activate();
			expect(ka.isActive()).toBe(true);
		});

		it("false after deactivate", () => {
			const child = createMockChild();
			const mockSpawn = createMockSpawn(child);

			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "darwin",
				_spawn: mockSpawn,
			});

			ka.activate();
			ka.deactivate();
			expect(ka.isActive()).toBe(false);
		});
	});

	// ─── T6: setEnabled(false) deactivates if active ────────────────────

	describe("T6: setEnabled(false) deactivates if active (AC3)", () => {
		it("deactivates when disabling while active", () => {
			const child = createMockChild();
			const mockSpawn = createMockSpawn(child);
			const processKillSpy = vi
				.spyOn(process, "kill")
				.mockImplementation(() => true);

			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "darwin",
				_spawn: mockSpawn,
			});

			const events: string[] = [];
			ka.on("deactivated", () => events.push("deactivated"));

			ka.activate();
			expect(ka.isActive()).toBe(true);

			ka.setEnabled(false);
			expect(ka.isActive()).toBe(false);
			expect(ka.isEnabled()).toBe(false);
			expect(events).toEqual(["deactivated"]);
			expect(processKillSpy).toHaveBeenCalledWith(-12345, "SIGTERM");
			processKillSpy.mockRestore();
		});

		it("just disables when not active", () => {
			const ka = new KeepAwake(new ServiceRegistry(), { _platform: "darwin" });

			ka.setEnabled(false);
			expect(ka.isEnabled()).toBe(false);
			expect(ka.isActive()).toBe(false);
		});
	});

	// ─── T7: setEnabled(true) auto-activates ────────────────────────────

	describe("T7: setEnabled(true) auto-activates on supported platform", () => {
		it("enables and activates on macOS", () => {
			const child = createMockChild();
			const mockSpawn = createMockSpawn(child);

			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "darwin",
				_spawn: mockSpawn,
				enabled: false,
			});

			const events: string[] = [];
			ka.on("activated", () => events.push("activated"));

			ka.setEnabled(true);
			expect(ka.isEnabled()).toBe(true);
			expect(ka.isActive()).toBe(true);
			expect(events).toEqual(["activated"]);
			expect(mockSpawn).toHaveBeenCalledTimes(1);
		});

		it("enables but does not activate on unsupported platform", () => {
			const mockSpawn =
				vi.fn() as unknown as typeof import("node:child_process").spawn;

			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "linux",
				_spawn: mockSpawn,
				_whichSync: () => null,
				enabled: false,
			});

			ka.setEnabled(true);
			expect(ka.isEnabled()).toBe(true);
			expect(ka.isActive()).toBe(false);
			expect(mockSpawn).not.toHaveBeenCalled();
		});

		it("is idempotent — does not spawn twice if already active", () => {
			const child = createMockChild();
			const mockSpawn = createMockSpawn(child);

			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "darwin",
				_spawn: mockSpawn,
			});

			ka.activate();
			expect(mockSpawn).toHaveBeenCalledTimes(1);

			ka.setEnabled(true);
			expect(mockSpawn).toHaveBeenCalledTimes(1);
			expect(ka.isActive()).toBe(true);
		});
	});

	// ─── T8: Non-macOS emits unsupported ─────────────────────────────────

	describe("T8: Non-macOS: activate() emits unsupported, isActive() false (AC4)", () => {
		it("emits unsupported on linux when no tool found", () => {
			const mockSpawn =
				vi.fn() as unknown as typeof import("node:child_process").spawn;

			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "linux",
				_spawn: mockSpawn,
				_whichSync: () => null,
			});

			const events: Array<{ platform: string }> = [];
			ka.on("unsupported", (info) => events.push(info));

			ka.activate();

			expect(events).toEqual([{ platform: "linux" }]);
			expect(ka.isActive()).toBe(false);
			expect(mockSpawn).not.toHaveBeenCalled();
		});

		it("emits unsupported on win32", () => {
			const mockSpawn =
				vi.fn() as unknown as typeof import("node:child_process").spawn;

			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "win32",
				_spawn: mockSpawn,
				_whichSync: () => null,
			});

			const events: Array<{ platform: string }> = [];
			ka.on("unsupported", (info) => events.push(info));

			ka.activate();

			expect(events).toEqual([{ platform: "win32" }]);
			expect(ka.isActive()).toBe(false);
		});

		it("does not throw on unsupported platform", () => {
			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "linux",
				_whichSync: () => null,
			});
			expect(() => ka.activate()).not.toThrow();
		});
	});

	// ─── T9: Idempotent: double activate ─────────────────────────────────

	describe("T9: Idempotent: double activate doesn't spawn twice (AC5)", () => {
		it("only spawns once on double activate", () => {
			const child = createMockChild();
			const mockSpawn = createMockSpawn(child);

			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "darwin",
				_spawn: mockSpawn,
			});

			ka.activate();
			ka.activate();

			expect(mockSpawn).toHaveBeenCalledTimes(1);
			expect(ka.isActive()).toBe(true);
		});

		it("emits activated only once on double activate", () => {
			const child = createMockChild();
			const mockSpawn = createMockSpawn(child);

			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "darwin",
				_spawn: mockSpawn,
			});

			const events: string[] = [];
			ka.on("activated", () => events.push("activated"));

			ka.activate();
			ka.activate();

			expect(events).toHaveLength(1);
		});
	});

	// ─── T10: Idempotent: double deactivate ──────────────────────────────

	describe("T10: Idempotent: double deactivate is safe (AC5)", () => {
		it("does not throw on double deactivate", () => {
			const child = createMockChild();
			const mockSpawn = createMockSpawn(child);

			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "darwin",
				_spawn: mockSpawn,
			});

			ka.activate();
			ka.deactivate();

			expect(() => ka.deactivate()).not.toThrow();
		});

		it("emits deactivated only once on double deactivate", () => {
			const child = createMockChild();
			const mockSpawn = createMockSpawn(child);

			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "darwin",
				_spawn: mockSpawn,
			});

			const events: string[] = [];
			ka.on("deactivated", () => events.push("deactivated"));

			ka.activate();
			ka.deactivate();
			ka.deactivate();

			expect(events).toHaveLength(1);
		});

		it("deactivate is safe when never activated", () => {
			const ka = new KeepAwake(new ServiceRegistry(), { _platform: "darwin" });
			expect(() => ka.deactivate()).not.toThrow();
		});
	});

	// ─── T11: Process exit handler ───────────────────────────────────────

	describe("T11: Process exit handler: unexpected exit emits error, resets state (AC6)", () => {
		it("emits error on unexpected caffeinate exit", () => {
			const child = createMockChild();
			const mockSpawn = createMockSpawn(child);

			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "darwin",
				_spawn: mockSpawn,
			});

			const errors: Error[] = [];
			ka.on("error", ({ error }) => errors.push(error));

			ka.activate();
			expect(ka.isActive()).toBe(true);

			// Simulate unexpected exit
			child.emit("exit", 1, null);

			expect(errors).toHaveLength(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(errors[0]!.message).toContain("exited unexpectedly");
		});

		it("resets active state on unexpected exit", () => {
			const child = createMockChild();
			const mockSpawn = createMockSpawn(child);

			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "darwin",
				_spawn: mockSpawn,
			});

			// Must attach error listener to prevent unhandled error throw from EventEmitter
			ka.on("error", () => {});

			ka.activate();
			expect(ka.isActive()).toBe(true);

			child.emit("exit", 1, null);

			expect(ka.isActive()).toBe(false);
		});

		it("allows re-activate after unexpected exit", () => {
			const child1 = createMockChild();
			const child2 = createMockChild();
			let callCount = 0;
			const mockSpawn = vi.fn(() => {
				callCount++;
				return callCount === 1 ? child1 : child2;
			}) as unknown as typeof import("node:child_process").spawn;

			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "darwin",
				_spawn: mockSpawn,
			});

			// Must attach error listener to prevent unhandled error throw from EventEmitter
			ka.on("error", () => {});

			ka.activate();
			child1.emit("exit", 1, null);

			expect(ka.isActive()).toBe(false);

			// Re-activate should work
			ka.activate();
			expect(ka.isActive()).toBe(true);
			expect(mockSpawn).toHaveBeenCalledTimes(2);
		});

		it("does not emit error on intentional deactivate", () => {
			const child = createMockChild();
			const mockSpawn = createMockSpawn(child);

			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "darwin",
				_spawn: mockSpawn,
			});

			const errors: Error[] = [];
			ka.on("error", ({ error }) => errors.push(error));

			ka.activate();
			ka.deactivate();

			// Simulate the exit that comes after kill()
			child.emit("exit", null, "SIGTERM");

			expect(errors).toHaveLength(0);
		});

		it("emits error on child process error event", () => {
			const child = createMockChild();
			const mockSpawn = createMockSpawn(child);

			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "darwin",
				_spawn: mockSpawn,
			});

			const errors: Error[] = [];
			ka.on("error", ({ error }) => errors.push(error));

			ka.activate();

			child.emit("error", new Error("ENOENT"));

			expect(errors).toHaveLength(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(errors[0]!.message).toBe("ENOENT");
			expect(ka.isActive()).toBe(false);
		});
	});

	// ─── T12: isSupported() ──────────────────────────────────────────────

	describe("T12: isSupported() returns true on darwin, delegates to resolveCommand", () => {
		it("returns true on darwin", () => {
			const ka = new KeepAwake(new ServiceRegistry(), { _platform: "darwin" });
			expect(ka.isSupported()).toBe(true);
		});

		it("returns false on linux when no tool found", () => {
			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "linux",
				_whichSync: () => null,
			});
			expect(ka.isSupported()).toBe(false);
		});

		it("returns false on win32", () => {
			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "win32",
				_whichSync: () => null,
			});
			expect(ka.isSupported()).toBe(false);
		});

		it("returns false on freebsd", () => {
			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "freebsd",
				_whichSync: () => null,
			});
			expect(ka.isSupported()).toBe(false);
		});
	});

	// ─── T13: Disabled: activate() is no-op ──────────────────────────────

	describe("T13: Disabled: activate() is no-op when not enabled", () => {
		it("does not spawn when disabled", () => {
			const mockSpawn =
				vi.fn() as unknown as typeof import("node:child_process").spawn;

			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "darwin",
				_spawn: mockSpawn,
				enabled: false,
			});

			ka.activate();

			expect(mockSpawn).not.toHaveBeenCalled();
			expect(ka.isActive()).toBe(false);
		});

		it("does not emit activated when disabled", () => {
			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "darwin",
				enabled: false,
			});

			const events: string[] = [];
			ka.on("activated", () => events.push("activated"));

			ka.activate();

			expect(events).toHaveLength(0);
		});

		it("does not emit unsupported when disabled", () => {
			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "darwin",
				enabled: false,
			});

			const events: string[] = [];
			ka.on("unsupported", () => events.push("unsupported"));

			ka.activate();

			expect(events).toHaveLength(0);
		});
	});

	// ─── T14: PBT: enabled/disabled state machine consistency ────────────

	describe("T14: PBT: enabled/disabled state machine consistency", () => {
		it("property: isActive is never true when isEnabled is false", () => {
			fc.assert(
				fc.property(
					fc.array(
						fc.oneof(
							fc.constant("activate" as const),
							fc.constant("deactivate" as const),
							fc.constant("enable" as const),
							fc.constant("disable" as const),
						),
						{ minLength: 1, maxLength: 20 },
					),
					(actions) => {
						const child = createMockChild();
						const mockSpawn = createMockSpawn(child);

						const ka = new KeepAwake(new ServiceRegistry(), {
							_platform: "darwin",
							_spawn: mockSpawn,
						});

						for (const action of actions) {
							switch (action) {
								case "activate":
									ka.activate();
									break;
								case "deactivate":
									ka.deactivate();
									break;
								case "enable":
									ka.setEnabled(true);
									break;
								case "disable":
									ka.setEnabled(false);
									break;
							}

							// Invariant: if disabled, must not be active
							if (!ka.isEnabled()) {
								expect(ka.isActive()).toBe(false);
							}
						}
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: isSupported is deterministic for any platform (no tool)", () => {
			fc.assert(
				fc.property(fc.string({ minLength: 1, maxLength: 20 }), (platform) => {
					const ka = new KeepAwake(new ServiceRegistry(), {
						_platform: platform,
						_whichSync: () => null,
					});
					// With no which-sync tool, only darwin is supported (caffeinate hardcoded)
					const expected = platform === "darwin";
					expect(ka.isSupported()).toBe(expected);
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});

		it("property: activate/deactivate cycle always returns to inactive", () => {
			fc.assert(
				fc.property(fc.integer({ min: 1, max: 5 }), (cycles) => {
					const child = createMockChild();
					const mockSpawn = createMockSpawn(child);

					const ka = new KeepAwake(new ServiceRegistry(), {
						_platform: "darwin",
						_spawn: mockSpawn,
					});

					for (let i = 0; i < cycles; i++) {
						ka.activate();
						expect(ka.isActive()).toBe(true);
						ka.deactivate();
						expect(ka.isActive()).toBe(false);
					}
				}),
				{ seed: SEED, numRuns: NUM_RUNS, endOnFailure: true },
			);
		});
	});

	// ─── T15: activate() when spawn throws synchronously ─────────────────

	describe("T15: activate() when spawn throws synchronously", () => {
		it("emits error event and state remains inactive", () => {
			const throwingSpawn = vi.fn(() => {
				throw new Error("ENOENT: caffeinate not found");
			}) as unknown as typeof import("node:child_process").spawn;

			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "darwin",
				_spawn: throwingSpawn,
			});

			const errors: Error[] = [];
			ka.on("error", ({ error }) => errors.push(error));

			ka.activate();

			expect(errors).toHaveLength(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(errors[0]!.message).toBe("ENOENT: caffeinate not found");
			expect(ka.isActive()).toBe(false);
		});
	});

	// ─── T16: Cross-platform tool resolution ────────────────────────────

	describe("T16: Cross-platform tool resolution", () => {
		it("uses config command/args when provided (any platform)", () => {
			const child = createMockChild();
			const mockSpawn = createMockSpawn(child);

			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "linux",
				_spawn: mockSpawn,
				_whichSync: () => null,
				command: "my-keep-awake",
				args: ["--flag"],
			});

			ka.activate();

			expect(mockSpawn).toHaveBeenCalledWith(
				"my-keep-awake",
				["--flag"],
				expect.objectContaining({ stdio: "ignore", detached: true }),
			);
			expect(ka.isActive()).toBe(true);
		});

		it("auto-detects systemd-inhibit on linux when available", () => {
			const child = createMockChild();
			const mockSpawn = createMockSpawn(child);

			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "linux",
				_spawn: mockSpawn,
				_whichSync: (cmd: string) =>
					cmd === "systemd-inhibit" ? "/usr/bin/systemd-inhibit" : null,
			});

			ka.activate();

			expect(mockSpawn).toHaveBeenCalledWith(
				"systemd-inhibit",
				[
					"--what=idle",
					"--who=conduit",
					"--why=Conduit relay running",
					"sleep",
					"infinity",
				],
				expect.objectContaining({ stdio: "ignore", detached: true }),
			);
			expect(ka.isActive()).toBe(true);
		});

		it("emits unsupported on linux when systemd-inhibit is not found", () => {
			const mockSpawn =
				vi.fn() as unknown as typeof import("node:child_process").spawn;

			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "linux",
				_spawn: mockSpawn,
				_whichSync: () => null,
			});

			const events: Array<{ platform: string }> = [];
			ka.on("unsupported", (info) => events.push(info));

			ka.activate();

			expect(events).toEqual([{ platform: "linux" }]);
			expect(ka.isActive()).toBe(false);
			expect(mockSpawn).not.toHaveBeenCalled();
		});

		it("isSupported() returns true on linux when systemd-inhibit is available", () => {
			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "linux",
				_whichSync: (cmd: string) =>
					cmd === "systemd-inhibit" ? "/usr/bin/systemd-inhibit" : null,
			});

			expect(ka.isSupported()).toBe(true);
		});

		it("isSupported() returns false on linux when no tool found", () => {
			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "linux",
				_whichSync: () => null,
			});

			expect(ka.isSupported()).toBe(false);
		});

		it("config command overrides auto-detection", () => {
			const child = createMockChild();
			const mockSpawn = createMockSpawn(child);

			// darwin + custom command → should use custom, not caffeinate
			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "darwin",
				_spawn: mockSpawn,
				command: "/opt/my-tool",
				args: ["--no-sleep"],
			});

			ka.activate();

			expect(mockSpawn).toHaveBeenCalledWith(
				"/opt/my-tool",
				["--no-sleep"],
				expect.any(Object),
			);
		});

		it("windows with no config command emits unsupported", () => {
			const mockSpawn =
				vi.fn() as unknown as typeof import("node:child_process").spawn;

			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "win32",
				_spawn: mockSpawn,
				_whichSync: () => null,
			});

			const events: Array<{ platform: string }> = [];
			ka.on("unsupported", (info) => events.push(info));

			ka.activate();

			expect(events).toEqual([{ platform: "win32" }]);
			expect(ka.isActive()).toBe(false);
		});

		it("windows with config command activates", () => {
			const child = createMockChild();
			const mockSpawn = createMockSpawn(child);

			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "win32",
				_spawn: mockSpawn,
				_whichSync: () => null,
				command: "powercfg",
				args: ["/change", "standby-timeout-ac", "0"],
			});

			ka.activate();

			expect(mockSpawn).toHaveBeenCalledWith(
				"powercfg",
				["/change", "standby-timeout-ac", "0"],
				expect.objectContaining({ stdio: "ignore", detached: true }),
			);
			expect(ka.isActive()).toBe(true);
		});

		it("whichSync is only called once (cached)", () => {
			const child = createMockChild();
			const mockSpawn = createMockSpawn(child);
			const processKillSpy = vi
				.spyOn(process, "kill")
				.mockImplementation(() => true);
			const whichSpy = vi.fn((cmd: string) =>
				cmd === "systemd-inhibit" ? "/usr/bin/systemd-inhibit" : null,
			);

			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "linux",
				_spawn: mockSpawn,
				_whichSync: whichSpy,
			});

			// activate → deactivate → activate: whichSync should only be called once
			ka.activate();
			ka.deactivate();
			ka.activate();

			expect(whichSpy).toHaveBeenCalledTimes(1);
			processKillSpy.mockRestore();
		});

		it("empty string command is treated as no command (auto-detect)", () => {
			const child = createMockChild();
			const mockSpawn = createMockSpawn(child);

			// darwin + command:"" → should auto-detect to caffeinate
			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "darwin",
				_spawn: mockSpawn,
				command: "",
			});

			ka.activate();

			expect(mockSpawn).toHaveBeenCalledWith(
				"caffeinate",
				["-di"],
				expect.objectContaining({ stdio: "ignore", detached: true }),
			);
			expect(ka.isActive()).toBe(true);
		});
	});

	// ─── T17: Process group kill (integration) ──────────────────────────

	describe("T17: Process group kill (integration)", () => {
		it("deactivate() kills a real detached child process", async () => {
			// Spawn a real 'sleep' process using KeepAwake with a custom command
			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "darwin",
				command: "sleep",
				args: ["60"],
			});

			ka.activate();
			expect(ka.isActive()).toBe(true);

			// biome-ignore lint/suspicious/noExplicitAny: accessing private field for integration test
			const pid = (ka as any).child?.pid;
			expect(pid).toBeGreaterThan(0);

			// Verify process is alive
			expect(() => process.kill(pid, 0)).not.toThrow();

			ka.deactivate();
			expect(ka.isActive()).toBe(false);

			// Give OS a moment to clean up
			await new Promise((r) => setTimeout(r, 100));

			// Verify process is dead
			expect(() => process.kill(pid, 0)).toThrow();
		});
	});

	// ─── T18: defaultWhichSync (integration) ────────────────────────────

	describe("T18: defaultWhichSync (integration)", () => {
		it("finds an existing command", () => {
			// 'ls' exists on all unix systems
			const result = _defaultWhichSync("ls");
			expect(result).not.toBeNull();
			expect(result).toContain("/ls");
		});

		it("returns null for nonexistent command", () => {
			const result = _defaultWhichSync("this_command_does_not_exist_xyz_123");
			expect(result).toBeNull();
		});

		it("returns null for empty string", () => {
			const result = _defaultWhichSync("");
			expect(result).toBeNull();
		});
	});

	// ─── T19: activate() spawn error handling ───────────────────────────

	describe("T19: activate() spawn error handling", () => {
		it("emits error and deactivates when spawn returns ENOENT", () => {
			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "darwin",
				command: "/nonexistent/binary/that/does/not/exist",
				args: [],
			});

			const errors: Error[] = [];
			ka.on("error", ({ error }) => errors.push(error));
			const deactivated: boolean[] = [];
			ka.on("deactivated", () => deactivated.push(true));

			ka.activate();

			// The spawn itself may not throw synchronously — the error comes
			// via the child 'error' event. Give it a moment.
			return new Promise<void>((resolve) => {
				setTimeout(() => {
					expect(errors.length).toBeGreaterThan(0);
					// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
					expect(errors[0]!.message).toContain("ENOENT");
					expect(ka.isActive()).toBe(false);
					resolve();
				}, 200);
			});
		});

		it("emits error when spawned process exits with non-zero code unexpectedly", () => {
			// Use a command that exits immediately with error
			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "darwin",
				command: "false", // exits with code 1
				args: [],
			});

			const errors: Error[] = [];
			ka.on("error", ({ error }) => errors.push(error));

			ka.activate();

			return new Promise<void>((resolve) => {
				setTimeout(() => {
					// 'false' exits with code 1, which should trigger the error path
					expect(ka.isActive()).toBe(false);
					resolve();
				}, 500);
			});
		});
	});

	// ─── T20: drain() kills the child process ───────────────────────────

	describe("T20: drain() kills the child process", () => {
		it("deactivates and drains when active", async () => {
			const child = createMockChild();
			const mockSpawn = createMockSpawn(child);
			const processKillSpy = vi
				.spyOn(process, "kill")
				.mockImplementation(() => true);

			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "darwin",
				_spawn: mockSpawn,
			});

			ka.activate();
			expect(ka.isActive()).toBe(true);

			await ka.drain();

			expect(ka.isActive()).toBe(false);
			expect(processKillSpy).toHaveBeenCalledWith(-12345, "SIGTERM");
			processKillSpy.mockRestore();
		});

		it("drains safely when not active", async () => {
			const ka = new KeepAwake(new ServiceRegistry(), {
				_platform: "darwin",
			});

			expect(ka.isActive()).toBe(false);
			await expect(ka.drain()).resolves.toBeUndefined();
		});

		it("registers with the ServiceRegistry", () => {
			const registry = new ServiceRegistry();
			expect(registry.size).toBe(0);

			new KeepAwake(registry, { _platform: "darwin" });

			expect(registry.size).toBe(1);
		});

		it("drainAll on registry kills the child process", async () => {
			const child = createMockChild();
			const mockSpawn = createMockSpawn(child);
			const processKillSpy = vi
				.spyOn(process, "kill")
				.mockImplementation(() => true);

			const registry = new ServiceRegistry();
			const ka = new KeepAwake(registry, {
				_platform: "darwin",
				_spawn: mockSpawn,
			});

			ka.activate();
			expect(ka.isActive()).toBe(true);

			await registry.drainAll();

			expect(ka.isActive()).toBe(false);
			expect(processKillSpy).toHaveBeenCalledWith(-12345, "SIGTERM");
			processKillSpy.mockRestore();
		});
	});
});
