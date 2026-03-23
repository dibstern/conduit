<!-- ─── File Viewer ───────────────────────────────────────────────────────────── -->
<!-- Split-pane file content viewer with syntax highlighting, line numbers, -->
<!-- and copy-to-clipboard. Sits beside #app on desktop, full overlay on mobile. -->

<script lang="ts">
	import type { RelayMessage } from "../../types.js";
	import { COPY_FEEDBACK_MS } from "../../ui-constants.js";
	import { onFileBrowser } from "../../stores/ws.svelte.js";
	import { copyToClipboard } from "../../utils/clipboard.js";
	import { showToast, openMobileSidebar, setSidebarPanel, uiState } from "../../stores/ui.svelte.js";
	import hljs from "highlight.js";
	import Icon from "../shared/Icon.svelte";
	import BlockGrid from "../shared/BlockGrid.svelte";

	let {
		visible = false,
		onClose,
	}: {
		visible?: boolean;
		onClose?: () => void;
	} = $props();

	// ─── Font size state ──────────────────────────────────────────────────────

	const FONT_SIZE_MIN = 6;
	const FONT_SIZE_MAX = 24;
	const FONT_SIZE_DEFAULT = 13;
	const FONT_SIZE_STEP = 1;
	const FONT_SIZE_STORAGE_KEY = "file-viewer-font-size";

	let fontSize = $state(
		Number(
			typeof localStorage !== "undefined" &&
				localStorage.getItem(FONT_SIZE_STORAGE_KEY),
		) || FONT_SIZE_DEFAULT,
	);

	function decreaseFontSize() {
		const next = Math.max(FONT_SIZE_MIN, fontSize - FONT_SIZE_STEP);
		if (next !== fontSize) {
			fontSize = next;
			persistFontSize();
		}
	}

	function increaseFontSize() {
		const next = Math.min(FONT_SIZE_MAX, fontSize + FONT_SIZE_STEP);
		if (next !== fontSize) {
			fontSize = next;
			persistFontSize();
		}
	}

	function persistFontSize() {
		try {
			localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(fontSize));
		} catch {
			/* ignore */
		}
	}

	// ─── State ─────────────────────────────────────────────────────────────────

	let filePath = $state<string | null>(null);
	let content = $state<string | null>(null);
	let binary = $state(false);
	let truncated = $state(false);
	let loading = $state(false);
	let copyIcon = $state<"copy" | "check">("copy");

	// DOM ref for the <code> element (for hljs)
	let codeEl: HTMLElement | undefined = $state();

	// ─── Derived ───────────────────────────────────────────────────────────────

	const fileExt = $derived(filePath?.split(".").pop()?.toLowerCase() ?? "");
	const fileName = $derived(filePath?.split("/").pop() ?? "");

	const lineNumbers = $derived.by(() => {
		if (!content) return "";
		const count = content.split("\n").length;
		const nums: number[] = [];
		for (let i = 1; i <= count; i++) nums.push(i);
		return nums.join("\n");
	});

	// ─── Language mapping (ported from claude-relay) ───────────────────────────

	function mapExtToLanguage(ext: string): string | undefined {
		const map: Record<string, string> = {
			js: "javascript", ts: "typescript", jsx: "javascript", tsx: "typescript",
			py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
			css: "css", html: "xml", xml: "xml", json: "json", yaml: "yaml",
			yml: "yaml", md: "markdown", sh: "bash", bash: "bash", zsh: "bash",
			sql: "sql", c: "c", cpp: "cpp", h: "c", hpp: "cpp",
			cs: "csharp", swift: "swift", kt: "kotlin", vue: "xml", svelte: "xml",
			toml: "ini", dockerfile: "dockerfile", makefile: "makefile",
			r: "r", lua: "lua", php: "php", scala: "scala", zig: "zig",
		};
		return map[ext];
	}

	// ─── Syntax highlighting effect ────────────────────────────────────────────

	$effect(() => {
		if (content && codeEl && !binary) {
			const lang = mapExtToLanguage(fileExt);
			// Reset element before highlighting
			codeEl.textContent = content;
			if (lang) {
				codeEl.className = `language-${lang}`;
				hljs.highlightElement(codeEl);
			} else {
				codeEl.className = "";
				// Try auto-detection for unknown extensions
				hljs.highlightElement(codeEl);
			}
		}
	});

	// ─── WS subscription ──────────────────────────────────────────────────────

	$effect(() => {
		if (!visible) return;
		const unsub = onFileBrowser((msg: RelayMessage) => {
			if (msg.type === "file_content") {
				const rawContent = msg.content ?? "";
				filePath = msg.path;
				binary = msg.binary ?? false;
				const isTruncated = rawContent.length > 50_000;
				truncated = isTruncated;
				content = isTruncated ? rawContent.slice(0, 50_000) : rawContent;
				loading = false;
			}
		});
		return unsub;
	});

	// ─── ESC to close ──────────────────────────────────────────────────────────

	$effect(() => {
		if (!visible) return;
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") {
				e.preventDefault();
				handleClose();
			}
		}
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	});

	// ─── Handlers ──────────────────────────────────────────────────────────────

	async function handleCopy() {
		if (!content) return;
		const ok = await copyToClipboard(content);
		if (ok) {
			copyIcon = "check";
			showToast("Copied to clipboard");
			setTimeout(() => { copyIcon = "copy"; }, COPY_FEEDBACK_MS);
		} else {
			showToast("Failed to copy", { variant: "warn" });
		}
	}

	function handleClose() {
		filePath = null;
		content = null;
		binary = false;
		truncated = false;
		onClose?.();
	}

	function handleOpenFileBrowser() {
		setSidebarPanel("files");
		openMobileSidebar();
	}
</script>

{#if visible && (filePath || loading)}
	<div id="file-viewer" class="file-viewer-pane" style="--file-viewer-w: {uiState.fileViewerWidth}%">
		<!-- Header -->
		<div class="flex items-center gap-2 px-4 py-2.5 border-b border-border-subtle shrink-0 min-h-[44px]">
			<!-- Mobile: file browser button (opens sidebar to files panel) -->
			<button
			class="fv-btn flex lg:hidden items-center justify-center w-7 h-7 rounded-md border-none bg-transparent text-text-muted cursor-pointer shrink-0 transition-[background,color] duration-150 hover:bg-[rgba(var(--overlay-rgb),0.04)] hover:text-text"
			onclick={handleOpenFileBrowser}
				title="File browser"
			>
				<Icon name="folder-tree" size={16} />
			</button>
			<span class="flex-1 font-mono text-base text-text-secondary truncate" dir="rtl">
				{filePath ?? ""}
			</span>
			<!-- Font size controls -->
			<div class="flex items-center gap-0 shrink-0">
				<button
					class="shrink-0 flex items-center justify-center w-[44px] h-[44px] border-none rounded bg-transparent text-text-dimmer font-mono text-base cursor-pointer transition-[color,background] duration-100 hover:text-text hover:bg-bg-alt disabled:opacity-30 disabled:cursor-default"
					title="Decrease font size"
					disabled={fontSize <= FONT_SIZE_MIN}
					onclick={decreaseFontSize}
				>
					&#8722;
				</button>
				<span class="text-sm text-text-dimmer font-mono tabular-nums min-w-[2ch] text-center select-none">{fontSize}</span>
				<button
					class="shrink-0 flex items-center justify-center w-[44px] h-[44px] border-none rounded bg-transparent text-text-dimmer font-mono text-base cursor-pointer transition-[color,background] duration-100 hover:text-text hover:bg-bg-alt disabled:opacity-30 disabled:cursor-default"
					title="Increase font size"
					disabled={fontSize >= FONT_SIZE_MAX}
					onclick={increaseFontSize}
				>
					+
				</button>
			</div>

			<button
			class="fv-btn flex items-center justify-center w-7 h-7 rounded-md border-none bg-transparent text-text-muted cursor-pointer shrink-0 transition-[background,color] duration-150 hover:bg-[rgba(var(--overlay-rgb),0.04)] hover:text-text"
			onclick={handleCopy}
				title="Copy contents"
			>
				<Icon name={copyIcon} size={16} />
			</button>
			<button
			class="fv-btn flex items-center justify-center w-7 h-7 rounded-md border-none bg-transparent text-text-muted cursor-pointer shrink-0 transition-[background,color] duration-150 hover:bg-[rgba(var(--overlay-rgb),0.04)] hover:text-text"
			onclick={handleClose}
				title="Close"
			>
				<Icon name="x" size={16} />
			</button>
		</div>

		<!-- Body -->
		<div class="flex-1 overflow-auto">
			{#if loading}
				<div class="flex items-center justify-center py-12 text-text-dimmer text-sm">
					<BlockGrid cols={5} mode="fast" blockSize={1.5} gap={0.5} class="shrink-0" />
					<span class="ml-2">Loading…</span>
				</div>
			{:else if binary}
				<div class="flex items-center justify-center h-full text-text-dimmer text-sm py-12">
					Binary file — cannot preview
				</div>
			{:else if content !== null}
				<!-- Code with line numbers (two-column flex) -->
				<div class="fv-code flex min-h-0">
					<!-- Gutter (line numbers) -->
				<pre
					class="fv-gutter shrink-0 py-3 pr-2 pl-3.5 text-right select-none border-r border-border-subtle min-w-[44px] sticky left-0 bg-bg z-[1] font-mono leading-[1.55] text-text-dimmer/50"
					style="font-size: {fontSize}px"
				>{lineNumbers}</pre>
					<!-- Code content -->
					<pre class="fv-content flex-1 py-3 px-3.5 min-w-0 font-mono leading-[1.55] text-text-secondary" style="font-size: {fontSize}px"><code bind:this={codeEl}>{content}</code></pre>
				</div>
				{#if truncated}
					<div class="text-xs text-text-dimmer italic px-4 py-2 border-t border-border-subtle">
						File truncated — showing first 50 KB
					</div>
				{/if}
			{/if}
		</div>
	</div>
{/if}
