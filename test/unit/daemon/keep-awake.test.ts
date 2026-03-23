// ─── Unit Tests: Keep-Awake Management (Ticket 3.5) ─────────────────────────
//
// Tests:
// T1:  Constructor defaults (enabled, not active)
// T2:  activate() on macOS spawns caffeinate with -di flags
// T3:  activate() emits activated event
// T4:  deactivate() kills process, emits deactivated
// T5:  isActive() tracks state correctly
// T6:  setEnabled(false) deactivates if active
// T7:  setEnabled(true) doesn't auto-activate
// T8:  Non-macOS: activate() emits unsupported, isActive() false
// T9:  Idempotent: double activate doesn't spawn twice
// T10: Idempotent: double deactivate is safe
// T11: Process exit handler: unexpected exit emits error, resets state
// T12: isSupported() returns true only on darwin
// T13: Disabled: activate() is no-op when not enabled
// T14: PBT: enabled/disabled state machine consistency
// T15: activate() when spawn throws synchronously

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { KeepAwake } from "../../../src/lib/daemon/keep-awake.js";

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
			const ka = new KeepAwake({ _platform: "darwin" });
			expect(ka.isEnabled()).toBe(true);
		});

		it("defaults to not active", () => {
			const ka = new KeepAwake({ _platform: "darwin" });
			expect(ka.isActive()).toBe(false);
		});

		it("is an EventEmitter", () => {
			const ka = new KeepAwake({ _platform: "darwin" });
			expect(typeof ka.on).toBe("function");
			expect(typeof ka.emit).toBe("function");
			expect(typeof ka.removeListener).toBe("function");
		});

		it("respects enabled: false in constructor", () => {
			const ka = new KeepAwake({ _platform: "darwin", enabled: false });
			expect(ka.isEnabled()).toBe(false);
		});
	});

	// ─── T2: activate() on macOS spawns caffeinate ───────────────────────

	describe("T2: activate() on macOS spawns caffeinate with -di flags (AC1)", () => {
		it("spawns caffeinate with correct args", () => {
			const child = createMockChild();
			const mockSpawn = createMockSpawn(child);

			const ka = new KeepAwake({
				_platform: "darwin",
				_spawn: mockSpawn,
			});
			ka.activate();

			expect(mockSpawn).toHaveBeenCalledWith(
				"caffeinate",
				["-di"],
				expect.objectContaining({
					stdio: "ignore",
					detached: false,
				}),
			);
		});

		it("spawns with custom command and args", () => {
			const child = createMockChild();
			const mockSpawn = createMockSpawn(child);

			const ka = new KeepAwake({
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

			const ka = new KeepAwake({
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
		it("kills the child process", () => {
			const child = createMockChild();
			const mockSpawn = createMockSpawn(child);

			const ka = new KeepAwake({
				_platform: "darwin",
				_spawn: mockSpawn,
			});

			ka.activate();
			ka.deactivate();

			expect(child.kill).toHaveBeenCalled();
		});

		it("emits deactivated event", () => {
			const child = createMockChild();
			const mockSpawn = createMockSpawn(child);

			const ka = new KeepAwake({
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
			const ka = new KeepAwake({ _platform: "darwin" });
			expect(ka.isActive()).toBe(false);
		});

		it("true after activate", () => {
			const child = createMockChild();
			const mockSpawn = createMockSpawn(child);

			const ka = new KeepAwake({
				_platform: "darwin",
				_spawn: mockSpawn,
			});

			ka.activate();
			expect(ka.isActive()).toBe(true);
		});

		it("false after deactivate", () => {
			const child = createMockChild();
			const mockSpawn = createMockSpawn(child);

			const ka = new KeepAwake({
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

			const ka = new KeepAwake({
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
			expect(child.kill).toHaveBeenCalled();
		});

		it("just disables when not active", () => {
			const ka = new KeepAwake({ _platform: "darwin" });

			ka.setEnabled(false);
			expect(ka.isEnabled()).toBe(false);
			expect(ka.isActive()).toBe(false);
		});
	});

	// ─── T7: setEnabled(true) doesn't auto-activate ─────────────────────

	describe("T7: setEnabled(true) doesn't auto-activate (AC3)", () => {
		it("enables but does not activate", () => {
			const ka = new KeepAwake({
				_platform: "darwin",
				enabled: false,
			});

			const events: string[] = [];
			ka.on("activated", () => events.push("activated"));

			ka.setEnabled(true);
			expect(ka.isEnabled()).toBe(true);
			expect(ka.isActive()).toBe(false);
			expect(events).toHaveLength(0);
		});
	});

	// ─── T8: Non-macOS emits unsupported ─────────────────────────────────

	describe("T8: Non-macOS: activate() emits unsupported, isActive() false (AC4)", () => {
		it("emits unsupported on linux", () => {
			const mockSpawn =
				vi.fn() as unknown as typeof import("node:child_process").spawn;

			const ka = new KeepAwake({
				_platform: "linux",
				_spawn: mockSpawn,
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

			const ka = new KeepAwake({
				_platform: "win32",
				_spawn: mockSpawn,
			});

			const events: Array<{ platform: string }> = [];
			ka.on("unsupported", (info) => events.push(info));

			ka.activate();

			expect(events).toEqual([{ platform: "win32" }]);
			expect(ka.isActive()).toBe(false);
		});

		it("does not throw on unsupported platform", () => {
			const ka = new KeepAwake({ _platform: "linux" });
			expect(() => ka.activate()).not.toThrow();
		});
	});

	// ─── T9: Idempotent: double activate ─────────────────────────────────

	describe("T9: Idempotent: double activate doesn't spawn twice (AC5)", () => {
		it("only spawns once on double activate", () => {
			const child = createMockChild();
			const mockSpawn = createMockSpawn(child);

			const ka = new KeepAwake({
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

			const ka = new KeepAwake({
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

			const ka = new KeepAwake({
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

			const ka = new KeepAwake({
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
			const ka = new KeepAwake({ _platform: "darwin" });
			expect(() => ka.deactivate()).not.toThrow();
		});
	});

	// ─── T11: Process exit handler ───────────────────────────────────────

	describe("T11: Process exit handler: unexpected exit emits error, resets state (AC6)", () => {
		it("emits error on unexpected caffeinate exit", () => {
			const child = createMockChild();
			const mockSpawn = createMockSpawn(child);

			const ka = new KeepAwake({
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

			const ka = new KeepAwake({
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

			const ka = new KeepAwake({
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

			const ka = new KeepAwake({
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

			const ka = new KeepAwake({
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

	describe("T12: isSupported() returns true only on darwin", () => {
		it("returns true on darwin", () => {
			const ka = new KeepAwake({ _platform: "darwin" });
			expect(ka.isSupported()).toBe(true);
		});

		it("returns false on linux", () => {
			const ka = new KeepAwake({ _platform: "linux" });
			expect(ka.isSupported()).toBe(false);
		});

		it("returns false on win32", () => {
			const ka = new KeepAwake({ _platform: "win32" });
			expect(ka.isSupported()).toBe(false);
		});

		it("returns false on freebsd", () => {
			const ka = new KeepAwake({ _platform: "freebsd" });
			expect(ka.isSupported()).toBe(false);
		});
	});

	// ─── T13: Disabled: activate() is no-op ──────────────────────────────

	describe("T13: Disabled: activate() is no-op when not enabled", () => {
		it("does not spawn when disabled", () => {
			const mockSpawn =
				vi.fn() as unknown as typeof import("node:child_process").spawn;

			const ka = new KeepAwake({
				_platform: "darwin",
				_spawn: mockSpawn,
				enabled: false,
			});

			ka.activate();

			expect(mockSpawn).not.toHaveBeenCalled();
			expect(ka.isActive()).toBe(false);
		});

		it("does not emit activated when disabled", () => {
			const ka = new KeepAwake({
				_platform: "darwin",
				enabled: false,
			});

			const events: string[] = [];
			ka.on("activated", () => events.push("activated"));

			ka.activate();

			expect(events).toHaveLength(0);
		});

		it("does not emit unsupported when disabled", () => {
			const ka = new KeepAwake({
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

						const ka = new KeepAwake({
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

		it("property: isSupported is deterministic for any platform", () => {
			fc.assert(
				fc.property(fc.string({ minLength: 1, maxLength: 20 }), (platform) => {
					const ka = new KeepAwake({ _platform: platform });
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

					const ka = new KeepAwake({
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

			const ka = new KeepAwake({
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
});
