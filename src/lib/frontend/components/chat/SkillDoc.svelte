<script lang="ts">
	import hljs from "highlight.js";
	import { getCurrentSessionId, getCurrentSlug } from "../../stores/router.svelte.js";
	import { findSession } from "../../stores/session.svelte.js";
	import { getSkillContentRpc } from "../../transport/ws-rpc-client.js";
	import { renderMarkdown } from "../../utils/markdown.js";

	let { name }: { name: string } = $props();
	let skillDoc = $state<string | null>(null);
	let skillState = $state<"loading" | "idle" | "missing">("loading");
	const sessionId = $derived(getCurrentSessionId());
	const workspace = $derived(JSON.stringify(sessionId ? findSession(sessionId)?.workspace ?? null : null));

	$effect(() => {
		const projectSlug = getCurrentSlug();
		const requestedName = name;
		const requestedWorkspace = workspace;
		let active = true;
		skillDoc = null;
		skillState = projectSlug && requestedName ? "loading" : "missing";
		if (projectSlug && requestedName) {
			void getSkillContentRpc({ projectSlug, name: requestedName, ...(sessionId ? { sessionId } : {}) })
				.then((response) => {
					if (!active || workspace !== requestedWorkspace) return;
					// Markdown would read YAML frontmatter as a rule and a heading.
					skillDoc = response.content.replace(
						/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/,
						"```yaml\n$1\n```\n",
					);
					skillState = "idle";
				})
				.catch(() => {
					if (active) skillState = "missing";
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
			{@attach (el) => el.querySelectorAll<HTMLElement>("pre code").forEach((c) => hljs.highlightElement(c))}
		>{@html renderMarkdown(skillDoc)}</div>
	{:else}
		<span class="font-mono text-xs text-text-muted">
			{skillState === "loading" ? "Loading skill…" : "This skill's file could not be found on disk."}
		</span>
	{/if}
</div>
