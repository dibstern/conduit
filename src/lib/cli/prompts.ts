// ─── Interactive Prompt Components (Ticket 8.1) ──────────────────────────────
// Five reusable interactive terminal prompt primitives: toggle, PIN, text,
// select, and multi-select. Ported from claude-relay/bin/cli.js lines 544-1013.
// Each prompt accepts injectable stdin/stdout/exit for testability.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	a,
	clearUp,
	gradient,
	log,
	sym,
	type Writable,
} from "./terminal-render.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Injectable I/O streams for all prompts. */
export interface PromptOptions {
	stdin: NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void };
	stdout: Writable;
	exit: (code: number) => void;
}

/** Item shape for promptSelect. */
export interface SelectItem<T = string> {
	label: string;
	value: T;
}

/** Item shape for promptMultiSelect. */
export interface MultiSelectItem<T = string> {
	label: string;
	value: T;
	checked?: boolean;
}

/** Injectable filesystem for tab-completion (defaults to real node:fs). */
export interface TabCompleteFs {
	statSync(p: string): { isDirectory(): boolean };
	readdirSync(p: string): string[];
}

/** Extended options for promptText. */
export interface TextPromptOptions extends PromptOptions {
	hint?: string;
	validate?: (value: string) => string | null;
	/** Injectable filesystem for tab-completion testing. */
	fs?: TabCompleteFs;
}

/** Extended options for promptSelect. */
export interface SelectPromptOptions extends PromptOptions {
	backItem?: string;
	hint?: string[];
	hotkeys?: Map<string, number>;
	/** Initial selection index (default 0). */
	defaultIndex?: number;
}

// ─── promptToggle ────────────────────────────────────────────────────────────

/**
 * Yes/No toggle prompt.
 * Arrow keys (left/right) and Tab toggle the value. y/n as shortcuts.
 * Enter confirms, Ctrl+C exits.
 */
export function promptToggle(
	title: string,
	description: string | null,
	defaultValue: boolean,
	callback: (value: boolean) => void,
	opts: PromptOptions,
): void {
	const { stdin, stdout, exit } = opts;
	let value = defaultValue || false;

	function renderToggle(): string {
		const yes = value
			? `${a.green}${a.bold}● Yes${a.reset}`
			: `${a.dim}○ Yes${a.reset}`;
		const no = !value
			? `${a.green}${a.bold}● No${a.reset}`
			: `${a.dim}○ No${a.reset}`;
		return `${yes}${a.dim} / ${a.reset}${no}`;
	}

	let lines = 3;
	log(`${sym.pointer}  ${a.bold}${title}${a.reset}`, stdout);
	if (description) {
		log(`${sym.bar}  ${a.dim}${description}${a.reset}`, stdout);
		lines = 4;
	}
	stdout.write(`  ${sym.bar}  ${renderToggle()}\n`);
	stdout.write(
		`  ${sym.bar}  ${a.dim}\u2190\u2192: toggle \u00B7 y/n: yes/no \u00B7 enter: confirm${a.reset}`,
	);

	if (stdin.setRawMode) stdin.setRawMode(true);
	stdin.resume();
	stdin.setEncoding("utf8");

	function redrawToggle(): void {
		stdout.write(`\x1b[1A\x1b[2K\r  ${sym.bar}  ${renderToggle()}\x1b[1B`);
	}

	function onToggle(ch: string): void {
		if (ch === "\x1b[D" || ch === "\x1b[C" || ch === "\t") {
			value = !value;
			redrawToggle();
		} else if (ch === "y" || ch === "Y") {
			value = true;
			redrawToggle();
		} else if (ch === "n" || ch === "N") {
			value = false;
			redrawToggle();
		} else if (ch === "\r" || ch === "\n") {
			if (stdin.setRawMode) stdin.setRawMode(false);
			stdin.pause();
			stdin.removeListener("data", onToggle);
			stdout.write("\n");
			clearUp(lines, stdout);
			const result = value ? `${a.green}Yes${a.reset}` : `${a.dim}No${a.reset}`;
			log(`${sym.done}  ${title} ${a.dim}\u00B7${a.reset} ${result}`, stdout);
			callback(value);
		} else if (ch === "\x03") {
			if (stdin.setRawMode) stdin.setRawMode(false);
			stdin.pause();
			stdin.removeListener("data", onToggle);
			stdout.write("\n");
			clearUp(lines, stdout);
			log(`${sym.end}  ${a.dim}Cancelled${a.reset}`, stdout);
			exit(0);
		}
	}

	stdin.on("data", onToggle);
}

// ─── promptPin ───────────────────────────────────────────────────────────────

/**
 * Masked PIN entry prompt.
 * Only accepts digits 0-9, shows cyan bullets. 4-8 digit validation.
 * Enter to skip (returns null), Enter with valid input confirms.
 * Backspace deletes, Ctrl+C exits.
 */
export function promptPin(
	callback: (pin: string | null) => void,
	opts: PromptOptions,
): void {
	const { stdin, stdout, exit } = opts;

	log(`${sym.pointer}  ${a.bold}Set a PIN${a.reset}`, stdout);
	log(
		`${sym.bar}  ${a.dim}Require a PIN (4-8 digits) to access the web UI. Enter to skip.${a.reset}`,
		stdout,
	);
	log(
		`${sym.bar}  ${a.dim}0-9: digits \u00B7 backspace: delete \u00B7 enter: confirm/skip \u00B7 esc: back${a.reset}`,
		stdout,
	);
	stdout.write(`  ${sym.bar}  `);

	let pin = "";

	if (stdin.setRawMode) stdin.setRawMode(true);
	stdin.resume();
	stdin.setEncoding("utf8");

	function onPin(ch: string): void {
		if (ch === "\r" || ch === "\n") {
			if (stdin.setRawMode) stdin.setRawMode(false);
			stdin.pause();
			stdin.removeListener("data", onPin);
			stdout.write("\n");

			if (pin !== "" && !/^\d{4,8}$/.test(pin)) {
				clearUp(4, stdout);
				log(
					`${sym.done}  PIN protection ${a.red}Must be 4-8 digits${a.reset}`,
					stdout,
				);
				log(sym.end, stdout);
				exit(1);
				return;
			}

			clearUp(4, stdout);
			if (pin) {
				log(
					`${sym.done}  PIN protection ${a.dim}\u00B7${a.reset} ${a.green}Enabled${a.reset}`,
					stdout,
				);
			} else {
				log(
					`${sym.done}  PIN protection ${a.dim}\u00B7 Skipped${a.reset}`,
					stdout,
				);
			}
			log(sym.bar, stdout);
			callback(pin || null);
		} else if (ch === "\x1b") {
			// Escape -- go back (same as skip)
			if (stdin.setRawMode) stdin.setRawMode(false);
			stdin.pause();
			stdin.removeListener("data", onPin);
			stdout.write("\n");
			clearUp(4, stdout);
			log(
				`${sym.done}  PIN protection ${a.dim}\u00B7 Skipped${a.reset}`,
				stdout,
			);
			log(sym.bar, stdout);
			callback(null);
		} else if (ch === "\x03") {
			if (stdin.setRawMode) stdin.setRawMode(false);
			stdin.pause();
			stdin.removeListener("data", onPin);
			stdout.write("\n");
			clearUp(4, stdout);
			log(`${sym.end}  ${a.dim}Cancelled${a.reset}`, stdout);
			exit(0);
		} else if (ch === "\x7f" || ch === "\b") {
			if (pin.length > 0) {
				pin = pin.slice(0, -1);
				stdout.write("\b \b");
			}
		} else if (/\d/.test(ch) && pin.length < 8) {
			pin += ch;
			stdout.write(`${a.cyan}\u25CF${a.reset}`);
		}
	}

	stdin.on("data", onPin);
}

// ─── promptText ──────────────────────────────────────────────────────────────

/**
 * Text input prompt with placeholder and Tab directory completion.
 * Enter with empty input returns placeholder value.
 * Tab completes directory paths. Escape returns null (back).
 * Ctrl+C exits.
 */
export function promptText(
	title: string,
	placeholder: string,
	callback: (value: string | null) => void,
	opts: TextPromptOptions,
): void {
	const { stdin, stdout, exit } = opts;
	const prefix = `  ${sym.bar}  `;
	let hintLine = "";
	let lineCount = 3;

	log(`${sym.pointer}  ${a.bold}${title}${a.reset}`, stdout);

	// Show hint if provided
	if (opts.hint) {
		log(`${sym.bar}  ${a.dim}${opts.hint}${a.reset}`, stdout);
		lineCount = 4;
	}

	log(
		`${sym.bar}  ${a.dim}tab: complete \u00B7 enter: confirm \u00B7 esc: back${a.reset}`,
		stdout,
	);

	stdout.write(`${prefix}${a.dim}${placeholder}${a.reset}`);
	// Move cursor to start of placeholder
	stdout.write(`\r${prefix}`);

	let text = "";
	let showingPlaceholder = true;

	if (stdin.setRawMode) stdin.setRawMode(true);
	stdin.resume();
	stdin.setEncoding("utf8");

	function redrawInput(): void {
		stdout.write(`\x1b[2K\r${prefix}${text}`);
	}

	function clearHint(): void {
		if (hintLine) {
			// Erase the hint line below
			stdout.write("\n\x1b[2K\x1b[1A");
			hintLine = "";
			// Restore lineCount to base (without tab-completion hint line)
			lineCount = opts.hint ? 4 : 3;
		}
	}

	function showTabHint(msg: string): void {
		clearHint();
		hintLine = msg;
		lineCount = (opts.hint ? 4 : 3) + 1;
		// Print hint below, then move cursor back up
		stdout.write(`\n${prefix}${a.dim}${msg}${a.reset}\x1b[1A`);
		redrawInput();
	}

	function tabComplete(): void {
		const fsImpl: TabCompleteFs = opts.fs ?? fs;
		let current = text || "";
		if (!current) current = "/";

		// Resolve ~ to home
		if (current.charAt(0) === "~") {
			current = os.homedir() + current.substring(1);
		}

		const resolved = path.resolve(current);
		let dir: string;
		let partial: string;

		try {
			const st = fsImpl.statSync(resolved);
			if (st.isDirectory()) {
				dir = resolved;
				partial = "";
			} else {
				dir = path.dirname(resolved);
				partial = path.basename(resolved);
			}
		} catch {
			dir = path.dirname(resolved);
			partial = path.basename(resolved);
		}

		let entries: string[];
		try {
			entries = fsImpl.readdirSync(dir);
		} catch {
			return;
		}

		// Filter to directories only, matching partial prefix
		const matches: string[] = [];
		const lowerPartial = partial.toLowerCase();
		for (let i = 0; i < entries.length; i++) {
			// biome-ignore lint/style/noNonNullAssertion: safe — loop bounded by array length
			const entry = entries[i]!;
			if (entry.charAt(0) === "." && !partial.startsWith(".")) continue;
			if (lowerPartial && entry.toLowerCase().indexOf(lowerPartial) !== 0)
				continue;
			try {
				const full = path.join(dir, entry);
				if (fsImpl.statSync(full).isDirectory()) {
					matches.push(entry);
				}
			} catch {
				// skip entries we can't stat
			}
		}

		if (matches.length === 0) return;

		if (matches.length === 1) {
			// Single match -- complete it
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
			const completed = path.join(dir, matches[0]!) + path.sep;
			text = completed;
			showingPlaceholder = false;
			clearHint();
			redrawInput();
		} else {
			// Multiple matches -- find longest common prefix and show candidates
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
			let common = matches[0]!;
			for (let m = 1; m < matches.length; m++) {
				// biome-ignore lint/style/noNonNullAssertion: safe — loop bounded by array length
				const matchStr = matches[m]!;
				let k = 0;
				while (
					k < common.length &&
					k < matchStr.length &&
					common.charAt(k) === matchStr.charAt(k)
				)
					k++;
				common = common.substring(0, k);
			}

			if (common.length > partial.length) {
				text = path.join(dir, common);
				showingPlaceholder = false;
			}

			// Show candidates as hint
			let display = matches.slice(0, 6).join("  ");
			if (matches.length > 6)
				display += `  ${a.dim}+${matches.length - 6} more${a.reset}`;
			showTabHint(display);
		}
	}

	function onText(ch: string): void {
		if (ch === "\r" || ch === "\n") {
			if (stdin.setRawMode) stdin.setRawMode(false);
			stdin.pause();
			stdin.removeListener("data", onText);
			const result = text || placeholder;
			clearHint();
			stdout.write("\n");

			// Validate if validator provided
			if (text && opts.validate) {
				const error = opts.validate(result);
				if (error) {
					clearUp(lineCount, stdout);
					log(`${sym.done}  ${title} ${a.red}${error}${a.reset}`, stdout);
					return;
				}
			}

			clearUp(lineCount, stdout);
			log(`${sym.done}  ${title} ${a.dim}\u00B7${a.reset} ${result}`, stdout);
			callback(result);
		} else if (ch === "\x1b") {
			if (stdin.setRawMode) stdin.setRawMode(false);
			stdin.pause();
			stdin.removeListener("data", onText);
			clearHint();
			stdout.write("\n");
			clearUp(lineCount, stdout);
			callback(null);
		} else if (ch === "\x03") {
			if (stdin.setRawMode) stdin.setRawMode(false);
			stdin.pause();
			stdin.removeListener("data", onText);
			clearHint();
			stdout.write("\n");
			clearUp(lineCount, stdout);
			log(`${sym.end}  ${a.dim}Cancelled${a.reset}`, stdout);
			exit(0);
		} else if (ch === "\t") {
			if (showingPlaceholder) {
				text = placeholder;
				showingPlaceholder = false;
				redrawInput();
			}
			tabComplete();
		} else if (ch === "\x7f" || ch === "\b") {
			if (text.length > 0) {
				text = text.slice(0, -1);
				clearHint();
				if (text.length === 0) {
					showingPlaceholder = true;
					stdout.write(`\x1b[2K\r${prefix}${a.dim}${placeholder}${a.reset}`);
					stdout.write(`\r${prefix}`);
				} else {
					redrawInput();
				}
			}
		} else if (ch >= " ") {
			if (showingPlaceholder) {
				showingPlaceholder = false;
			}
			clearHint();
			text += ch;
			redrawInput();
		}
	}

	stdin.on("data", onText);
}

// ─── promptSelect ────────────────────────────────────────────────────────────

/**
 * Single-choice select menu.
 * Arrow keys (up/down) to navigate, Enter to select.
 * Optional back item triggered by Backspace.
 * Optional hotkeys map for quick selection.
 */
export function promptSelect<T = string>(
	title: string,
	items: SelectItem<T>[],
	callback: (value: T | null) => void,
	opts: SelectPromptOptions,
): void {
	const { stdin, stdout, exit } = opts;
	let idx = Math.min(opts.defaultIndex ?? 0, items.length - 1);

	function render(): string {
		let out = "";
		for (let i = 0; i < items.length; i++) {
			const pfx =
				i === idx
					? `${a.green}${a.bold}  \u25CF ${a.reset}`
					: `${a.dim}  \u25CB ${a.reset}`;
			// biome-ignore lint/style/noNonNullAssertion: safe — loop bounded by array length
			out += `  ${sym.bar}${pfx}${items[i]!.label}\n`;
		}
		const keyHint = opts.backItem
			? `\u2191\u2193: navigate \u00B7 enter: select \u00B7 esc: back`
			: `\u2191\u2193: navigate \u00B7 enter: select`;
		out += `  ${sym.bar}  ${a.dim}${keyHint}${a.reset}\n`;
		return out;
	}

	log(`${sym.pointer}  ${a.bold}${title}${a.reset}`, stdout);
	stdout.write(render());

	// Render hint lines below the menu
	let hintBoxLines = 0;
	if (opts.hint && opts.hint.length > 0) {
		log(sym.end, stdout);
		for (let h = 0; h < opts.hint.length; h++) {
			// biome-ignore lint/style/noNonNullAssertion: safe — loop bounded by array length
			log(`   ${gradient(opts.hint[h]!)}`, stdout);
		}
		hintBoxLines = 1 + opts.hint.length;
	}

	const lineCount = items.length + 2 + hintBoxLines;

	if (stdin.setRawMode) stdin.setRawMode(true);
	stdin.resume();
	stdin.setEncoding("utf8");

	function onSelect(ch: string): void {
		if (ch === "\x1b[A") {
			// up
			if (idx > 0) idx--;
		} else if (ch === "\x1b[B") {
			// down
			if (idx < items.length - 1) idx++;
		} else if (ch === "\r" || ch === "\n") {
			if (stdin.setRawMode) stdin.setRawMode(false);
			stdin.pause();
			stdin.removeListener("data", onSelect);
			clearUp(lineCount, stdout);
			log(
				// biome-ignore lint/style/noNonNullAssertion: safe — idx bounded by items.length
				`${sym.done}  ${title} ${a.dim}\u00B7${a.reset} ${items[idx]!.label}`,
				stdout,
			);
			// biome-ignore lint/style/noNonNullAssertion: safe — idx bounded by items.length
			callback(items[idx]!.value);
			return;
		} else if (ch === "\x03") {
			if (stdin.setRawMode) stdin.setRawMode(false);
			stdin.pause();
			stdin.removeListener("data", onSelect);
			stdout.write("\n");
			clearUp(lineCount, stdout);
			log(`${sym.end}  ${a.dim}Cancelled${a.reset}`, stdout);
			exit(0);
			return;
		} else if (ch === "\x7f" || ch === "\b" || ch === "\x1b") {
			// Backspace or Escape -- trigger back item if available
			if (opts.backItem) {
				if (stdin.setRawMode) stdin.setRawMode(false);
				stdin.pause();
				stdin.removeListener("data", onSelect);
				clearUp(lineCount, stdout);
				log(
					`${sym.done}  ${title} ${a.dim}\u00B7${a.reset} ${opts.backItem}`,
					stdout,
				);
				callback(null);
				return;
			}
			return;
		} else if (opts.hotkeys?.has(ch)) {
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by .has() check
			const hotkeyIdx = opts.hotkeys.get(ch)!;
			if (hotkeyIdx >= 0 && hotkeyIdx < items.length) {
				if (stdin.setRawMode) stdin.setRawMode(false);
				stdin.pause();
				stdin.removeListener("data", onSelect);
				clearUp(lineCount, stdout);
				log(
					// biome-ignore lint/style/noNonNullAssertion: safe — guarded by bounds check
					`${sym.done}  ${title} ${a.dim}\u00B7${a.reset} ${items[hotkeyIdx]!.label}`,
					stdout,
				);
				// biome-ignore lint/style/noNonNullAssertion: safe — guarded by bounds check
				callback(items[hotkeyIdx]!.value);
				return;
			}
			return;
		} else {
			return;
		}

		// Redraw
		clearUp(items.length + 1 + hintBoxLines, stdout);
		stdout.write(render());
		// Re-render hint lines
		if (opts.hint && opts.hint.length > 0) {
			log(sym.end, stdout);
			for (let rh = 0; rh < opts.hint.length; rh++) {
				// biome-ignore lint/style/noNonNullAssertion: safe — loop bounded by array length
				log(`   ${gradient(opts.hint[rh]!)}`, stdout);
			}
		}
	}

	stdin.on("data", onSelect);
}

// ─── promptMultiSelect ───────────────────────────────────────────────────────

/**
 * Multi-choice select menu.
 * Space to toggle, A to select/deselect all.
 * Enter confirms (returns selected indices), Escape returns empty.
 * Ctrl+C exits.
 */
export function promptMultiSelect<T = string>(
	title: string,
	items: MultiSelectItem<T>[],
	callback: (values: T[]) => void,
	opts: PromptOptions,
): void {
	const { stdin, stdout, exit } = opts;

	const selected: boolean[] = [];
	for (let si = 0; si < items.length; si++) {
		// biome-ignore lint/style/noNonNullAssertion: safe — loop bounded by array length
		selected.push(items[si]!.checked !== false);
	}
	let idx = 0;

	function render(): string {
		let out = "";
		for (let i = 0; i < items.length; i++) {
			const cursor = i === idx ? `${a.cyan}>${a.reset}` : " ";
			const check = selected[i]
				? `${a.green}${a.bold}\u25A0${a.reset}`
				: `${a.dim}\u25A1${a.reset}`;
			// biome-ignore lint/style/noNonNullAssertion: safe — loop bounded by array length
			out += `  ${sym.bar} ${cursor} ${check} ${items[i]!.label}\n`;
		}
		out += `  ${sym.bar}  ${a.dim}\u2191\u2193: navigate \u00B7 space: toggle \u00B7 a: all \u00B7 enter: confirm \u00B7 esc: skip${a.reset}\n`;
		return out;
	}

	log(`${sym.pointer}  ${a.bold}${title}${a.reset}`, stdout);
	stdout.write(render());

	const lineCount = items.length + 2; // title + items + hint

	if (stdin.setRawMode) stdin.setRawMode(true);
	stdin.resume();
	stdin.setEncoding("utf8");

	function onMulti(ch: string): void {
		if (ch === "\x1b[A") {
			// up
			if (idx > 0) idx--;
		} else if (ch === "\x1b[B") {
			// down
			if (idx < items.length - 1) idx++;
		} else if (ch === " ") {
			// toggle
			selected[idx] = !selected[idx];
		} else if (ch === "a" || ch === "A") {
			// toggle all
			const allSelected = selected.every((s) => s);
			for (let ai = 0; ai < selected.length; ai++) selected[ai] = !allSelected;
		} else if (ch === "\r" || ch === "\n") {
			if (stdin.setRawMode) stdin.setRawMode(false);
			stdin.pause();
			stdin.removeListener("data", onMulti);
			clearUp(lineCount, stdout);
			const result: T[] = [];
			const labels: string[] = [];
			for (let ri = 0; ri < items.length; ri++) {
				if (selected[ri]) {
					// biome-ignore lint/style/noNonNullAssertion: safe — loop bounded by array length
					result.push(items[ri]!.value);
					// biome-ignore lint/style/noNonNullAssertion: safe — loop bounded by array length
					labels.push(items[ri]!.label);
				}
			}
			const summary =
				result.length === items.length
					? `All (${result.length})`
					: `${result.length} of ${items.length}`;
			log(`${sym.done}  ${title} ${a.dim}\u00B7${a.reset} ${summary}`, stdout);
			callback(result);
			return;
		} else if (ch === "\x03") {
			if (stdin.setRawMode) stdin.setRawMode(false);
			stdin.pause();
			stdin.removeListener("data", onMulti);
			stdout.write("\n");
			clearUp(lineCount, stdout);
			log(`${sym.end}  ${a.dim}Cancelled${a.reset}`, stdout);
			exit(0);
			return;
		} else if (ch === "\x1b") {
			// Escape -- select none
			if (stdin.setRawMode) stdin.setRawMode(false);
			stdin.pause();
			stdin.removeListener("data", onMulti);
			clearUp(lineCount, stdout);
			log(`${sym.done}  ${title} ${a.dim}\u00B7 Skipped${a.reset}`, stdout);
			callback([]);
			return;
		} else {
			return;
		}

		// Redraw
		clearUp(items.length + 1, stdout); // items + hint (not title)
		stdout.write(render());
	}

	stdin.on("data", onMulti);
}
