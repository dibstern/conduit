<script lang="ts">
	import { Schema } from "effect";
	import { WorkspaceMoveError } from "../../../contracts/session-workspace.js";
	import type { SessionGit, WorktreeInfo } from "../../../shared-types.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuGroup from "../ui/MenuGroup.svelte";
	import MenuItem from "../ui/MenuItem.svelte";
	import MenuSeparator from "../ui/MenuSeparator.svelte";

	let { directory, git, presentation, workspaceMismatch, workspaceHint, loadWorktrees, onmove, ondismiss }: {
		directory: string;
		git: SessionGit | undefined;
		presentation?: "word" | "control" | "row" | undefined;
		workspaceMismatch?: { readonly actualPath: string } | undefined;
		workspaceHint?: string | undefined;
		loadWorktrees?: (() => Promise<{ readonly worktrees: readonly WorktreeInfo[]; readonly directory?: string | undefined }>) | undefined;
		onmove?: ((path: string) => Promise<void>) | undefined;
		ondismiss?: ((path: string) => Promise<void>) | undefined;
	} = $props();
	let showWorktrees = $state(false);
	let worktrees = $state<readonly WorktreeInfo[] | undefined>();
	let currentDirectory = $state<string | undefined>();
	let moving = $state(false);
	let dismissing = $state(false);
	const word = $derived(presentation === "word");
	const phone = $derived(sessionViewState.composerTier === "phone");

	async function openWorktrees() {
		showWorktrees = true;
		worktrees = undefined;
		currentDirectory = undefined;
		try {
			const result = await loadWorktrees?.();
			worktrees = result?.worktrees ?? [];
			currentDirectory = result?.directory;
		} catch {
			worktrees = [];
			showToast("Could not list worktrees", { variant: "error" });
		}
	}

	const moveFailures: Record<WorkspaceMoveError["reason"], string> = {
		missing: "Could not move session: that folder no longer exists",
		"not-a-worktree": "Could not move session: that folder is not a git worktree",
		"other-repository": "Could not move session: that worktree belongs to another repository",
		"unsupported-provider": "Could not move session: its provider cannot switch worktrees",
	};

	async function move(path: string) {
		moving = true;
		try {
			await onmove?.(path);
		} catch (error) {
			showToast(Schema.is(WorkspaceMoveError)(error) ? moveFailures[error.reason] : "Could not move session", { variant: "error" });
		} finally {
			moving = false;
		}
	}
	async function dismiss(path: string) {
		dismissing = true;
		try {
			await ondismiss?.(path);
		} catch {
			showToast("Could not dismiss workspace hint", { variant: "error" });
		} finally {
			dismissing = false;
		}
	}
	const project = $derived(directory.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || directory);
	const hintFolder = $derived(workspaceHint?.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || workspaceHint);
	const hintLabel = $derived(`working in ${hintFolder}?`);
	const checkout = $derived(git?.branch || git?.head);
	const label = $derived(checkout ? `${project} / ${checkout}` : project);
	const upstream = $derived(`↑${git?.ahead ?? 0} ↓${git?.behind ?? 0}`);
	const operation = $derived(git?.operation ? {
		rebase: "rebasing", merge: "merging", "cherry-pick": "cherry-picking",
		revert: "reverting", bisect: "bisecting",
	}[git.operation] : undefined);
	// Phones show one status word: an in-progress operation outranks merged.
	const showMerged = $derived(git?.merged === true && !(phone && operation));
	const upstreamMark = $derived([git?.ahead ? `↑${git.ahead}` : "", git?.behind ? `↓${git.behind}` : ""].filter(Boolean).join(" "));
	const warningLabel = $derived(workspaceMismatch ? `Workspace mismatch: Claude is working in ${workspaceMismatch.actualPath}` : workspaceHint ? hintLabel : undefined);
	const projectFloor = $derived(Math.min(project.length, word ? 4.5 : 5));
	const branchFloor = $derived(Math.min(checkout?.length ?? 0, word ? 6.5 : 5));
	// Floor = labels + slash, icon, padding, divider and fixed marks. It wins over the nominal cap for long operation labels.
	const minimumWidth = $derived.by(() => {
		const marks = [
			!phone && upstreamMark ? `${upstreamMark.length}ch` : null,
			operation ? `${operation.length}ch` : null,
			showMerged ? "6ch" : null,
		].filter((width) => width !== null);
		const gaps = 5 * (1 + (checkout ? 2 : 0) + marks.length);
		return `calc(${projectFloor + (checkout ? 1 + branchFloor : 0)}ch + 12px + ${word ? 0 : 18}px + ${gaps}px${warningLabel ? " + 17px" : ""}${marks.map((width) => ` + ${width}`).join("")})`;
	});

	async function copy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			showToast("Could not copy to clipboard", { variant: "error" });
		}
	}
</script>

<Menu presentation={phone ? "sheet" : "popover"} side={word ? "top" : undefined} align="end" ariaLabel="Checkout" class={phone ? undefined : "w-[280px]"} data-testid={presentation ? "composer-checkout-menu" : "session-bar-checkout"} onopenchange={(open) => { if (!open) showWorktrees = false; }}>
	{#snippet trigger({ props })}
		<!-- A grid track gives the pill an honest minimum: flex parents read a truncating label's minimum as its full text width, so the bar would overflow instead of shrinking the title. -->
		<!-- The wrapper and button share a font size so the ch floors agree. -->
		<span class="git-pill {word ? 'git-word text-[11.5px]' : phone ? 'git-pill-phone text-[10px]' : 'text-[10px]'} inline-grid" style={`grid-template-columns: minmax(${minimumWidth}, max-content)`}><Button {...props} variant="ghost" size={word ? "content" : "segment"} {...(word ? { tone: "muted" as const, hoverFill: "none" as const } : {})} touchTarget align="start" class={word ? "max-w-full gap-[5px] font-normal font-brand" : "max-w-full"}
			style={`min-width: ${minimumWidth}`}
			title={label} ariaLabel={`Checkout: ${label}${warningLabel ? `, ${warningLabel}` : ""}`} data-testid={presentation ? "composer-checkout" : "session-bar-identity"}>
			<span class="relative flex size-[12px] shrink-0 items-center text-text-muted" data-part={git?.worktree ? "worktree" : undefined} data-icon={!git ? "folder" : !git.branch ? "commit" : git.worktree ? "worktree" : "branch"}>
				{#if git && !git.branch}
					<!-- Compose the commit glyph from the existing circle icon. -->
					<span class="commit-icon"><Icon name="circle" size={4} /></span>
				{:else}
					<Icon name={!git ? "folder" : git.worktree ? "folder-tree" : "git-branch"} size={12} />
				{/if}
				<!-- On the icon, not after the branch: the icon never truncates, and a trailing dot sat against the account pill's dot. -->
				{#if git?.dirty}
					<span data-part="dirty" class="absolute -right-[2px] -bottom-[1px] size-[6px] rounded-full bg-warning ring-[1.5px] {word ? 'ring-input-bg' : 'ring-bg-surface'}" title="Uncommitted changes"><span class="sr-only">Uncommitted changes</span></span>
				{/if}
			</span>
			<span data-part="project" class="shrink-[100000000] truncate text-text-muted" style={`min-width: calc(${projectFloor}ch + 1px)`} title={project}>{project}</span>
			{#if checkout}
				<span class="shrink-0 text-text-dimmer" aria-hidden="true">/</span>
				<span data-part="branch" class="min-w-0 truncate {git?.branch ? word ? 'text-text-secondary' : 'text-text' : 'text-text-muted'}" style:min-width={word ? `${branchFloor}ch` : undefined} title={git?.branch ? `Branch: ${checkout}` : `Detached at ${checkout}`}>{checkout}</span>
			{/if}
			{#if !phone && upstreamMark}
				<span data-part="upstream" class="shrink-0 tabular-nums text-text-muted">{upstreamMark}</span>
			{/if}
			{#if operation}<span data-part="operation" class="shrink-0 text-warning">{operation}</span>{/if}
			{#if showMerged}<span data-part="merged" class="shrink-0 text-success">merged</span>{/if}
			{#if warningLabel}
				<span data-part="warning" class="inline-flex shrink-0 text-warning" role="img" aria-label={warningLabel} title={warningLabel} data-testid={workspaceMismatch ? "workspace-mismatch-indicator" : "workspace-hint"}><Icon name="circle-alert" size={12} /></span>
			{/if}
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
	{#if workspaceMismatch}
		<MenuSeparator />
		<p class="px-[8px] py-[6px] text-[10px] text-warning" data-testid="workspace-mismatch">Workspace mismatch: Claude is working in <span class="break-all">{workspaceMismatch.actualPath}</span>. The recorded folder is <span class="break-all">{directory}</span>.</p>
		{#if onmove}<MenuItem disabled={moving} onselect={() => void move(directory)}>Retry move</MenuItem>{/if}
	{/if}
	{#if workspaceHint}
		<MenuSeparator />
		<p class="px-[8px] py-[6px] text-[10px] text-warning">{hintLabel}<span class="mt-[4px] block break-all text-text-muted">{workspaceHint}</span></p>
		{#if onmove}<MenuItem disabled={moving || dismissing} data-testid="workspace-hint-move" onselect={() => workspaceHint && void move(workspaceHint)}>Move</MenuItem>{/if}
		{#if ondismiss}<MenuItem disabled={moving || dismissing} data-testid="workspace-hint-dismiss" onselect={() => workspaceHint && void dismiss(workspaceHint)}>Dismiss</MenuItem>{/if}
	{/if}
	<MenuSeparator />
	{#if git?.branch}<MenuItem onselect={() => void copy(git?.branch ?? "")}>Copy branch name</MenuItem>{/if}
	<MenuItem onselect={() => void copy(directory)}>Copy folder path</MenuItem>
	{#if loadWorktrees && onmove}
		<MenuSeparator />
		<MenuItem closeOnSelect={false} onselect={() => void openWorktrees()}>Move to worktree…</MenuItem>
		{#if showWorktrees}
			<MenuGroup label="Worktrees">
				{#if worktrees === undefined}
					<MenuItem disabled>Loading worktrees…</MenuItem>
				{:else if worktrees.length === 0}
					<MenuItem disabled>No worktrees available</MenuItem>
				{:else}
					{#each worktrees as worktree (worktree.path)}
						<MenuItem disabled={moving} onselect={() => void move(worktree.path)}>
							<span class="flex min-w-0 flex-1 flex-col">
								<span>{worktree.branch ?? (worktree.main ? "Main folder" : "Detached HEAD")}{worktree.main ? " · main worktree" : ""}</span>
								<span class="break-all text-text-muted">{worktree.path}</span>
							</span>
							{#if worktree.path === (currentDirectory ?? directory)}<span data-testid="current-worktree"><Icon name="check" size={12} /><span class="sr-only">Current worktree</span></span>{/if}
						</MenuItem>
					{/each}
				{/if}
			</MenuGroup>
		{/if}
	{/if}
</Menu>

<style>
	/* The cap sits on the grid wrapper, the flex item: on the button it left the wrapper sized to the full label, with dead space after the pill. */
	.git-pill { max-width: 240px; flex-shrink: 1; }
	.git-pill-phone { max-width: 150px; }
	.git-pill.git-word { max-width: 100%; }
	.commit-icon { display: flex; align-items: center; width: 12px; }
	.commit-icon::before, .commit-icon::after { content: ""; flex: 1; border-top: 1px solid currentColor; }
</style>
