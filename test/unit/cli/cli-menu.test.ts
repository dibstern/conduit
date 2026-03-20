// ─── Main Menu Loop — Unit Tests (Ticket 8.10) ────────────────────────────────
// Tests for showMainMenu, renderStatus, and the full menu interaction flow.
// Uses mock stdin (EventEmitter), stdout, and exit from the prompts test pattern.

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
	type DaemonInfo,
	type MenuOptions,
	renderStatus,
	showMainMenu,
} from "../../../src/lib/cli/cli-menu.js";

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

/** Default daemon info for tests. */
function defaultDaemonInfo(overrides?: Partial<DaemonInfo>): DaemonInfo {
	return {
		port: 2633,
		url: "http://localhost:2633",
		networkUrls: [],
		projectCount: 1,
		sessionCount: 2,
		processingCount: 0,
		version: "1.0.0",
		...overrides,
	};
}

/** Create mock I/O for the menu. */
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
		opts(overrides?: Partial<MenuOptions>): MenuOptions {
			return {
				stdin: stdin as unknown as MenuOptions["stdin"],
				stdout,
				exit,
				getDaemonInfo: () => defaultDaemonInfo(),
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

// ─── renderStatus ─────────────────────────────────────────────────────────────

describe("renderStatus", () => {
	it("displays the version", () => {
		const io = createMockIO();
		const info = defaultDaemonInfo({ version: "2.5.3" });
		renderStatus(info, io.stdout);
		expect(io.text()).toContain("v2.5.3");
	});

	it("displays the URL in bold", () => {
		const io = createMockIO();
		const info = defaultDaemonInfo({ url: "https://myrelay.local:8443" });
		renderStatus(info, io.stdout);
		expect(io.text()).toContain("https://myrelay.local:8443");
		expect(io.raw()).toContain("\x1b[1m"); // bold
	});

	it("displays network URLs with Local: prefix", () => {
		const io = createMockIO();
		const info = defaultDaemonInfo({
			networkUrls: ["http://192.168.1.50:2633", "http://10.0.0.5:2633"],
		});
		renderStatus(info, io.stdout);
		const text = io.text();
		expect(text).toContain("Local: http://192.168.1.50:2633");
		expect(text).toContain("Local: http://10.0.0.5:2633");
	});

	it("displays project and session counts", () => {
		const io = createMockIO();
		const info = defaultDaemonInfo({ projectCount: 3, sessionCount: 7 });
		renderStatus(info, io.stdout);
		const text = io.text();
		expect(text).toContain("3 projects");
		expect(text).toContain("7 sessions");
	});

	it("uses singular form for 1 project/session", () => {
		const io = createMockIO();
		const info = defaultDaemonInfo({ projectCount: 1, sessionCount: 1 });
		renderStatus(info, io.stdout);
		const text = io.text();
		expect(text).toContain("1 project");
		expect(text).not.toContain("1 projects");
		expect(text).toContain("1 session");
		expect(text).not.toContain("1 sessions");
	});

	it("shows processing count in yellow when > 0", () => {
		const io = createMockIO();
		const info = defaultDaemonInfo({ processingCount: 3 });
		renderStatus(info, io.stdout);
		const text = io.text();
		expect(text).toContain("3 processing");
		// Check for yellow ANSI
		expect(io.raw()).toContain("\x1b[33m");
	});

	it("does not show processing when count is 0", () => {
		const io = createMockIO();
		const info = defaultDaemonInfo({ processingCount: 0 });
		renderStatus(info, io.stdout);
		expect(io.text()).not.toContain("processing");
	});

	it("displays QR code when qrCode is provided", () => {
		const io = createMockIO();
		const info = defaultDaemonInfo({
			qrCode: "\u2588\u2588 QR \u2588\u2588\n\u2588\u2588 QR \u2588\u2588",
		});
		renderStatus(info, io.stdout);
		expect(io.text()).toContain("QR");
	});

	it("indents each QR line with 2 spaces", () => {
		const io = createMockIO();
		const info = defaultDaemonInfo({ qrCode: "LINE1\nLINE2" });
		renderStatus(info, io.stdout);
		const raw = io.raw();
		expect(raw).toContain("  LINE1");
		expect(raw).toContain("  LINE2");
	});

	it("omits QR section when qrCode is undefined", () => {
		const io = createMockIO();
		const info = defaultDaemonInfo();
		renderStatus(info, io.stdout);
		expect(io.text()).not.toContain("\u2588\u2588");
	});

	it("displays qrCaption under QR code", () => {
		const io = createMockIO();
		const info = defaultDaemonInfo({
			qrCode: "LINE1\nLINE2",
			qrCaption: "Scan or visit: http://10.0.0.1:2634/setup",
		});
		renderStatus(info, io.stdout);
		const text = io.text();
		expect(text).toContain("Scan or visit: http://10.0.0.1:2634/setup");
	});

	it("does not show qrCaption when no QR code", () => {
		const io = createMockIO();
		const info = defaultDaemonInfo({
			qrCaption: "Scan or visit: http://10.0.0.1:2634/setup",
		});
		renderStatus(info, io.stdout);
		expect(io.text()).not.toContain("Scan or visit");
	});

	it("shows QR without caption when qrCaption absent (non-TLS)", () => {
		const io = createMockIO();
		const info = defaultDaemonInfo({
			qrCode: "LINE1\nLINE2",
		});
		renderStatus(info, io.stdout);
		const text = io.text();
		expect(text).toContain("LINE1");
		expect(text).not.toContain("Scan or visit");
	});

	it("labels network URLs with Local:", () => {
		const io = createMockIO();
		const info = defaultDaemonInfo({
			networkUrls: ["https://192.168.1.50:2633"],
		});
		renderStatus(info, io.stdout);
		expect(io.text()).toContain("Local: https://192.168.1.50:2633");
	});

	it("does not show Setup: line (removed field)", () => {
		const io = createMockIO();
		const info = defaultDaemonInfo();
		renderStatus(info, io.stdout);
		expect(io.text()).not.toContain("Setup:");
	});
});

// ─── Menu rendering ──────────────────────────────────────────────────────────

describe("menu rendering", () => {
	it("shows the logo (clear screen)", async () => {
		const io = createMockIO();
		void showMainMenu(io.opts());
		await tick();

		// Logo clears screen with \x1bc
		expect(io.raw()).toContain("\x1bc");

		// Clean up with Ctrl+C
		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("shows the version from daemon info", async () => {
		const io = createMockIO();
		void showMainMenu(
			io.opts({
				getDaemonInfo: () => defaultDaemonInfo({ version: "3.2.1" }),
			}),
		);
		await tick();

		expect(io.text()).toContain("v3.2.1");

		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("shows the URL from daemon info", async () => {
		const io = createMockIO();
		void showMainMenu(
			io.opts({
				getDaemonInfo: () =>
					defaultDaemonInfo({ url: "https://relay.example.com:443" }),
			}),
		);
		await tick();

		expect(io.text()).toContain("https://relay.example.com:443");

		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("shows project and session counts", async () => {
		const io = createMockIO();
		void showMainMenu(
			io.opts({
				getDaemonInfo: () =>
					defaultDaemonInfo({ projectCount: 5, sessionCount: 12 }),
			}),
		);
		await tick();

		const text = io.text();
		expect(text).toContain("5 projects");
		expect(text).toContain("12 sessions");

		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("shows processing count in yellow when > 0", async () => {
		const io = createMockIO();
		void showMainMenu(
			io.opts({
				getDaemonInfo: () => defaultDaemonInfo({ processingCount: 2 }),
			}),
		);
		await tick();

		expect(io.text()).toContain("2 processing");
		expect(io.raw()).toContain("\x1b[33m"); // yellow

		io.stdin.emit("data", "\x03");
		await tick();
	});
});

// ─── Menu items ──────────────────────────────────────────────────────────────

describe("menu items", () => {
	it("shows all 5 menu items", async () => {
		const io = createMockIO();
		void showMainMenu(io.opts());
		await tick();

		const text = io.text();
		expect(text).toContain("Setup notifications");
		expect(text).toContain("Projects");
		expect(text).toContain("Settings");
		expect(text).toContain("Shut down server");
		expect(text).toContain("Keep server alive & exit");

		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("selects first item by default (Enter)", async () => {
		const onSetupNotifications = vi.fn();
		const io = createMockIO();

		// Limit recursion: onSetupNotifications fires, then the menu re-renders.
		// We need to handle the second menu render too. Use Ctrl+C on re-render.
		let callCount = 0;
		void showMainMenu(
			io.opts({
				onSetupNotifications: async () => {
					onSetupNotifications();
					callCount++;
				},
				// On the second render (after callback), exit via Ctrl+C
				getDaemonInfo: () => {
					if (callCount > 0) {
						// Schedule Ctrl+C for the re-rendered menu
						setTimeout(() => io.stdin.emit("data", "\x03"), 30);
					}
					return defaultDaemonInfo();
				},
			}),
		);
		await tick();

		// Press Enter to select "Setup notifications" (first item)
		await sendKeys(io.stdin, ["\r"]);
		await tick(50);

		expect(onSetupNotifications).toHaveBeenCalled();
	});

	it("navigates to second item with down arrow", async () => {
		const onProjects = vi.fn();
		const io = createMockIO();

		let callCount = 0;
		void showMainMenu(
			io.opts({
				onProjects: async () => {
					onProjects();
					callCount++;
				},
				getDaemonInfo: () => {
					if (callCount > 0) {
						setTimeout(() => io.stdin.emit("data", "\x03"), 30);
					}
					return defaultDaemonInfo();
				},
			}),
		);
		await tick();

		// Down arrow once to "Projects", then Enter
		await sendKeys(io.stdin, ["\x1b[B", "\r"]);
		await tick(50);

		expect(onProjects).toHaveBeenCalled();
	});
});

// ─── Notifications ───────────────────────────────────────────────────────────

describe("notifications", () => {
	it("calls onSetupNotifications when selected", async () => {
		const onSetupNotifications = vi.fn();
		const io = createMockIO();

		let callCount = 0;
		void showMainMenu(
			io.opts({
				onSetupNotifications: async () => {
					onSetupNotifications();
					callCount++;
				},
				getDaemonInfo: () => {
					if (callCount > 0) {
						setTimeout(() => io.stdin.emit("data", "\x03"), 30);
					}
					return defaultDaemonInfo();
				},
			}),
		);
		await tick();

		// First item is "Setup notifications"
		await sendKeys(io.stdin, ["\r"]);
		await tick(50);

		expect(onSetupNotifications).toHaveBeenCalledOnce();
	});

	it("re-renders menu after notifications callback returns", async () => {
		const io = createMockIO();
		let renderCount = 0;

		void showMainMenu(
			io.opts({
				onSetupNotifications: async () => {},
				getDaemonInfo: () => {
					renderCount++;
					if (renderCount > 1) {
						// Second render — exit to prevent infinite loop
						setTimeout(() => io.stdin.emit("data", "\x03"), 30);
					}
					return defaultDaemonInfo();
				},
			}),
		);
		await tick();

		// Select "Setup notifications"
		await sendKeys(io.stdin, ["\r"]);
		await tick(50);

		// getDaemonInfo should have been called at least twice (initial + re-render)
		expect(renderCount).toBeGreaterThanOrEqual(2);
	});
});

// ─── Projects ────────────────────────────────────────────────────────────────

describe("projects", () => {
	it("calls onProjects when selected", async () => {
		const onProjects = vi.fn();
		const io = createMockIO();

		let callCount = 0;
		void showMainMenu(
			io.opts({
				onProjects: async () => {
					onProjects();
					callCount++;
				},
				getDaemonInfo: () => {
					if (callCount > 0) {
						setTimeout(() => io.stdin.emit("data", "\x03"), 30);
					}
					return defaultDaemonInfo();
				},
			}),
		);
		await tick();

		// Navigate to "Projects" (index 1)
		await sendKeys(io.stdin, ["\x1b[B", "\r"]);
		await tick(50);

		expect(onProjects).toHaveBeenCalledOnce();
	});

	it("re-renders menu after projects callback returns", async () => {
		const io = createMockIO();
		let renderCount = 0;

		void showMainMenu(
			io.opts({
				onProjects: async () => {},
				getDaemonInfo: () => {
					renderCount++;
					if (renderCount > 1) {
						setTimeout(() => io.stdin.emit("data", "\x03"), 30);
					}
					return defaultDaemonInfo();
				},
			}),
		);
		await tick();

		// Navigate to "Projects" and select
		await sendKeys(io.stdin, ["\x1b[B", "\r"]);
		await tick(50);

		expect(renderCount).toBeGreaterThanOrEqual(2);
	});
});

// ─── Settings ────────────────────────────────────────────────────────────────

describe("settings", () => {
	it("calls onSettings when selected", async () => {
		const onSettings = vi.fn();
		const io = createMockIO();

		let callCount = 0;
		void showMainMenu(
			io.opts({
				onSettings: async () => {
					onSettings();
					callCount++;
				},
				getDaemonInfo: () => {
					if (callCount > 0) {
						setTimeout(() => io.stdin.emit("data", "\x03"), 30);
					}
					return defaultDaemonInfo();
				},
			}),
		);
		await tick();

		// Navigate to "Settings" (index 2)
		await sendKeys(io.stdin, ["\x1b[B", "\x1b[B", "\r"]);
		await tick(50);

		expect(onSettings).toHaveBeenCalledOnce();
	});

	it("re-renders menu after settings callback returns", async () => {
		const io = createMockIO();
		let renderCount = 0;

		void showMainMenu(
			io.opts({
				onSettings: async () => {},
				getDaemonInfo: () => {
					renderCount++;
					if (renderCount > 1) {
						setTimeout(() => io.stdin.emit("data", "\x03"), 30);
					}
					return defaultDaemonInfo();
				},
			}),
		);
		await tick();

		// Navigate to "Settings" and select
		await sendKeys(io.stdin, ["\x1b[B", "\x1b[B", "\r"]);
		await tick(50);

		expect(renderCount).toBeGreaterThanOrEqual(2);
	});
});

// ─── Shutdown ────────────────────────────────────────────────────────────────

describe("shutdown", () => {
	it("shows confirmation prompt when shutdown is selected", async () => {
		const io = createMockIO();
		const menuPromise = showMainMenu(io.opts());
		await tick();

		// Navigate to "Shut down" (index 3)
		await sendKeys(io.stdin, ["\x1b[B", "\x1b[B", "\x1b[B", "\r"]);
		await tick();

		const text = io.text();
		expect(text).toContain("Shut down?");
		expect(text).toContain("Stop the relay and exit");

		// Confirm shutdown (press 'y' then Enter)
		await sendKeys(io.stdin, ["y", "\r"]);
		await menuPromise;
	});

	it("calls onShutdown when confirmed", async () => {
		const onShutdown = vi.fn();
		const io = createMockIO();
		const menuPromise = showMainMenu(io.opts({ onShutdown }));
		await tick();

		// Navigate to "Shut down" and select
		await sendKeys(io.stdin, ["\x1b[B", "\x1b[B", "\x1b[B", "\r"]);
		await tick();

		// Confirm (press 'y' then Enter)
		await sendKeys(io.stdin, ["y", "\r"]);
		await menuPromise;

		expect(onShutdown).toHaveBeenCalledOnce();
	});

	it("re-renders menu when shutdown is declined", async () => {
		const io = createMockIO();
		let renderCount = 0;

		void showMainMenu(
			io.opts({
				getDaemonInfo: () => {
					renderCount++;
					if (renderCount > 1) {
						setTimeout(() => io.stdin.emit("data", "\x03"), 30);
					}
					return defaultDaemonInfo();
				},
			}),
		);
		await tick();

		// Navigate to "Shut down" and select
		await sendKeys(io.stdin, ["\x1b[B", "\x1b[B", "\x1b[B", "\r"]);
		await tick();

		// Decline (default is No, press Enter)
		await sendKeys(io.stdin, ["\r"]);
		await tick(50);

		// Should have re-rendered (getDaemonInfo called again)
		expect(renderCount).toBeGreaterThanOrEqual(2);
	});
});

// ─── Keep alive & exit ───────────────────────────────────────────────────────

describe("keep alive & exit", () => {
	it("calls onKeepAliveExit when selected", async () => {
		const onKeepAliveExit = vi.fn();
		const io = createMockIO();
		const menuPromise = showMainMenu(io.opts({ onKeepAliveExit }));
		await tick();

		// Navigate to "Keep alive & exit" (index 4)
		await sendKeys(io.stdin, ["\x1b[B", "\x1b[B", "\x1b[B", "\x1b[B", "\r"]);
		await menuPromise;

		expect(onKeepAliveExit).toHaveBeenCalledOnce();
	});

	it("does not re-render menu after exit", async () => {
		const io = createMockIO();
		let renderCount = 0;

		const menuPromise = showMainMenu(
			io.opts({
				onKeepAliveExit: async () => {},
				getDaemonInfo: () => {
					renderCount++;
					return defaultDaemonInfo();
				},
			}),
		);
		await tick();

		// Navigate to "Keep alive & exit" and select
		await sendKeys(io.stdin, ["\x1b[B", "\x1b[B", "\x1b[B", "\x1b[B", "\r"]);
		await menuPromise;

		// Only called once for initial render
		expect(renderCount).toBe(1);
	});
});

// ─── Hotkeys ─────────────────────────────────────────────────────────────────

describe("hotkeys", () => {
	it("'o' calls onOpenBrowser", async () => {
		const onOpenBrowser = vi.fn();
		const io = createMockIO();

		let renderCount = 0;
		void showMainMenu(
			io.opts({
				onOpenBrowser,
				getDaemonInfo: () => {
					renderCount++;
					if (renderCount > 1) {
						// After re-render, exit
						setTimeout(() => io.stdin.emit("data", "\x03"), 30);
					}
					return defaultDaemonInfo();
				},
			}),
		);
		await tick();

		// Press "o"
		io.stdin.emit("data", "o");
		await tick(50);

		expect(onOpenBrowser).toHaveBeenCalledOnce();
	});

	it("'o' re-renders menu after browser open", async () => {
		const io = createMockIO();
		let renderCount = 0;

		void showMainMenu(
			io.opts({
				onOpenBrowser: async () => {},
				getDaemonInfo: () => {
					renderCount++;
					if (renderCount > 1) {
						setTimeout(() => io.stdin.emit("data", "\x03"), 30);
					}
					return defaultDaemonInfo();
				},
			}),
		);
		await tick();

		// Press "o"
		io.stdin.emit("data", "o");
		await tick(50);

		// Should have re-rendered
		expect(renderCount).toBeGreaterThanOrEqual(2);
	});
});

// ─── Edge cases ──────────────────────────────────────────────────────────────

describe("edge cases", () => {
	it("Ctrl+C calls exit", async () => {
		const io = createMockIO();

		// Don't await — Ctrl+C calls exit which doesn't resolve the promise
		void showMainMenu(io.opts());
		await tick();

		// Send Ctrl+C
		io.stdin.emit("data", "\x03");
		await tick();

		expect(io.wasExitCalled()).toBe(true);
		expect(io.getExitCode()).toBe(0);
	});

	it("getDaemonInfo async works", async () => {
		const io = createMockIO();
		void showMainMenu(
			io.opts({
				getDaemonInfo: async () => {
					// Simulate async delay
					await tick(5);
					return defaultDaemonInfo({ version: "9.9.9" });
				},
			}),
		);
		await tick(30);

		expect(io.text()).toContain("v9.9.9");

		// Clean up
		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("handles missing optional callbacks gracefully", async () => {
		const io = createMockIO();
		let renderCount = 0;

		void showMainMenu(
			io.opts({
				// No onSetupNotifications provided
				getDaemonInfo: () => {
					renderCount++;
					if (renderCount > 1) {
						setTimeout(() => io.stdin.emit("data", "\x03"), 30);
					}
					return defaultDaemonInfo();
				},
			}),
		);
		await tick();

		// Select "Setup notifications" with no callback — should not throw
		await sendKeys(io.stdin, ["\r"]);
		await tick(50);

		// Menu re-renders even with no callback
		expect(renderCount).toBeGreaterThanOrEqual(2);
	});

	it("shows open-in-browser hint", async () => {
		const io = createMockIO();
		void showMainMenu(io.opts());
		await tick();

		const text = io.text();
		expect(text).toContain("open in browser");

		// Clean up
		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("displays network URLs when present", async () => {
		const io = createMockIO();
		void showMainMenu(
			io.opts({
				getDaemonInfo: () =>
					defaultDaemonInfo({
						networkUrls: ["http://192.168.1.100:2633"],
					}),
			}),
		);
		await tick();

		expect(io.text()).toContain("Local: http://192.168.1.100:2633");

		// Clean up
		io.stdin.emit("data", "\x03");
		await tick();
	});
});
