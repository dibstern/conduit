<!-- Renders assistant markdown with streaming support, code blocks with -->
<!-- language headers + copy buttons, pele diagrams, and copy-on-click. -->
<!-- Preserves .msg-assistant class for E2E. -->

<script lang="ts">
	import { tick, onDestroy, mount, unmount } from "svelte";
	import type { AssistantMessage, ModelExecution, UserMessage } from "../../types.js";
	import { copyToClipboard } from "../../utils/clipboard.js";
	import { isLoading, sessionMessages } from "../../stores/chat.svelte.js";
	import { findSession, sessionState } from "../../stores/session.svelte.js";
	import { initTableScrollShadows } from "../../utils/table-scroll.js";
	import { loadHighlighter } from "../../utils/load-highlighter.js";
	import CodeBlockHeader from "../ui/CodeBlockHeader.svelte";
	import Diagram from "./Diagram.svelte";
	import AssistantHeader from "./AssistantHeader.svelte";

	let { message, forkMessageId, sessionId, hideHeader = false, modelExecution, providerId, turnUser }: {
		message: AssistantMessage;
		forkMessageId?: string | undefined;
		sessionId?: string | undefined;
		hideHeader?: boolean;
		modelExecution?: ModelExecution | undefined;
		providerId?: string | undefined;
		turnUser?: UserMessage | undefined;
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


	// Track table scroll shadow cleanup so we can tear down listeners/observers
	// before re-attaching on the next render, and on component destroy.
	let tableScrollCleanup: (() => void) | null = null;

	// A main thread that stays busy never yields an idle period; without a
	// deadline its code blocks would wait unhighlighted until it does.
	const idleDeadline = { timeout: 1000 };

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

		mountComponents(contentEl as HTMLElement);

		void highlightCodeBlocks(contentEl as HTMLElement);
	}

	// Re-render when HTML changes
	$effect(() => {
		// Track html content, finalized (finishing often leaves the html unchanged)
		// and the replaying flag.
		// During replay: skip all post-render work (hljs, code headers, diagrams)
		//   — these are wasted CPU for off-screen blocks rendered during event replay.
		// When replay ends: replaying becomes false, effect re-fires, postRender runs.
		// All mounted AssistantMessage instances will run postRender when replay ends.
		// requestIdleCallback spreads the work across idle frames to avoid a single jank spike.
		const _html = message.html;
		void message.finalized;
		const replaying = sessionId === undefined
			? isLoading()
			: sessionMessages.get(sessionId)?.loadLifecycle === "loading";
		// @perf-guard C1 — removing this guard causes 50-300ms of wasted hljs/diagram CPU during session switch replay
		if (!_html || replaying) return;

		// Use requestIdleCallback to avoid a jank spike when replay ends
		// and all AssistantMessage effects re-fire on the same frame.
		// During normal streaming (not post-replay), requestIdleCallback
		// fires almost immediately since the main thread is idle between
		// each streamed message.
		if (typeof requestIdleCallback === "function") {
			const handle = requestIdleCallback(() => postRender(), idleDeadline);
			return () => cancelIdleCallback(handle);
		}
		// Fallback for environments without requestIdleCallback (SSR, old browsers)
		postRender();
		return undefined;
	});

	// A localhost link to one of the session's live servers (8.7) reads as a live chip, opening
	// through the Preview Gate while the gate serves the port; any other localhost link is plain
	// text (CONTRACT.md 3013-3014). data-server-link keeps the link as written.
	$effect(() => {
		void message.html;
		const servers = findSession(sessionId ?? sessionState.currentId ?? "")?.servers ?? [];
		for (const link of containerEl?.querySelectorAll<HTMLAnchorElement>(".md-content a[href], .md-content a[data-server-link]") ?? []) {
			const written = link.dataset["serverLink"] ?? link.getAttribute("href") ?? "";
			const url = URL.canParse(written) ? new URL(written) : undefined;
			const local = url !== undefined && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
			const server = local ? servers.find(({ port }) => String(port) === url.port) : undefined;
			if (url && server) {
				link.dataset["serverLink"] = written;
				link.dataset["serverChip"] = "live";
				link.href = server.gateUrl ? `${server.gateUrl}${url.pathname}${url.search}${url.hash}` : written;
				link.target = "_blank";
				link.rel = "noopener noreferrer";
			} else if (local) {
				link.dataset["serverLink"] = written;
				for (const name of ["href", "data-server-chip", "target", "rel"]) link.removeAttribute(name);
			}
		}
	});

	// Every component mounted into the message HTML: code headers and diagrams.
	const mounted = new Map<HTMLElement, ReturnType<typeof mount>>();
	function mountComponents(container: HTMLElement): void {
		for (const pre of container.querySelectorAll("pre")) {
			if (pre.closest("[data-diagram]")) continue;
			const code = pre.querySelector("code");
			if (!code) continue;
			const language = [...code.classList].find((name) => name.startsWith("language-"))?.slice(9) ?? "";
			// A streaming diagram stays a code block: half a diagram is a syntax error.
			if (language === "mermaid" && message.finalized) {
				const root = document.createElement("div");
				pre.replaceWith(root);
				mounted.set(root, mount(Diagram, { target: root, props: { source: code.textContent ?? "", variant: "inline" } }));
				continue;
			}
			if (pre.querySelector(".code-header")) continue;
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
			mounted.set(header, mount(CodeBlockHeader, {
				target: header,
				props: {
					label: language || "code", filename, code: text,
					additions: diff ? lines.filter((line) => line.startsWith("+") && !line.startsWith("+++ ")).length : undefined,
					deletions: diff ? lines.filter((line) => line.startsWith("-") && !line.startsWith("--- ")).length : undefined,
				},
			}));
		}
		for (const [element, component] of mounted) {
			if (container.contains(element)) continue;
			void unmount(component);
			mounted.delete(element);
		}
	}

	async function highlightCodeBlocks(container: HTMLElement): Promise<void> {
		const blocks = [...container.querySelectorAll<HTMLElement>(
			"pre code:not(.hljs):not(.language-mermaid)",
		)].filter((block) => !block.closest(".tool-result, [data-diagram]"));
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
			requestIdleCallback(highlight, idleDeadline);
		} else {
			highlight();
		}
	}

	function handleClick(e: MouseEvent) {
		if (!message.finalized) return;

		// Don't intercept clicks on interactive elements
		const target = e.target as HTMLElement;
		if (
			target.closest(".assistant-header") ||
			target.closest("[data-diagram]") ||
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
		if (e.target instanceof Element && e.target.closest("button, a, [role=menuitem], [data-diagram]")) return;
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
		for (const component of mounted.values()) void unmount(component);
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
		<AssistantHeader {message} {forkMessageId} {sessionId} {modelExecution} {providerId} {turnUser} bind:copyState />
	{/if}
	<div class="md-content min-w-0 text-[15px] leading-[1.65] md:ml-[42px] {hideHeader ? '' : 'mt-[2px]'} {copyState === 'primed' ? 'bg-selection' : copyState === 'done' ? 'bg-success/5' : ''}">
		{@html message.html}
	</div>
	{#if hideHeader && copyState !== "idle"}
		<p role="status" class="mt-[4px] text-[12px] md:ml-[42px] {copyState === 'done' ? 'text-success' : 'text-text-muted'}">{copyState === "done" ? "Copied!" : "Click again to copy"}</p>
	{/if}
</div>
