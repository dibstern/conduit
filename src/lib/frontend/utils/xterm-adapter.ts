// ─── xterm.js Adapter ────────────────────────────────────────────────────────
// Wraps @xterm/xterm (npm) with FitAddon. Implements TerminalAdapter interface.

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { TerminalAdapter } from "../types.js";

// ─── ANSI Theme Colors (design system) ──────────────────────────────────────

export const ANSI_THEME: Record<string, string> = {
	background: "#111111",
	foreground: "#EEEEEE",
	cursor: "#EEEEEE",
	cursorAccent: "#111111",
	selectionBackground: "rgba(92, 156, 245, 0.3)",
	black: "#0A0A0A",
	red: "#E06C75",
	green: "#7FD88F",
	yellow: "#FAB283",
	blue: "#5C9CF5",
	magenta: "#9D7CD8",
	cyan: "#56B6C2",
	white: "#EEEEEE",
	brightBlack: "#606060",
	brightRed: "#E06C75",
	brightGreen: "#7FD88F",
	brightYellow: "#FAB283",
	brightBlue: "#5C9CF5",
	brightMagenta: "#9D7CD8",
	brightCyan: "#56B6C2",
	brightWhite: "#EEEEEE",
};

// ─── Options ────────────────────────────────────────────────────────────────

export interface XtermAdapterOptions {
	theme?: Record<string, string>;
	fontFamily?: string;
	fontSize?: number;
	cursorBlink?: boolean;
	cursorStyle?: "block" | "underline" | "bar";
	scrollback?: number;
}

export const DEFAULT_XTERM_OPTIONS: Required<XtermAdapterOptions> = {
	theme: ANSI_THEME,
	fontFamily:
		"Berkeley Mono, IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace",
	fontSize: 13,
	cursorBlink: true,
	cursorStyle: "block",
	scrollback: 5000,
};

// ─── XtermAdapter class ─────────────────────────────────────────────────────

export class XtermAdapter implements TerminalAdapter {
	private readonly terminal: Terminal;
	private readonly fitAddon: FitAddon;
	private disposed = false;

	constructor(options?: XtermAdapterOptions) {
		const mergedOpts = { ...DEFAULT_XTERM_OPTIONS, ...options };

		this.terminal = new Terminal({
			theme: mergedOpts.theme,
			fontFamily: mergedOpts.fontFamily,
			fontSize: mergedOpts.fontSize,
			cursorBlink: mergedOpts.cursorBlink,
			cursorStyle: mergedOpts.cursorStyle,
			scrollback: mergedOpts.scrollback,
		});

		this.fitAddon = new FitAddon();
		this.terminal.loadAddon(this.fitAddon);
	}

	/** Mount the terminal into a container element. */
	mount(container: HTMLElement): void {
		this.terminal.open(container);
		this.fitAddon.fit();
	}

	/** Write data to the terminal. */
	write(data: string): void {
		if (!this.disposed) {
			this.terminal.write(data);
		}
	}

	/** Register a callback for user input data. */
	onData(cb: (data: string) => void): void {
		this.terminal.onData(cb);
	}

	/** Register a callback for terminal resize events. */
	onResize(cb: (size: { cols: number; rows: number }) => void): void {
		this.terminal.onResize(cb);
	}

	/** Fit the terminal to its container and return new dimensions. */
	resize(): { cols: number; rows: number } {
		this.fitAddon.fit();
		return { cols: this.terminal.cols, rows: this.terminal.rows };
	}

	/** Scroll the terminal viewport by a number of lines (negative = up). */
	scrollLines(n: number): void {
		this.terminal.scrollLines(n);
	}

	/** Update font size and re-fit. Returns new dimensions. */
	setFontSize(px: number): { cols: number; rows: number } {
		this.terminal.options.fontSize = px;
		this.fitAddon.fit();
		return { cols: this.terminal.cols, rows: this.terminal.rows };
	}

	/** Update the terminal theme at runtime */
	setTheme(theme: Record<string, string>): void {
		this.terminal.options.theme = theme;
	}

	/** Focus the terminal. */
	focus(): void {
		this.terminal.focus();
	}

	/** Dispose of the terminal and its addons. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.fitAddon.dispose();
		this.terminal.dispose();
	}

	/** Current column count. */
	get cols(): number {
		return this.terminal.cols;
	}

	/** Current row count. */
	get rows(): number {
		return this.terminal.rows;
	}
}

/** Factory function for creating XtermAdapter instances. */
export function createXtermAdapter(
	options?: XtermAdapterOptions,
): TerminalAdapter {
	return new XtermAdapter(options);
}
