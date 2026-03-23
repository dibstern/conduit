<!-- ─── Assistant Message ────────────────────────────────────────────────────── -->
<!-- Renders assistant markdown with streaming support, code blocks with -->
<!-- language headers + copy buttons, mermaid diagrams, and copy-on-click. -->
<!-- Preserves .msg-assistant class for E2E. -->

<script module lang="ts">
	// Module-level: shared across all AssistantMessage instances.
	// Avoids O(n) mermaid re-init when theme changes with many visible messages.
	let mermaidInitialized = false;
</script>

<script lang="ts">
	import { tick, onDestroy } from "svelte";
	import type { AssistantMessage } from "../../types.js";
	import { copyToClipboard } from "../../utils/clipboard.js";
	import { chatState } from "../../stores/chat.svelte.js";
	import { wsSend } from "../../stores/ws.svelte.js";
	import { assertNever } from "../../../utils.js";
	import Icon from "../shared/Icon.svelte";
	import hljs from "highlight.js";
	// Register aliases for template languages not natively supported by highlight.js.
	// Consistent with FileViewer's mapExtToLanguage mapping (svelte/vue → xml).
	hljs.registerAliases(["svelte", "vue"], { languageName: "xml" });
	import mermaid from "mermaid";
	import {
		themeState,
		getCurrentTheme,
	} from "../../stores/theme.svelte.js";
	import { computeMermaidVars } from "../../stores/theme-compute.js";

	let { message }: { message: AssistantMessage } = $props();
	let containerEl: HTMLDivElement | undefined = $state();

	// ─── Copy-on-click state machine ───────────────────────────────────────────
	type CopyState = "idle" | "primed" | "done";
	let copyState: CopyState = $state("idle");
	let copyResetTimer: ReturnType<typeof setTimeout> | null = null;

	// ─── Mermaid init (once globally) ──────────────────────────────────────────

	function initializeMermaid(): void {
		const theme = getCurrentTheme();
		let vars: ReturnType<typeof computeMermaidVars>;
		if (theme) {
			vars = computeMermaidVars(theme);
		} else {
			// Read fallback values from the active CSS custom properties
			const s = getComputedStyle(document.documentElement);
			const get = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
			vars = {
				darkMode: false,
				background: get("--color-code-bg", "#f5f4f3"),
				primaryColor: get("--color-accent", "#1d1b1b"),
				primaryTextColor: get("--color-text", "#1d1b1b"),
				primaryBorderColor: get("--color-border", "#e0dfde"),
				lineColor: get("--color-text-muted", "#999999"),
				secondaryColor: get("--color-bg-alt", "#f7f6f5"),
				tertiaryColor: get("--color-bg", "#fdfdfc"),
				fontFamily:
					"'Berkeley Mono', 'IBM Plex Mono', ui-monospace, monospace",
			};
		}

		mermaid.initialize({
			startOnLoad: false,
			theme: vars.darkMode ? "dark" : "default",
			themeVariables: vars,
		});
	}

	function ensureMermaidInit(): void {
		if (mermaidInitialized) return;
		initializeMermaid();
		mermaidInitialized = true;
	}

	// Re-initialize mermaid when theme changes and re-render existing diagrams
	$effect(() => {
		const _themeId = themeState.currentThemeId;
		initializeMermaid();
		// Re-render already-rendered mermaid diagrams with the new theme
		if (containerEl) {
			const diagrams = containerEl.querySelectorAll(".mermaid-diagram");
			for (const wrapper of diagrams) {
				const svgEl = wrapper.querySelector("svg");
				if (!svgEl) continue;
				// Mermaid stores the original source in a data attribute
				const source =
					svgEl.getAttribute("data-mermaid-source") ??
					wrapper.getAttribute("data-mermaid-source");
				if (!source) continue;
				const id = `mermaid-${Math.random().toString(36).slice(2, 8)}`;
				mermaid
					.render(id, source)
					.then(({ svg }) => {
						wrapper.innerHTML = svg;
						// Preserve source for future re-renders
						const newSvg = wrapper.querySelector("svg");
						if (newSvg)
							newSvg.setAttribute("data-mermaid-source", source);
					})
					.catch(() => {
						// Diagram failed to re-render with new theme — keep old SVG
					});
			}
		}
	});

	// ─── Post-render: code block headers + syntax highlighting ─────────────────

	async function postRender() {
		if (!containerEl) return;
		await tick();
		// Re-check after async yield — component may have unmounted during tick
		if (!containerEl) return;

		const contentEl = containerEl.querySelector(".md-content");
		if (!contentEl) return;

		// Add code block headers
		addCodeBlockHeaders(contentEl as HTMLElement);

		// Syntax highlighting via hljs (npm import)
		highlightCodeBlocks(contentEl as HTMLElement);

		// Mermaid diagrams
		renderMermaidBlocks(contentEl as HTMLElement);
	}

	// Re-render when HTML changes
	$effect(() => {
		// Track both html content and replaying flag.
		// During replay: skip all post-render work (hljs, code headers, mermaid)
		//   — these are wasted CPU for off-screen blocks rendered during event replay.
		// When replay ends: replaying becomes false, effect re-fires, postRender runs.
		// All mounted AssistantMessage instances will run postRender when replay ends.
		// requestIdleCallback spreads the work across idle frames to avoid a single jank spike.
		const _html = message.html;
		const replaying = chatState.replaying;
		// @perf-guard C1 — removing this guard causes 50-300ms of wasted hljs/mermaid CPU during session switch replay
		if (!_html || replaying) return;

		// Use requestIdleCallback to avoid a jank spike when replay ends
		// and all AssistantMessage effects re-fire on the same frame.
		// During normal streaming (not post-replay), requestIdleCallback
		// fires almost immediately since the main thread is idle between
		// each streamed message.
		if (typeof requestIdleCallback === "function") {
			const handle = requestIdleCallback(() => postRender());
			return () => cancelIdleCallback(handle);
		}
		// Fallback for environments without requestIdleCallback (SSR, old browsers)
		postRender();
	});

	// ─── Code block headers ────────────────────────────────────────────────────

	function addCodeBlockHeaders(container: HTMLElement): void {
		const pres = container.querySelectorAll("pre");
		for (const pre of pres) {
			if (pre.querySelector(".code-header")) continue;

			const code = pre.querySelector("code");
			let lang = "";
			if (code) {
				const cls = Array.from(code.classList).find((c) =>
					c.startsWith("language-"),
				);
				if (cls) lang = cls.replace("language-", "");
			}
			if (lang === "mermaid") continue;

			const header = document.createElement("div");
			header.className =
				"code-header flex justify-between items-center text-sm py-1 px-3 border-b border-border-subtle text-text-dimmer";

			const langSpan = document.createElement("span");
			langSpan.textContent = lang || "code";

			const copyBtn = document.createElement("button");
			copyBtn.className =
				"code-copy-btn text-sm cursor-pointer bg-transparent border border-border rounded px-2 py-0.5 text-text-muted hover:text-text hover:bg-bg-alt transition-colors duration-150";
			copyBtn.textContent = "Copy";
			copyBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				const codeEl = pre.querySelector("code");
				if (codeEl) {
					copyToClipboard(codeEl.textContent ?? "");
					copyBtn.textContent = "Copied!";
					copyBtn.classList.add("text-success", "border-success");
					setTimeout(() => {
						copyBtn.textContent = "Copy";
						copyBtn.classList.remove("text-success", "border-success");
					}, 1500);
				}
			});

			header.appendChild(langSpan);
			header.appendChild(copyBtn);
			pre.insertBefore(header, pre.firstChild);
		}
	}

	// ─── Syntax highlighting ───────────────────────────────────────────────────

	function highlightCodeBlocks(container: HTMLElement): void {
		const blocks = container.querySelectorAll(
			"pre code:not(.hljs):not(.language-mermaid)",
		);
		for (const block of blocks) {
			if (block.closest(".tool-result")) continue;
			hljs.highlightElement(block as HTMLElement);
		}
	}

	// ─── Mermaid diagrams ──────────────────────────────────────────────────────

	async function renderMermaidBlocks(container: HTMLElement): Promise<void> {
		ensureMermaidInit();

		const blocks = container.querySelectorAll("code.language-mermaid");
		for (const code of blocks) {
			const pre = code.parentElement;
			if (!pre || pre.tagName !== "PRE") continue;
			if (pre.classList.contains("mermaid-rendered")) continue;

			const text = code.textContent ?? "";
			const id = `mermaid-${Math.random().toString(36).slice(2, 8)}`;

			try {
				const { svg } = await mermaid.render(id, text);
				const wrapper = document.createElement("div");
				wrapper.className =
					"mermaid-diagram my-2 p-4 bg-code-bg border border-border-subtle rounded-lg overflow-x-auto cursor-pointer text-center hover:border-border [&_svg]:max-w-full [&_svg]:h-auto";
				wrapper.setAttribute("data-mermaid-source", text);
				wrapper.innerHTML = svg;
				// Also store source on the SVG for theme re-renders
				const svgEl = wrapper.querySelector("svg");
				if (svgEl) svgEl.setAttribute("data-mermaid-source", text);
				pre.replaceWith(wrapper);
			} catch {
				pre.classList.add("mermaid-rendered", "border-error/30");
				const hint = document.createElement("div");
				hint.className = "text-xs text-error py-1 px-3 italic";
				hint.textContent = "Diagram syntax error";
				pre.appendChild(hint);
			}
		}
	}

	// ─── Copy-on-click handlers ────────────────────────────────────────────────

	function handleClick(e: MouseEvent) {
		if (!message.finalized) return;

		// Don't intercept clicks on interactive elements
		const target = e.target as HTMLElement;
		if (
			target.closest("a") ||
			target.closest("pre") ||
			target.closest("code") ||
			target.closest(".code-header") ||
			target.closest(".code-copy-btn")
		)
			return;

		// Don't intercept if user selected text
		const selection = window.getSelection();
		if (selection && selection.toString().length > 0) return;

		if (copyState === "idle") {
			copyState = "primed";
			if (copyResetTimer) clearTimeout(copyResetTimer);
			copyResetTimer = setTimeout(() => {
				copyState = "idle";
			}, 3000);
		} else if (copyState === "primed") {
			copyToClipboard(message.rawText);
			copyState = "done";
			if (copyResetTimer) clearTimeout(copyResetTimer);
			copyResetTimer = setTimeout(() => {
				copyState = "idle";
			}, 3000);
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (!message.finalized) return;
		if (e.key !== "Enter" && e.key !== " ") return;
		e.preventDefault();

		if (copyState === "idle") {
			copyState = "primed";
			if (copyResetTimer) clearTimeout(copyResetTimer);
			copyResetTimer = setTimeout(() => {
				copyState = "idle";
			}, 3000);
		} else if (copyState === "primed") {
			copyToClipboard(message.rawText);
			copyState = "done";
			if (copyResetTimer) clearTimeout(copyResetTimer);
			copyResetTimer = setTimeout(() => {
				copyState = "idle";
			}, 3000);
		}
	}

	// ─── Fork handler ─────────────────────────────────────────────────────────

	function handleFork(e: MouseEvent) {
		e.stopPropagation(); // Don't trigger the copy click handler
		if (message.messageId) {
			wsSend({
				type: "fork_session",
				messageId: message.messageId,
			});
		}
	}

	// ─── Hint text ─────────────────────────────────────────────────────────────

	const hintText = $derived.by(() => {
		switch (copyState) {
			case "idle":
				return "Click to grab this";
			case "primed":
				return "Click again to copy";
			case "done":
				return "Copied!";
			default:
				return assertNever(copyState);
		}
	});

	// TODO: Look into this warning:
	// This comparison appears to be unintentional because the types '"idle"' and '"done"' have no overlap.ts(2367)
	const hintColor = $derived(
		copyState === "done" ? "text-success" : "text-text-dimmer",
	);

	// Dynamic classes for copy state (Tailwind classes with / can't use class: directive)
	const containerCopyClass = $derived.by(() => {
		if (copyState === "primed")
			return "bg-[rgba(var(--overlay-rgb),0.03)] cursor-pointer";
		if (copyState === "done") return "bg-success/[0.06]";
		return "";
	});

	// ─── Cleanup ───────────────────────────────────────────────────────────────

	onDestroy(() => {
		if (copyResetTimer) clearTimeout(copyResetTimer);
	});
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
	bind:this={containerEl}
	class="msg-assistant group max-w-[760px] mx-auto mb-3 px-5 {containerCopyClass}"
	data-uuid={message.uuid}
	onclick={handleClick}
	onkeydown={handleKeydown}
	role="article"
>
	<div class="bg-bg-surface rounded-[10px] py-4 px-5 relative glow-brand-b transition-colors duration-150">
		<!-- Action buttons (hover) — top-right icon row -->
		{#if message.finalized}
			<div
				class="msg-actions absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 touch:opacity-100 transition-opacity duration-150 z-10"
				class:opacity-100={copyState !== "idle"}
			>
				<button
					class="flex items-center justify-center w-7 h-7 rounded-md border cursor-pointer transition-colors duration-150 backdrop-blur-sm {copyState === 'done' ? 'border-success/30 bg-success/10 text-success' : copyState === 'primed' ? 'border-brand-b/30 bg-brand-b/10 text-brand-b' : 'border-border-subtle/50 bg-bg-surface/80 text-text-muted hover:text-text-secondary'}"
					title={copyState === 'done' ? 'Copied!' : copyState === 'primed' ? 'Click to confirm copy' : 'Copy message'}
					onclick={handleClick}
				>
					{#if copyState === 'done'}
						<Icon name="check" size={14} />
					{:else}
						<Icon name="copy" size={14} />
					{/if}
				</button>
				{#if message.messageId}
					<button
						class="flex items-center justify-center w-7 h-7 rounded-md border border-border-subtle/50 bg-bg-surface/80 text-text-muted hover:text-text-secondary cursor-pointer transition-colors duration-150 backdrop-blur-sm"
						title="Fork from here"
						onclick={handleFork}
					>
						<Icon name="git-fork" size={14} />
					</button>
				{/if}
			</div>
		{/if}

		<div class="text-sm font-mono font-semibold uppercase tracking-[1.5px] text-brand-b mb-2">Assistant</div>
		<div class="md-content text-base leading-[1.7]">
			{@html message.html}
		</div>
	</div>
</div>
