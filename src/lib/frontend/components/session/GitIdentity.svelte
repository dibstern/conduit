<script lang="ts">
	import type { SessionGit } from "../../../shared-types.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuGroup from "../ui/MenuGroup.svelte";
	import MenuItem from "../ui/MenuItem.svelte";
	import MenuSeparator from "../ui/MenuSeparator.svelte";

	let { directory, git }: { directory: string; git: SessionGit | undefined } = $props();
	const project = $derived(directory.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || directory);
	const checkout = $derived(git?.branch || git?.head);
	const label = $derived(checkout ? `${project} / ${checkout}` : project);
	const upstream = $derived(`↑${git?.ahead ?? 0} ↓${git?.behind ?? 0}`);
	const operation = $derived(git?.operation ? {
		rebase: "rebasing", merge: "merging", "cherry-pick": "cherry-picking",
		revert: "reverting", bisect: "bisecting",
	}[git.operation] : undefined);
	// Phones show one status word: an in-progress operation outranks merged.
	const showMerged = $derived(git?.merged === true && !(sessionViewState.compact && operation));
	const upstreamMark = $derived([git?.ahead ? `↑${git.ahead}` : "", git?.behind ? `↓${git.behind}` : ""].filter(Boolean).join(" "));
	// Each label keeps 4 letters plus the ellipsis (5ch), or its whole name when shorter.
	// The 1px of slack stops sub-pixel rounding from dropping the fourth letter.
	const projectFloor = $derived(Math.min(project.length, 5));
	// Floor = labels + slash, icon, padding, divider and fixed marks. It wins over the nominal cap for long operation labels.
	const minimumWidth = $derived.by(() => {
		const marks = [
			git?.dirty ? "6px" : null,
			!sessionViewState.compact && upstreamMark ? `${upstreamMark.length}ch` : null,
			operation ? `${operation.length}ch` : null,
			showMerged ? "6ch" : null,
		].filter((width) => width !== null);
		const gaps = 5 * (1 + (checkout ? 2 : 0) + marks.length);
		return `calc(${projectFloor + (checkout ? 1 + Math.min(checkout.length, 5) : 0)}ch + 12px + 16px + 2px + ${gaps}px${marks.map((width) => ` + ${width}`).join("")})`;
	});

	async function copy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			showToast("Could not copy to clipboard", { variant: "error" });
		}
	}
</script>

<Menu presentation={sessionViewState.compact ? "sheet" : "popover"} align="end" ariaLabel="Checkout" class={sessionViewState.compact ? undefined : "w-[280px]"} data-testid="session-bar-checkout">
	{#snippet trigger({ props })}
		<!-- A grid track gives the pill an honest minimum: flex parents read a truncating label's minimum as its full text width, so the bar would overflow instead of shrinking the title. -->
		<!-- text-[10px] matches the pill so the ch-based floor measures the same font. -->
		<span class="inline-grid text-[10px]" style={`grid-template-columns: minmax(${minimumWidth}, max-content)`}><Button {...props} variant="ghost" size="segment" touchTarget align="start"
			class="git-pill {sessionViewState.compact ? 'git-pill-phone' : ''}"
			style={`min-width: ${minimumWidth}`}
			title={label} ariaLabel={`Checkout: ${label}`} data-testid="session-bar-identity">
			<span class="flex size-[12px] shrink-0 items-center text-text-muted" data-part={git?.worktree ? "worktree" : undefined} data-icon={!git ? "folder" : !git.branch ? "commit" : git.worktree ? "worktree" : "branch"}>
				{#if git && !git.branch}
					<!-- Compose the commit glyph from the existing circle icon. -->
					<span class="commit-icon"><Icon name="circle" size={4} /></span>
				{:else}
					<Icon name={!git ? "folder" : git.worktree ? "folder-tree" : "git-branch"} size={12} />
				{/if}
			</span>
			<span data-part="project" class="shrink-[100000000] truncate text-text-muted" style={`min-width: calc(${projectFloor}ch + 1px)`} title={project}>{project}</span>
			{#if checkout}
				<span class="shrink-0 text-text-dimmer" aria-hidden="true">/</span>
				<span data-part="branch" class="min-w-0 truncate {git?.branch ? 'text-text' : 'text-text-muted'}" title={git?.branch ? `Branch: ${checkout}` : `Detached at ${checkout}`}>{checkout}</span>
			{/if}
			{#if git?.dirty}
				<span data-part="dirty" class="size-[6px] shrink-0 rounded-full bg-warning" title="Uncommitted changes"><span class="sr-only">Uncommitted changes</span></span>
			{/if}
			{#if !sessionViewState.compact && upstreamMark}
				<span class="shrink-0 tabular-nums text-text-muted">{upstreamMark}</span>
			{/if}
			{#if operation}<span data-part="operation" class="shrink-0 text-warning">{operation}</span>{/if}
			{#if showMerged}<span data-part="merged" class="shrink-0 text-success">merged</span>{/if}
		</Button></span>
	{/snippet}
	<MenuGroup label="Checkout">
		<dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-[12px] gap-y-[8px] px-[8px] py-[6px] text-[10px]">
			<dt class="text-text-muted">Project</dt><dd class="min-w-0 break-all text-right text-text">{project}</dd>
			{#if git}
				<dt class="text-text-muted">Branch</dt><dd class="min-w-0 break-all text-right text-text">{git.branch || `Detached at ${git.head ?? "unknown"}`}</dd>
				{#if git.worktree}<dt class="text-text-muted">Worktree</dt><dd class="min-w-0 break-all text-right text-text">{git.worktree}</dd>{/if}
			{/if}
			<dt class="text-text-muted">Folder</dt><dd class="min-w-0 break-all text-right text-text">{directory}</dd>
			{#if git && (git.ahead !== undefined || git.behind !== undefined)}
				<dt class="text-text-muted">Upstream</dt><dd class="text-right tabular-nums text-text">{upstream}</dd>
			{/if}
			{#if git}
				<dt class="text-text-muted">Changes</dt><dd class="text-right {git.dirty ? 'text-warning' : 'text-text'}">{git.dirty ? "uncommitted" : "clean"}</dd>
			{/if}
		</dl>
	</MenuGroup>
	<MenuSeparator />
	{#if git?.branch}<MenuItem onselect={() => void copy(git?.branch ?? "")}>Copy branch name</MenuItem>{/if}
	<MenuItem onselect={() => void copy(directory)}>Copy folder path</MenuItem>
</Menu>

<style>
	:global(.git-pill) { max-width: min(240px, 100%); flex-shrink: 1; }
	:global(.git-pill-phone) { max-width: min(150px, 100%); }
	.commit-icon { display: flex; align-items: center; width: 12px; }
	.commit-icon::before, .commit-icon::after { content: ""; flex: 1; border-top: 1px solid currentColor; }
</style>
