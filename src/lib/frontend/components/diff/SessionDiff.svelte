<!-- The Diff pane: the current session's branch changes, committed and not, file by file. -->
<script lang="ts">
	import type { SessionDiffBase } from "../../../contracts/session-diff.js";
	import { getDiffReveal, getDiffScopeKind } from "../../stores/diff-selection.js";
	import { getCurrentSessionId } from "../../stores/router.svelte.js";
	import { SessionDiffView } from "../../stores/session-diff.svelte.js";
	import { findSession } from "../../stores/session.svelte.js";
	import ConduitMark from "../ui/ConduitMark.svelte";
	import DiffBasePicker, { baseLabel } from "./DiffBasePicker.svelte";
	import DiffFile from "./DiffFile.svelte";

	// Mounted as a right pane; it has no chrome of its own to close.
	const { visible = true }: { pane?: boolean; onClose?: () => void; visible?: boolean } = $props();

	const sessionId = $derived(getCurrentSessionId());
	// The session's base override; another client changing it re-lists here.
	const override = $derived(sessionId ? (findSession(sessionId)?.diffBase ?? null) : null);
	// A new session, scope or base is a new view, so a late reply lands only in the view that asked.
	// The kind is its own derived, so a URL change that keeps it keeps the view and its patches.
	const kind = $derived(getDiffScopeKind());
	const view = $derived(
		sessionId ? new SessionDiffView(sessionId, kind === "branch" ? { kind, base: override } : { kind }) : null,
	);
	const reveal = $derived(getDiffReveal());
	// The pane stays mounted behind other tabs; only a shown pane lists or fetches.
	$effect(() => (visible ? view?.watch() : undefined));

	const listed = $derived(view?.state.kind === "listed" ? view.state.folders : []);
	const clean = $derived(view?.state.kind === "listed" && listed.every((folder) => "rows" in folder && folder.rows.length === 0));
	const base = $derived(listed.flatMap((folder) => ("rows" in folder && folder.base ? [folder.base] : []))[0]);

	const notice = ({ fallback, ...shown }: SessionDiffBase) =>
		fallback &&
		{
			missing: `${fallback.wanted} was not found, so this compares against ${baseLabel(shown)}.`,
			shallow: `This clone is shallow, so ${fallback.wanted} has no shared history. Comparing against ${baseLabel(shown)}.`,
			unrelated: `${fallback.wanted} shares no history with this checkout. Comparing against ${baseLabel(shown)}.`,
		}[fallback.reason];
</script>

{#snippet baseNotice(folder: (typeof listed)[number])}
	{#if "rows" in folder && folder.base?.fallback}
		<p data-testid="session-diff-base-notice" role="status" class="border-b border-border-subtle px-3 py-2 text-xs text-warning">{notice(folder.base)}</p>
	{/if}
{/snippet}

<div data-testid="session-diff" class="flex flex-1 min-h-0 flex-col overflow-y-auto">
	{#if sessionId}
		<DiffBasePicker {sessionId} {base} />
	{/if}
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
		<!-- A fallback still says so when nothing changed against it. -->
		{#each listed as folder (folder.folder)}
			{@render baseNotice(folder)}
		{/each}
		<p class="p-6 text-center text-sm text-text-dimmer">No changes against {base ? baseLabel(base) : "the base"}.</p>
	{:else}
		{@const folders = view.state.folders}
		{#each folders as folder (folder.folder)}
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
				{@render baseNotice(folder)}
				{#each folder.rows as row (row.key)}
					<DiffFile
						{row}
						reveal={reveal?.path === row.file.path && (reveal.folder ?? row.folder) === row.folder ? reveal.nonce : undefined}
					/>
				{/each}
			{/if}
		{/each}
	{/if}
</div>
