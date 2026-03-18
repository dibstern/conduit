// ─── First-Run Setup Flow (Ticket 8.9) ───────────────────────────────────────
// Interactive CLI setup wizard for opencode-relay. Prompts for port, PIN,
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
	/** Injectable: is macOS? */
	isMacOS?: boolean;
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

/** Default recent projects loader: reads ~/.opencode-relay/recent.json. */
function defaultGetRecentProjects(): Array<{
	path: string;
	slug: string;
	title?: string;
	lastUsed: number;
}> {
	try {
		const recentPath = join(homedir(), ".opencode-relay", "recent.json");
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

/**
 * Pixel-art letter definitions for the OPENCODE logo.
 * Derived from the official SVG (logo-light.B0yzR0O5.svg) on a 6px grid.
 *
 * Cell types: B = body, W = window (inner fill), . = empty.
 * Most letters are 4 cells wide × 5 rows. Exceptions:
 * - 'd' has 6 rows: row 0 is ascender, rows 1–5 are main body
 * - 'p' has 6 rows: rows 0–4 are main body, row 5 is descender
 *
 * Each cell is rendered at double character width (2 chars per cell)
 * to achieve the correct ~52:63 aspect ratio in terminal fonts.
 */
const OC: Record<string, string[]> = {
	o: ["BBBB", "B..B", "BWWB", "BWWB", "BBBB"],
	p: ["BBBB", "B..B", "BWWB", "BWWB", "BBBB", "B..."],
	e: ["BBBB", "B..B", "BBBB", "BWWW", "BBBB"],
	n: ["BBB.", "B..B", "BWWB", "BWWB", "BWWB"],
	c: ["BBBB", "B...", "BWWW", "BWWW", "BBBB"],
	d: ["...B", "BBBB", "B..B", "BWWB", "BWWB", "BBBB"],
};

/** Pixel-art letter definitions for RELAY (body-only, no windows). */
const RL: Record<string, string[]> = {
	r: ["BBB.", "B..B", "BBB.", "B.B.", "B..B"],
	e: ["BBBB", "B...", "BBBB", "B...", "BBBB"],
	l: ["B...", "B...", "B...", "B...", "BBBB"],
	a: [".BB.", "B..B", "BBBB", "B..B", "B..B"],
	y: ["B..B", "B..B", ".BB.", ".B..", ".B.."],
};

/** Chars per cell (doubled for correct terminal aspect ratio). */
const CELL_W = 2;
/** Gap chars between adjacent letters. */
const LETTER_GAP = 2;
/** Number of "open" letters (first 4); rest are "code" group. */
const OPEN_LEN = 4;
/** Total rows for opencode: 0=ascender, 1–5=main, 6=descender. */
const TOTAL_ROWS = 7;

/**
 * Print the OPENCODE RELAY logo to stdout.
 *
 * Renders a pixel-art reproduction of the official OpenCode SVG logo at
 * doubled character width for correct terminal aspect ratio (~52:63).
 *
 * Colors:
 * - "open" body: medium gray
 * - "code" body: white
 * - Window (inner fill): dark gray (darker than "open")
 * - "relay" subtitle: white, same pixel-art style
 *
 * Clears the screen first.
 */
export function printLogo(stdout: Writable): void {
	stdout.write("\x1bc"); // clear screen
	stdout.write("\n");

	const basic = isBasicTerm();
	const openClr = basic ? a.dim : "\x1b[38;2;140;138;138m";
	const codeClr = basic ? a.bold : "\x1b[38;2;240;240;240m";
	const winClr = basic ? "" : "\x1b[38;2;70;68;68m";
	const relayClr = basic ? a.bold : "\x1b[38;2;240;240;240m";

	const blk = "\u2588".repeat(CELL_W);
	const spc = " ".repeat(CELL_W);
	const gap = " ".repeat(LETTER_GAP);

	// ── Render "opencode" ─────────────────────────────────────────────
	const ocWord = "opencode";
	const ocGlyphs = [...ocWord].map((ch) => OC[ch]);

	for (let row = 0; row < TOTAL_ROWS; row++) {
		let line = "  ";
		let prev = "";

		for (let li = 0; li < ocGlyphs.length; li++) {
			if (li > 0) line += gap;

			const glyph = ocGlyphs[li];
			const key = ocWord[li];
			const isCode = li >= OPEN_LEN;
			if (!glyph || key === undefined) continue;

			// Map logo row → glyph row (d has ascender, p has descender)
			let gr: string | undefined;
			if (key === "d") {
				gr = row < glyph.length ? glyph[row] : undefined;
			} else if (key === "p") {
				if (row >= 1 && row <= 5) gr = glyph[row - 1];
				else if (row === 6) gr = glyph[5];
			} else {
				if (row >= 1 && row <= 5) gr = glyph[row - 1];
			}

			if (!gr) {
				line += spc.repeat(4);
				continue;
			}

			for (const cell of gr) {
				if (cell === "B") {
					const clr = isCode ? codeClr : openClr;
					if (clr !== prev) {
						line += clr;
						prev = clr;
					}
					line += blk;
				} else if (cell === "W") {
					if (winClr !== prev) {
						line += winClr;
						prev = winClr;
					}
					line += blk;
				} else {
					line += spc;
				}
			}
		}

		line += a.reset;
		stdout.write(`${line}\n`);
	}

	// ── Render "relay" subtitle centered below ────────────────────────
	const rlWord = "relay";
	const rlGlyphs = [...rlWord].map((ch) => RL[ch]);
	const ocWidth = ocWord.length * 4 * CELL_W + (ocWord.length - 1) * LETTER_GAP;
	const rlWidth = rlWord.length * 4 * CELL_W + (rlWord.length - 1) * LETTER_GAP;
	const pad = " ".repeat(Math.floor((ocWidth - rlWidth) / 2));

	stdout.write("\n");

	for (let row = 0; row < 5; row++) {
		let line = `  ${pad}`;
		let prev = "";

		for (let li = 0; li < rlGlyphs.length; li++) {
			if (li > 0) line += gap;
			const glyphRows = rlGlyphs[li];
			const gr = glyphRows?.[row];
			if (!gr) continue;
			for (const cell of gr) {
				if (cell === "B") {
					if (relayClr !== prev) {
						line += relayClr;
						prev = relayClr;
					}
					line += blk;
				} else {
					line += spc;
				}
			}
		}

		line += a.reset;
		stdout.write(`${line}\n`);
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
 * 5. Keep-awake toggle (macOS only)
 * 6. Restore recent projects (if any exist)
 * 7. Return SetupResult
 */
export async function runSetup(opts: SetupOptions): Promise<SetupResult> {
	const { stdout, exit } = opts;
	const isPortFree = opts.isPortFree ?? defaultIsPortFree;
	const getRecentProjects = opts.getRecentProjects ?? defaultGetRecentProjects;
	const isMacOS = opts.isMacOS ?? process.platform === "darwin";

	// Step 1: Logo
	printLogo(stdout);

	// Step 2: Branding + disclaimer
	log(
		`${sym.pointer}  ${a.bold}OpenCode Relay${a.reset}${a.dim}  \u00B7  Unofficial, open-source project${a.reset}`,
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

	// Step 6: Keep-awake (macOS only)
	let keepAwake = false;
	if (isMacOS) {
		keepAwake = await new Promise<boolean>((resolve) => {
			promptToggle(
				"Keep awake?",
				"Prevent the system from sleeping while the relay is running",
				false,
				resolve,
				promptOpts,
			);
		});
	}

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
	log(`${sym.end}  ${a.dim}Starting relay...${a.reset}`, stdout);
	log("", stdout);

	return selected.map((p) => ({
		path: p.path,
		slug: p.slug,
		...(p.title != null && { title: p.title }),
	}));
}
