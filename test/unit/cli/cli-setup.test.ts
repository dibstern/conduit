// ─── First-Run Setup Flow — Unit Tests (Ticket 8.9) ──────────────────────────
// Tests for printLogo, runSetup, and the full setup wizard flow.
// Uses mock stdin (EventEmitter), stdout, and exit from the prompts test pattern.

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
	printLogo,
	runSetup,
	type SetupOptions,
} from "../../../src/lib/cli/cli-setup.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Strip ANSI escape sequences from a string. */
function stripAnsi(s: string): string {
	const esc = String.fromCharCode(0x1b);
	return s.replaceAll(new RegExp(`${esc}\\[[0-9;]*m`, "g"), "");
}

/** Create a mock stdin as an EventEmitter with setRawMode and pause/resume. */
function createMockStdin(): EventEmitter & {
	setRawMode: (mode: boolean) => void;
	resume: () => void;
	pause: () => void;
	setEncoding: (enc: string) => void;
	rawMode: boolean;
	paused: boolean;
} {
	const emitter = new EventEmitter() as EventEmitter & {
		setRawMode: (mode: boolean) => void;
		resume: () => void;
		pause: () => void;
		setEncoding: (enc: string) => void;
		rawMode: boolean;
		paused: boolean;
	};
	emitter.rawMode = false;
	emitter.paused = true;
	emitter.setRawMode = (mode: boolean) => {
		emitter.rawMode = mode;
	};
	emitter.resume = () => {
		emitter.paused = false;
	};
	emitter.pause = () => {
		emitter.paused = true;
	};
	emitter.setEncoding = () => {};
	return emitter;
}

/** Create mock I/O for the setup wizard. */
function createMockIO() {
	const output: string[] = [];
	const stdout = {
		write(s: string) {
			output.push(s);
		},
	};
	let exitCode: number | undefined;
	let exitCalled = false;
	const exit = (code: number) => {
		exitCode = code;
		exitCalled = true;
	};
	const stdin = createMockStdin();
	return {
		stdin,
		stdout,
		output,
		exit,
		getExitCode: () => exitCode,
		wasExitCalled: () => exitCalled,
		opts(overrides?: Partial<SetupOptions>): SetupOptions {
			return {
				stdin: stdin as unknown as SetupOptions["stdin"],
				stdout,
				exit,
				isPortFree: async () => true,
				getRecentProjects: () => [],
				...overrides,
			};
		},
	};
}

/** Wait for a given number of milliseconds. */
function tick(ms = 15): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Send a single key to stdin after a microtask delay. */
function sendKey(stdin: EventEmitter, key: string): void {
	queueMicrotask(() => stdin.emit("data", key));
}

/**
 * Send a sequence of keys with delays between them.
 * Returns a promise that resolves after all keys are sent.
 */
async function sendKeys(
	stdin: EventEmitter,
	keys: string[],
	delay = 15,
): Promise<void> {
	for (const key of keys) {
		stdin.emit("data", key);
		await tick(delay);
	}
}

// ─── printLogo ───────────────────────────────────────────────────────────────

describe("printLogo", () => {
	it("clears the screen", () => {
		const output: string[] = [];
		const stdout = { write: (s: string) => output.push(s) };
		printLogo(stdout);
		// First write should be screen clear escape
		expect(output[0]).toBe("\x1bc");
	});

	it("outputs gradient-colored text", () => {
		const output: string[] = [];
		const stdout = { write: (s: string) => output.push(s) };
		printLogo(stdout);
		const all = output.join("");
		// Should contain 24-bit color escape sequences (gradient)
		expect(all).toContain("\x1b[38;2;");
	});

	it("contains ASCII art block characters for conduit", () => {
		const output: string[] = [];
		const stdout = { write: (s: string) => output.push(s) };
		printLogo(stdout);
		const all = stripAnsi(output.join(""));
		// ASCII art uses full block characters
		expect(all).toContain("\u2588");
		// Multiple rows of art (CONDUIT_ART has 5 rows with █)
		const blockLines = all.split("\n").filter((l) => l.includes("\u2588"));
		expect(blockLines.length).toBeGreaterThanOrEqual(5);
	});

	it("uses cyan→pink gradient and brand bars in non-basic terminal", () => {
		const saved = process.env["TERM_PROGRAM"];
		process.env["TERM_PROGRAM"] = "vscode";
		try {
			const output: string[] = [];
			const stdout = { write: (s: string) => output.push(s) };
			printLogo(stdout);
			const all = output.join("");
			// Cyan start of gradient (0,229,255) on first row
			expect(all).toContain("\x1b[1;38;2;0;229;255m");
			// Pink end of gradient (255,45,123) on last row
			expect(all).toContain("\x1b[1;38;2;255;45;123m");
			// Brand grid underline uses upper/lower block chars
			const stripped = stripAnsi(all);
			expect(stripped).toContain("\u2580"); // upper half block (pink row)
			expect(stripped).toContain("\u2584"); // lower half block (cyan row)
		} finally {
			if (saved !== undefined) {
				process.env["TERM_PROGRAM"] = saved;
			} else {
				delete process.env["TERM_PROGRAM"];
			}
		}
	});

	it("uses bold cyan in basic terminal mode (no 24-bit RGB)", () => {
		const saved = process.env["TERM_PROGRAM"];
		process.env["TERM_PROGRAM"] = "Apple_Terminal";
		try {
			const output: string[] = [];
			const stdout = { write: (s: string) => output.push(s) };
			printLogo(stdout);
			const all = output.join("");
			// Bold cyan for CONDUIT art (16-color)
			expect(all).toContain("\x1b[1;36m");
			// Should NOT use 24-bit RGB
			expect(all).not.toContain("\x1b[38;2;");
		} finally {
			if (saved !== undefined) {
				process.env["TERM_PROGRAM"] = saved;
			} else {
				delete process.env["TERM_PROGRAM"];
			}
		}
	});

	it("renders brand underline with half-block characters", () => {
		const output: string[] = [];
		const stdout = { write: (s: string) => output.push(s) };
		printLogo(stdout);
		const all = stripAnsi(output.join(""));
		expect(all).toContain("\u2580"); // upper half block
		expect(all).toContain("\u2584"); // lower half block
	});
});

// ─── Disclaimer ──────────────────────────────────────────────────────────────

describe("disclaimer", () => {
	it("shows warning text about LAN access", async () => {
		const io = createMockIO();
		const setupPromise = runSetup(io.opts());
		await tick();

		const all = stripAnsi(io.output.join(""));
		expect(all).toContain("Anyone with the URL gets full OpenCode access");
		expect(all).toContain("private network");
		expect(all).toContain("no responsibility");

		// Clean up — accept and finish (disclaimer, port, PIN, keep-awake)
		await sendKeys(io.stdin, ["\r", "\r", "\r", "\r"]);
		await setupPromise;
	});

	it("shows security branding line", async () => {
		const io = createMockIO();
		const setupPromise = runSetup(io.opts());
		await tick();

		const all = stripAnsi(io.output.join(""));
		expect(all).toContain("Conduit");
		expect(all).toContain("Unofficial, open-source project");

		// Clean up (disclaimer, port, PIN, keep-awake)
		await sendKeys(io.stdin, ["\r", "\r", "\r", "\r"]);
		await setupPromise;
	});

	it("calls exit(0) when disclaimer is declined", async () => {
		const io = createMockIO();
		const setupPromise = runSetup(io.opts());
		await tick();

		// Press 'n' to decline, then Enter
		await sendKeys(io.stdin, ["n", "\r"]);
		await setupPromise;

		expect(io.getExitCode()).toBe(0);
	});
});

// ─── Port ────────────────────────────────────────────────────────────────────

describe("port prompt", () => {
	it("defaults to 2633", async () => {
		const io = createMockIO();
		const setupPromise = runSetup(io.opts());
		await tick();

		// Accept disclaimer (default Yes), press Enter
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		// Accept default port (Enter with empty = placeholder "2633"), then skip PIN, accept keep-awake default
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		const result = await setupPromise;

		expect(result.port).toBe(2633);
	});

	it("accepts a custom port", async () => {
		const io = createMockIO();
		const setupPromise = runSetup(io.opts());
		await tick();

		// Accept disclaimer
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		// Type custom port 8080
		await sendKeys(io.stdin, ["8", "0", "8", "0", "\r"]);
		await tick();

		// Skip PIN, accept keep-awake default
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		const result = await setupPromise;

		expect(result.port).toBe(8080);
	});

	it("rejects non-number input and retries", async () => {
		const io = createMockIO();
		const setupPromise = runSetup(io.opts());
		await tick();

		// Accept disclaimer
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		// Type invalid port "abc" then confirm
		await sendKeys(io.stdin, ["a", "b", "c", "\r"]);
		await tick();

		const all = stripAnsi(io.output.join(""));
		expect(all).toContain("Invalid port number");

		// Retry with default valid port, then skip PIN, accept keep-awake default
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		const result = await setupPromise;

		expect(result.port).toBe(2633);
	});

	it("rejects out-of-range port and retries", async () => {
		const io = createMockIO();
		const setupPromise = runSetup(io.opts());
		await tick();

		// Accept disclaimer
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		// Type port 0 (out of range)
		await sendKeys(io.stdin, ["0", "\r"]);
		await tick();

		const all = stripAnsi(io.output.join(""));
		expect(all).toContain("Invalid port number");

		// Retry with valid default, then skip PIN, accept keep-awake default
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		const result = await setupPromise;

		expect(result.port).toBe(2633);
	});

	it("shows warning when port is in use", async () => {
		let callCount = 0;
		const io = createMockIO();
		const setupPromise = runSetup(
			io.opts({
				isPortFree: async () => {
					callCount++;
					// First call: port in use, second call: free
					return callCount > 1;
				},
			}),
		);
		await tick();

		// Accept disclaimer
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		// Accept default port (which will be "in use")
		await sendKeys(io.stdin, ["\r"]);
		await tick(30);

		const all = stripAnsi(io.output.join(""));
		expect(all).toContain("already in use");

		// Second attempt with same port (now free), then skip PIN, accept keep-awake default
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		const result = await setupPromise;

		expect(result.port).toBe(2633);
	});
});

// ─── PIN ─────────────────────────────────────────────────────────────────────

describe("PIN prompt", () => {
	it("sets PIN correctly", async () => {
		const io = createMockIO();
		const setupPromise = runSetup(io.opts());
		await tick();

		// Accept disclaimer, accept default port
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		// Enter PIN "1234", then accept keep-awake default
		await sendKeys(io.stdin, ["1", "2", "3", "4", "\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		const result = await setupPromise;

		expect(result.pin).toBe("1234");
	});

	it("returns null when PIN is skipped", async () => {
		const io = createMockIO();
		const setupPromise = runSetup(io.opts());
		await tick();

		// Accept disclaimer, accept default port
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		// Skip PIN (just Enter), then accept keep-awake default
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		const result = await setupPromise;

		expect(result.pin).toBeNull();
	});

	it("PIN is included in result", async () => {
		const io = createMockIO();
		const setupPromise = runSetup(io.opts());
		await tick();

		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		// Enter PIN, then accept keep-awake default
		await sendKeys(io.stdin, ["5", "6", "7", "8", "\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		const result = await setupPromise;

		expect(result).toHaveProperty("pin");
		expect(result.pin).toBe("5678");
	});
});

// ─── Keep awake ──────────────────────────────────────────────────────────────

describe("keep awake", () => {
	it("shows keep-awake prompt on all platforms", async () => {
		const io = createMockIO();
		const setupPromise = runSetup(io.opts());
		await tick();

		// Accept disclaimer, default port, skip PIN
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		const all = stripAnsi(io.output.join(""));
		expect(all).toContain("Keep awake");
		expect(all).toContain("Prevent the system from sleeping");

		// Accept default (No)
		await sendKeys(io.stdin, ["\r"]);
		const result = await setupPromise;

		expect(result.keepAwake).toBe(false);
	});

	it("defaults to false", async () => {
		const io = createMockIO();
		const setupPromise = runSetup(io.opts());
		await tick();

		// Accept disclaimer, default port, skip PIN
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		// Accept default (No)
		await sendKeys(io.stdin, ["\r"]);
		const result = await setupPromise;

		expect(result.keepAwake).toBe(false);
	});
});

// ─── Restore projects ────────────────────────────────────────────────────────

describe("restore projects", () => {
	it("skips restore when no recent projects", async () => {
		const io = createMockIO();
		const setupPromise = runSetup(io.opts({ getRecentProjects: () => [] }));
		await tick();

		// Accept disclaimer, default port, skip PIN, accept keep-awake default
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		const result = await setupPromise;

		expect(result.restoredProjects).toEqual([]);
		const all = stripAnsi(io.output.join(""));
		expect(all).not.toContain("Restore projects");
	});

	it("shows project list when recent projects exist", async () => {
		const io = createMockIO();
		const recentProjects = [
			{
				path: "/home/user/project-a",
				slug: "project-a",
				title: "Project A",
				lastUsed: Date.now(),
			},
			{
				path: "/home/user/project-b",
				slug: "project-b",
				lastUsed: Date.now() - 1000,
			},
		];
		const setupPromise = runSetup(
			io.opts({ getRecentProjects: () => recentProjects }),
		);
		await tick();

		// Accept disclaimer, default port, skip PIN, accept keep-awake default
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		const all = stripAnsi(io.output.join(""));
		expect(all).toContain("Restore projects");
		expect(all).toContain("Project A");
		expect(all).toContain("/home/user/project-b");

		// Confirm (select all by default)
		await sendKeys(io.stdin, ["\r"]);
		const result = await setupPromise;

		expect(result.restoredProjects).toHaveLength(2);
	});

	it("restores selected projects", async () => {
		const io = createMockIO();
		const recentProjects = [
			{
				path: "/home/user/project-a",
				slug: "project-a",
				title: "Project A",
				lastUsed: Date.now(),
			},
			{
				path: "/home/user/project-b",
				slug: "project-b",
				title: "Project B",
				lastUsed: Date.now() - 1000,
			},
		];
		const setupPromise = runSetup(
			io.opts({ getRecentProjects: () => recentProjects }),
		);
		await tick();

		// Accept disclaimer, default port, skip PIN, accept keep-awake default
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		// Deselect first project (Space), then confirm (Enter)
		await sendKeys(io.stdin, [" ", "\r"]);
		const result = await setupPromise;

		expect(result.restoredProjects).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(result.restoredProjects[0]!.slug).toBe("project-b");
	});

	it("returns empty array when all deselected via Escape", async () => {
		const io = createMockIO();
		const recentProjects = [
			{
				path: "/home/user/project-a",
				slug: "project-a",
				lastUsed: Date.now(),
			},
		];
		const setupPromise = runSetup(
			io.opts({ getRecentProjects: () => recentProjects }),
		);
		await tick();

		// Accept disclaimer, default port, skip PIN, accept keep-awake default
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		// Escape to skip all
		await sendKeys(io.stdin, ["\x1b"]);
		const result = await setupPromise;

		expect(result.restoredProjects).toEqual([]);
	});
});

// ─── Full flow ───────────────────────────────────────────────────────────────

describe("full flow", () => {
	it("completes with all defaults", async () => {
		const io = createMockIO();
		const setupPromise = runSetup(io.opts());
		await tick();

		// Accept disclaimer (default Yes), default port, skip PIN, accept keep-awake default
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		const result = await setupPromise;

		expect(result).toEqual({
			port: 2633,
			pin: null,
			keepAwake: false,
			restoredProjects: [],
		});
	});

	it("completes with custom values", async () => {
		const io = createMockIO();
		const recentProjects = [
			{
				path: "/tmp/myproject",
				slug: "myproject",
				title: "My Project",
				lastUsed: Date.now(),
			},
		];
		const setupPromise = runSetup(
			io.opts({
				getRecentProjects: () => recentProjects,
			}),
		);
		await tick();

		// Accept disclaimer
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		// Custom port: 3000
		await sendKeys(io.stdin, ["3", "0", "0", "0", "\r"]);
		await tick();

		// PIN: 9999
		await sendKeys(io.stdin, ["9", "9", "9", "9", "\r"]);
		await tick();

		// Keep awake: Yes
		await sendKeys(io.stdin, ["y", "\r"]);
		await tick();

		// Restore projects (accept all)
		await sendKeys(io.stdin, ["\r"]);
		const result = await setupPromise;

		expect(result.port).toBe(3000);
		expect(result.pin).toBe("9999");
		expect(result.keepAwake).toBe(true);
		expect(result.restoredProjects).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(result.restoredProjects[0]!.slug).toBe("myproject");
	});

	it("Ctrl+C at disclaimer calls exit(0)", async () => {
		const io = createMockIO();

		// Start setup but don't await — Ctrl+C causes promptToggle to call
		// exit(0) without calling its callback, so the promise never resolves.
		// We just verify exit was called.
		runSetup(io.opts());
		await tick();

		// Ctrl+C at the disclaimer toggle
		sendKey(io.stdin, "\x03");
		await tick();

		expect(io.getExitCode()).toBe(0);
	});

	it("result has correct shape", async () => {
		const io = createMockIO();
		const setupPromise = runSetup(io.opts());
		await tick();

		// Accept disclaimer, default port, skip PIN, accept keep-awake default
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		const result = await setupPromise;

		expect(result).toHaveProperty("port");
		expect(result).toHaveProperty("pin");
		expect(result).toHaveProperty("keepAwake");
		expect(result).toHaveProperty("restoredProjects");
		expect(typeof result.port).toBe("number");
		expect(typeof result.keepAwake).toBe("boolean");
		expect(Array.isArray(result.restoredProjects)).toBe(true);
	});
});

// ─── Edge cases ──────────────────────────────────────────────────────────────

describe("edge cases", () => {
	it("handles empty recent projects", async () => {
		const io = createMockIO();
		const setupPromise = runSetup(io.opts({ getRecentProjects: () => [] }));
		await tick();

		// Accept disclaimer, default port, skip PIN, accept keep-awake default
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		const result = await setupPromise;

		expect(result.restoredProjects).toEqual([]);
	});

	it("handles isPortFree rejecting all attempts then succeeding", async () => {
		let attempt = 0;
		const io = createMockIO();
		const setupPromise = runSetup(
			io.opts({
				isPortFree: async () => {
					attempt++;
					return attempt >= 3;
				},
			}),
		);
		await tick();

		// Accept disclaimer
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		// First attempt — port in use
		await sendKeys(io.stdin, ["\r"]);
		await tick(30);

		// Second attempt — port in use
		await sendKeys(io.stdin, ["\r"]);
		await tick(30);

		// Third attempt — succeeds, then skip PIN, accept keep-awake default
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		const result = await setupPromise;

		expect(result.port).toBe(2633);
		expect(attempt).toBe(3);
	});

	it("keep-awake defaults to false when accepted with Enter", async () => {
		const io = createMockIO();
		const setupPromise = runSetup(io.opts());
		await tick();

		// Accept disclaimer, default port, skip PIN, accept keep-awake default
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		await tick();
		await sendKeys(io.stdin, ["\r"]);
		const result = await setupPromise;

		expect(result.keepAwake).toBe(false);
	});
});
