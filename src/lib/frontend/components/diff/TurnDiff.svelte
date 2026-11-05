<!-- A settled turn's footer entry: the files its run changed, opened in place. -->
<script lang="ts">
	import { setRightPaneView } from "../../stores/session-view.svelte.js";
	import { SessionDiffView } from "../../stores/session-diff.svelte.js";
	import TextButton from "../ui/TextButton.svelte";
	import DiffFile from "./DiffFile.svelte";

	// A step in the turn's log can open the list, so the caller may bind it.
	let { sessionId, turnId, open = $bindable(false) }: { sessionId: string; turnId: string; open?: boolean } = $props();

	const view = $derived(new SessionDiffView(sessionId, { kind: "turn", turnId }));
	// A settled turn's capture never changes once recorded; one lease follows it from pending until it lands.
	$effect(() => view.watch());

	const listed = $derived(view.state.kind === "listed" ? view.state : null);
	const count = $derived(listed?.folders.reduce((total, folder) => total + ("rows" in folder ? folder.rows.length : 0), 0) ?? 0);
</script>

<!-- Loading and failed turns show nothing: the entry is a shortcut, and the Diff pane reports errors. -->
{#if listed?.pending}
	<span data-testid="turn-diff-pending" class="whitespace-nowrap text-[11.5px] text-text-muted">Capturing changes…</span>
{:else if listed?.notCaptured}
	<span data-testid="turn-diff-not-captured" class="whitespace-nowrap text-[11.5px] text-text-muted">
		Not captured · <TextButton underline="always" onclick={() => setRightPaneView("diff")}>Branch diff</TextButton>
	</span>
{:else if listed && (count > 0 || listed.folders.some((folder) => "error" in folder))}
	<TextButton data-testid="turn-diff-toggle" aria-expanded={open} class="whitespace-nowrap text-[11.5px]" onclick={() => (open = !open)}>
		{count} {count === 1 ? "file" : "files"} changed
	</TextButton>
	{#if listed.pruned}
		<span data-testid="turn-diff-pruned" class="whitespace-nowrap text-[11.5px] text-text-muted">Pruned</span>
	{/if}
	{#if open}
		<div data-testid="turn-diff" class="order-last -mx-[12px] w-[calc(100%+24px)] border-t border-border">
			{#each listed.folders as folder (folder.folder)}
				{#if listed.folders.length > 1}
					<h3 class="truncate border-b border-border-subtle px-3 py-1.5 text-xs font-semibold text-text-muted" title={folder.folder}>
						{folder.folder.split("/").at(-1)}
					</h3>
				{/if}
				{#if "error" in folder}
					<p data-testid="session-diff-error" class="px-3 py-2 text-xs text-error" title={folder.message}>This folder's changes were not captured.</p>
				{:else}
					{#if folder.shared}
						<p data-testid="turn-diff-shared" class="px-3 py-1.5 text-xs text-warning">May include changes from other sessions</p>
					{/if}
					{#each folder.rows as row (row.key)}
						<DiffFile {row} />
					{/each}
				{/if}
			{/each}
		</div>
	{/if}
{/if}
