<!-- Renders assistant markdown with streaming support, code blocks with -->
<!-- language headers + copy buttons, mermaid diagrams, and copy-on-click. -->
<!-- Preserves .msg-assistant class for E2E. -->

<script module lang="ts">
	import type { Mermaid } from "mermaid";

	// Module-level: shared across all AssistantMessage instances.
	// Avoids O(n) mermaid re-init when theme changes with many visible messages.
	let mermaidInitialized = false;
	// Mermaid is large, so it loads with the first diagram rather than at startup.
	let mermaidModule: Promise<Mermaid> | null = null;
	const loadMermaid = () =>
		(mermaidModule ??= import("mermaid").then((m) => m.default));
</script>

<script lang="ts">
	import { tick, onDestroy, mount, unmount } from "svelte";
	import type { AssistantMessage } from "../../types.js";
	import { copyToClipboard } from "../../utils/clipboard.js";
	import { isLoading, sessionMessages } from "../../stores/chat.svelte.js";
	import { initTableScrollShadows } from "../../utils/table-scroll.js";
	import { loadHighlighter } from "../../utils/load-highlighter.js";
	import { themeState } from "../../stores/theme.svelte.js";
	import CodeBlockHeader from "../ui/CodeBlockHeader.svelte";
	import AssistantHeader from "./AssistantHeader.svelte";

	let { message, forkMessageId, sessionId, hideHeader = false, model, providerId }: {
		message: AssistantMessage;
		forkMessageId?: string | undefined;
		sessionId?: string | undefined;
		hideHeader?: boolean;
		model?: string | undefined;
		providerId?: string | undefined;
	} = $props();
	let containerEl: HTMLDivElement | undefined = $state();

	type CopyState = "idle" | "primed" | "done";
	let copyState: CopyState = $state("idle");
	let copyResetTimer: ReturnType<typeof setTimeout> | null = null;
	$effect(() => {
		if (copyState === "idle") return;
		copyResetTimer = setTimeout(() => { copyState = "idle"; }, 3000);
		return () => { if (copyResetTimer) clearTimeout(copyResetTimer); };
	});


	// Mermaid init (once globally)

	function initializeMermaid(mermaid: Mermaid): void {
		const styles = getComputedStyle(document.documentElement);
		const get = (name: string, fallback: string) =>
			styles.getPropertyValue(name).trim() || fallback;
		const vars = {
			darkMode: themeState.resolved === "dark",
			background: get("--color-code-bg", "#141416"),
			edgeLabelBackground: get("--color-code-bg", "#141416"),
			clusterBkg: get("--color-bg-alt", "#232327"),
			// Under theme "base", primaryColor IS the node fill, so it must be a
			// surface token. Nodes read as panels; accent is reserved for emphasis.
			primaryColor: get("--color-bg-alt", "#232327"),
			primaryTextColor: get("--color-text", "#ededf0"),
			primaryBorderColor: get("--color-border", "#2b2b31"),
			lineColor: get("--color-text-muted", "#a1a1aa"),
			secondaryColor: get("--color-bg-surface", "#1a1a1d"),
			tertiaryColor: get("--color-bg", "#111113"),
			fontFamily: get("--font-sans", "Geist, system-ui, sans-serif"),
		};

		mermaid.initialize({
			startOnLoad: false,
			// "base" is the only mermaid theme that honours themeVariables. The prebuilt
			// "default"/"dark" themes recompute their own palette and discard most of
			// what we pass, which left light-mode diagrams rendering mermaid's stock
			// lavender (#ECECFF) instead of conduit's tokens.
			theme: "base",
			themeVariables: vars,
		});
	}

	async function ensureMermaid(): Promise<Mermaid> {
		const mermaid = await loadMermaid();
		if (!mermaidInitialized) {
			initializeMermaid(mermaid);
			mermaidInitialized = true;
		}
		return mermaid;
	}

	// Re-initialize mermaid when theme changes and re-render existing diagrams.
	// Until a diagram has loaded mermaid there is nothing to re-theme.
	$effect(() => {
		const _resolvedTheme = themeState.resolved;
		void mermaidModule?.then((mermaid) => {
			initializeMermaid(mermaid);
			if (!containerEl) return;
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
		});
	});

	// Track table scroll shadow cleanup so we can tear down listeners/observers
	// before re-attaching on the next render, and on component destroy.
	let tableScrollCleanup: (() => void) | null = null;

	async function postRender() {
		if (!containerEl) return;
		await tick();
		// Re-check after async yield — component may have unmounted during tick
		if (!containerEl?.isConnected) return;

		const contentEl = containerEl.querySelector(".md-content");
		if (!contentEl) return;

		// Tear down previous scroll shadow listeners before re-attaching
		tableScrollCleanup?.();
		tableScrollCleanup = initTableScrollShadows(contentEl as HTMLElement).destroy;

		// Add code block headers
		addCodeBlockHeaders(contentEl as HTMLElement);

		void highlightCodeBlocks(contentEl as HTMLElement);

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
		const replaying = sessionId === undefined
			? isLoading()
			: sessionMessages.get(sessionId)?.loadLifecycle === "loading";
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
		return undefined;
	});

	const codeHeaders = new Map<HTMLElement, ReturnType<typeof mount>>();
	function addCodeBlockHeaders(container: HTMLElement): void {
		for (const [element, component] of codeHeaders) {
			if (container.contains(element)) continue;
			void unmount(component);
			codeHeaders.delete(element);
		}
		for (const pre of container.querySelectorAll("pre")) {
			if (pre.querySelector(".code-header")) continue;
			const code = pre.querySelector("code");
			if (!code) continue;
			const language = [...code.classList].find((name) => name.startsWith("language-"))?.slice(9) ?? "";
			if (language === "mermaid") continue;
			const text = code.textContent ?? "";
			const lines = text.split("\n");
			const diff = language === "diff" || language === "patch";
			const oldPathIndex = diff ? lines.findIndex((line) => line.startsWith("--- ")) : -1;
			const newPathIndex = diff ? lines.findIndex((line) => line.startsWith("+++ ")) : -1;
			const diffPath = newPathIndex < 0 ? undefined : lines[newPathIndex]?.slice(4).replace(/^b\//, "");
			const filename = code.dataset["filename"] ?? (diffPath === "/dev/null" ? lines[oldPathIndex]?.slice(4).replace(/^a\//, "") : diffPath);
			if (filename && oldPathIndex >= 0 && newPathIndex === oldPathIndex + 1) {
				code.textContent = lines.filter((_, index) => index !== oldPathIndex && index !== newPathIndex).join("\n");
			}
			const header = document.createElement("div");
			header.className = "code-header";
			pre.prepend(header);
			codeHeaders.set(header, mount(CodeBlockHeader, {
				target: header,
				props: {
					label: language || "code", filename, code: text,
					additions: diff ? lines.filter((line) => line.startsWith("+") && !line.startsWith("+++ ")).length : undefined,
					deletions: diff ? lines.filter((line) => line.startsWith("-") && !line.startsWith("--- ")).length : undefined,
				},
			}));
		}
	}

	async function highlightCodeBlocks(container: HTMLElement): Promise<void> {
		const blocks = [...container.querySelectorAll<HTMLElement>(
			"pre code:not(.hljs):not(.language-mermaid)",
		)].filter((block) => !block.closest(".tool-result"));
		if (!blocks.length) return;
		const hljs = await loadHighlighter();
		const highlight = () => {
			const replaying = sessionId === undefined
				? isLoading()
				: sessionMessages.get(sessionId)?.loadLifecycle === "loading";
			if (!container.isConnected || !message.html || replaying) return;

			for (const block of blocks) {
				if (!block.isConnected || block.dataset["highlighted"] || block.classList.contains("hljs")) continue;
				hljs.highlightElement(block);
				if (block.matches(".language-diff, .language-patch")) {
					block.innerHTML = block.innerHTML.replace(/\n$/, "").split("\n").map((line) => `<span class="diff-line">${line || " "}</span>`).join("");
				}
			}
		};
		// A cold import resumes all waiting messages together; spread the work out again.
		if (typeof requestIdleCallback === "function") {
			requestIdleCallback(highlight);
		} else {
			highlight();
		}
	}

	async function renderMermaidBlocks(container: HTMLElement): Promise<void> {
		const blocks = container.querySelectorAll("code.language-mermaid");
		if (blocks.length === 0) return;
		const mermaid = await ensureMermaid();

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

	function handleClick(e: MouseEvent) {
		if (!message.finalized) return;

		// Don't intercept clicks on interactive elements
		const target = e.target as HTMLElement;
		if (
			target.closest(".assistant-header") ||
			target.closest("button") ||
			target.closest("[role=menuitem]") ||
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
		} else if (copyState === "primed") {
			copyToClipboard(message.rawText);
			copyState = "done";
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (!message.finalized) return;
		if (e.target instanceof Element && e.target.closest("button, a, [role=menuitem]")) return;
		if (e.key !== "Enter" && e.key !== " ") return;
		e.preventDefault();

		if (copyState === "idle") {
			copyState = "primed";
		} else if (copyState === "primed") {
			copyToClipboard(message.rawText);
			copyState = "done";
		}
	}


	onDestroy(() => {
		if (copyResetTimer) clearTimeout(copyResetTimer);
		tableScrollCleanup?.();
		for (const component of codeHeaders.values()) void unmount(component);
	});
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
	bind:this={containerEl}
	class="msg-assistant group mx-auto mb-[26px] max-w-[820px] px-[14px] md:px-[32px]"
	data-uuid={message.uuid}
	onclick={handleClick}
	onkeydown={handleKeydown}
	role="article"
>
	{#if !hideHeader}
		<AssistantHeader {message} {forkMessageId} {sessionId} {model} {providerId} bind:copyState />
	{/if}
	<div class="md-content min-w-0 text-[15px] leading-[1.65] md:ml-[42px] {hideHeader ? '' : 'mt-[2px]'} {copyState === 'primed' ? 'bg-selection' : copyState === 'done' ? 'bg-success/5' : ''}">
		{@html message.html}
	</div>
	{#if hideHeader && copyState !== "idle"}
		<p role="status" class="mt-[4px] text-[12px] md:ml-[42px] {copyState === 'done' ? 'text-success' : 'text-text-muted'}">{copyState === "done" ? "Copied!" : "Click again to copy"}</p>
	{/if}
</div>
