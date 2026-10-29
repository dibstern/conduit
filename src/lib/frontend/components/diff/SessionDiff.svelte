<!-- The Diff pane: the current session's unstaged changes, file by file. -->
<script lang="ts">
	import type { SessionDiffListing } from "../../../contracts/session-diff.js";
	import { getCurrentSessionId } from "../../stores/router.svelte.js";
	import { failureLine } from "../../transport/rpc-errors.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import ConduitMark from "../ui/ConduitMark.svelte";
	import DiffFile from "./DiffFile.svelte";

	// Mounted as a right pane; it has no chrome of its own to close.
	const _props: { pane?: boolean; onClose?: () => void } = $props();

	const scope = { kind: "unstaged" } as const;
	const sessionId = $derived(getCurrentSessionId());
	let listing = $state<SessionDiffListing | null>(null);
	let failure = $state<string | null>(null);
	// Only the newest listing call may land.
	let latest = 0;

	async function list(id: string) {
		const call = ++latest;
		try {
			const next = await rpc("SessionDiffList", { sessionId: id, scope });
			if (call !== latest) return;
			listing = next;
			failure = null;
		} catch (error) {
			if (call === latest) failure = failureLine(error, "Could not load the diff.");
		}
	}

	$effect(() => {
		listing = null;
		failure = null;
		if (sessionId) void list(sessionId);
	});

	/** A collected snapshot re-lists silently; rows keep what they already show. */
	function relist() {
		if (sessionId) void list(sessionId);
	}

	const clean = $derived(listing?.folders.every((folder) => "files" in folder && folder.files.length === 0) ?? false);
</script>

<div data-testid="session-diff" class="flex flex-1 min-h-0 flex-col overflow-y-auto">
	{#if !sessionId}
		<p class="p-6 text-center text-sm text-text-dimmer">Open a session to see its changes.</p>
	{:else if failure !== null}
		<p data-testid="session-diff-error" class="p-6 text-center text-sm text-error">{failure}</p>
	{:else if listing === null}
		<div class="flex items-center justify-center py-8 text-sm text-text-dimmer">
			<ConduitMark size={16} variant="running" />
			<span class="ml-2">Loading...</span>
		</div>
	{:else if clean}
		<p class="p-6 text-center text-sm text-text-dimmer">No unstaged changes.</p>
	{:else}
		{#each listing.folders as folder (folder.folder)}
			{#if listing.folders.length > 1}
				<h3 class="truncate border-b border-border-subtle px-3 py-1.5 text-xs font-semibold text-text-muted" title={folder.folder}>
					{folder.folder.split("/").at(-1)}
				</h3>
			{/if}
			{#if "error" in folder}
				<p data-testid="session-diff-error" class="px-3 py-2 text-xs text-error" title={folder.message}>
					{folder.error === "timeout" ? "Git took too long to read this folder." : "This folder's changes are unavailable."}
				</p>
			{:else}
				{#each folder.files as file (`${file.path}\0${file.before}\0${file.after}`)}
					<DiffFile {sessionId} {scope} revision={listing.revision} folder={folder.folder} {file} onGone={relist} />
				{/each}
			{/if}
		{/each}
	{/if}
</div>
