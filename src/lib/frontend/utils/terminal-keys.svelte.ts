// The terminal keys module: everything on-screen keys do to a terminal.
//
// One per terminal panel, dying with it. The bar and the phone row only call
// press; each tab only calls connect. On-screen keys go in through the emulator's own
// input call, so they arrive on the same data stream as typed keys and queue
// behind them in the tab's one-in-flight send: they can never reorder.
//
// Modifiers apply in one place, that data stream, so a waiting ⌃ combines
// with an on-screen key and a physical one alike. Pastes skip them: every
// paste, on-screen or the keyboard's own, goes through the module.
//
// ⌘ alone then V, C, K or F runs conduit's paste, copy, clear or find instead of
// sending. Every other ⌘ combination goes to the program as Meta.

import type { Terminal } from "@xterm/xterm";
import {
	DEFAULT_TERMINAL_KEYS,
	TERMINAL_MODIFIERS,
	type TerminalKeyAction,
	type TerminalKeysSetting,
	type TerminalModifier,
} from "../../contracts/terminal-keys.js";
import { replaceScrollback, terminalState } from "../stores/terminal.svelte.js";

export type TerminalArrow = "left" | "up" | "down" | "right";
type PlainKey =
	| Exclude<TerminalKeyAction, TerminalModifier | "paste" | "copy" | "nothing">
	| TerminalArrow;
/** Everything an on-screen key can do. The keyboard toggle shows or hides
 *  the software keyboard by focusing or blurring the terminal's input. */
export type TerminalKeyPress = TerminalKeyAction | TerminalArrow | "keyboard";
export type ModifierState = "off" | "waiting" | "locked";

export const isTerminalModifier = (key: string): key is TerminalModifier =>
	(TERMINAL_MODIFIERS as readonly string[]).includes(key);

const CURSOR_FINAL: Record<TerminalArrow | "home" | "end", string> = {
	up: "A",
	down: "B",
	right: "C",
	left: "D",
	home: "H",
	end: "F",
};

/** The bytes the physical key sends. Arrows follow the program's cursor-key
 *  mode: SS3 in application mode, CSI otherwise. */
function encode(terminal: Terminal, key: PlainKey): string {
	if (key === "esc") return "\x1b";
	if (key === "tab") return "\t";
	if (key === "return") return "\r";
	if (key === "delete") return "\x7f";
	if (key === "interrupt") return "\x03";
	if (key === "pageUp") return "\x1b[5~";
	if (key === "pageDown") return "\x1b[6~";
	const prefix = terminal.modes.applicationCursorKeysMode ? "\x1bO" : "\x1b[";
	return prefix + CURSOR_FINAL[key];
}

// ---- Applying held modifiers to one key, as xterm.js encodes the physical
// combination (its Keyboard.ts). ⌥ and ⌘ both send Meta.

type Held = { ctrl: boolean; shift: boolean; meta: boolean };

/** xterm's modifier parameter: 1 + shift 1 + alt 2 + ctrl 4. */
const param = (held: Held) =>
	1 + (held.shift ? 1 : 0) + (held.meta ? 2 : 0) + (held.ctrl ? 4 : 0);
const withMeta = (held: Held, bytes: string) =>
	held.meta ? `\x1b${bytes}` : bytes;

type KeyEncoding = {
	label: string;
	encode: (held: Held, plain: string) => string;
};

/** The plain sequences recognised as one key, so they can be re-encoded.
 *  Anything missing here passes through untouched and spends nothing. */
const NAMED_KEYS: Record<string, KeyEncoding> = {
	"\t": { label: "tab", encode: (h) => withMeta(h, h.shift ? "\x1b[Z" : "\t") },
	"\x1b": { label: "esc", encode: (h) => withMeta(h, "\x1b") },
	"\x03": { label: "interrupt", encode: (h) => withMeta(h, "\x03") },
	"\r": { label: "⏎", encode: (h) => withMeta(h, "\r") },
	"\x7f": { label: "⌫", encode: (h) => withMeta(h, h.ctrl ? "\b" : "\x7f") },
	"\x1b[5~": {
		label: "⇞",
		encode: (h, plain) => (param(h) > 1 ? `\x1b[5;${param(h)}~` : plain),
	},
	"\x1b[6~": {
		label: "⇟",
		encode: (h, plain) => (param(h) > 1 ? `\x1b[6;${param(h)}~` : plain),
	},
};
for (const [final, label] of [
	["A", "↑"],
	["B", "↓"],
	["C", "→"],
	["D", "←"],
	["H", "⇱"],
	["F", "⇲"],
] as const) {
	const key: KeyEncoding = {
		label,
		encode: (h, plain) => (param(h) > 1 ? `\x1b[1;${param(h)}${final}` : plain),
	};
	NAMED_KEYS[`\x1b[${final}`] = key;
	NAMED_KEYS[`\x1bO${final}`] = key;
}

/** ⌃ with a character that isn't a letter, per xterm's table. */
const CONTROL_FORMS: Record<string, string> = {
	" ": "\0",
	"@": "\0",
	"3": "\x1b",
	"4": "\x1c",
	"5": "\x1d",
	"6": "\x1e",
	"7": "\x1f",
	"8": "\x7f",
	"[": "\x1b",
	"\\": "\x1c",
	"]": "\x1d",
	_: "\x1f",
};

function charKey(char: string): KeyEncoding {
	return {
		label: char === " " ? "space" : char.toUpperCase(),
		encode(held) {
			if (!held.ctrl)
				return withMeta(held, held.shift ? char.toUpperCase() : char);
			const control = /^[a-z]$/i.test(char)
				? String.fromCharCode(char.toUpperCase().charCodeAt(0) - 64)
				: (CONTROL_FORMS[char] ?? char);
			return withMeta(held, control);
		},
	};
}

/** How a key shows each action: a short label, an icon where one reads
 *  better on the key face, and the name it's announced by. */
export const TERMINAL_KEY_LABELS: Record<
	TerminalKeyAction | TerminalArrow,
	{ text: string; name: string; icon?: string }
> = {
	paste: { text: "paste", name: "Paste", icon: "clipboard" },
	copy: { text: "copy", name: "Copy", icon: "copy" },
	esc: { text: "esc", name: "Escape" },
	tab: { text: "tab", name: "Tab" },
	ctrl: { text: "⌃", name: "Control" },
	opt: { text: "⌥", name: "Option" },
	cmd: { text: "⌘", name: "Command" },
	shift: { text: "⇧", name: "Shift" },
	return: { text: "ret", name: "Return" },
	delete: { text: "del", name: "Delete" },
	home: { text: "home", name: "Home" },
	end: { text: "end", name: "End" },
	pageUp: { text: "pg up", name: "Page up" },
	pageDown: { text: "pg dn", name: "Page down" },
	interrupt: { text: "⌃C", name: "Interrupt" },
	nothing: { text: "", name: "Nothing" },
	left: { text: "", name: "Left arrow", icon: "arrow-left" },
	up: { text: "", name: "Up arrow", icon: "arrow-up" },
	down: { text: "", name: "Down arrow", icon: "arrow-down" },
	right: { text: "", name: "Right arrow", icon: "arrow-right" },
};
/** The Mac's order for naming a combination. */
const COMBO_ORDER: readonly TerminalModifier[] = [
	"ctrl",
	"opt",
	"shift",
	"cmd",
];

/** What a sent combination does in most shells. */
const HINTS: Record<string, string> = {
	"⌃C": "interrupt",
	"⌃D": "exit",
	"⌃A": "start of line",
	"⌃E": "end of line",
	"⌃R": "search history",
	"⌃W": "delete word",
	"⌃U": "clear line",
	"⌃L": "clear screen",
	"⌃Z": "suspend",
	"⌥B": "back a word",
	"⌥F": "forward a word",
	"⌥←": "back a word",
	"⌥→": "forward a word",
	"⇧tab": "next mode",
};

const NOTICE_MS = 1700;
const CLIPBOARD_DENIED_MS = 4000;
// Control bytes: the mark of a combination that doesn't print.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point.
const NON_PRINTING = /[\x00-\x1f\x7f]/;

type NoticeBody =
	| { kind: "sent"; combo: string; hint: string | undefined }
	| { kind: "pasted"; lines: number }
	| { kind: "info"; text: string };
export type Notice = NoticeBody & { id: number };

const lineCount = (text: string) =>
	text.replace(/\r?\n$/, "").split(/\r\n|\r|\n/).length;

export function createTerminalKeys({
	openFind,
	settings = () => DEFAULT_TERMINAL_KEYS,
}: {
	/** Open the find bar on this terminal. */
	openFind: (terminal: Terminal) => void;
	settings?: () => TerminalKeysSetting;
}) {
	const terminals = new Map<string, Terminal>();
	const modifiers = $state<Record<TerminalModifier, ModifierState>>({
		ctrl: "off",
		opt: "off",
		cmd: "off",
		shift: "off",
	});
	let notice = $state<Notice | null>(null);
	let noticeTimer: ReturnType<typeof setTimeout> | undefined;
	let pending = $state<{
		terminal: Terminal;
		text: string;
		lines: number;
	} | null>(null);
	// Set while a held key repeats, so the repeats don't confirm again.
	let repeating = false;
	// Set while the module pastes, so pasted data skips modifiers.
	let pasting = false;
	// The emulator clears its selection on the keypress itself, before the c
	// of ⌘ then C arrives, so ⌘ copies the selection kept while it was held.
	let cmdSelection = "";
	// Hidden tabs can't hold focus, so a focused input is the active tab's.
	let inputFocused = $state(false);

	function show(body: NoticeBody, ms = NOTICE_MS) {
		clearTimeout(noticeTimer);
		notice = { ...body, id: (notice?.id ?? 0) + 1 };
		noticeTimer = setTimeout(() => (notice = null), ms);
	}

	function activeTerminal(): Terminal | undefined {
		const id = terminalState.activeTabId;
		return id ? terminals.get(id) : undefined;
	}

	function paste(terminal: Terminal, text: string) {
		pasting = true;
		// paste fires onData synchronously, bracketed if the program asked.
		terminal.paste(text);
		pasting = false;
	}

	/** Multi-line text without bracketed paste would run line by line, so it
	 *  waits for the user to confirm. */
	function guardedPaste(terminal: Terminal, text: string) {
		const lines = lineCount(text);
		if (lines < 2) return paste(terminal, text);
		if (settings().pasteAsOneBlock && !terminal.modes.bracketedPasteMode) {
			pending = { terminal, text, lines };
			return;
		}
		paste(terminal, text);
		show({ kind: "pasted", lines });
	}

	async function pasteClipboard(terminal: Terminal) {
		let text: string;
		try {
			text = await navigator.clipboard.readText();
		} catch {
			// Denied, or no clipboard API outside a secure context.
			show(
				{
					kind: "info",
					text: "Can't read the clipboard here. Paste with the keyboard instead.",
				},
				CLIPBOARD_DENIED_MS,
			);
			return;
		}
		if (text) guardedPaste(terminal, text);
	}

	async function copy(text: string) {
		if (!text) return show({ kind: "info", text: "Nothing selected" });
		try {
			await navigator.clipboard.writeText(text);
			show({ kind: "info", text: "Copied the selection" });
		} catch {
			show({ kind: "info", text: "Can't write to the clipboard here" });
		}
	}

	/** Re-encode one key with the held modifiers and spend the waiting ones.
	 *  Input that isn't a single key passes through and spends nothing. A ⌘
	 *  command runs and sends nothing. */
	function applyModifiers(
		data: string,
		commands: Record<string, () => void>,
	): string {
		const held = TERMINAL_MODIFIERS.filter((m) => modifiers[m] !== "off");
		if (held.length === 0) return data;
		const key =
			NAMED_KEYS[data] ?? ([...data].length === 1 ? charKey(data) : undefined);
		if (!key) return data;
		for (const m of held) if (modifiers[m] === "waiting") modifiers[m] = "off";
		const command = held.length === 1 && held[0] === "cmd" && commands[data];
		if (command) {
			command();
			return "";
		}
		const bytes = key.encode(
			{
				ctrl: held.includes("ctrl"),
				shift: held.includes("shift"),
				meta: held.includes("opt") || held.includes("cmd"),
			},
			data,
		);
		if (!repeating && NON_PRINTING.test(bytes)) {
			const glyphs = COMBO_ORDER.filter((m) => held.includes(m)).map(
				(m) => TERMINAL_KEY_LABELS[m].text,
			);
			const combo = glyphs.join("") + key.label;
			show({ kind: "sent", combo, hint: HINTS[combo] });
		}
		return bytes;
	}

	return {
		get modifiers(): Readonly<Record<TerminalModifier, ModifierState>> {
			return modifiers;
		},

		get notice(): Notice | null {
			return notice;
		},

		/** Lines in a paste waiting for the user to confirm it. */
		get pendingPasteLines(): number | null {
			return pending?.lines ?? null;
		},

		/** Whether the active terminal's input has focus, which on a touch
		 *  device is whether the software keyboard is up. */
		get keyboard(): boolean {
			return inputFocused;
		},

		resolvePaste(confirmed: boolean): void {
			const resolved = pending;
			pending = null;
			if (!resolved) return;
			if (confirmed) paste(resolved.terminal, resolved.text);
			resolved.terminal.focus();
		},

		/** Run an on-screen key on the active tab. Paste reads the clipboard, so
		 *  it, like the keyboard toggle, must run in a user gesture. */
		press(key: TerminalKeyPress, repeated = false): void {
			if (key === "nothing") return;
			const terminal = activeTerminal();
			if (!terminal) return;
			if (isTerminalModifier(key)) {
				// A second tap either locks the modifier or releases it.
				const next = {
					off: "waiting",
					waiting: settings().tapTwiceToLock ? "locked" : "off",
					locked: "off",
				} as const;
				modifiers[key] = next[modifiers[key]];
				if (key === "cmd" && modifiers.cmd === "waiting")
					cmdSelection = terminal.getSelection();
				return;
			}
			if (key === "paste") return void pasteClipboard(terminal);
			// The Copy key never goes through the emulator's input, so nothing
			// has cleared the live selection.
			if (key === "copy") return void copy(terminal.getSelection());
			if (key === "keyboard") {
				if (inputFocused) terminal.textarea?.blur();
				else terminal.focus();
				return;
			}
			repeating = repeated;
			// input fires onData synchronously, so the flag covers exactly this key.
			terminal.input(encode(terminal, key));
			repeating = false;
		},

		/** Called by each tab on mount. Takes over the terminal's data stream,
		 *  which carries typed keys, pastes and on-screen keys alike. */
		connect(
			ptyId: string,
			terminal: Terminal,
			send: (data: string) => void,
		): () => void {
			terminals.set(ptyId, terminal);
			terminal.options.macOptionIsMeta = settings().optionKey === "meta";
			// connect can run outside component setup. Its subscription lives
			// exactly as long as this terminal's data listeners.
			const stopOptions = $effect.root(() => {
				$effect(() => {
					terminal.options.macOptionIsMeta = settings().optionKey === "meta";
				});
			});
			const commands: Record<string, () => void> = {
				v: () => void pasteClipboard(terminal),
				f: () => openFind(terminal),
				c: () => void copy(cmdSelection),
				k: () => {
					// Leaves only the prompt line, and sends nothing to the program.
					terminal.clear();
					const { active } = terminal.buffer;
					const prompt = active.getLine(active.baseY + active.cursorY);
					replaceScrollback(
						ptyId,
						prompt?.translateToString(false, 0, active.cursorX) ?? "",
					);
				},
			};
			const data = terminal.onData((input) => {
				const bytes = pasting ? input : applyModifiers(input, commands);
				if (bytes) send(bytes);
			});
			const selection = terminal.onSelectionChange(() => {
				if (modifiers.cmd !== "off" && terminal.hasSelection())
					cmdSelection = terminal.getSelection();
			});
			// The keyboard's own paste gets the same guard as the Paste key.
			// Capture runs before xterm's listener on its textarea.
			const onPaste = (event: ClipboardEvent) => {
				event.preventDefault();
				event.stopImmediatePropagation();
				const text = event.clipboardData?.getData("text/plain");
				if (text) guardedPaste(terminal, text);
			};
			terminal.element?.addEventListener("paste", onPaste, true);
			const onFocus = (event: FocusEvent) =>
				(inputFocused = event.type === "focus");
			terminal.textarea?.addEventListener("focus", onFocus);
			terminal.textarea?.addEventListener("blur", onFocus);
			return () => {
				stopOptions();
				data.dispose();
				selection.dispose();
				terminal.element?.removeEventListener("paste", onPaste, true);
				terminal.textarea?.removeEventListener("focus", onFocus);
				terminal.textarea?.removeEventListener("blur", onFocus);
				if (terminal.textarea === document.activeElement) inputFocused = false;
				if (terminals.get(ptyId) === terminal) terminals.delete(ptyId);
			};
		},
	};
}

export type TerminalKeys = ReturnType<typeof createTerminalKeys>;
