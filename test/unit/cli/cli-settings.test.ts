// ─── Settings Menu — Unit Tests (Ticket 8.12) ─────────────────────────────────
// Tests for showSettingsMenu: detection status display, dynamic menu items,
// PIN set/change/remove, keep-awake toggle, log viewing, notification setup,
// and back navigation. Uses mock stdin/stdout/exit pattern from cli-menu tests.

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type {
	SettingsInfo,
	SettingsMenuOptions,
} from "../../../src/lib/cli/cli-settings.js";
import { showSettingsMenu } from "../../../src/lib/cli/cli-settings.js";

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

/** Default settings info for tests. */
function defaultSettingsInfo(overrides?: Partial<SettingsInfo>): SettingsInfo {
	return {
		tailscaleIP: null,
		hasMkcert: false,
		tlsEnabled: false,
		pinEnabled: false,
		keepAwake: false,
		...overrides,
	};
}

/** Create mock I/O for the settings menu. */
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
		/** Get all output as a single stripped string. */
		text: () => stripAnsi(output.join("")),
		/** Get all raw output as a single string. */
		raw: () => output.join(""),
		opts(overrides?: Partial<SettingsMenuOptions>): SettingsMenuOptions {
			return {
				stdin: stdin as unknown as SettingsMenuOptions["stdin"],
				stdout,
				exit,
				getSettingsInfo: () => defaultSettingsInfo(),
				setPin: vi.fn().mockResolvedValue({ ok: true }),
				removePin: vi.fn().mockResolvedValue({ ok: true }),
				setKeepAwake: vi.fn().mockResolvedValue({ ok: true }),
				onBack: vi.fn(),
				isMacOS: false,
				...overrides,
			};
		},
	};
}

/** Wait for a given number of milliseconds. */
function tick(ms = 15): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Send a sequence of keys with delays between them. */
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

// ─── Settings header and status display ─────────────────────────────────────

describe("settings header", () => {
	it("renders Settings header", async () => {
		const io = createMockIO();
		void showSettingsMenu(io.opts());
		await tick();

		expect(io.text()).toContain("Settings");

		// Clean up with Ctrl+C
		io.stdin.emit("data", "\x03");
		await tick();
	});
});

describe("detection status: Tailscale", () => {
	it("shows Tailscale connected with IP", async () => {
		const io = createMockIO();
		void showSettingsMenu(
			io.opts({
				getSettingsInfo: () =>
					defaultSettingsInfo({ tailscaleIP: "100.64.0.1" }),
			}),
		);
		await tick();

		const text = io.text();
		expect(text).toContain("Tailscale");
		expect(text).toContain("Connected");
		expect(text).toContain("100.64.0.1");

		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("shows Tailscale not detected", async () => {
		const io = createMockIO();
		void showSettingsMenu(
			io.opts({
				getSettingsInfo: () => defaultSettingsInfo({ tailscaleIP: null }),
			}),
		);
		await tick();

		const text = io.text();
		expect(text).toContain("Tailscale");
		expect(text).toContain("Not detected");

		io.stdin.emit("data", "\x03");
		await tick();
	});
});

describe("detection status: mkcert", () => {
	it("shows mkcert installed", async () => {
		const io = createMockIO();
		void showSettingsMenu(
			io.opts({
				getSettingsInfo: () => defaultSettingsInfo({ hasMkcert: true }),
			}),
		);
		await tick();

		const text = io.text();
		expect(text).toContain("mkcert");
		expect(text).toContain("Installed");

		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("shows mkcert not found", async () => {
		const io = createMockIO();
		void showSettingsMenu(
			io.opts({
				getSettingsInfo: () => defaultSettingsInfo({ hasMkcert: false }),
			}),
		);
		await tick();

		const text = io.text();
		expect(text).toContain("mkcert");
		expect(text).toContain("Not found");

		io.stdin.emit("data", "\x03");
		await tick();
	});
});

describe("detection status: HTTPS", () => {
	it("shows HTTPS enabled", async () => {
		const io = createMockIO();
		void showSettingsMenu(
			io.opts({
				getSettingsInfo: () => defaultSettingsInfo({ tlsEnabled: true }),
			}),
		);
		await tick();

		const text = io.text();
		expect(text).toContain("HTTPS");
		expect(text).toContain("Enabled");

		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("shows HTTPS disabled", async () => {
		const io = createMockIO();
		void showSettingsMenu(
			io.opts({
				getSettingsInfo: () => defaultSettingsInfo({ tlsEnabled: false }),
			}),
		);
		await tick();

		const text = io.text();
		expect(text).toContain("HTTPS");
		expect(text).toContain("Disabled");

		io.stdin.emit("data", "\x03");
		await tick();
	});
});

describe("detection status: PIN", () => {
	it("shows PIN enabled", async () => {
		const io = createMockIO();
		void showSettingsMenu(
			io.opts({
				getSettingsInfo: () => defaultSettingsInfo({ pinEnabled: true }),
			}),
		);
		await tick();

		const text = io.text();
		expect(text).toContain("PIN");
		// "Enabled" is in the status line (green)
		expect(io.raw()).toContain("\x1b[32m"); // green for Enabled

		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("shows PIN off", async () => {
		const io = createMockIO();
		void showSettingsMenu(
			io.opts({
				getSettingsInfo: () => defaultSettingsInfo({ pinEnabled: false }),
			}),
		);
		await tick();

		const text = io.text();
		expect(text).toContain("PIN");
		expect(text).toContain("Off");

		io.stdin.emit("data", "\x03");
		await tick();
	});
});

describe("detection status: keep awake", () => {
	it("shows keep awake on macOS", async () => {
		const io = createMockIO();
		void showSettingsMenu(
			io.opts({
				isMacOS: true,
				getSettingsInfo: () => defaultSettingsInfo({ keepAwake: true }),
			}),
		);
		await tick();

		const text = io.text();
		expect(text).toContain("Keep awake");

		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("hides keep awake on non-macOS", async () => {
		const io = createMockIO();
		void showSettingsMenu(
			io.opts({
				isMacOS: false,
				getSettingsInfo: () => defaultSettingsInfo({ keepAwake: false }),
			}),
		);
		await tick();

		const text = io.text();
		expect(text).not.toContain("Keep awake");

		io.stdin.emit("data", "\x03");
		await tick();
	});
});

// ─── Dynamic menu items ─────────────────────────────────────────────────────

describe("menu items: PIN not set", () => {
	it("shows Set PIN when no PIN", async () => {
		const io = createMockIO();
		void showSettingsMenu(
			io.opts({
				getSettingsInfo: () => defaultSettingsInfo({ pinEnabled: false }),
			}),
		);
		await tick();

		const text = io.text();
		expect(text).toContain("Set PIN");
		expect(text).not.toContain("Change PIN");
		expect(text).not.toContain("Remove PIN");

		io.stdin.emit("data", "\x03");
		await tick();
	});
});

describe("menu items: PIN set", () => {
	it("shows Change PIN and Remove PIN when PIN is set", async () => {
		const io = createMockIO();
		void showSettingsMenu(
			io.opts({
				getSettingsInfo: () => defaultSettingsInfo({ pinEnabled: true }),
			}),
		);
		await tick();

		const text = io.text();
		expect(text).toContain("Change PIN");
		expect(text).toContain("Remove PIN");
		expect(text).not.toContain("Set PIN");

		io.stdin.emit("data", "\x03");
		await tick();
	});
});

// ─── PIN set action ─────────────────────────────────────────────────────────

describe("PIN set action", () => {
	it("calls setPin callback when PIN entered", async () => {
		const setPin = vi.fn().mockResolvedValue({ ok: true });
		const io = createMockIO();
		let renderCount = 0;

		void showSettingsMenu(
			io.opts({
				setPin,
				getSettingsInfo: () => {
					renderCount++;
					if (renderCount > 1) {
						// On re-render, clean up
						setTimeout(() => io.stdin.emit("data", "\x03"), 30);
					}
					return defaultSettingsInfo({ pinEnabled: false });
				},
			}),
		);
		await tick();

		// Navigate to "Set PIN" (index 1: after "Setup notifications")
		await sendKeys(io.stdin, ["\x1b[B", "\r"]);
		await tick();

		// The promptPin is now active — type 4 digits and Enter
		await sendKeys(io.stdin, ["1", "2", "3", "4", "\r"]);
		await tick(50);

		expect(setPin).toHaveBeenCalledWith("1234");
	});
});

// ─── PIN remove action ──────────────────────────────────────────────────────

describe("PIN remove action", () => {
	it("calls removePin callback", async () => {
		const removePin = vi.fn().mockResolvedValue({ ok: true });
		const io = createMockIO();
		let renderCount = 0;

		void showSettingsMenu(
			io.opts({
				removePin,
				getSettingsInfo: () => {
					renderCount++;
					if (renderCount > 1) {
						setTimeout(() => io.stdin.emit("data", "\x03"), 30);
					}
					return defaultSettingsInfo({ pinEnabled: true });
				},
			}),
		);
		await tick();

		// With PIN enabled, items are:
		// 0: Setup notifications
		// 1: Change PIN
		// 2: Remove PIN
		// 3: View logs
		await sendKeys(io.stdin, ["\x1b[B", "\x1b[B", "\r"]);
		await tick(50);

		expect(removePin).toHaveBeenCalledOnce();
		expect(io.text()).toContain("PIN removed");
	});
});

// ─── Keep awake toggle ──────────────────────────────────────────────────────

describe("keep awake toggle", () => {
	it("calls setKeepAwake with toggled value", async () => {
		const setKeepAwake = vi.fn().mockResolvedValue({ ok: true });
		const io = createMockIO();
		let renderCount = 0;

		void showSettingsMenu(
			io.opts({
				setKeepAwake,
				isMacOS: true,
				getSettingsInfo: () => {
					renderCount++;
					if (renderCount > 1) {
						setTimeout(() => io.stdin.emit("data", "\x03"), 30);
					}
					return defaultSettingsInfo({
						pinEnabled: false,
						keepAwake: false,
					});
				},
			}),
		);
		await tick();

		// Items with macOS + no PIN:
		// 0: Setup notifications
		// 1: Set PIN
		// 2: Enable keep awake
		// 3: View logs
		await sendKeys(io.stdin, ["\x1b[B", "\x1b[B", "\r"]);
		await tick(50);

		expect(setKeepAwake).toHaveBeenCalledWith(true);
	});
});

// ─── View logs ──────────────────────────────────────────────────────────────

describe("view logs", () => {
	it("shows last 30 lines of log file", async () => {
		const lines = Array.from({ length: 40 }, (_, i) => `log line ${i + 1}`);
		const logContent = lines.join("\n");
		const readFile = vi.fn().mockReturnValue(logContent);
		const io = createMockIO();

		void showSettingsMenu(
			io.opts({
				logPath: "/tmp/daemon.log",
				readFile,
				getSettingsInfo: () => defaultSettingsInfo({ pinEnabled: false }),
			}),
		);
		await tick();

		// Items with no PIN, non-macOS:
		// 0: Setup notifications
		// 1: Set PIN
		// 2: View logs
		await sendKeys(io.stdin, ["\x1b[B", "\x1b[B", "\r"]);
		await tick();

		const text = io.text();
		expect(text).toContain("Daemon logs");
		// Should show last 30 lines (lines 11-40)
		expect(text).toContain("log line 40");
		expect(text).toContain("log line 11");
		expect(text).not.toContain("log line 1\n");
		expect(readFile).toHaveBeenCalledWith("/tmp/daemon.log");

		// Clean up: press Enter on "Back?" prompt
		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("shows (empty) when no log file", async () => {
		const readFile = vi.fn().mockImplementation(() => {
			throw new Error("ENOENT");
		});
		const io = createMockIO();

		void showSettingsMenu(
			io.opts({
				logPath: "/tmp/missing.log",
				readFile,
				getSettingsInfo: () => defaultSettingsInfo({ pinEnabled: false }),
			}),
		);
		await tick();

		// Navigate to "View logs" (index 2)
		await sendKeys(io.stdin, ["\x1b[B", "\x1b[B", "\r"]);
		await tick();

		expect(io.text()).toContain("(empty)");

		// Clean up
		io.stdin.emit("data", "\x03");
		await tick();
	});
});

// ─── Setup notifications ────────────────────────────────────────────────────

describe("setup notifications", () => {
	it("calls onSetupNotifications callback", async () => {
		const onSetupNotifications = vi.fn();
		const io = createMockIO();
		let renderCount = 0;

		void showSettingsMenu(
			io.opts({
				onSetupNotifications,
				getSettingsInfo: () => {
					renderCount++;
					if (renderCount > 1) {
						setTimeout(() => io.stdin.emit("data", "\x03"), 30);
					}
					return defaultSettingsInfo();
				},
			}),
		);
		await tick();

		// First item is "Setup notifications"
		await sendKeys(io.stdin, ["\r"]);
		await tick(50);

		expect(onSetupNotifications).toHaveBeenCalledOnce();
	});
});

// ─── Back navigation ────────────────────────────────────────────────────────

describe("back navigation", () => {
	it("calls onBack callback via Backspace", async () => {
		const onBack = vi.fn();
		const io = createMockIO();
		const menuPromise = showSettingsMenu(io.opts({ onBack }));
		await tick();

		// Backspace triggers the back item
		await sendKeys(io.stdin, ["\x7f"]);
		await menuPromise;

		expect(onBack).toHaveBeenCalledOnce();
	});

	it("renders visible Back menu item", async () => {
		const io = createMockIO();
		void showSettingsMenu(io.opts());
		await tick();

		// The "Back" item should be rendered in the menu
		expect(io.text()).toContain("Back");

		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("selecting visible Back item calls onBack", async () => {
		const onBack = vi.fn();
		const io = createMockIO();
		// non-macOS, no PIN: items = [notifications, set PIN, logs, back] → 4 items
		const menuPromise = showSettingsMenu(
			io.opts({
				onBack,
				getSettingsInfo: () => defaultSettingsInfo({ pinEnabled: false }),
				isMacOS: false,
			}),
		);
		await tick();

		// Navigate down to last item (Back) and press Enter
		// Items: notifications(0), set PIN(1), logs(2), back(3)
		await sendKeys(io.stdin, ["\x1b[B", "\x1b[B", "\x1b[B", "\r"]);
		await menuPromise;

		expect(onBack).toHaveBeenCalledOnce();
	});

	it("Escape key triggers back", async () => {
		const onBack = vi.fn();
		const io = createMockIO();
		const menuPromise = showSettingsMenu(io.opts({ onBack }));
		await tick();

		// Escape triggers the back item
		await sendKeys(io.stdin, ["\x1b"]);
		await menuPromise;

		expect(onBack).toHaveBeenCalledOnce();
	});
});

// ─── Re-render after action ─────────────────────────────────────────────────

describe("re-render after action", () => {
	it("re-renders settings menu after PIN change", async () => {
		const setPin = vi.fn().mockResolvedValue({ ok: true });
		const io = createMockIO();
		let renderCount = 0;

		void showSettingsMenu(
			io.opts({
				setPin,
				getSettingsInfo: () => {
					renderCount++;
					if (renderCount > 1) {
						// On re-render, exit
						setTimeout(() => io.stdin.emit("data", "\x03"), 30);
					}
					return defaultSettingsInfo({ pinEnabled: false });
				},
			}),
		);
		await tick();

		// Navigate to "Set PIN" and enter a PIN
		await sendKeys(io.stdin, ["\x1b[B", "\r"]);
		await tick();
		await sendKeys(io.stdin, ["5", "6", "7", "8", "\r"]);
		await tick(50);

		// getSettingsInfo should have been called at least twice (initial + re-render)
		expect(renderCount).toBeGreaterThanOrEqual(2);
	});
});
