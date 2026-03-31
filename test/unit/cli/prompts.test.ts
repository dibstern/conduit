// ─── Interactive Prompt Components — Unit Tests (Ticket 8.1) ─────────────────
// Tests for promptToggle, promptPin, promptText, promptSelect, and
// promptMultiSelect. Uses mock stdin (EventEmitter), stdout, and exit.

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type {
	MultiSelectItem,
	PromptOptions,
	SelectItem,
	SelectPromptOptions,
	TabCompleteFs,
	TextPromptOptions,
} from "../../../src/lib/cli/prompts.js";
import {
	promptMultiSelect,
	promptPin,
	promptSelect,
	promptText,
	promptToggle,
} from "../../../src/lib/cli/prompts.js";
import { a } from "../../../src/lib/cli/terminal-render.js";

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

/** Create mock I/O for prompts. */
function createMockIO() {
	const output: string[] = [];
	const stdout = {
		write(s: string) {
			output.push(s);
		},
	};
	let exitCode: number | undefined;
	const exit = (code: number) => {
		exitCode = code;
	};
	const stdin = createMockStdin();
	return {
		stdin,
		stdout,
		output,
		exit,
		getExitCode: () => exitCode,
		opts(): PromptOptions {
			return {
				stdin: stdin as unknown as PromptOptions["stdin"],
				stdout,
				exit,
			};
		},
	};
}

/** Send a key to stdin after a microtask delay. */
function sendKey(stdin: EventEmitter, key: string): void {
	queueMicrotask(() => stdin.emit("data", key));
}

/** Yield one event-loop tick so the prompt processes the preceding input. */
function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 1));
}

/**
 * Count how many lines clearUp erased after a specific point in the output.
 * clearUp emits "\x1b[1A\x1b[2K" per line. We match that pattern using
 * the ESC character code to avoid control-char-in-regex lint errors.
 */
function countClearUpLines(output: string[], afterIndex: number): number {
	const tail = output.slice(afterIndex).join("");
	const esc = String.fromCharCode(0x1b);
	const pattern = new RegExp(`${esc}\\[1A${esc}\\[2K`, "g");
	return (tail.match(pattern) || []).length;
}

// ─── promptToggle ────────────────────────────────────────────────────────────

describe("promptToggle", () => {
	it("renders title in output", () => {
		const io = createMockIO();
		promptToggle("Enable feature", null, false, () => {}, io.opts());
		const all = io.output.join("");
		expect(stripAnsi(all)).toContain("Enable feature");
	});

	it("renders description when provided", () => {
		const io = createMockIO();
		promptToggle("Enable", "Turn on the thing", false, () => {}, io.opts());
		const all = io.output.join("");
		expect(stripAnsi(all)).toContain("Turn on the thing");
	});

	it("shows Yes/No toggle indicators", () => {
		const io = createMockIO();
		promptToggle("Test", null, false, () => {}, io.opts());
		const all = stripAnsi(io.output.join(""));
		expect(all).toContain("Yes");
		expect(all).toContain("No");
	});

	it("defaults to false (No highlighted)", () => {
		const io = createMockIO();
		promptToggle("Test", null, false, () => {}, io.opts());
		// The toggle render is the second-to-last output (key hints line is last)
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		const toggleLine = io.output[io.output.length - 2]!;
		// No should be active (green+bold)
		expect(toggleLine).toContain(`${a.green}${a.bold}`);
		expect(stripAnsi(toggleLine)).toContain("No");
	});

	it("defaults to true when defaultValue is true", () => {
		const io = createMockIO();
		promptToggle("Test", null, true, () => {}, io.opts());
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		const toggleLine = io.output[io.output.length - 2]!;
		expect(toggleLine).toContain(`${a.green}${a.bold}`);
		expect(stripAnsi(toggleLine)).toContain("Yes");
	});

	it("toggles value on left arrow", async () => {
		const io = createMockIO();
		let result: boolean | undefined;
		promptToggle(
			"Test",
			null,
			true,
			(v) => {
				result = v;
			},
			io.opts(),
		);
		sendKey(io.stdin, "\x1b[D"); // left arrow toggles
		await tick();
		sendKey(io.stdin, "\r"); // confirm
		await tick();
		expect(result).toBe(false);
	});

	it("toggles value on right arrow", async () => {
		const io = createMockIO();
		let result: boolean | undefined;
		promptToggle(
			"Test",
			null,
			false,
			(v) => {
				result = v;
			},
			io.opts(),
		);
		sendKey(io.stdin, "\x1b[C"); // right arrow toggles
		await tick();
		sendKey(io.stdin, "\r"); // confirm
		await tick();
		expect(result).toBe(true);
	});

	it("sets true on y key", async () => {
		const io = createMockIO();
		let result: boolean | undefined;
		promptToggle(
			"Test",
			null,
			false,
			(v) => {
				result = v;
			},
			io.opts(),
		);
		sendKey(io.stdin, "y");
		await tick();
		sendKey(io.stdin, "\r");
		await tick();
		expect(result).toBe(true);
	});

	it("sets false on n key", async () => {
		const io = createMockIO();
		let result: boolean | undefined;
		promptToggle(
			"Test",
			null,
			true,
			(v) => {
				result = v;
			},
			io.opts(),
		);
		sendKey(io.stdin, "n");
		await tick();
		sendKey(io.stdin, "\r");
		await tick();
		expect(result).toBe(false);
	});

	it("toggles on Tab", async () => {
		const io = createMockIO();
		let result: boolean | undefined;
		promptToggle(
			"Test",
			null,
			false,
			(v) => {
				result = v;
			},
			io.opts(),
		);
		sendKey(io.stdin, "\t"); // tab toggles
		await tick();
		sendKey(io.stdin, "\r");
		await tick();
		expect(result).toBe(true);
	});

	it("confirms on Enter and calls callback", async () => {
		const io = createMockIO();
		let result: boolean | undefined;
		promptToggle(
			"Test",
			null,
			false,
			(v) => {
				result = v;
			},
			io.opts(),
		);
		sendKey(io.stdin, "\r");
		await tick();
		expect(result).toBe(false);
	});

	it("exits on Ctrl+C", async () => {
		const io = createMockIO();
		promptToggle("Test", null, false, () => {}, io.opts());
		sendKey(io.stdin, "\x03");
		await tick();
		expect(io.getExitCode()).toBe(0);
	});

	it("renders key hints", () => {
		const io = createMockIO();
		promptToggle("Test", null, false, () => {}, io.opts());
		const all = stripAnsi(io.output.join(""));
		expect(all).toContain("\u2190\u2192: toggle");
		expect(all).toContain("y/n: yes/no");
		expect(all).toContain("enter: confirm");
	});

	it("clearUp erases exactly 3 lines on confirm (no description)", async () => {
		const io = createMockIO();
		promptToggle("Test", null, false, () => {}, io.opts());
		const beforeConfirm = io.output.length;
		sendKey(io.stdin, "\r");
		await tick();
		expect(countClearUpLines(io.output, beforeConfirm)).toBe(3);
	});

	it("clearUp erases exactly 4 lines on confirm (with description)", async () => {
		const io = createMockIO();
		promptToggle("Test", "A description", false, () => {}, io.opts());
		const beforeConfirm = io.output.length;
		sendKey(io.stdin, "\r");
		await tick();
		expect(countClearUpLines(io.output, beforeConfirm)).toBe(4);
	});

	it("redraws toggle without corrupting hint line on key press", async () => {
		const io = createMockIO();
		promptToggle("Test", null, false, () => {}, io.opts());
		const beforeKey = io.output.length;
		sendKey(io.stdin, "\x1b[C"); // right arrow
		await tick();
		// Redraw should move up 1, clear, redraw, move down 1
		const redrawOutput = io.output.slice(beforeKey).join("");
		const esc = String.fromCharCode(0x1b);
		expect(redrawOutput).toContain(`${esc}[1A`); // move up
		expect(redrawOutput).toContain(`${esc}[2K`); // clear line
		expect(redrawOutput).toContain(`${esc}[1B`); // move down
	});
});

// ─── promptPin ───────────────────────────────────────────────────────────────

describe("promptPin", () => {
	it("renders title and description", () => {
		const io = createMockIO();
		promptPin(() => {}, io.opts());
		const all = stripAnsi(io.output.join(""));
		expect(all).toContain("Set a PIN");
		expect(all).toContain("4-8 digits");
	});

	it("shows cyan bullets when digits are typed", async () => {
		const io = createMockIO();
		promptPin(() => {}, io.opts());
		sendKey(io.stdin, "1");
		await tick();
		sendKey(io.stdin, "2");
		await tick();
		const all = io.output.join("");
		// Should contain cyan-colored bullet character
		expect(all).toContain(a.cyan);
		expect(all).toContain("\u25CF");
	});

	it("only accepts digit characters", async () => {
		const io = createMockIO();
		let result: string | null | undefined;
		promptPin((v) => {
			result = v;
		}, io.opts());
		sendKey(io.stdin, "a"); // non-digit, should be ignored
		await tick();
		sendKey(io.stdin, "1");
		await tick();
		sendKey(io.stdin, "2");
		await tick();
		sendKey(io.stdin, "3");
		await tick();
		sendKey(io.stdin, "4");
		await tick();
		sendKey(io.stdin, "\r");
		await tick();
		expect(result).toBe("1234");
	});

	it("supports backspace", async () => {
		const io = createMockIO();
		let result: string | null | undefined;
		promptPin((v) => {
			result = v;
		}, io.opts());
		sendKey(io.stdin, "1");
		await tick();
		sendKey(io.stdin, "2");
		await tick();
		sendKey(io.stdin, "\x7f"); // backspace
		await tick();
		sendKey(io.stdin, "3");
		await tick();
		sendKey(io.stdin, "4");
		await tick();
		sendKey(io.stdin, "5");
		await tick();
		sendKey(io.stdin, "6");
		await tick();
		sendKey(io.stdin, "\r");
		await tick();
		expect(result).toBe("13456");
	});

	it("returns null on Enter with no input (skip)", async () => {
		const io = createMockIO();
		let result: string | null | undefined = "unset";
		promptPin((v) => {
			result = v;
		}, io.opts());
		sendKey(io.stdin, "\r");
		await tick();
		expect(result).toBeNull();
	});

	it("returns valid 4-digit PIN", async () => {
		const io = createMockIO();
		let result: string | null | undefined;
		promptPin((v) => {
			result = v;
		}, io.opts());
		for (const d of ["1", "2", "3", "4"]) {
			sendKey(io.stdin, d);
			await tick();
		}
		sendKey(io.stdin, "\r");
		await tick();
		expect(result).toBe("1234");
	});

	it("returns valid 8-digit PIN", async () => {
		const io = createMockIO();
		let result: string | null | undefined;
		promptPin((v) => {
			result = v;
		}, io.opts());
		for (const d of ["1", "2", "3", "4", "5", "6", "7", "8"]) {
			sendKey(io.stdin, d);
			await tick();
		}
		sendKey(io.stdin, "\r");
		await tick();
		expect(result).toBe("12345678");
	});

	it("rejects PIN shorter than 4 digits", async () => {
		const io = createMockIO();
		let callbackCalled = false;
		promptPin(() => {
			callbackCalled = true;
		}, io.opts());
		sendKey(io.stdin, "1");
		await tick();
		sendKey(io.stdin, "2");
		await tick();
		sendKey(io.stdin, "3");
		await tick();
		sendKey(io.stdin, "\r");
		await tick();
		// Should call exit(1) for invalid pin
		expect(io.getExitCode()).toBe(1);
		expect(callbackCalled).toBe(false);
	});

	it("does not accept more than 8 digits", async () => {
		const io = createMockIO();
		let result: string | null | undefined;
		promptPin((v) => {
			result = v;
		}, io.opts());
		for (const d of ["1", "2", "3", "4", "5", "6", "7", "8", "9"]) {
			sendKey(io.stdin, d);
			await tick();
		}
		sendKey(io.stdin, "\r");
		await tick();
		// Should only have 8 digits
		expect(result).toBe("12345678");
	});

	it("exits on Ctrl+C", async () => {
		const io = createMockIO();
		promptPin(() => {}, io.opts());
		sendKey(io.stdin, "\x03");
		await tick();
		expect(io.getExitCode()).toBe(0);
	});

	it("renders key hints", () => {
		const io = createMockIO();
		promptPin(() => {}, io.opts());
		const all = stripAnsi(io.output.join(""));
		expect(all).toContain("0-9: digits");
		expect(all).toContain("backspace: delete");
		expect(all).toContain("enter: confirm/skip");
		expect(all).toContain("esc: back");
	});

	it("returns null on Escape (back)", async () => {
		const io = createMockIO();
		let result: string | null | undefined = "unset";
		promptPin((v) => {
			result = v;
		}, io.opts());
		sendKey(io.stdin, "\x1b");
		await tick();
		expect(result).toBeNull();
	});

	it("returns null on Escape even after typing digits", async () => {
		const io = createMockIO();
		let result: string | null | undefined = "unset";
		promptPin((v) => {
			result = v;
		}, io.opts());
		sendKey(io.stdin, "1");
		await tick();
		sendKey(io.stdin, "2");
		await tick();
		sendKey(io.stdin, "\x1b");
		await tick();
		expect(result).toBeNull();
	});

	it("clearUp erases exactly 4 lines on Escape", async () => {
		const io = createMockIO();
		promptPin(() => {}, io.opts());
		const beforeEsc = io.output.length;
		sendKey(io.stdin, "\x1b");
		await tick();
		expect(countClearUpLines(io.output, beforeEsc)).toBe(4);
	});

	it("clearUp erases exactly 4 lines on confirm (skip)", async () => {
		const io = createMockIO();
		promptPin(() => {}, io.opts());
		const beforeConfirm = io.output.length;
		sendKey(io.stdin, "\r");
		await tick();
		// 4 lines: title, description, key hints, input
		expect(countClearUpLines(io.output, beforeConfirm)).toBe(4);
	});

	it("clearUp erases exactly 4 lines on confirm (valid PIN)", async () => {
		const io = createMockIO();
		promptPin(() => {}, io.opts());
		for (const d of ["1", "2", "3", "4"]) {
			sendKey(io.stdin, d);
			await tick();
		}
		const beforeConfirm = io.output.length;
		sendKey(io.stdin, "\r");
		await tick();
		expect(countClearUpLines(io.output, beforeConfirm)).toBe(4);
	});

	it("clearUp erases exactly 4 lines on Ctrl+C", async () => {
		const io = createMockIO();
		promptPin(() => {}, io.opts());
		const beforeCancel = io.output.length;
		sendKey(io.stdin, "\x03");
		await tick();
		expect(countClearUpLines(io.output, beforeCancel)).toBe(4);
	});
});

// ─── promptText ──────────────────────────────────────────────────────────────

describe("promptText", () => {
	it("renders title and key hints", () => {
		const io = createMockIO();
		const textOpts: TextPromptOptions = { ...io.opts() };
		promptText("Working directory", "/home/user", () => {}, textOpts);
		const all = stripAnsi(io.output.join(""));
		expect(all).toContain("Working directory");
		expect(all).toContain("tab: complete");
		expect(all).toContain("enter: confirm");
		expect(all).toContain("esc: back");
	});

	it("shows placeholder text initially", () => {
		const io = createMockIO();
		const textOpts: TextPromptOptions = { ...io.opts() };
		promptText("Dir", "/home/user", () => {}, textOpts);
		const all = io.output.join("");
		// Placeholder should be dimmed
		expect(all).toContain(a.dim);
		expect(stripAnsi(all)).toContain("/home/user");
	});

	it("typing replaces placeholder", async () => {
		const io = createMockIO();
		let result: string | null | undefined;
		const textOpts: TextPromptOptions = { ...io.opts() };
		promptText(
			"Dir",
			"/default",
			(v) => {
				result = v;
			},
			textOpts,
		);
		sendKey(io.stdin, "/");
		await tick();
		sendKey(io.stdin, "t");
		await tick();
		sendKey(io.stdin, "m");
		await tick();
		sendKey(io.stdin, "p");
		await tick();
		sendKey(io.stdin, "\r");
		await tick();
		expect(result).toBe("/tmp");
	});

	it("returns placeholder when Enter pressed with no input", async () => {
		const io = createMockIO();
		let result: string | null | undefined;
		const textOpts: TextPromptOptions = { ...io.opts() };
		promptText(
			"Dir",
			"/default",
			(v) => {
				result = v;
			},
			textOpts,
		);
		sendKey(io.stdin, "\r");
		await tick();
		expect(result).toBe("/default");
	});

	it("supports backspace", async () => {
		const io = createMockIO();
		let result: string | null | undefined;
		const textOpts: TextPromptOptions = { ...io.opts() };
		promptText(
			"Dir",
			"/default",
			(v) => {
				result = v;
			},
			textOpts,
		);
		sendKey(io.stdin, "a");
		await tick();
		sendKey(io.stdin, "b");
		await tick();
		sendKey(io.stdin, "\x7f"); // backspace
		await tick();
		sendKey(io.stdin, "c");
		await tick();
		sendKey(io.stdin, "\r");
		await tick();
		expect(result).toBe("ac");
	});

	it("restores placeholder after backspacing all text", async () => {
		const io = createMockIO();
		const textOpts: TextPromptOptions = { ...io.opts() };
		promptText("Dir", "/default", () => {}, textOpts);
		sendKey(io.stdin, "a");
		await tick();
		sendKey(io.stdin, "\x7f"); // backspace
		await tick();
		// Output should contain placeholder re-render with dim
		const lastChunk = io.output.slice(-3).join("");
		expect(lastChunk).toContain(a.dim);
		expect(stripAnsi(lastChunk)).toContain("/default");
	});

	it("returns null on Escape", async () => {
		const io = createMockIO();
		let result: string | null | undefined = "unset";
		const textOpts: TextPromptOptions = { ...io.opts() };
		promptText(
			"Dir",
			"/default",
			(v) => {
				result = v;
			},
			textOpts,
		);
		sendKey(io.stdin, "\x1b");
		await tick();
		expect(result).toBeNull();
	});

	it("exits on Ctrl+C", async () => {
		const io = createMockIO();
		const textOpts: TextPromptOptions = { ...io.opts() };
		promptText("Dir", "/default", () => {}, textOpts);
		sendKey(io.stdin, "\x03");
		await tick();
		expect(io.getExitCode()).toBe(0);
	});

	it("displays hint when provided", () => {
		const io = createMockIO();
		const textOpts: TextPromptOptions = {
			...io.opts(),
			hint: "Enter a directory path",
		};
		promptText("Dir", "/default", () => {}, textOpts);
		const all = stripAnsi(io.output.join(""));
		expect(all).toContain("Enter a directory path");
	});

	it("calls validate on confirm and shows error", async () => {
		const io = createMockIO();
		let callbackCalled = false;
		const textOpts: TextPromptOptions = {
			...io.opts(),
			validate: (v) => (v === "bad" ? "Invalid value" : null),
		};
		promptText(
			"Val",
			"default",
			() => {
				callbackCalled = true;
			},
			textOpts,
		);
		sendKey(io.stdin, "b");
		await tick();
		sendKey(io.stdin, "a");
		await tick();
		sendKey(io.stdin, "d");
		await tick();
		sendKey(io.stdin, "\r");
		await tick();
		// Validation should show error
		const all = stripAnsi(io.output.join(""));
		expect(all).toContain("Invalid value");
		expect(callbackCalled).toBe(false);
	});

	it("calls callback when validation passes", async () => {
		const io = createMockIO();
		let result: string | null | undefined;
		const textOpts: TextPromptOptions = {
			...io.opts(),
			validate: (v) => (v.length < 2 ? "Too short" : null),
		};
		promptText(
			"Val",
			"default",
			(v) => {
				result = v;
			},
			textOpts,
		);
		sendKey(io.stdin, "o");
		await tick();
		sendKey(io.stdin, "k");
		await tick();
		sendKey(io.stdin, "\r");
		await tick();
		expect(result).toBe("ok");
	});

	it("tab-completes directory paths", async () => {
		const mockFs: TabCompleteFs = {
			statSync(p: string) {
				const pStr = String(p);
				if (pStr === "/tmp" || pStr === "/tmp/test-dir") {
					return { isDirectory: () => true };
				}
				throw new Error("ENOENT");
			},
			readdirSync() {
				return ["test-dir"];
			},
		};

		const io = createMockIO();
		let result: string | null | undefined;
		const textOpts: TextPromptOptions = { ...io.opts(), fs: mockFs };
		promptText(
			"Dir",
			"/default",
			(v) => {
				result = v;
			},
			textOpts,
		);
		sendKey(io.stdin, "/");
		await tick();
		sendKey(io.stdin, "t");
		await tick();
		sendKey(io.stdin, "m");
		await tick();
		sendKey(io.stdin, "p");
		await tick();
		sendKey(io.stdin, "\t"); // tab complete
		await tick();
		sendKey(io.stdin, "\r");
		await tick();

		// Should have completed to /tmp/test-dir/
		expect(result).toBe("/tmp/test-dir/");
	});

	it("shows multiple tab-completion candidates", async () => {
		// User types "/tmp/al" -> partial is "al", dir is "/tmp"
		// readdirSync returns entries starting with "al"
		const dirs = new Set(["/tmp", "/tmp/alpha-one", "/tmp/alpha-two"]);
		const mockFs: TabCompleteFs = {
			statSync(p: string) {
				if (dirs.has(p)) return { isDirectory: () => true };
				throw new Error("ENOENT");
			},
			readdirSync() {
				return ["alpha-one", "alpha-two"];
			},
		};

		const io = createMockIO();
		const textOpts: TextPromptOptions = { ...io.opts(), fs: mockFs };
		promptText("Dir", "/default", () => {}, textOpts);
		// Type /tmp/al then tab -- partial "al" doesn't exist, so catch branch
		// dir = "/tmp", partial = "al"
		for (const ch of "/tmp/al".split("")) {
			sendKey(io.stdin, ch);
			await tick();
		}
		sendKey(io.stdin, "\t");
		await tick();

		// Should show both candidates
		const all = stripAnsi(io.output.join(""));
		expect(all).toContain("alpha-one");
		expect(all).toContain("alpha-two");
	});

	it("completes common prefix when multiple matches share one", async () => {
		// User types "/tmp/ab" -> partial is "ab", dir is "/tmp"
		const dirs = new Set(["/tmp", "/tmp/abc-one", "/tmp/abc-two"]);
		const mockFs: TabCompleteFs = {
			statSync(p: string) {
				if (dirs.has(p)) return { isDirectory: () => true };
				throw new Error("ENOENT");
			},
			readdirSync() {
				return ["abc-one", "abc-two"];
			},
		};

		const io = createMockIO();
		let result: string | null | undefined;
		const textOpts: TextPromptOptions = { ...io.opts(), fs: mockFs };
		promptText(
			"Dir",
			"/default",
			(v) => {
				result = v;
			},
			textOpts,
		);
		for (const ch of "/tmp/ab".split("")) {
			sendKey(io.stdin, ch);
			await tick();
		}
		sendKey(io.stdin, "\t");
		await tick();

		// The text should now include common prefix "abc-"
		// Confirm to get result
		sendKey(io.stdin, "\r");
		await tick();
		// Result should contain the common prefix path
		expect(result).toContain("/tmp/abc-");
	});

	it("clearUp erases exactly 3 lines on confirm (no content hint)", async () => {
		const io = createMockIO();
		const textOpts: TextPromptOptions = { ...io.opts() };
		promptText("Dir", "/default", () => {}, textOpts);
		const beforeConfirm = io.output.length;
		sendKey(io.stdin, "\r");
		await tick();
		// 3 lines: title, key hints, input
		expect(countClearUpLines(io.output, beforeConfirm)).toBe(3);
	});

	it("clearUp erases exactly 4 lines on confirm (with content hint)", async () => {
		const io = createMockIO();
		const textOpts: TextPromptOptions = {
			...io.opts(),
			hint: "Some hint",
		};
		promptText("Dir", "/default", () => {}, textOpts);
		const beforeConfirm = io.output.length;
		sendKey(io.stdin, "\r");
		await tick();
		// 4 lines: title, content hint, key hints, input
		expect(countClearUpLines(io.output, beforeConfirm)).toBe(4);
	});

	it("clearUp erases exactly 3 lines on Escape (no content hint)", async () => {
		const io = createMockIO();
		const textOpts: TextPromptOptions = { ...io.opts() };
		promptText("Dir", "/default", () => {}, textOpts);
		const beforeEsc = io.output.length;
		sendKey(io.stdin, "\x1b");
		await tick();
		expect(countClearUpLines(io.output, beforeEsc)).toBe(3);
	});
});

// ─── promptSelect ────────────────────────────────────────────────────────────

describe("promptSelect", () => {
	const items: SelectItem[] = [
		{ label: "Option A", value: "a" },
		{ label: "Option B", value: "b" },
		{ label: "Option C", value: "c" },
	];

	it("renders title", () => {
		const io = createMockIO();
		const selectOpts: SelectPromptOptions = { ...io.opts() };
		promptSelect("Pick one", items, () => {}, selectOpts);
		const all = stripAnsi(io.output.join(""));
		expect(all).toContain("Pick one");
	});

	it("renders all items", () => {
		const io = createMockIO();
		const selectOpts: SelectPromptOptions = { ...io.opts() };
		promptSelect("Pick one", items, () => {}, selectOpts);
		const all = stripAnsi(io.output.join(""));
		expect(all).toContain("Option A");
		expect(all).toContain("Option B");
		expect(all).toContain("Option C");
	});

	it("first item is highlighted by default", () => {
		const io = createMockIO();
		const selectOpts: SelectPromptOptions = { ...io.opts() };
		promptSelect("Pick one", items, () => {}, selectOpts);
		// The render output should have the first item with green+bold indicator
		const renderOutput = io.output[1]; // second write is the render() output
		expect(renderOutput).toContain(a.green);
	});

	it("selects first item on Enter", async () => {
		const io = createMockIO();
		let result: string | null | undefined;
		const selectOpts: SelectPromptOptions = { ...io.opts() };
		promptSelect(
			"Pick one",
			items,
			(v) => {
				result = v;
			},
			selectOpts,
		);
		sendKey(io.stdin, "\r");
		await tick();
		expect(result).toBe("a");
	});

	it("navigates down with down arrow", async () => {
		const io = createMockIO();
		let result: string | null | undefined;
		const selectOpts: SelectPromptOptions = { ...io.opts() };
		promptSelect(
			"Pick one",
			items,
			(v) => {
				result = v;
			},
			selectOpts,
		);
		sendKey(io.stdin, "\x1b[B"); // down
		await tick();
		sendKey(io.stdin, "\r");
		await tick();
		expect(result).toBe("b");
	});

	it("navigates up with up arrow", async () => {
		const io = createMockIO();
		let result: string | null | undefined;
		const selectOpts: SelectPromptOptions = { ...io.opts() };
		promptSelect(
			"Pick one",
			items,
			(v) => {
				result = v;
			},
			selectOpts,
		);
		sendKey(io.stdin, "\x1b[B"); // down to B
		await tick();
		sendKey(io.stdin, "\x1b[B"); // down to C
		await tick();
		sendKey(io.stdin, "\x1b[A"); // up to B
		await tick();
		sendKey(io.stdin, "\r");
		await tick();
		expect(result).toBe("b");
	});

	it("does not go above first item", async () => {
		const io = createMockIO();
		let result: string | null | undefined;
		const selectOpts: SelectPromptOptions = { ...io.opts() };
		promptSelect(
			"Pick one",
			items,
			(v) => {
				result = v;
			},
			selectOpts,
		);
		sendKey(io.stdin, "\x1b[A"); // up (already at 0)
		await tick();
		sendKey(io.stdin, "\r");
		await tick();
		expect(result).toBe("a");
	});

	it("does not go below last item", async () => {
		const io = createMockIO();
		let result: string | null | undefined;
		const selectOpts: SelectPromptOptions = { ...io.opts() };
		promptSelect(
			"Pick one",
			items,
			(v) => {
				result = v;
			},
			selectOpts,
		);
		sendKey(io.stdin, "\x1b[B"); // down to B
		await tick();
		sendKey(io.stdin, "\x1b[B"); // down to C
		await tick();
		sendKey(io.stdin, "\x1b[B"); // down (already at last)
		await tick();
		sendKey(io.stdin, "\r");
		await tick();
		expect(result).toBe("c");
	});

	it("returns null on Backspace when backItem is set", async () => {
		const io = createMockIO();
		let result: string | null | undefined = "unset";
		const selectOpts: SelectPromptOptions = {
			...io.opts(),
			backItem: "\u2190 Back",
		};
		promptSelect(
			"Pick one",
			items,
			(v) => {
				result = v;
			},
			selectOpts,
		);
		sendKey(io.stdin, "\x7f"); // backspace
		await tick();
		expect(result).toBeNull();
	});

	it("ignores Backspace when no backItem", async () => {
		const io = createMockIO();
		let result: string | null | undefined = "unset";
		const selectOpts: SelectPromptOptions = { ...io.opts() };
		promptSelect(
			"Pick one",
			items,
			(v) => {
				result = v;
			},
			selectOpts,
		);
		sendKey(io.stdin, "\x7f"); // backspace -- should be ignored
		await tick();
		sendKey(io.stdin, "\r"); // confirm
		await tick();
		expect(result).toBe("a");
	});

	it("returns null on Escape when backItem is set", async () => {
		const io = createMockIO();
		let result: string | null | undefined = "unset";
		const selectOpts: SelectPromptOptions = {
			...io.opts(),
			backItem: "\u2190 Back",
		};
		promptSelect(
			"Pick one",
			items,
			(v) => {
				result = v;
			},
			selectOpts,
		);
		sendKey(io.stdin, "\x1b"); // escape
		await tick();
		expect(result).toBeNull();
	});

	it("ignores Escape when no backItem", async () => {
		const io = createMockIO();
		let result: string | null | undefined = "unset";
		const selectOpts: SelectPromptOptions = { ...io.opts() };
		promptSelect(
			"Pick one",
			items,
			(v) => {
				result = v;
			},
			selectOpts,
		);
		sendKey(io.stdin, "\x1b"); // escape -- should be ignored
		await tick();
		sendKey(io.stdin, "\r"); // confirm
		await tick();
		expect(result).toBe("a");
	});

	it("supports hotkeys", async () => {
		const io = createMockIO();
		let result: string | null | undefined;
		const hotkeys = new Map<string, number>();
		hotkeys.set("1", 0);
		hotkeys.set("2", 1);
		hotkeys.set("3", 2);
		const selectOpts: SelectPromptOptions = { ...io.opts(), hotkeys };
		promptSelect(
			"Pick one",
			items,
			(v) => {
				result = v;
			},
			selectOpts,
		);
		sendKey(io.stdin, "2"); // hotkey for index 1
		await tick();
		expect(result).toBe("b");
	});

	it("renders hint lines", () => {
		const io = createMockIO();
		const selectOpts: SelectPromptOptions = {
			...io.opts(),
			hint: ["Press Enter to confirm", "Press Esc to cancel"],
		};
		promptSelect("Pick one", items, () => {}, selectOpts);
		const all = stripAnsi(io.output.join(""));
		expect(all).toContain("Press Enter to confirm");
		expect(all).toContain("Press Esc to cancel");
	});

	it("exits on Ctrl+C", async () => {
		const io = createMockIO();
		const selectOpts: SelectPromptOptions = { ...io.opts() };
		promptSelect("Pick one", items, () => {}, selectOpts);
		sendKey(io.stdin, "\x03");
		await tick();
		expect(io.getExitCode()).toBe(0);
	});

	it("shows selected item label in summary after confirm", async () => {
		const io = createMockIO();
		const selectOpts: SelectPromptOptions = { ...io.opts() };
		promptSelect("Pick one", items, () => {}, selectOpts);
		sendKey(io.stdin, "\x1b[B"); // down to B
		await tick();
		sendKey(io.stdin, "\r");
		await tick();
		const all = stripAnsi(io.output.join(""));
		// After confirm, summary should show selected label
		expect(all).toContain("Option B");
	});

	it("renders key hints with navigate and select", () => {
		const io = createMockIO();
		const selectOpts: SelectPromptOptions = { ...io.opts() };
		promptSelect("Pick one", items, () => {}, selectOpts);
		const all = stripAnsi(io.output.join(""));
		expect(all).toContain("\u2191\u2193: navigate");
		expect(all).toContain("enter: select");
	});

	it("renders esc: back hint when backItem is set", () => {
		const io = createMockIO();
		const selectOpts: SelectPromptOptions = {
			...io.opts(),
			backItem: "\u2190 Back",
		};
		promptSelect("Pick one", items, () => {}, selectOpts);
		const all = stripAnsi(io.output.join(""));
		expect(all).toContain("esc: back");
	});

	it("does not render esc: back hint when no backItem", () => {
		const io = createMockIO();
		const selectOpts: SelectPromptOptions = { ...io.opts() };
		promptSelect("Pick one", items, () => {}, selectOpts);
		const all = stripAnsi(io.output.join(""));
		expect(all).not.toContain("esc: back");
	});

	it("clearUp erases exactly 5 lines on confirm (3 items, no gradient hints)", async () => {
		const io = createMockIO();
		const selectOpts: SelectPromptOptions = { ...io.opts() };
		promptSelect("Pick one", items, () => {}, selectOpts);
		const beforeConfirm = io.output.length;
		sendKey(io.stdin, "\r");
		await tick();
		// 5 lines: title + 3 items + key hint
		expect(countClearUpLines(io.output, beforeConfirm)).toBe(5);
	});

	it("clearUp erases correct lines with gradient hints", async () => {
		const io = createMockIO();
		const selectOpts: SelectPromptOptions = {
			...io.opts(),
			hint: ["Tip 1", "Tip 2"],
		};
		promptSelect("Pick one", items, () => {}, selectOpts);
		const beforeConfirm = io.output.length;
		sendKey(io.stdin, "\r");
		await tick();
		// 5 + 3 (sym.end + 2 hints) = 8
		expect(countClearUpLines(io.output, beforeConfirm)).toBe(8);
	});

	it("clearUp erases correct lines on back with backItem", async () => {
		const io = createMockIO();
		const selectOpts: SelectPromptOptions = {
			...io.opts(),
			backItem: "\u2190 Back",
		};
		promptSelect("Pick one", items, () => {}, selectOpts);
		const beforeBack = io.output.length;
		sendKey(io.stdin, "\x1b"); // escape
		await tick();
		// 5 lines: title + 3 items + key hint
		expect(countClearUpLines(io.output, beforeBack)).toBe(5);
	});
});

// ─── promptMultiSelect ───────────────────────────────────────────────────────

describe("promptMultiSelect", () => {
	const items: MultiSelectItem[] = [
		{ label: "Alpha", value: "alpha" },
		{ label: "Beta", value: "beta" },
		{ label: "Gamma", value: "gamma" },
	];

	it("renders title", () => {
		const io = createMockIO();
		promptMultiSelect("Select items", items, () => {}, io.opts());
		const all = stripAnsi(io.output.join(""));
		expect(all).toContain("Select items");
	});

	it("renders all items with checkboxes", () => {
		const io = createMockIO();
		promptMultiSelect("Select", items, () => {}, io.opts());
		const all = stripAnsi(io.output.join(""));
		expect(all).toContain("Alpha");
		expect(all).toContain("Beta");
		expect(all).toContain("Gamma");
	});

	it("items default to checked", () => {
		const io = createMockIO();
		promptMultiSelect("Select", items, () => {}, io.opts());
		const all = io.output.join("");
		// Checked items use filled square with green
		const filledCount = (all.match(/\u25A0/g) || []).length;
		expect(filledCount).toBeGreaterThanOrEqual(3);
	});

	it("respects checked: false on individual items", () => {
		const io = createMockIO();
		const mixedItems: MultiSelectItem[] = [
			{ label: "A", value: "a", checked: true },
			{ label: "B", value: "b", checked: false },
			{ label: "C", value: "c" },
		];
		promptMultiSelect("Select", mixedItems, () => {}, io.opts());
		const all = io.output.join("");
		// B should have empty square
		const emptyCount = (all.match(/\u25A1/g) || []).length;
		expect(emptyCount).toBeGreaterThanOrEqual(1);
	});

	it("toggles selection on Space", async () => {
		const io = createMockIO();
		let result: string[] | undefined;
		promptMultiSelect(
			"Select",
			items,
			(v) => {
				result = v;
			},
			io.opts(),
		);
		// First item is selected (cursor at 0), press space to deselect
		sendKey(io.stdin, " ");
		await tick();
		sendKey(io.stdin, "\r"); // confirm
		await tick();
		// Should have beta and gamma but not alpha
		expect(result).toEqual(["beta", "gamma"]);
	});

	it("selects all with A key", async () => {
		const io = createMockIO();
		let result: string[] | undefined;
		const uncheckedItems: MultiSelectItem[] = [
			{ label: "A", value: "a", checked: false },
			{ label: "B", value: "b", checked: false },
			{ label: "C", value: "c", checked: false },
		];
		promptMultiSelect(
			"Select",
			uncheckedItems,
			(v) => {
				result = v;
			},
			io.opts(),
		);
		sendKey(io.stdin, "A"); // select all
		await tick();
		sendKey(io.stdin, "\r");
		await tick();
		expect(result).toEqual(["a", "b", "c"]);
	});

	it("deselects all with A when all are selected", async () => {
		const io = createMockIO();
		let result: string[] | undefined;
		promptMultiSelect(
			"Select",
			items,
			(v) => {
				result = v;
			},
			io.opts(),
		);
		sendKey(io.stdin, "a"); // all are selected, so A deselects all
		await tick();
		sendKey(io.stdin, "\r");
		await tick();
		expect(result).toEqual([]);
	});

	it("returns selected values on Enter", async () => {
		const io = createMockIO();
		let result: string[] | undefined;
		promptMultiSelect(
			"Select",
			items,
			(v) => {
				result = v;
			},
			io.opts(),
		);
		sendKey(io.stdin, "\r");
		await tick();
		expect(result).toEqual(["alpha", "beta", "gamma"]);
	});

	it("returns empty array on Escape", async () => {
		const io = createMockIO();
		let result: string[] | undefined;
		promptMultiSelect(
			"Select",
			items,
			(v) => {
				result = v;
			},
			io.opts(),
		);
		sendKey(io.stdin, "\x1b");
		await tick();
		expect(result).toEqual([]);
	});

	it("shows summary with count after confirm", async () => {
		const io = createMockIO();
		promptMultiSelect("Select", items, () => {}, io.opts());
		// Deselect first item
		sendKey(io.stdin, " ");
		await tick();
		sendKey(io.stdin, "\r");
		await tick();
		const all = stripAnsi(io.output.join(""));
		expect(all).toContain("2 of 3");
	});

	it("exits on Ctrl+C", async () => {
		const io = createMockIO();
		promptMultiSelect("Select", items, () => {}, io.opts());
		sendKey(io.stdin, "\x03");
		await tick();
		expect(io.getExitCode()).toBe(0);
	});

	it("renders complete key hints", () => {
		const io = createMockIO();
		promptMultiSelect("Select", items, () => {}, io.opts());
		const all = stripAnsi(io.output.join(""));
		expect(all).toContain("\u2191\u2193: navigate");
		expect(all).toContain("space: toggle");
		expect(all).toContain("a: all");
		expect(all).toContain("enter: confirm");
		expect(all).toContain("esc: skip");
	});

	it("clearUp erases exactly 5 lines on confirm (3 items)", async () => {
		const io = createMockIO();
		promptMultiSelect("Select", items, () => {}, io.opts());
		const beforeConfirm = io.output.length;
		sendKey(io.stdin, "\r");
		await tick();
		// 5 lines: title + 3 items + hint
		expect(countClearUpLines(io.output, beforeConfirm)).toBe(5);
	});

	it("clearUp erases exactly 5 lines on Escape (3 items)", async () => {
		const io = createMockIO();
		promptMultiSelect("Select", items, () => {}, io.opts());
		const beforeEsc = io.output.length;
		sendKey(io.stdin, "\x1b");
		await tick();
		expect(countClearUpLines(io.output, beforeEsc)).toBe(5);
	});
});
