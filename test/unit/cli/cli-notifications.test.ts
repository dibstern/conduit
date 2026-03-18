// ─── Notifications Setup Wizard — Unit Tests (Ticket 8.14) ─────────────────────
// Tests for showNotificationWizard: two-toggle flow, Tailscale, HTTPS, QR sections.
// Uses mock stdin (EventEmitter), stdout, and exit from the prompts test pattern.

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
	type NotificationWizardOptions,
	showNotificationWizard,
} from "../../../src/lib/cli/cli-notifications.js";

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

/** Create mock I/O for the wizard. */
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
		opts(
			overrides?: Partial<NotificationWizardOptions>,
		): NotificationWizardOptions {
			return {
				stdin: stdin as unknown as NotificationWizardOptions["stdin"],
				stdout,
				exit,
				onBack: vi.fn(),
				config: { tls: false, port: 2633 },
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

// ─── Header & Toggles ────────────────────────────────────────────────────────

describe("header and toggles", () => {
	it("shows 'Setup Notifications' header", async () => {
		const io = createMockIO();
		void showNotificationWizard(io.opts());
		await tick();

		expect(io.text()).toContain("Setup Notifications");

		// Clean up by cancelling
		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("renders toggle 1: remote access prompt", async () => {
		const io = createMockIO();
		void showNotificationWizard(io.opts());
		await tick();

		const text = io.text();
		expect(text).toContain("Access from outside your network?");
		expect(text).toContain("Requires Tailscale on both devices");

		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("renders toggle 2: push notifications prompt after toggle 1", async () => {
		const io = createMockIO();
		void showNotificationWizard(io.opts());
		await tick();

		// Answer toggle 1 (No, press Enter)
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		const text = io.text();
		expect(text).toContain("Want push notifications?");
		expect(text).toContain("Requires HTTPS (mkcert certificate)");

		io.stdin.emit("data", "\x03");
		await tick();
	});
});

// ─── Neither selected ─────────────────────────────────────────────────────────

describe("neither selected", () => {
	it("shows 'All set!' message when neither toggle is selected", async () => {
		const onBack = vi.fn();
		const io = createMockIO();
		void showNotificationWizard(io.opts({ onBack }));
		await tick();

		// Toggle 1: No (default), press Enter
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		// Toggle 2: No (default), press Enter
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		const text = io.text();
		expect(text).toContain("All set!");
		expect(text).toContain("No additional setup needed.");

		// Press Enter on "Back?" select to complete
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		expect(onBack).toHaveBeenCalled();
	});
});

// ─── Tailscale Section ────────────────────────────────────────────────────────

describe("tailscale section", () => {
	it("shows Tailscale section when wantRemote is selected", async () => {
		const io = createMockIO();
		void showNotificationWizard(
			io.opts({
				getTailscaleIP: () => null,
			}),
		);
		await tick();

		// Toggle 1: Yes (press 'y' then Enter)
		await sendKeys(io.stdin, ["y", "\r"]);
		await tick();

		// Toggle 2: No, Enter
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		const text = io.text();
		expect(text).toContain("Tailscale Setup");

		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("shows Tailscale IP in green when connected", async () => {
		const io = createMockIO();
		void showNotificationWizard(
			io.opts({
				getTailscaleIP: () => "100.64.1.5",
			}),
		);
		await tick();

		// Toggle 1: Yes
		await sendKeys(io.stdin, ["y", "\r"]);
		await tick();

		// Toggle 2: No
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		const text = io.text();
		expect(text).toContain("Tailscale is running");
		expect(text).toContain("100.64.1.5");
		// Check for green ANSI
		expect(io.raw()).toContain("\x1b[32m");

		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("shows warning when Tailscale not connected", async () => {
		const io = createMockIO();
		void showNotificationWizard(
			io.opts({
				getTailscaleIP: () => null,
			}),
		);
		await tick();

		// Toggle 1: Yes
		await sendKeys(io.stdin, ["y", "\r"]);
		await tick();

		// Toggle 2: No
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		const text = io.text();
		expect(text).toContain("Tailscale not found");
		// Check for yellow ANSI
		expect(io.raw()).toContain("\x1b[33m");

		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("re-check re-renders Tailscale section", async () => {
		let callCount = 0;
		const io = createMockIO();
		void showNotificationWizard(
			io.opts({
				getTailscaleIP: () => {
					callCount++;
					return callCount >= 2 ? "100.64.1.5" : null;
				},
			}),
		);
		await tick();

		// Toggle 1: Yes
		await sendKeys(io.stdin, ["y", "\r"]);
		await tick();

		// Toggle 2: No
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		// First render: not found. Select "Re-check" (first item, Enter)
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		// Should now show "Tailscale is running" after re-check
		const text = io.text();
		expect(text).toContain("Tailscale is running");
		expect(callCount).toBeGreaterThanOrEqual(2);

		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("Back from Tailscale calls onBack", async () => {
		const onBack = vi.fn();
		const io = createMockIO();
		void showNotificationWizard(
			io.opts({
				onBack,
				getTailscaleIP: () => null,
			}),
		);
		await tick();

		// Toggle 1: Yes
		await sendKeys(io.stdin, ["y", "\r"]);
		await tick();

		// Toggle 2: No
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		// Select "Back" (second item: down, Enter)
		await sendKeys(io.stdin, ["\x1b[B", "\r"]);
		await tick();

		expect(onBack).toHaveBeenCalled();
	});
});

// ─── HTTPS Section ────────────────────────────────────────────────────────────

describe("HTTPS section", () => {
	it("shows HTTPS section when wantPush is selected", async () => {
		const io = createMockIO();
		void showNotificationWizard(
			io.opts({
				hasMkcert: () => true,
			}),
		);
		await tick();

		// Toggle 1: No
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		// Toggle 2: Yes
		await sendKeys(io.stdin, ["y", "\r"]);
		await tick();

		const text = io.text();
		expect(text).toContain("HTTPS Setup");

		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("shows green status when mkcert is installed", async () => {
		const io = createMockIO();
		void showNotificationWizard(
			io.opts({
				hasMkcert: () => true,
			}),
		);
		await tick();

		// Toggle 1: No
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		// Toggle 2: Yes
		await sendKeys(io.stdin, ["y", "\r"]);
		await tick();

		const text = io.text();
		expect(text).toContain("mkcert is installed");
		expect(io.raw()).toContain("\x1b[32m"); // green

		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("shows warning when mkcert not found", async () => {
		const io = createMockIO();
		void showNotificationWizard(
			io.opts({
				hasMkcert: () => false,
				platform: "darwin",
			}),
		);
		await tick();

		// Toggle 1: No
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		// Toggle 2: Yes
		await sendKeys(io.stdin, ["y", "\r"]);
		await tick();

		const text = io.text();
		expect(text).toContain("mkcert not found");
		expect(io.raw()).toContain("\x1b[33m"); // yellow

		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("re-check re-renders HTTPS section", async () => {
		let callCount = 0;
		const io = createMockIO();
		void showNotificationWizard(
			io.opts({
				hasMkcert: () => {
					callCount++;
					return callCount >= 2;
				},
				platform: "darwin",
			}),
		);
		await tick();

		// Toggle 1: No
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		// Toggle 2: Yes
		await sendKeys(io.stdin, ["y", "\r"]);
		await tick();

		// First render: not found. Select "Re-check" (first item, Enter)
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		const text = io.text();
		expect(text).toContain("mkcert is installed");
		expect(callCount).toBeGreaterThanOrEqual(2);

		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("triggers restartWithTLS when mkcert installed but not yet TLS", async () => {
		const restartWithTLS = vi.fn().mockResolvedValue({
			ok: true,
			newConfig: { tls: true, port: 2633 },
		});
		const io = createMockIO();
		void showNotificationWizard(
			io.opts({
				hasMkcert: () => true,
				config: { tls: false, port: 2633 },
				restartWithTLS,
			}),
		);
		await tick();

		// Toggle 1: No
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		// Toggle 2: Yes
		await sendKeys(io.stdin, ["y", "\r"]);
		await tick(30);

		expect(restartWithTLS).toHaveBeenCalled();
		const text = io.text();
		expect(text).toContain("Restarting server with HTTPS");

		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("skips HTTPS section when !wantPush", async () => {
		const io = createMockIO();
		void showNotificationWizard(
			io.opts({
				getTailscaleIP: () => "100.64.1.5",
				hasMkcert: () => true,
			}),
		);
		await tick();

		// Toggle 1: Yes (remote)
		await sendKeys(io.stdin, ["y", "\r"]);
		await tick();

		// Toggle 2: No (no push)
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		const text = io.text();
		// Should skip HTTPS and go straight to QR
		expect(text).not.toContain("HTTPS Setup");
		expect(text).toContain("Continue on your device");

		io.stdin.emit("data", "\x03");
		await tick();
	});
});

// ─── Setup QR Section ─────────────────────────────────────────────────────────

describe("setup QR section", () => {
	it("displays URL", async () => {
		const io = createMockIO();
		void showNotificationWizard(
			io.opts({
				getTailscaleIP: () => "100.64.1.5",
			}),
		);
		await tick();

		// Toggle 1: Yes
		await sendKeys(io.stdin, ["y", "\r"]);
		await tick();

		// Toggle 2: No
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		const text = io.text();
		expect(text).toContain("Continue on your device");
		expect(text).toContain("Or open:");

		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("uses HTTP onboarding port (port+1) when TLS is active", async () => {
		const restartWithTLS = vi.fn().mockResolvedValue({
			ok: true,
			newConfig: { tls: true, port: 2633 },
		});
		const io = createMockIO();
		void showNotificationWizard(
			io.opts({
				hasMkcert: () => true,
				config: { tls: false, port: 2633 },
				restartWithTLS,
				getAllIPs: () => ["192.168.1.50"],
			}),
		);
		await tick();

		// Toggle 1: No
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		// Toggle 2: Yes
		await sendKeys(io.stdin, ["y", "\r"]);
		await tick(30);

		const text = io.text();
		// After restartWithTLS updates config.tls to true, port+1 = 2634
		expect(text).toContain(":2634/setup");

		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("uses main port when no TLS", async () => {
		const io = createMockIO();
		void showNotificationWizard(
			io.opts({
				getTailscaleIP: () => "100.64.1.5",
				config: { tls: false, port: 2633 },
			}),
		);
		await tick();

		// Toggle 1: Yes
		await sendKeys(io.stdin, ["y", "\r"]);
		await tick();

		// Toggle 2: No
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		const text = io.text();
		expect(text).toContain(":2633/setup");

		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("uses Tailscale IP for remote", async () => {
		const io = createMockIO();
		void showNotificationWizard(
			io.opts({
				getTailscaleIP: () => "100.64.1.5",
				config: { tls: false, port: 2633 },
			}),
		);
		await tick();

		// Toggle 1: Yes (remote)
		await sendKeys(io.stdin, ["y", "\r"]);
		await tick();

		// Toggle 2: No
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		const text = io.text();
		expect(text).toContain("http://100.64.1.5:2633/setup");

		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("uses LAN IP for local", async () => {
		const io = createMockIO();
		void showNotificationWizard(
			io.opts({
				getAllIPs: () => ["192.168.1.50"],
				hasMkcert: () => true,
				config: { tls: false, port: 2633 },
			}),
		);
		await tick();

		// Toggle 1: No (local)
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		// Toggle 2: Yes
		await sendKeys(io.stdin, ["y", "\r"]);
		await tick();

		const text = io.text();
		expect(text).toContain("http://192.168.1.50:2633/setup");

		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("appends ?mode=lan for local", async () => {
		const io = createMockIO();
		void showNotificationWizard(
			io.opts({
				getAllIPs: () => ["192.168.1.50"],
				hasMkcert: () => true,
				config: { tls: false, port: 2633 },
			}),
		);
		await tick();

		// Toggle 1: No (local)
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		// Toggle 2: Yes
		await sendKeys(io.stdin, ["y", "\r"]);
		await tick();

		const text = io.text();
		expect(text).toContain("?mode=lan");

		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("Back from QR calls onBack", async () => {
		const onBack = vi.fn();
		const io = createMockIO();
		void showNotificationWizard(
			io.opts({
				onBack,
				getTailscaleIP: () => "100.64.1.5",
				config: { tls: false, port: 2633 },
			}),
		);
		await tick();

		// Toggle 1: Yes (remote)
		await sendKeys(io.stdin, ["y", "\r"]);
		await tick();

		// Toggle 2: No
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		// Now on QR section, select "Back?" (Enter on first item)
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		expect(onBack).toHaveBeenCalled();
	});

	it("displays QR art when generateQR returns valid art", async () => {
		const io = createMockIO();
		void showNotificationWizard(
			io.opts({
				getTailscaleIP: () => "100.64.1.5",
				config: { tls: false, port: 2633 },
				generateQR: () => "\u2588\u2580\u2580\u2588\n\u2588\u2584\u2584\u2588",
			}),
		);
		await tick();

		// Toggle 1: Yes (remote)
		await sendKeys(io.stdin, ["y", "\r"]);
		await tick();

		// Toggle 2: No
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		const text = io.text();
		// QR art characters should be rendered
		expect(text).toContain("\u2588\u2580\u2580\u2588");

		io.stdin.emit("data", "\x03");
		await tick();
	});

	it("skips QR art when generateQR returns fallback string", async () => {
		const io = createMockIO();
		void showNotificationWizard(
			io.opts({
				getTailscaleIP: () => "100.64.1.5",
				config: { tls: false, port: 2633 },
				generateQR: () => "[QR code for: http://100.64.1.5:2633/setup]",
			}),
		);
		await tick();

		// Toggle 1: Yes (remote)
		await sendKeys(io.stdin, ["y", "\r"]);
		await tick();

		// Toggle 2: No
		await sendKeys(io.stdin, ["\r"]);
		await tick();

		const text = io.text();
		// Fallback "[QR..." should be filtered out
		expect(text).not.toContain("[QR code");
		// URL should still be shown
		expect(text).toContain("Or open:");

		io.stdin.emit("data", "\x03");
		await tick();
	});
});
