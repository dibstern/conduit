<!-- The Diff pane: the current session's unstaged changes, file by file. -->
<script lang="ts">
	import { getCurrentSessionId } from "../../stores/router.svelte.js";
	import { SessionDiffView } from "../../stores/session-diff.svelte.js";
	import ConduitMark from "../ui/ConduitMark.svelte";
	import DiffFile from "./DiffFile.svelte";

	// Mounted as a right pane; it has no chrome of its own to close.
	const { visible = true }: { pane?: boolean; onClose?: () => void; visible?: boolean } = $props();

	const sessionId = $derived(getCurrentSessionId());
	// A new session is a new view, so a late reply lands only in the view that asked.
	const view = $derived(sessionId ? new SessionDiffView(sessionId, { kind: "unstaged" }) : null);
	// The pane stays mounted behind other tabs; only a shown pane lists or fetches.
	$effect(() => (visible ? view?.watch() : undefined));

	const clean = $derived(
		view?.state.kind === "listed" && view.state.folders.every((folder) => "rows" in folder && folder.rows.length === 0),
	);
</script>

<div data-testid="session-diff" class="flex flex-1 min-h-0 flex-col overflow-y-auto">
	{#if !view}
		<p class="p-6 text-center text-sm text-text-dimmer">Open a session to see its changes.</p>
	{:else if view.state.kind === "failed"}
		<p data-testid="session-diff-error" class="p-6 text-center text-sm text-error">{view.state.message}</p>
	{:else if view.state.kind === "loading"}
		<div class="flex items-center justify-center py-8 text-sm text-text-dimmer">
			<ConduitMark size={16} variant="running" />
			<span class="ml-2">Loading...</span>
		</div>
	{:else if clean}
		<p class="p-6 text-center text-sm text-text-dimmer">No unstaged changes.</p>
	{:else}
		{@const folders = view.state.folders}
		{#each folders as folder (folder.folder)}
			<div data-testid="session-diff-folder" data-folder={folder.folder}>
				{#if folders.length > 1}
					<h3 class="truncate border-b border-border-subtle px-3 py-1.5 text-xs font-semibold text-text-muted" title={folder.folder}>
						{folder.folder.split("/").at(-1)}
					</h3>
				{/if}
				{#if "error" in folder}
					<p data-testid="session-diff-error" class="px-3 py-2 text-xs text-error" title={folder.message}>
						{folder.error === "timeout" ? "Git took too long to read this folder." : "This folder's changes are unavailable."}
					</p>
				{:else}
					{#each folder.rows as row (row.key)}
						<DiffFile {row} />
					{/each}
				{/if}
			</div>
		{/each}
	{/if}
</div>
