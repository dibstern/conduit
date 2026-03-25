// ─── First-Run Setup Flow (Ticket 8.9) ───────────────────────────────────────
// Interactive CLI setup wizard for conduit. Prompts for port, PIN,
// keep-awake, and project restoration. Ported from claude-relay/bin/cli.js
// lines 1109-1166 with OpenCode-specific adaptations.

import { readFileSync } from "node:fs";
import * as net from "node:net";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
	deserializeRecent,
	filterExistingProjects,
} from "../daemon/recent-projects.js";
import type { PromptOptions, TextPromptOptions } from "./prompts.js";
import {
	promptMultiSelect,
	promptPin,
	promptText,
	promptToggle,
} from "./prompts.js";
import type { Writable } from "./terminal-render.js";
import { a, isBasicTerm, log, sym } from "./terminal-render.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SetupResult {
	port: number;
	pin: string | null;
	keepAwake: boolean;
	restoredProjects: Array<{ path: string; slug: string; title?: string }>;
}

export interface SetupOptions {
	stdin: NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void };
	stdout: Writable;
	exit: (code: number) => void;
	/** Injectable for testing: check if a port is free */
	isPortFree?: (port: number) => Promise<boolean>;
	/** Injectable for testing: get recent projects */
	getRecentProjects?: () => Array<{
		path: string;
		slug: string;
		title?: string;
		lastUsed: number;
	}>;
}

// ─── Default Helpers ─────────────────────────────────────────────────────────

/** Default port-free check: try to bind and release. */
async function defaultIsPortFree(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.once("error", () => resolve(false));
		server.once("listening", () => {
			server.close(() => resolve(true));
		});
		server.listen(port, "127.0.0.1");
	});
}

/** Default recent projects loader: reads ~/.conduit/recent.json. */
function defaultGetRecentProjects(): Array<{
	path: string;
	slug: string;
	title?: string;
	lastUsed: number;
}> {
	try {
		const recentPath = join(homedir(), ".conduit", "recent.json");
		const data = readFileSync(recentPath, "utf-8");
		const projects = filterExistingProjects(deserializeRecent(data));
		return projects.map((p) => ({
			path: p.directory,
			slug: p.slug,
			...(p.title != null && { title: p.title }),
			lastUsed: p.lastUsed,
		}));
	} catch {
		return [];
	}
}

// ─── Logo ────────────────────────────────────────────────────────────────────

/** Number of block-grid columns in the brand underline. */
const GRID_COLS = 10;

/** Width of the brand underline — matches CONDUIT_ART max line width. */
const LOGO_WIDTH = 56;

/** "CONDUIT" in ANSI Shadow figlet font — 6 rows, used as a subtitle. */
const CONDUIT_ART = [
	" ██████╗ ██████╗ ███╗   ██╗██████╗ ██╗   ██╗██╗████████╗",
	"██╔════╝██╔═══██╗████╗  ██║██╔══██╗██║   ██║██║╚══██╔══╝",
	"██║     ██║   ██║██╔██╗ ██║██║  ██║██║   ██║██║   ██║",
	"██║     ██║   ██║██║╚██╗██║██║  ██║██║   ██║██║   ██║",
	"╚██████╗╚██████╔╝██║ ╚████║██████╔╝╚██████╔╝██║   ██║",
	" ╚═════╝ ╚═════╝ ╚═╝  ╚═══╝╚═════╝  ╚═════╝ ╚═╝   ╚═╝",
];

/**
 * Interpolate between two RGB colors.
 */
function lerpColor(
	c1: [number, number, number],
	c2: [number, number, number],
	t: number,
): [number, number, number] {
	return [
		Math.round(c1[0] + (c2[0] - c1[0]) * t),
		Math.round(c1[1] + (c2[1] - c1[1]) * t),
		Math.round(c1[2] + (c2[2] - c1[2]) * t),
	];
}

/**
 * Print the Conduit logo to stdout.
 *
 * Renders "CONDUIT" in ANSI Shadow figlet font with a per-row cyan→pink
 * gradient, a version tag, and 2-row brand underline.
 *
 * Falls back to bold cyan ANSI for basic terminals.
 * Clears the screen first.
 */
export function printLogo(stdout: Writable): void {
	stdout.write("\x1bc"); // clear screen
	stdout.write("\n");

	const basic = isBasicTerm();

	const pad = "  "; // 2-char left indent

	if (basic) {
		// Basic terminal: bold cyan, no gradient
		for (const row of CONDUIT_ART) {
			stdout.write(`${pad}\x1b[1;36m${row}${a.reset}\n`);
		}
		stdout.write("\n");
		stdout.write(`${pad}${"▀".repeat(LOGO_WIDTH)}\n`);
		stdout.write(`${pad}${"▄".repeat(LOGO_WIDTH)}\n`);
	} else {
		// Truecolor: per-row cyan → pink gradient
		const cyan: [number, number, number] = [0, 229, 255];
		const pink: [number, number, number] = [255, 45, 123];
		for (let i = 0; i < CONDUIT_ART.length; i++) {
			const t = CONDUIT_ART.length > 1 ? i / (CONDUIT_ART.length - 1) : 0;
			const rgb = lerpColor(cyan, pink, t);
			const color = `\x1b[1;38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
			stdout.write(`${pad}${color}${CONDUIT_ART[i]}${a.reset}\n`);
		}

		// Brand block grid underline — same width as logo art (78 chars)
		const baseCellWidth = Math.floor(LOGO_WIDTH / GRID_COLS);
		const remainder = LOGO_WIDTH - baseCellWidth * GRID_COLS;

		// Pink row (L→R fade)
		let pinkRow = pad;
		for (let i = 0; i < GRID_COLS; i++) {
			const t = i / (GRID_COLS - 1);
			const r = Math.round(255 - t * 200);
			const g = Math.round(45 - t * 35);
			const b = Math.round(123 - t * 90);
			const cw = baseCellWidth + (i < remainder ? 1 : 0);
			pinkRow += `\x1b[38;2;${r};${g};${b}m${"\u2584".repeat(cw)}`;
		}
		pinkRow += a.reset;
		stdout.write(`${pinkRow}\n`);

		// Cyan row (R→L fade)
		let cyanRow = pad;
		for (let i = 0; i < GRID_COLS; i++) {
			const t = i / (GRID_COLS - 1);
			const r = 0;
			const g = Math.round(60 + t * 169);
			const b = Math.round(70 + t * 185);
			const cw = baseCellWidth + (i < remainder ? 1 : 0);
			cyanRow += `\x1b[38;2;${r};${g};${b}m${"\u2580".repeat(cw)}`;
		}
		cyanRow += a.reset;
		stdout.write(`${cyanRow}\n`);
	}

	stdout.write("\n");
}

// ─── Setup Flow ──────────────────────────────────────────────────────────────

/**
 * Run the first-run setup wizard.
 *
 * Flow:
 * 1. Print logo
 * 2. Security disclaimer with accept toggle
 * 3. Port prompt (default 2633, validates range + availability)
 * 4. PIN prompt (optional, 4-8 digits)
 * 5. Keep-awake toggle
 * 6. Restore recent projects (if any exist)
 * 7. Return SetupResult
 */
export async function runSetup(opts: SetupOptions): Promise<SetupResult> {
	const { stdout, exit } = opts;
	const isPortFree = opts.isPortFree ?? defaultIsPortFree;
	const getRecentProjects = opts.getRecentProjects ?? defaultGetRecentProjects;
	// Step 1: Logo
	printLogo(stdout);

	// Step 2: Branding + disclaimer
	log(
		`${sym.pointer}  ${a.bold}Conduit${a.reset}${a.dim}  \u00B7  Unofficial, open-source project${a.reset}`,
		stdout,
	);
	log(sym.bar, stdout);
	log(
		`${sym.bar}  ${a.dim}Anyone with the URL gets full OpenCode access to this machine.${a.reset}`,
		stdout,
	);
	log(
		`${sym.bar}  ${a.dim}Use a private network (Tailscale, VPN).${a.reset}`,
		stdout,
	);
	log(
		`${sym.bar}  ${a.dim}The authors assume no responsibility for any damage or data loss.${a.reset}`,
		stdout,
	);
	log(sym.bar, stdout);

	const promptOpts: PromptOptions = {
		stdin: opts.stdin,
		stdout: opts.stdout,
		exit: opts.exit,
	};

	// Step 3: Accept disclaimer
	const accepted = await new Promise<boolean>((resolve) => {
		promptToggle(
			"Accept and continue?",
			"By proceeding, you acknowledge the security risks",
			true,
			resolve,
			promptOpts,
		);
	});

	if (!accepted) {
		log(`${sym.end}  ${a.dim}Aborted.${a.reset}`, stdout);
		log("", stdout);
		exit(0);
		// Return a dummy value; exit should terminate the process
		return { port: 0, pin: null, keepAwake: false, restoredProjects: [] };
	}

	log(sym.bar, stdout);

	// Step 4: Port prompt with validation and retry
	const port = await askPort(promptOpts, isPortFree, stdout, exit);

	log(sym.bar, stdout);

	// Step 5: PIN prompt
	const pin = await new Promise<string | null>((resolve) => {
		promptPin(resolve, promptOpts);
	});

	// Step 6: Keep-awake
	const keepAwake = await new Promise<boolean>((resolve) => {
		promptToggle(
			"Keep awake?",
			"Prevent the system from sleeping while the relay is running",
			false,
			resolve,
			promptOpts,
		);
	});

	// Step 7: Restore recent projects
	const recentProjects = getRecentProjects();
	let restoredProjects: Array<{
		path: string;
		slug: string;
		title?: string;
	}> = [];

	if (recentProjects.length > 0) {
		restoredProjects = await promptRestoreProjects(
			recentProjects,
			promptOpts,
			stdout,
		);
	}

	return { port, pin, keepAwake, restoredProjects };
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

/** Port prompt with validation and retry loop. */
async function askPort(
	opts: PromptOptions,
	isPortFree: (port: number) => Promise<boolean>,
	stdout: Writable,
	exit: (code: number) => void,
): Promise<number> {
	return new Promise<number>((resolve) => {
		function doAskPort(): void {
			// No validate in TextPromptOptions — we validate in the callback
			// and retry by calling doAskPort() again (matches claude-relay pattern).
			const textOpts: TextPromptOptions = { ...opts };

			promptText(
				"Port",
				"2633",
				(val) => {
					if (val === null) {
						// Escape pressed — abort
						log(`${sym.end}  ${a.dim}Aborted.${a.reset}`, stdout);
						log("", stdout);
						exit(0);
						return;
					}

					const p = Number.parseInt(val, 10);

					if (!p || p < 1 || p > 65535) {
						log(`${sym.warn}  ${a.red}Invalid port number${a.reset}`, stdout);
						doAskPort();
						return;
					}

					isPortFree(p).then((free) => {
						if (!free) {
							log(
								`${sym.warn}  ${a.yellow}Port ${p} is already in use${a.reset}`,
								stdout,
							);
							doAskPort();
							return;
						}
						resolve(p);
					});
				},
				textOpts,
			);
		}

		doAskPort();
	});
}

/** Prompt user to restore recent projects via multi-select. */
async function promptRestoreProjects(
	projects: Array<{
		path: string;
		slug: string;
		title?: string;
		lastUsed: number;
	}>,
	opts: PromptOptions,
	stdout: Writable,
): Promise<Array<{ path: string; slug: string; title?: string }>> {
	if (projects.length === 0) {
		return [];
	}

	log(sym.bar, stdout);

	const items = projects.map((p) => ({
		label: `${a.bold}${p.title || basename(p.path)}${a.reset}  ${a.dim}${p.path}${a.reset}`,
		value: p,
		checked: true,
	}));

	const selected = await new Promise<
		Array<{ path: string; slug: string; title?: string; lastUsed: number }>
	>((resolve) => {
		promptMultiSelect("Restore projects?", items, resolve, opts);
	});

	log(sym.bar, stdout);
	if (selected.length > 0) {
		log(
			`${sym.done}  ${a.green}Restoring ${selected.length} ${selected.length === 1 ? "project" : "projects"}${a.reset}`,
			stdout,
		);
	} else {
		log(`${sym.done}  ${a.dim}Starting fresh${a.reset}`, stdout);
	}
	log(`${sym.end}  ${a.dim}Starting daemon...${a.reset}`, stdout);
	log("", stdout);

	return selected.map((p) => ({
		path: p.path,
		slug: p.slug,
		...(p.title != null && { title: p.title }),
	}));
}
