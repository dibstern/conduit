<!--
  TerminalTab — Single terminal instance.
  Creates the xterm emulator on mount and connects it to the panel's terminal
  keys module, which feeds its data stream into PtyInput. Subscribes to PTY
  output via the non-reactive callback pattern, replays scrollback on mount, and
  handles its own resize via ResizeObserver on the container element.
-->
<script lang="ts">
	import { onMount } from "svelte";
	import {
		onOutput,
		getScrollback,
	} from "../../stores/terminal.svelte.js";
	import { getBrowserClientId } from "../../stores/client-identity.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { toastFailure } from "../../transport/rpc-errors.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import { FitAddon } from "@xterm/addon-fit";
	import { Terminal } from "@xterm/xterm";
	import "@xterm/xterm/css/xterm.css";
	import type { TerminalKeys } from "../../utils/terminal-keys.svelte.js";
	import { XTERM_THEMES } from "../../utils/xterm-themes.js";
	import { themeState } from "../../stores/theme.svelte.js";

	let {
		ptyId,
		active,
		keys,
		fontSize,
		onFontSizeResize,
	}: {
		ptyId: string;
		active: boolean;
		keys: TerminalKeys;
		fontSize?: number;
		onFontSizeResize?: (size: { cols: number; rows: number }) => void;
	} = $props();

	let containerEl: HTMLDivElement;
	let mounted = $state<{ terminal: Terminal; fit: FitAddon } | null>(null);

	function refit(): { cols: number; rows: number } {
		if (!mounted) return { cols: 0, rows: 0 };
		mounted.fit.fit();
		return { cols: mounted.terminal.cols, rows: mounted.terminal.rows };
	}

	function sendResize(size: { cols: number; rows: number }) {
		const projectSlug = getCurrentSlug();
		if (!projectSlug) return;
		void rpc("ResizePty", {
			projectSlug,
			ptyId,
			originId: getBrowserClientId(),
			cols: size.cols,
			rows: size.rows,
		}).catch(() => undefined);
	}

	// Keystrokes must reach the shell in order, but the server runs each call on
	// its own fiber. So one PtyInput is in flight at a time and whatever is typed
	// meanwhile rides the next one. No timer: the first key goes out at once.
	let unsentInput = "";
	let sendingInput = false;

	async function sendInput(data: string) {
		unsentInput += data;
		if (sendingInput) return;
		sendingInput = true;
		while (unsentInput) {
			const projectSlug = getCurrentSlug();
			const chunk = unsentInput;
			unsentInput = "";
			if (!projectSlug) break;
			try {
				await rpc("PtyInput", { projectSlug, ptyId, data: chunk });
			} catch (error) {
				toastFailure("Terminal input was not delivered", "warn")(error);
				unsentInput = "";
			}
		}
		sendingInput = false;
	}

	function initializeTerminal(): () => void {
		const terminal = new Terminal({
			// The resolved theme goes in before any data is written.
			theme: XTERM_THEMES[themeState.resolved],
			fontFamily:
				"Berkeley Mono, IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace",
			fontSize: fontSize ?? 13,
			cursorBlink: true,
			cursorStyle: "block",
			scrollback: 5000,
			// The search addon's match highlights are decorations, still proposed API.
			allowProposedApi: true,
		});
		const fitAddon = new FitAddon();
		terminal.loadAddon(fitAddon);
		terminal.open(containerEl);
		fitAddon.fit();
		mounted = { terminal, fit: fitAddon };

		// Wire user input → server, through the keys module
		const disconnect = keys.connect(ptyId, terminal, (data) => void sendInput(data));

		// Wire resize → server
		terminal.onResize(sendResize);

		// Replay scrollback buffer (reconnection / tab remount)
		const buffer = getScrollback(ptyId);
		for (const chunk of buffer) {
			terminal.write(chunk);
		}

		// Subscribe to live PTY output (high-throughput, bypasses Svelte reactivity)
		const unsubOutput = onOutput(ptyId, (data: string, replace?: boolean) => {
			// Queue cancellation and reset after any earlier writes, before replay.
			terminal.write(replace ? `\x18\x1bc${data}` : data);
		});

		// Send initial dimensions to server
		sendResize({ cols: terminal.cols, rows: terminal.rows });

		// Focus if this is the active tab
		if (active) terminal.focus();

		// Own resize handling — fit terminal when container dimensions change
		const ro = new ResizeObserver(() => {
			fitAddon.fit();
		});
		ro.observe(containerEl);

		// Translate vertical swipe gestures into xterm scrollLines() calls
		// so users can scroll the terminal scrollback on touch devices.
		let touchStartY: number | null = null;
		let touchAccum = 0; // accumulated px not yet converted to lines
		const LINE_HEIGHT_PX = 16; // approximate; close enough for scrolling feel

		function onTouchStart(e: TouchEvent) {
			if (e.touches.length === 1) {
				const touch = e.touches.item(0);
				if (!touch) return;
				touchStartY = touch.clientY;
				touchAccum = 0;
			}
		}

		function onTouchMove(e: TouchEvent) {
			if (touchStartY === null || e.touches.length !== 1) return;
			e.preventDefault(); // prevent page scroll while swiping terminal
			const touch = e.touches.item(0);
			if (!touch) return;
			const currentY = touch.clientY;
			const deltaY = touchStartY - currentY; // positive = swiped up
			touchStartY = currentY;
			touchAccum += deltaY;

			const lines = Math.trunc(touchAccum / LINE_HEIGHT_PX);
			if (lines !== 0) {
				terminal.scrollLines(lines);
				touchAccum -= lines * LINE_HEIGHT_PX;
			}
		}

		function onTouchEnd() {
			touchStartY = null;
			touchAccum = 0;
		}

		containerEl.addEventListener("touchstart", onTouchStart, {
			passive: true,
		});
		containerEl.addEventListener("touchmove", onTouchMove, {
			passive: false,
		});
		containerEl.addEventListener("touchend", onTouchEnd);

		return () => {
			containerEl.removeEventListener("touchstart", onTouchStart);
			containerEl.removeEventListener("touchmove", onTouchMove);
			containerEl.removeEventListener("touchend", onTouchEnd);
			ro.disconnect();
			unsubOutput();
			disconnect();
			terminal.dispose();
			mounted = null;
		};
	}

	onMount(() => {
		let destroyed = false;
		let cleanup: (() => void) | undefined;
		// xterm measures the first font it sees. Wait for the hosted face so its
		// row height cannot be measured from a fallback and change after paint.
		void document.fonts
			.load(`${fontSize ?? 13}px "IBM Plex Mono"`)
			.catch(() => [])
			.then(() => {
				if (!destroyed) cleanup = initializeTerminal();
			});
		return () => {
			destroyed = true;
			cleanup?.();
		};
	});

	// When tab becomes active: re-fit (container may have had zero dimensions
	// when hidden) and focus the terminal.
	$effect(() => {
		if (active && mounted) {
			refit();
			mounted.terminal.focus();
		}
	});

	// When font size changes, re-fit and notify parent of new dimensions
	$effect(() => {
		if (fontSize && mounted) {
			mounted.terminal.options.fontSize = fontSize;
			onFontSizeResize?.(refit());
		}
	});

	// When theme changes, update the terminal theme
	$effect(() => {
		if (!mounted) return;
		mounted.terminal.options.theme = XTERM_THEMES[themeState.resolved];
	});
</script>

<div
	bind:this={containerEl}
	class="term-tab-content absolute inset-0"
	class:hidden={!active}
	data-pty-id={ptyId}
></div>
