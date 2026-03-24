// ─── Settings Menu (Ticket 8.12) ──────────────────────────────────────────────
// Interactive CLI settings menu for conduit. Displays detection status
// (Tailscale, mkcert, HTTPS, PIN, keep-awake) and provides actions for PIN
// management, keep-awake toggle, log viewing, and notification setup.
// Ported from claude-relay/bin/cli.js lines 1856-1982.

import { readFileSync } from "node:fs";
import { assertNever } from "../utils.js";
import { printLogo } from "./cli-setup.js";
import type { PromptOptions, SelectPromptOptions } from "./prompts.js";
import { promptPin, promptSelect, promptText } from "./prompts.js";
import type { Writable } from "./terminal-render.js";
import { a, log, sym } from "./terminal-render.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Current settings state for status display. */
export interface SettingsInfo {
	tailscaleIP: string | null;
	hasMkcert: boolean;
	tlsEnabled: boolean;
	pinEnabled: boolean;
	keepAwake: boolean;
}

/** Options for the settings menu. */
export interface SettingsMenuOptions extends PromptOptions {
	/** Get current settings state. */
	getSettingsInfo: () => SettingsInfo | Promise<SettingsInfo>;
	/** IPC: set PIN. */
	setPin: (pin: string) => Promise<{ ok: boolean; error?: string }>;
	/** IPC: remove PIN (set null). */
	removePin: () => Promise<{ ok: boolean; error?: string }>;
	/** IPC: toggle keep-awake. */
	setKeepAwake: (enabled: boolean) => Promise<{
		ok: boolean;
		supported?: boolean;
		active?: boolean;
		error?: string;
	}>;
	/** IPC: set custom keep-awake command and args. */
	setKeepAwakeCommand?: (
		command: string,
		args: string[],
	) => Promise<{ ok: boolean; error?: string }>;
	/** Callback: show notifications setup wizard. */
	onSetupNotifications?: () => void | Promise<void>;
	/** Callback: return to main menu. */
	onBack: () => void | Promise<void>;
	/** Path to daemon log file. */
	logPath?: string;
	/** Injectable: is macOS? */
	isMacOS?: boolean;
	/** Injectable: read file (for logs). */
	readFile?: (path: string) => string;
}

// ─── Settings Choice Values ─────────────────────────────────────────────────

/** All possible settings menu choice values. */
type SettingsChoice =
	| "guide"
	| "pin"
	| "remove_pin"
	| "awake"
	| "logs"
	| "back";

// ─── Status Rendering ───────────────────────────────────────────────────────

/**
 * Render detection status lines for the settings menu.
 *
 * Displays Tailscale, mkcert, HTTPS, PIN, and (on macOS) keep-awake status.
 */
export function renderSettingsStatus(
	info: SettingsInfo,
	stdout: Writable,
	_isMacOS: boolean,
): void {
	const tsStatus = info.tailscaleIP
		? `${a.green}Connected${a.reset}${a.dim} \u00B7 ${info.tailscaleIP}${a.reset}`
		: `${a.dim}Not detected${a.reset}`;
	const mcStatus = info.hasMkcert
		? `${a.green}Installed${a.reset}`
		: `${a.dim}Not found${a.reset}`;
	const tlsStatus = info.tlsEnabled
		? `${a.green}Enabled${a.reset}`
		: `${a.dim}Disabled${a.reset}`;
	const pinStatus = info.pinEnabled
		? `${a.green}Enabled${a.reset}`
		: `${a.dim}Off${a.reset}`;
	const awakeStatus = info.keepAwake
		? `${a.green}On${a.reset}`
		: `${a.dim}Off${a.reset}`;

	log(`${sym.bar}  Tailscale    ${tsStatus}`, stdout);
	log(`${sym.bar}  mkcert       ${mcStatus}`, stdout);
	log(`${sym.bar}  HTTPS        ${tlsStatus}`, stdout);
	log(`${sym.bar}  PIN          ${pinStatus}`, stdout);
	log(`${sym.bar}  Keep awake   ${awakeStatus}`, stdout);
	log(sym.bar, stdout);
}

// ─── Settings Menu ──────────────────────────────────────────────────────────

/**
 * Show the settings menu.
 *
 * 1. Fetches settings info via getSettingsInfo()
 * 2. Clears screen + prints logo
 * 3. Displays detection status lines
 * 4. Builds dynamic menu items based on state
 * 5. Dispatches to callbacks based on selection
 * 6. Re-renders after each action (except "back")
 */
export async function showSettingsMenu(
	opts: SettingsMenuOptions,
): Promise<void> {
	const info = await opts.getSettingsInfo();
	const isMacOS = opts.isMacOS ?? process.platform === "darwin";
	const readFileFn = opts.readFile ?? defaultReadFile;

	// Clear screen + logo
	printLogo(opts.stdout);

	// Header
	log("", opts.stdout);
	log(`${sym.pointer}  ${a.bold}Settings${a.reset}`, opts.stdout);
	log(sym.bar, opts.stdout);

	// Detection status
	renderSettingsStatus(info, opts.stdout, isMacOS);

	// Build menu items
	const items: Array<{ label: string; value: SettingsChoice }> = [
		{ label: "Setup notifications", value: "guide" },
	];

	if (info.pinEnabled) {
		items.push({ label: "Change PIN", value: "pin" });
		items.push({ label: "Remove PIN", value: "remove_pin" });
	} else {
		items.push({ label: "Set PIN", value: "pin" });
	}

	items.push({
		label: info.keepAwake ? "Disable keep awake" : "Enable keep awake",
		value: "awake",
	});

	items.push({ label: "View logs", value: "logs" });
	items.push({ label: "Back", value: "back" });

	// Build select options with back item (esc/backspace also triggers back)
	const selectOpts: SelectPromptOptions = {
		stdin: opts.stdin,
		stdout: opts.stdout,
		exit: opts.exit,
		backItem: "Back",
	};

	return new Promise<void>((resolve) => {
		promptSelect<SettingsChoice>(
			"Select",
			items,
			async (choice) => {
				if (choice === null) {
					// Back
					await opts.onBack();
					resolve();
					return;
				}

				switch (choice) {
					case "guide":
						await opts.onSetupNotifications?.();
						await showSettingsMenu(opts);
						resolve();
						break;

					case "pin": {
						log(sym.bar, opts.stdout);
						const pinPromise = new Promise<void>((pinResolve) => {
							promptPin(async (pin) => {
								if (pin) {
									await opts.setPin(pin);
									log(
										`${sym.done}  ${a.green}PIN updated${a.reset}`,
										opts.stdout,
									);
									log("", opts.stdout);
								}
								await showSettingsMenu(opts);
								pinResolve();
							}, opts);
						});
						await pinPromise;
						resolve();
						break;
					}

					case "remove_pin": {
						await opts.removePin();
						log(`${sym.done}  ${a.dim}PIN removed${a.reset}`, opts.stdout);
						log("", opts.stdout);
						await showSettingsMenu(opts);
						resolve();
						break;
					}

					case "awake": {
						const result = await opts.setKeepAwake(!info.keepAwake);
						if (
							!info.keepAwake &&
							result.supported === false &&
							opts.setKeepAwakeCommand
						) {
							// Enabling, but no tool auto-detected — prompt for custom command
							log(
								`${sym.bar}  ${a.yellow}No keep-awake tool detected for your platform.${a.reset}`,
								opts.stdout,
							);
							log(
								`${sym.bar}  ${a.dim}Enter a command to prevent sleep, e.g.: caffeinate -di${a.reset}`,
								opts.stdout,
							);
							const cmdPromise = new Promise<void>((cmdResolve) => {
								promptText(
									"Command",
									"",
									async (val) => {
										if (val?.trim()) {
											const parts = val.trim().split(/\s+/);
											// biome-ignore lint/style/noNonNullAssertion: safe — split always returns at least one element
											const command = parts[0]!;
											const args = parts.slice(1);
											// biome-ignore lint/style/noNonNullAssertion: safe — guarded by opts.setKeepAwakeCommand check above
											await opts.setKeepAwakeCommand!(command, args);
											await opts.setKeepAwake(true);
											log(
												`${sym.done}  ${a.green}Keep awake configured${a.reset}`,
												opts.stdout,
											);
										} else {
											// User skipped — disable keep awake
											await opts.setKeepAwake(false);
											log(
												`${sym.done}  ${a.dim}Keep awake disabled${a.reset}`,
												opts.stdout,
											);
										}
										cmdResolve();
									},
									{
										stdin: opts.stdin,
										stdout: opts.stdout,
										exit: opts.exit,
									},
								);
							});
							await cmdPromise;
						}
						await showSettingsMenu(opts);
						resolve();
						break;
					}

					case "logs": {
						showLogs(opts.stdout, opts.logPath, readFileFn);
						const logsPromise = new Promise<void>((logsResolve) => {
							promptSelect(
								"Back?",
								[
									{
										label: "Back",
										value: "back" as const,
									},
								],
								async () => {
									await showSettingsMenu(opts);
									logsResolve();
								},
								{
									stdin: opts.stdin,
									stdout: opts.stdout,
									exit: opts.exit,
								},
							);
						});
						await logsPromise;
						resolve();
						break;
					}

					case "back":
						await opts.onBack();
						resolve();
						break;

					default:
						assertNever(choice);
				}
			},
			selectOpts,
		);
	});
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/** Default file reader using node:fs. */
function defaultReadFile(filePath: string): string {
	return readFileSync(filePath, "utf8");
}

/** Display daemon logs (last 30 lines). */
function showLogs(
	stdout: Writable,
	logPath: string | undefined,
	readFile: (path: string) => string,
): void {
	stdout.write("\x1bc"); // clear screen
	log(
		`${a.bold}Daemon logs${a.reset} ${a.dim}(${logPath ?? "no path"})${a.reset}`,
		stdout,
	);
	log("", stdout);

	if (!logPath) {
		log(`${a.dim}(empty)${a.reset}`, stdout);
		log("", stdout);
		return;
	}

	try {
		const content = readFile(logPath);
		const lines = content.split("\n").slice(-30);
		for (const line of lines) {
			log(`${a.dim}${line}${a.reset}`, stdout);
		}
	} catch {
		log(`${a.dim}(empty)${a.reset}`, stdout);
	}
	log("", stdout);
}
