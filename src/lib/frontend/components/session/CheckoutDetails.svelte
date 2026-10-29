<script lang="ts">
	import { getWorkspaceCheckout } from "../../stores/workspace-checkout.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";

	let { onclose }: { onclose: () => void } = $props();
	const checkoutState = $derived(getWorkspaceCheckout());
	const directory = $derived(checkoutState.directory ?? "");
	const folders = $derived(checkoutState.folders);
	const git = $derived(checkoutState.git);
	const project = $derived(checkoutState.projectName);
	const multiFolder = $derived(folders.length > 1 || folders.some((folder) => folder.shared) || (!git && folders.length > 0));
	const operation = $derived(checkoutState.operationLabel);

	async function copy(text: string, message: string) {
		try {
			await navigator.clipboard.writeText(text);
			showToast(message, { variant: "success" });
		} catch {
			showToast("Could not copy to clipboard", { variant: "error" });
		}
	}
</script>

<div data-testid="checkout-details" class="pb-[6px] text-[13.5px]">
	{#if multiFolder}
		{#each folders as folder (folder.root)}
			<section class="px-[10px] py-[6px]" aria-label={folder.label} data-testid="session-folder-git" data-folder-root={folder.root}>
				<p class="mb-[6px] break-all font-medium text-text" title={folder.root}>{folder.label}{#if folder.shared}<span class="ml-2 font-normal text-text-muted">shared</span>{/if}</p>
				{#if folder.missing}
					<p class="text-warning">Worktree missing</p>
				{:else if folder.branch || folder.head || folder.dirty !== undefined}
					<dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-[12px] gap-y-[8px]">
						<dt class="text-text-muted">Branch</dt><dd class="min-w-0 break-all text-right text-text">{folder.branch || `Detached at ${folder.head ?? "unknown"}`}</dd>
						{#if folder.ahead !== undefined || folder.behind !== undefined}
							<dt class="text-text-muted">Upstream</dt><dd class="text-right tabular-nums text-text">↑{folder.ahead ?? 0} ↓{folder.behind ?? 0}</dd>
						{/if}
						<dt class="text-text-muted">Changes</dt><dd class="text-right {folder.dirty ? 'text-warning' : 'text-text'}">{#if folder.changes}{folder.changes.files} file{folder.changes.files === 1 ? "" : "s"} changed{#if folder.changes.insertions}{" "}<span class="font-mono text-success">+{folder.changes.insertions}</span>{/if}{#if folder.changes.deletions}{" "}<span class="font-mono text-error">-{folder.changes.deletions}</span>{/if}{:else}{folder.dirty ? "uncommitted" : "clean"}{/if}</dd>
					</dl>
				{/if}
			</section>
		{/each}
	{:else}
		<div role="group" aria-label="Checkout" class="px-[10px] pt-[6px] pb-[4px]">
			<div class="flex items-center gap-[10px]">
				<span class="grid size-[34px] shrink-0 place-items-center rounded-[10px] bg-accent/14 text-accent"><Icon name={git?.worktree ? "folder-tree" : git ? "git-branch" : "folder"} size={18} /></span>
				<div class="min-w-0 flex-1">
					<p data-part="checkout-branch" class="break-all font-mono text-[15px] font-semibold text-text max-md:text-[17px]">{git?.branch || (git?.head ? `Detached at ${git.head}` : project)}</p>
					{#if git}<p class="mt-[2px] break-words text-[12.5px] text-text-secondary">{folders[0]?.label ?? project}{#if git.worktree}{" · worktree "}<span class="font-mono text-[12px]">{git.worktree}</span>{/if}</p>{/if}
				</div>
				{#if git?.branch}<Button variant="ghost" size="content" iconOnly icon="copy" iconSize={15} ariaLabel="Copy branch name" title="Copy branch name" class="size-[30px] shrink-0 rounded-[8px] text-text-muted max-md:size-[40px]" onclick={() => void copy(git?.branch ?? "", "Branch copied")} />{/if}
			</div>
			{#if git}
				<div class="mt-[14px] grid grid-cols-[1fr_1fr_1.7fr] gap-[8px]">
					{#each [{ label: "ahead", count: git.ahead }, { label: "behind", count: git.behind }] as tile (tile.label)}
						<div data-testid={`checkout-${tile.label}`} title={tile.count === undefined ? "No upstream" : undefined} class="min-w-0 rounded-[12px] border border-border px-[10px] py-[9px]">
							<p class="font-mono text-[17px] font-semibold tabular-nums text-text">{tile.count ?? "–"}</p><p class="text-[12px] text-text-secondary">{tile.label}</p>
						</div>
					{/each}
					<div data-testid="checkout-changes" class="min-w-0 rounded-[12px] border border-border px-[10px] py-[9px]">
						<p class="flex flex-wrap items-baseline gap-x-[5px] font-mono tabular-nums"><span class="text-[17px] font-semibold text-text">{git.changes?.files ?? (git.dirty ? "–" : 0)}</span>{#if git.changes?.insertions}<span class="text-[12px] text-success">+{git.changes.insertions}</span>{/if}{#if git.changes?.deletions}<span class="text-[12px] text-error">-{git.changes.deletions}</span>{/if}</p><p class="text-[12px] text-text-secondary">files changed</p>
					</div>
				</div>
				{#if operation || git.merged}<div class="mt-[8px] flex flex-wrap gap-[6px] text-[11.5px]">{#if operation}<span class="rounded-full bg-warning/10 px-[8px] py-[2px] text-warning">{operation}</span>{/if}{#if git.merged}<span class="rounded-full bg-success/10 px-[8px] py-[2px] text-success">merged</span>{/if}</div>{/if}
			{/if}
		</div>
	{/if}

	<h3 class="px-[10px] pt-[12px] pb-[6px] text-[12px] font-medium text-text-muted">Location</h3>
	{#if multiFolder}
		{#if git?.branch}<Button variant="picker-row" size="content" layout="flow" onclick={() => void copy(git?.branch ?? "", "Branch copied")}><Icon name="copy" size={15} class="shrink-0 text-text-muted" />Copy branch name</Button>{/if}
		<Button variant="picker-row" size="content" layout="flow" onclick={() => void copy(directory, "Path copied")}><Icon name="copy" size={15} class="shrink-0 text-text-muted" />Copy folder path</Button>
	{:else}
		<Button variant="picker-row" size="content" layout="flow" ariaLabel={`Copy worktree path, ${directory}`} onclick={() => void copy(directory, "Path copied")}>
			<span class="shrink-0 text-text-muted">Worktree</span><span class="min-w-0 flex-1 truncate text-right font-mono text-[12px] text-text" dir="rtl" title={directory}><bdi>{directory}</bdi></span><Icon name="copy" size={14} class="shrink-0 text-text-dimmer" />
		</Button>
		{#if git?.upstream}<Button variant="picker-row" size="content" layout="flow" ariaLabel={`Copy upstream, ${git.upstream}`} onclick={() => void copy(git?.upstream ?? "", "Upstream copied")}>
			<span class="shrink-0 text-text-muted">Upstream</span><span class="min-w-0 flex-1 truncate text-right font-mono text-[12px] text-text" title={git.upstream}>{git.upstream}</span><Icon name="copy" size={14} class="shrink-0 text-text-dimmer" />
		</Button>{/if}
		{#if git?.head}<Button variant="picker-row" size="content" layout="flow" ariaLabel={`Copy commit hash, ${git.head}`} onclick={() => void copy(git?.oid ?? git?.head ?? "", "Commit hash copied")}>
			<span class="shrink-0 text-text-muted">HEAD</span><span class="min-w-0 flex-1 truncate text-right font-mono text-[12px] text-text">{git.head}</span><Icon name="copy" size={14} class="shrink-0 text-text-dimmer" />
		</Button>{/if}
	{/if}

	{#if checkoutState.workspaceMissing}
		<div class="px-[10px] py-[6px] text-[12px] text-warning">
			{#if checkoutState.missingFolders.length}
				{#if checkoutState.workspaceMissing.canRecreate}<p>These worktrees will be recreated from their branches on your next message:</p>{/if}
				{#each checkoutState.missingFolders as folder, index (folder.folder)}
					<p class="mt-[4px] break-all" data-testid="workspace-missing-folder">{checkoutState.missingFolderLabels[index]?.label ?? folder.folder}<span class="block text-text-muted">{folder.path}</span>{#if folder.reason === "branch-missing"}<span class="block">Its branch no longer exists.</span>{/if}</p>
				{/each}
			{:else if checkoutState.workspaceMissing.canRecreate || checkoutState.workspaceMissing.reason === "branch-missing"}
				<p data-testid="workspace-missing-folder">{#if checkoutState.workspaceMissing.canRecreate}It will be recreated from its branch on your next message.{:else}Its branch no longer exists.{/if}</p>
			{/if}
		</div>
	{/if}
	{#if checkoutState.workspaceMismatch}
		<p class="break-all px-[10px] py-[6px] text-[12px] text-warning" data-testid="workspace-mismatch">{#if checkoutState.dismissedMismatch}Workspace mismatch: Claude is working in {checkoutState.workspaceMismatch.actualPath}. {/if}The recorded folder is {directory}.</p>
	{/if}

	{#if checkoutState.canRenameBranch}
		<Button variant="picker-row" size="content" layout="flow" data-testid="session-branch-rename" onclick={() => { onclose(); checkoutState.openBranchRename(); }}>
			<Icon name="pencil" size={15} class="shrink-0 text-text-muted" />Rename branch
		</Button>
	{/if}
	{#if checkoutState.canListWorktrees}
		<h3 class="px-[10px] pt-[12px] pb-[6px] text-[12px] font-medium text-text-muted">Worktrees</h3>
		{#if checkoutState.worktrees === undefined}
			<Button variant="picker-row" size="content" layout="flow" disabled>Loading worktrees…</Button>
		{:else if checkoutState.worktrees.length === 0}
			<Button variant="picker-row" size="content" layout="flow" disabled>No worktrees available</Button>
		{:else}
			{#each checkoutState.worktrees as worktree (worktree.path)}
				{@const current = worktree.path === (checkoutState.currentDirectory ?? checkoutState.directory)}
				<Button variant="picker-row" size="content" layout="flow" data-testid="picker-worktree" data-path={worktree.path} disabled={checkoutState.moving} onclick={() => { if (!current) { void checkoutState.move(worktree.path); onclose(); } }}>
					<Icon name="git-branch" size={16} class="shrink-0 text-text-muted" />
					<span class="min-w-0 flex-1">
						<span class="block">{worktree.branch ?? (worktree.main ? "Main folder" : "Detached HEAD")}{worktree.main ? " · main worktree" : ""}</span>
						<span class="block break-all text-[12px] text-text-muted">{worktree.path}</span>
					</span>
					{#if current}<span data-testid="current-worktree" class="text-accent"><Icon name="check" size={16} /><span class="sr-only">Current worktree</span></span>{/if}
				</Button>
			{/each}
		{/if}
	{/if}
</div>
