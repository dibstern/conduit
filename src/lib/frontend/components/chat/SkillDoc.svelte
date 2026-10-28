<script lang="ts">
	import { loadHighlighter } from "../../utils/load-highlighter.js";
	import { getCurrentSessionId, getCurrentSlug } from "../../stores/router.svelte.js";
	import { findSession } from "../../stores/session.svelte.js";
	import { discoveryState } from "../../stores/discovery.svelte.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import { failureLine } from "../../transport/rpc-errors.js";
	import { renderMarkdown } from "../../utils/markdown.js";
	import ConduitMark from "../ui/ConduitMark.svelte";

	let { name }: { name: string } = $props();
	let skillDoc = $state<string | null>(null);
	let skillState = $state<"loading" | "idle" | "missing">("loading");
	let skillError = $state("");
	const sessionId = $derived(getCurrentSessionId());
	const skillRef = $derived(discoveryState.commands.find((command) => command.name === name && command.skillRef)?.skillRef);
	const workspace = $derived(JSON.stringify(sessionId ? findSession(sessionId)?.workspace ?? null : null));

	function highlightCodeBlocks(el: HTMLElement) {
		const blocks = el.querySelectorAll<HTMLElement>("pre code");
		if (!blocks.length) return;
		let active = true;
		void (async () => {
			const hljs = await loadHighlighter();
			if (!active || !el.isConnected) return;
			for (const block of blocks) {
				if (!block.isConnected || block.dataset["highlighted"] || block.classList.contains("hljs")) continue;
				hljs.highlightElement(block);
			}
		})();
		return () => { active = false; };
	}

	$effect(() => {
		const projectSlug = getCurrentSlug();
		const requestedRef = skillRef;
		const requestedWorkspace = workspace;
		let active = true;
		skillDoc = null;
		skillError = "";
		skillState = projectSlug && requestedRef ? "loading" : "missing";
		if (projectSlug && requestedRef) {
			void rpc("GetSkillContent", { ...(sessionId ? { sessionId } : { projectSlug }), skillRef: requestedRef })
				.then((response) => {
					if (!active || workspace !== requestedWorkspace) return;
					// Markdown would read YAML frontmatter as a rule and a heading.
					skillDoc = response.content.replace(
						/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/,
						"```yaml\n$1\n```\n",
					);
					skillState = "idle";
				})
				.catch((error) => {
					if (active) {
						skillState = "missing";
						skillError = failureLine(error, "This skill's file could not be found on disk.");
					}
				});
		}
		return () => {
			active = false;
		};
	});
</script>

<div class="py-2 px-2.5 bg-code-bg border border-border-subtle rounded-lg max-h-[300px] overflow-y-auto">
	{#if skillDoc}
		<div
			class="md-content text-xs leading-[1.6] text-text-secondary"
			{@attach highlightCodeBlocks}
		>{@html renderMarkdown(skillDoc)}</div>
	{:else}
		<span class="inline-flex items-center gap-2 font-mono text-xs text-text-muted">
			{#if skillState === "loading"}<ConduitMark size={16} variant="running" />{/if}
			{skillState === "loading" ? "Loading skill…" : skillError || "This skill's file could not be found on disk."}
		</span>
	{/if}
</div>
