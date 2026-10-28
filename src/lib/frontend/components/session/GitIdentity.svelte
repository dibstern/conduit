<script lang="ts">
	import type { Snippet } from "svelte";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import { getWorkspaceCheckout } from "../../stores/workspace-checkout.svelte.js";
	import Button from "../ui/Button.svelte";
	import Field from "../ui/Field.svelte";
	import Icon from "../ui/Icon.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuGroup from "../ui/MenuGroup.svelte";
	import MenuItem from "../ui/MenuItem.svelte";
	import MenuSeparator from "../ui/MenuSeparator.svelte";
	import Modal from "../ui/Modal.svelte";
	import TextInput from "../ui/TextInput.svelte";

	let { directory, presentation, compact = false, children }: {
		directory: string;
		presentation: "word" | "control" | "row";
		compact?: boolean | undefined;
		children?: Snippet<[attention: boolean, checkout: Snippet, warning: Snippet]> | undefined;
	} = $props();
	const checkoutState = $derived(getWorkspaceCheckout());
	const folders = $derived(checkoutState.folders);
	const git = $derived(checkoutState.git);
	const multiFolder = $derived(folders.length > 1 || folders.some((folder) => folder.shared) || (!git && folders.length > 0));
	const control = $derived(presentation === "control");
	const row = $derived(presentation === "row");
	const phone = $derived(sessionViewState.composerTier === "phone");
	let identityElement = $state<HTMLButtonElement | HTMLAnchorElement>();
	const componentId = $props.id();
	const branchRenameFormId = `${componentId}-branch-rename`;
	const showBranchRename = $derived(checkoutState.showBranchRename && checkoutState.branchRenameOpener === identityElement);
	const project = $derived(directory.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || directory);
	const checkout = $derived(git?.branch || git?.head);
	const label = $derived(checkout ? `${project} / ${checkout}` : project);
	const operation = $derived(git?.operation ? {
		rebase: "rebasing", merge: "merging", "cherry-pick": "cherry-picking",
		revert: "reverting", bisect: "bisecting",
	}[git.operation] : undefined);
	// Phones show one status word: an in-progress operation outranks merged.
	const showMerged = $derived(git?.merged === true && !(phone && operation));
	const upstreamMark = $derived([git?.ahead ? `↑${git.ahead}` : "", git?.behind ? `↓${git.behind}` : ""].filter(Boolean).join(" "));
	const noticeLabels = $derived((row ? checkoutState.rowNotices : checkoutState.notices).map((notice) => notice.label));
	const noticeLabel = $derived(noticeLabels.join(", "));
	const projectFloor = $derived(Math.min(project.length, 4.5));
	const branchFloor = $derived(Math.min(checkout?.length ?? 0, 6.5));
	// Checkout gives up its labels before the model label needs to truncate.
	type Fit = "full" | "icon";
	// Floor = labels + slash and fixed marks in ch, plus icon, gaps, padding, chevron and notices in px. It wins over the nominal cap for long operation labels.
	function floor(fit: Fit) {
		const marks = fit === "icon" ? [] : [
			!phone && upstreamMark ? upstreamMark.length : null,
			operation ? operation.length : null,
			showMerged ? 6 : null,
		].filter((width) => width !== null);
		const labels = fit === "icon" ? [] : !control && !row && checkout ? [branchFloor] : checkout ? [projectFloor, 1, branchFloor] : [projectFloor];
		const widths = [...labels, ...marks];
		return { ch: widths.reduce((sum, width) => sum + width, 0), px: 12 + 5 * widths.length + (control ? 12 : 0) + (fit === "icon" ? 0 : (noticeLabels.length ? 17 : 0) + (git?.dirty ? 11 : 0)) };
	}
	// Unmeasured until bound: a measured 0 means send left no room, which must fall to icon.
	let room = $state<number>();
	let hundredCh = $state(0);
	const fit = $derived.by((): Fit => {
		const available = room;
		if (compact) return available === undefined || available >= 66 ? "full" : "icon";
		if (row || available === undefined || !hundredCh) return "full";
		const fits = (candidate: Fit) => {
			const { ch, px } = floor(candidate);
			return (ch * hundredCh) / 100 + px <= available;
		};
		return fits("full") && (!control || available >= 220) ? "full" : "icon";
	});
	const width = (candidate: Fit) => {
		const { ch, px } = floor(candidate);
		return `calc(${ch}ch + ${px}px)`;
	};
	const minimumWidth = $derived(compact ? "44px" : width(fit));

	async function copy(text: string, message: string) {
		try {
			await navigator.clipboard.writeText(text);
			showToast(message, { variant: "success" });
		} catch {
			showToast("Could not copy to clipboard", { variant: "error" });
		}
	}
</script>

{#snippet dirtyMark(placement: string)}
	<span data-part="dirty" class="{placement} size-[6px] rounded-full bg-warning" title="Uncommitted changes"><span class="sr-only">Uncommitted changes</span></span>
{/snippet}

{#snippet identity()}
			{#if !row}
			<span class="relative flex size-[12px] shrink-0 items-center {presentation === 'word' ? 'text-text-dimmer' : 'text-text-muted'}" data-part={git?.worktree ? "worktree" : undefined} data-icon={!git ? "folder" : !git.branch ? "commit" : git.worktree ? "worktree" : "branch"}>
				{#if git && !git.branch}
					<!-- Compose the commit glyph from the existing circle icon. -->
					<span class="commit-icon"><Icon name="circle" size={4} /></span>
				{:else}
					<Icon name={!git ? "folder" : git.worktree ? "folder-tree" : "git-branch"} size={12} />
				{/if}
				<!-- Without labels the dirty mark rides the icon; with them it follows the branch. -->
				{#if git?.dirty && fit === "icon"}{@render dirtyMark("absolute -right-[2px] -bottom-[1px] ring-[1.5px] " + (row ? "ring-bg-surface" : "ring-input-bg"))}{/if}
			</span>
			{/if}
			{#if fit === "full" && ((!compact && (control || row)) || !checkout)}
				<span data-part="project" class="shrink-[100000000] truncate text-text-muted" style={`min-width: ${compact ? '0' : `calc(${projectFloor}ch + 1px)`}`} title={project}>{project}</span>
				{#if checkout}<span class="shrink-0 text-text-dimmer" aria-hidden="true">{control ? "·" : "/"}</span>{/if}
			{/if}
			{#if fit !== "icon"}
				{#if checkout}
					<span data-part="branch" class="min-w-0 truncate {presentation === 'word' ? 'text-text-dimmer' : git?.branch ? 'text-text-secondary' : 'text-text-muted'}" style:min-width={compact ? '0' : `${branchFloor}ch`} title={git?.branch ? `Branch: ${checkout}` : `Detached at ${checkout}`}>{checkout}</span>
				{/if}
				{#if git?.dirty}{@render dirtyMark("shrink-0")}{/if}
				{#if !phone && upstreamMark}
					<span data-part="upstream" class="shrink-0 tabular-nums text-text-muted">{upstreamMark}</span>
				{/if}
				{#if !compact && operation}<span data-part="operation" class="shrink-0 text-warning">{operation}</span>{/if}
				{#if !compact && showMerged}<span data-part="merged" class="shrink-0 text-success">merged</span>{/if}
			{/if}
			{#if noticeLabel}
				<span data-part="warning" class="text-warning {fit === 'icon' && !row ? 'absolute right-[2px] top-[2px]' : 'inline-flex shrink-0'}" role="img" aria-label={noticeLabel} title={noticeLabel} data-testid="workspace-notice-indicator"><Icon name="circle-alert" size={12} /></span>
			{/if}
{/snippet}

{#snippet checkoutActions()}
	{#if checkoutState.canRenameBranch}<MenuItem density={multiFolder ? undefined : "default"} class={multiFolder ? undefined : "min-h-[36px] px-[12px] max-md:min-h-[44px]"} data-testid="session-branch-rename" onselect={() => checkoutState.openBranchRename(identityElement)}>{#if !multiFolder}<span class="shrink-0 text-text-muted"><Icon name="pencil" size={15} /></span>{/if}Rename branch</MenuItem>{/if}
	{#if multiFolder}
		{#if git?.branch}<MenuItem onselect={() => void copy(git?.branch ?? "", "Branch copied")}>Copy branch name</MenuItem>{/if}
		<MenuItem onselect={() => void copy(directory, "Path copied")}>Copy folder path</MenuItem>
	{/if}
	{#if checkoutState.canListWorktrees}
		{#if multiFolder}<MenuSeparator />{/if}
		<MenuItem density={multiFolder ? undefined : "default"} class={multiFolder ? undefined : "min-h-[36px] px-[12px] max-md:min-h-[44px]"} closeOnSelect={false} onselect={() => void checkoutState.openWorktrees()}>{#if !multiFolder}<span class="shrink-0 text-text-muted"><Icon name="folder-tree" size={15} /></span>{/if}<span class="flex-1">{multiFolder ? "Move to worktree…" : "Move to another worktree…"}</span>{#if !multiFolder}<span class="shrink-0 text-text-dimmer"><Icon name="chevron-right" size={13} /></span>{/if}</MenuItem>
		{#if checkoutState.showWorktrees}
			<MenuGroup label="Worktrees">
				{#if checkoutState.worktrees === undefined}
					<MenuItem disabled>Loading worktrees…</MenuItem>
				{:else if checkoutState.worktrees.length === 0}
					<MenuItem disabled>No worktrees available</MenuItem>
				{:else}
					{#each checkoutState.worktrees as worktree (worktree.path)}
						<MenuItem disabled={checkoutState.moving} onselect={() => void checkoutState.move(worktree.path)}>
							<span class="flex min-w-0 flex-1 flex-col">
								<span>{worktree.branch ?? (worktree.main ? "Main folder" : "Detached HEAD")}{worktree.main ? " · main worktree" : ""}</span>
								<span class="break-all text-text-muted">{worktree.path}</span>
							</span>
							{#if worktree.path === (checkoutState.currentDirectory ?? directory)}<span data-testid="current-worktree"><Icon name="check" size={12} /><span class="sr-only">Current worktree</span></span>{/if}
						</MenuItem>
					{/each}
				{/if}
			</MenuGroup>
		{/if}
	{/if}
{/snippet}

{#snippet checkoutMenu()}
<Menu presentation={phone ? "sheet" : "popover"} side="top" align="end" ariaLabel="Checkout" class={phone ? undefined : "w-[320px]"} data-testid="composer-checkout-menu" onopenchange={(open) => { if (!open) checkoutState.showWorktrees = false; }} onCloseAutoFocus={(event) => { if (showBranchRename) event.preventDefault(); }}>
	{#snippet trigger({ props })}
		{#if row}
			<Button {...props} bind:element={identityElement} variant="composer-row" size="content"
				title={label} ariaLabel={`Checkout: ${[label, ...noticeLabels].join(", ")}`} data-testid="composer-checkout">
				<Icon name="git-branch" size={16} class="shrink-0 text-text-dimmer" />
				<span data-part="label" class="flex-1">Checkout</span>
				<span data-part="value" class="flex min-w-0 items-center justify-end gap-[5px] text-right text-text-secondary">{@render identity()}</span>
				<span data-part="chevron" class="inline-flex shrink-0 text-text-dimmer"><Icon name="chevron-right" size={10} /></span>
			</Button>
		{:else}
			<!-- A grid track gives the pill an honest minimum: flex parents read a truncating label's minimum as its full text width, so the bar would overflow instead of shrinking the title. -->
			<!-- The wrapper, ruler and button share a font so the ch floors agree. -->
			<span class="git-pill {control ? 'git-control font-mono' : 'git-word font-sans'} text-[11.5px] inline-grid" class:compact style={`grid-template-columns: minmax(${minimumWidth}, max-content)`} style:width={!control && !row && fit === "icon" ? width("full") : undefined} bind:clientWidth={room}>{#if !row}<span class="ruler" aria-hidden="true" bind:clientWidth={hundredCh}></span>{/if}<Button {...props} bind:element={identityElement} variant={control ? "composer-checkout" : "composer-word"} size={control ? "composer-chip" : "content"} touchTarget align="start" class="max-w-full"
				style={`min-width: ${minimumWidth}`}
				title={label} ariaLabel={`Checkout: ${[label, ...noticeLabels].join(", ")}`} data-testid="composer-checkout">
				{@render identity()}
			</Button></span>
		{/if}
	{/snippet}
	{#if multiFolder}
		<MenuGroup label="Checkout">
			{#each folders as folder (folder.root)}
				<section class="px-[8px] py-[6px] text-[10px]" aria-label={folder.label} data-testid="session-folder-git" data-folder-root={folder.root}>
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
		</MenuGroup>
		{:else}
		<div role="group" aria-label="Checkout" class="px-[8px] pt-[6px] pb-[4px] max-md:px-4">
			<div class="flex items-center gap-[10px]">
				<span class="grid size-[34px] shrink-0 place-items-center rounded-[10px] bg-accent/14 text-accent"><Icon name={git?.worktree ? "folder-tree" : git ? "git-branch" : "folder"} size={18} /></span>
				<div class="min-w-0 flex-1">
					<p data-part="checkout-branch" class="break-all font-mono text-[15px] font-semibold text-text max-md:text-[17px]">{git?.branch || (git?.head ? `Detached at ${git.head}` : project)}</p>
					{#if git}<p class="mt-[2px] break-words text-[12.5px] text-text-secondary">{folders[0]?.label ?? project}{#if git.worktree}{" · worktree "}<span class="font-mono text-[12px]">{git.worktree}</span>{/if}</p>{/if}
				</div>
				{#if git?.branch}<MenuItem density="compact" closeOnSelect={false} aria-label="Copy branch name" title="Copy branch name" class="size-[30px] shrink-0 justify-center rounded-[8px] text-text-muted max-md:size-[40px]" onselect={() => void copy(git?.branch ?? "", "Branch copied")}><Icon name="copy" size={15} /></MenuItem>{/if}
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
		<MenuGroup label="Location">
			<div class="mx-[8px] overflow-hidden rounded-[12px] border border-border max-md:mx-4">
				<MenuItem density="default" closeOnSelect={false} aria-label={`Copy worktree path, ${directory}`} class="min-h-[36px] gap-[10px] px-[12px] max-md:min-h-[44px]" onselect={() => void copy(directory, "Path copied")}>
					<span class="shrink-0 text-text-muted">Worktree</span><span class="min-w-0 flex-1 truncate text-right font-mono text-[12px] text-text" dir="rtl" title={directory}><bdi>{directory}</bdi></span><span class="shrink-0 text-text-dimmer"><Icon name="copy" size={14} /></span>
				</MenuItem>
				{#if git?.upstream}<div class="flex min-h-[36px] items-center gap-[10px] border-t border-border px-[12px] text-sm max-md:min-h-[44px]"><span class="shrink-0 text-text-muted">Upstream</span><span class="min-w-0 flex-1 truncate text-right font-mono text-[12px] text-text" title={git.upstream}>{git.upstream}</span></div>{/if}
				{#if git?.head}<MenuItem density="default" closeOnSelect={false} aria-label={`Copy commit hash, ${git.head}`} class="min-h-[36px] gap-[10px] border-t border-border px-[12px] max-md:min-h-[44px]" onselect={() => void copy(git?.oid ?? git?.head ?? "", "Commit hash copied")}>
					<span class="shrink-0 text-text-muted">HEAD</span><span class="min-w-0 flex-1 truncate text-right font-mono text-[12px] text-text">{git.head}</span><span class="shrink-0 text-text-dimmer"><Icon name="copy" size={14} /></span>
				</MenuItem>{/if}
			</div>
		</MenuGroup>
		<p class="{phone ? 'px-4' : 'px-3'} pt-[7px] pb-[4px] text-[12px] text-text-muted">{phone ? "Tap" : "Click"} a row to copy it.</p>
		{/if}
	{#if checkoutState.workspaceMissing}
		<MenuSeparator />
		{#if checkoutState.missingFolders.length}
			<div class="px-[8px] py-[6px] text-[10px] text-warning">
				<p>{checkoutState.workspaceMissing.canRecreate ? "These worktrees are missing. They will be recreated from their branches on your next message:" : "Missing worktrees:"}</p>
				{#each checkoutState.missingFolders as folder, index (folder.folder)}
					<p class="mt-[4px] break-all" data-testid="workspace-missing-folder">{checkoutState.missingFolderLabels[index]?.label ?? folder.folder}<span class="block text-text-muted">{folder.path}</span>{#if folder.reason === "branch-missing"}<span class="block">Its branch no longer exists.</span>{/if}</p>
				{/each}
			</div>
		{:else}
			<p class="px-[8px] py-[6px] text-[10px] text-warning">{#if checkoutState.workspaceMissing.canRecreate}This worktree is missing. It will be recreated from its branch on your next message.{:else}The session's worktree is missing.{#if checkoutState.workspaceMissing.reason === "branch-missing"}<span class="mt-[4px] block">Its branch no longer exists.</span>{/if}{/if}</p>
		{/if}
		{#each checkoutState.notices.find((notice) => notice.kind === "missing")?.actions ?? [] as action (action.kind)}
			<MenuItem disabled={checkoutState.moving || checkoutState.dismissing} data-testid={action.kind === "recreate" ? "workspace-recreate" : "workspace-continue-main"} onselect={() => void action.run()}>{action.label}</MenuItem>
		{/each}
	{/if}
	{#if checkoutState.workspaceMismatch}
		<MenuSeparator />
		<p class="px-[8px] py-[6px] text-[10px] text-warning" data-testid="workspace-mismatch">Workspace mismatch: Claude is working in <span class="break-all">{checkoutState.workspaceMismatch.actualPath}</span>. The recorded folder is <span class="break-all">{directory}</span>.</p>
		{#each checkoutState.notices.find((notice) => notice.kind === "mismatch")?.actions ?? [] as action (action.kind)}
			{#if action.kind === "move"}<MenuItem disabled={checkoutState.moving} onselect={() => void action.run()}>{action.label}</MenuItem>{/if}
		{/each}
	{/if}
	{#if checkoutState.workspaceHint}
		<MenuSeparator />
		<p class="px-[8px] py-[6px] text-[10px] text-warning">{checkoutState.hintLabel}<span class="mt-[4px] block break-all text-text-muted">{checkoutState.workspaceHint}</span></p>
		{#each checkoutState.notices.find((notice) => notice.kind === "hint")?.actions ?? [] as action (action.kind)}
			<MenuItem disabled={checkoutState.moving || checkoutState.dismissing} data-testid={`workspace-hint-${action.kind}`} onselect={() => void action.run()}>{action.label}</MenuItem>
		{/each}
	{/if}
	{#if multiFolder}
		<MenuSeparator />
		{@render checkoutActions()}
	{:else if checkoutState.canRenameBranch || checkoutState.canListWorktrees}
		<MenuGroup label="Actions">
			<div class="mx-[8px] divide-y divide-border overflow-hidden rounded-[12px] border border-border max-md:mx-4">
				{@render checkoutActions()}
			</div>
		</MenuGroup>
	{/if}
</Menu>
{/snippet}

{#snippet warningRow()}
	{#if checkoutState.warningPath}
		<div data-testid="composer-checkout-warning" class="flex min-h-[50px] flex-wrap items-center gap-x-[10px] gap-y-[6px] py-[8px] text-[11.5px] text-warning">
			<span class="flex min-w-0 items-center gap-[5px]"><span class="inline-flex shrink-0"><Icon name="circle-alert" size={12} /></span><span class="min-w-0 break-all">Claude is working in {checkoutState.warningDisplayPath}</span></span>
			<span class="ml-auto flex shrink-0 gap-[6px]">
				{#each checkoutState.warningNotice?.actions ?? [] as action (action.kind)}
					<Button variant="ghost" size="content" tone="inherit" hoverFill="none" class="rounded-[7px] border border-border px-[10px] py-[3px] text-[11.5px] font-normal text-text" disabled={checkoutState.moving || checkoutState.dismissing} data-testid={`workspace-hint-${action.kind}`} onclick={() => void action.run()}>{action.kind === "move" ? "Move" : action.label}</Button>
				{/each}
			</span>
		</div>
	{/if}
{/snippet}

<Modal open={showBranchRename} title="Rename branch" description="Rename the branch in every worktree created for this session." size="sm" placement={phone ? "sheet" : "center"} dismissible={!checkoutState.renamingBranch} showClose={!checkoutState.renamingBranch} onclose={() => { if (!checkoutState.renamingBranch) checkoutState.showBranchRename = false; }} returnFocus={() => identityElement ?? null}>
	<form id={branchRenameFormId} onsubmit={(event) => { event.preventDefault(); void checkoutState.renameBranch(); }} aria-busy={checkoutState.renamingBranch}>
		<Field label="Branch name" error={checkoutState.branchRenameError}>
			<TextInput bind:value={checkoutState.branchName} readonly={checkoutState.renamingBranch} autofocus={showBranchRename} autocomplete="off" autocapitalize="off" spellcheck={false} data-testid="session-branch-rename-input" oninput={() => { checkoutState.branchRenameError = undefined; }} />
		</Field>
	</form>
	{#snippet footer()}
		<Button variant="secondary" size="sm" disabled={checkoutState.renamingBranch} onclick={() => { checkoutState.showBranchRename = false; }} data-testid="session-branch-rename-cancel">Cancel</Button>
		<Button variant="primary" size="sm" type="submit" form={branchRenameFormId} disabled={checkoutState.renamingBranch || !checkoutState.branchName.trim()} data-testid="session-branch-rename-submit">{checkoutState.renamingBranch ? "Renaming…" : "Rename"}</Button>
	{/snippet}
</Modal>

{#if children}
	{@render children(noticeLabels.length > 0, checkoutMenu, warningRow)}
{:else}
	{@render checkoutMenu()}
{/if}

<style>
	/* The cap sits on the grid wrapper, the flex item: on the button it left the wrapper sized to the full label, with dead space after the pill. */
	.git-pill { max-width: 100%; flex-shrink: 1; }
	/* A stable slot measures available room in block, grid and flex parents. Checkout still yields before the model. */
	.git-pill.git-control { position: relative; width: 100%; flex: 0 1000000 220px; min-width: 30px; max-width: 220px; justify-content: end; }
	/* Phone models yield their name first; checkout keeps a readable branch until then. */
	.git-pill.git-control.compact { flex: 0 0 var(--composer-checkout-width, 90px); max-width: 110px; }
	/* Content-sized, so it sits beside the context %. As an icon it still asks for its full width, or it could never grow back. */
	.git-pill.git-word { position: relative; flex: 0 1 auto; min-width: 12px; justify-content: end; }
	/* 100ch in the pill's font turns ch floors into px. It extends left from the pill, so it never adds scroll. */
	.ruler { position: absolute; top: 0; right: 0; width: 100ch; height: 0; visibility: hidden; pointer-events: none; }
	.commit-icon { display: flex; align-items: center; width: 12px; }
	.commit-icon::before, .commit-icon::after { content: ""; flex: 1; border-top: 1px solid currentColor; }
</style>
