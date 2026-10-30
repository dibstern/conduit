<!-- A file-writing step's own diff: the change its tool reported, opened in place. -->
<script lang="ts">
	import { SessionDiffView } from "../../stores/session-diff.svelte.js";
	import DiffFile from "./DiffFile.svelte";

	const { sessionId, toolId }: { sessionId: string; toolId: string } = $props();

	const view = $derived(new SessionDiffView(sessionId, { kind: "toolCall", toolId }));
	// Leased only while the step's diff is open.
	$effect(() => view.watch());
</script>

<div data-testid="tool-diff" class="my-[4px] border border-border">
	{#if view.state.kind === "loading"}
		<p class="px-3 py-2 text-xs text-text-muted">Loading diff…</p>
	{:else if view.state.kind === "failed"}
		<p data-testid="session-diff-error" class="px-3 py-2 text-xs text-error">{view.state.message}</p>
	{:else}
		{#if view.state.source}
			<p data-testid="tool-diff-source" class="border-b border-border-subtle px-3 py-1.5 text-xs text-text-muted">
				{view.state.source === "provider" ? "Reported by the provider" : "Read from the tool's input"}
			</p>
		{/if}
		{#each view.state.folders as folder (folder.folder)}
			{#if "error" in folder}
				<p data-testid="session-diff-error" class="px-3 py-2 text-xs text-error" title={folder.message}>Could not list this change.</p>
			{:else}
				{#each folder.rows as row (row.key)}
					<DiffFile {row} />
				{/each}
			{/if}
		{:else}
			<p class="px-3 py-2 text-xs text-text-muted">No change recorded.</p>
		{/each}
	{/if}
</div>
