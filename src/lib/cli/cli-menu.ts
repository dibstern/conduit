// ─── Main Menu Loop (Ticket 8.10) ─────────────────────────────────────────────
// Interactive CLI main menu for opencode-relay. Displays daemon status and
// provides menu navigation for notifications, projects, settings, shutdown,
// and keep-alive exit. Ported from claude-relay/bin/cli.js lines 1361-1482.

import { assertNever } from "../utils.js";
import { printLogo } from "./cli-setup.js";
import type { PromptOptions, SelectPromptOptions } from "./prompts.js";
import { promptSelect, promptToggle } from "./prompts.js";
import type { Writable } from "./terminal-render.js";
import { a, formatStatusLine, log } from "./terminal-render.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Information about the running daemon for status display. */
export interface DaemonInfo {
	port: number;
	url: string;
	networkUrls: string[];
	projectCount: number;
	sessionCount: number;
	processingCount: number;
	version: string;
	/** QR code art string for the relay URL (optional). */
	qrCode?: string;
	/** HTTP onboarding/setup URL shown when TLS is active (optional). */
	setupUrl?: string;
}

/** Options for the main menu loop. */
export interface MenuOptions extends PromptOptions {
	/** Daemon info for status display. */
	getDaemonInfo: () => DaemonInfo | Promise<DaemonInfo>;
	/** Callback: open the notification setup wizard. */
	onSetupNotifications?: () => void | Promise<void>;
	/** Callback: show the projects submenu. */
	onProjects?: () => void | Promise<void>;
	/** Callback: show the settings menu. */
	onSettings?: () => void | Promise<void>;
	/** Callback: shut down the relay daemon. */
	onShutdown?: () => void | Promise<void>;
	/** Callback: exit the CLI but keep the daemon running. */
	onKeepAliveExit?: () => void | Promise<void>;
	/** Callback: open the relay URL in a browser. */
	onOpenBrowser?: () => void | Promise<void>;
}

// ─── Menu Choice Values ──────────────────────────────────────────────────────

/** All possible menu choice values. */
type MenuChoice =
	| "notifications"
	| "projects"
	| "settings"
	| "shutdown"
	| "exit";

// ─── Status Rendering ────────────────────────────────────────────────────────

/**
 * Render the daemon status section to stdout.
 *
 * Displays version, URL, network URLs, project/session counts,
 * and a processing indicator (yellow when > 0).
 */
export function renderStatus(info: DaemonInfo, stdout: Writable): void {
	log(`${a.dim}v${info.version}${a.reset}`, stdout);
	log("", stdout);

	// Show QR code if available (indent each line with 2 spaces)
	if (info.qrCode) {
		const lines = info.qrCode.split("\n").map((l) => `  ${l}`);
		for (const line of lines) {
			log(line, stdout);
		}
		log("", stdout);
	}

	log(`${a.bold}${info.url}${a.reset}`, stdout);
	for (const url of info.networkUrls) {
		log(`  ${a.dim}${url}${a.reset}`, stdout);
	}
	if (info.setupUrl) {
		log(`  ${a.dim}Setup: ${info.setupUrl}${a.reset}`, stdout);
	}
	log("", stdout);

	const items = [
		`${info.projectCount} project${info.projectCount !== 1 ? "s" : ""}`,
		`${info.sessionCount} session${info.sessionCount !== 1 ? "s" : ""}`,
	];
	if (info.processingCount > 0) {
		items.push(`${a.yellow}${info.processingCount} processing${a.reset}`);
	}
	log(formatStatusLine(items), stdout);
	log("", stdout);
}

// ─── Menu Items ──────────────────────────────────────────────────────────────

/** Visible menu items for the main select prompt. */
const MENU_ITEMS = [
	{ label: "Setup notifications", value: "notifications" as const },
	{ label: "Projects", value: "projects" as const },
	{ label: "Settings", value: "settings" as const },
	{ label: "Shut down server", value: "shutdown" as const },
	{ label: "Keep server alive & exit", value: "exit" as const },
];

// ─── Main Menu ───────────────────────────────────────────────────────────────

/**
 * Show the main menu loop.
 *
 * 1. Clears screen, prints logo
 * 2. Fetches and renders daemon status
 * 3. Shows a select menu with 5 items + hint
 * 4. Dispatches to callbacks based on selection
 * 5. After each submenu action, re-renders the main menu (loop)
 *
 * Hotkey `o` opens the relay URL in a browser and re-renders.
 * The hotkey works by intercepting the key on stdin before promptSelect
 * processes it. When "o" is detected, promptSelect is cancelled via a
 * synthetic Ctrl+C routed through a wrapper exit function that detects
 * the hotkey flag and re-renders instead of exiting.
 *
 * Ctrl+C exits via the real exit function.
 */
export async function showMainMenu(opts: MenuOptions): Promise<void> {
	const info = await opts.getDaemonInfo();

	// Clear screen + logo
	printLogo(opts.stdout);

	// Status display
	renderStatus(info, opts.stdout);

	// Build select options
	const selectOpts: SelectPromptOptions = {
		stdin: opts.stdin,
		stdout: opts.stdout,
		exit: opts.exit,
		hint: [
			"Run npx opencode-relay in other directories to add more projects.",
			`Press ${a.bold}o${a.reset} to open in browser`,
		],
	};

	// Wrap callback-based promptSelect in a promise.
	// The "o" hotkey is handled by prepending a listener on stdin.
	// When "o" is pressed, promptSelect ignores it (unknown key) and our
	// listener fires onOpenBrowser, then cancels promptSelect by sending
	// Ctrl+C via a wrapper exit that re-renders instead of exiting.
	return new Promise<void>((resolve) => {
		let hotkeyFired = false;

		// Wrapper exit: if the hotkey flag is set, re-render instead of exit.
		const wrappedExit = (code: number) => {
			if (hotkeyFired) {
				// Hotkey triggered the Ctrl+C — re-render after browser open
				return;
			}
			opts.exit(code);
		};

		function onHotkey(ch: string): void {
			if (ch === "o" && !hotkeyFired) {
				hotkeyFired = true;
				opts.stdin.removeListener("data", onHotkey);

				// Cancel promptSelect by sending Ctrl+C.
				// Our wrappedExit will catch this and NOT call the real exit.
				// Then we call onOpenBrowser and re-render.
				//
				// We need a microtask delay so promptSelect processes the
				// Ctrl+C in the next event loop tick after our handler runs.
				queueMicrotask(async () => {
					// The Ctrl+C has already been processed by promptSelect
					// (wrappedExit was called, which returned without exiting).
					// Now call onOpenBrowser and re-render.
					await opts.onOpenBrowser?.();
					await showMainMenu(opts);
					resolve();
				});

				// Emit Ctrl+C to make promptSelect clean up
				opts.stdin.emit("data", "\x03");
			}
		}

		// Prepend our listener so it fires before promptSelect's
		opts.stdin.prependListener("data", onHotkey);

		// Override exit in select opts
		const hotkeySelectOpts: SelectPromptOptions = {
			...selectOpts,
			exit: wrappedExit,
		};

		promptSelect<MenuChoice>(
			"What would you like to do?",
			MENU_ITEMS,
			async (choice) => {
				// Clean up hotkey interceptor
				if (!hotkeyFired) {
					opts.stdin.removeListener("data", onHotkey);
				}

				if (choice === null) {
					// Back item — shouldn't happen at top level
					resolve();
					return;
				}

				switch (choice) {
					case "notifications":
						await opts.onSetupNotifications?.();
						await showMainMenu(opts);
						resolve();
						break;

					case "projects":
						await opts.onProjects?.();
						await showMainMenu(opts);
						resolve();
						break;

					case "settings":
						await opts.onSettings?.();
						await showMainMenu(opts);
						resolve();
						break;

					case "shutdown": {
						const shutdownPromise = new Promise<void>((shutdownResolve) => {
							promptToggle(
								"Shut down?",
								"Stop the relay and exit",
								false,
								async (confirmed) => {
									if (confirmed) {
										await opts.onShutdown?.();
										shutdownResolve();
									} else {
										await showMainMenu(opts);
										shutdownResolve();
									}
								},
								{
									stdin: opts.stdin,
									stdout: opts.stdout,
									exit: opts.exit,
								},
							);
						});
						await shutdownPromise;
						resolve();
						break;
					}

					case "exit":
						await opts.onKeepAliveExit?.();
						resolve();
						break;

					default:
						assertNever(choice);
				}
			},
			hotkeySelectOpts,
		);
	});
}
