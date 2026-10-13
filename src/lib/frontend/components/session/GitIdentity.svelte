<script lang="ts">
	import type { Snippet } from "svelte";
	import { Schema } from "effect";
	import { type WorkspaceMoveCause, WorkspaceMoveError } from "../../../contracts/session-workspace.js";
	import { type WorkspaceMissing, WorktreeBranchRenameError, WorktreeRecoveryError } from "../../../contracts/worktree.js";
	import type { SessionGit, WorktreeInfo } from "../../../shared-types.js";
	import { labelProjectFolders } from "../../../project-folders.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import Button from "../ui/Button.svelte";
	import Field from "../ui/Field.svelte";
	import Icon from "../ui/Icon.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuGroup from "../ui/MenuGroup.svelte";
	import MenuItem from "../ui/MenuItem.svelte";
	import MenuSeparator from "../ui/MenuSeparator.svelte";
	import Modal from "../ui/Modal.svelte";
	import TextInput from "../ui/TextInput.svelte";

	let { directory, git: folderGit, presentation, workspaceCause, workspaceMissing, workspaceMismatch, workspaceHint, loadWorktrees, onmove, onrecreate, oncontinue, ondismiss, onrenamebranch, children }: {
		directory: string;
		git: SessionGit | undefined;
		presentation: "word" | "control" | "row";
		workspaceCause?: WorkspaceMoveCause | undefined;
		workspaceMissing?: WorkspaceMissing | undefined;
		workspaceMismatch?: { readonly actualPath: string } | undefined;
		workspaceHint?: string | undefined;
		loadWorktrees?: (() => Promise<{ readonly worktrees: readonly WorktreeInfo[]; readonly directory?: string | undefined }>) | undefined;
		onmove?: ((path: string) => Promise<void>) | undefined;
		onrecreate?: (() => Promise<void>) | undefined;
		oncontinue?: (() => Promise<void>) | undefined;
		ondismiss?: ((path: string) => Promise<void>) | undefined;
		onrenamebranch?: ((branchName: string) => Promise<void>) | undefined;
		children?: Snippet<[attention: boolean, checkout: Snippet, warning: Snippet]> | undefined;
	} = $props();
	const folders = $derived(folderGit?.folders ?? []);
	const git = $derived(folderGit?.folders && !folderGit.branch && !folderGit.head && folderGit.dirty === undefined ? undefined : folderGit);
	let showWorktrees = $state(false);
	let worktrees = $state<readonly WorktreeInfo[] | undefined>();
	let currentDirectory = $state<string | undefined>();
	let moving = $state(false);
	let dismissing = $state(false);
	let dismissedMismatch = $state<string | undefined>();
	const control = $derived(presentation === "control");
	const row = $derived(presentation === "row");
	const phone = $derived(sessionViewState.composerTier === "phone");
	const mismatchKey = $derived(workspaceMismatch ? `${directory}\0${workspaceMismatch.actualPath}` : undefined);
	$effect(() => {
		if (dismissedMismatch !== mismatchKey) dismissedMismatch = undefined;
	});
	let showBranchRename = $state(false);
	let branchName = $state("");
	let branchRenameError = $state<string | undefined>();
	let renamingBranch = $state(false);
	let identityElement = $state<HTMLButtonElement | HTMLAnchorElement>();
	const componentId = $props.id();
	const branchRenameFormId = `${componentId}-branch-rename`;

	function openBranchRename() {
		branchName = git?.branch ?? folders.find((folder) => !folder.shared && folder.branch)?.branch ?? "";
		branchRenameError = undefined;
		showBranchRename = true;
	}

	async function renameBranch() {
		if (!onrenamebranch || renamingBranch || !branchName.trim()) return;
		renamingBranch = true;
		branchRenameError = undefined;
		try {
			await onrenamebranch(branchName);
			showBranchRename = false;
		} catch (error) {
			branchRenameError = Schema.is(WorktreeBranchRenameError)(error)
				? `${error.folder}: ${error.message}`
				: "Could not rename branch";
		} finally {
			renamingBranch = false;
		}
	}

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
	async function recover(action: "recreate" | "continue") {
		moving = true;
		try {
			if (action === "recreate") await onrecreate?.();
			else await oncontinue?.();
		} catch (error) {
			showToast(Schema.is(WorktreeRecoveryError)(error) ? error.message : Schema.is(WorkspaceMoveError)(error) ? moveFailures[error.reason] : action === "recreate" ? "Could not recreate worktree" : "Could not continue in main folder", { variant: "error" });
		} finally {
			moving = false;
		}
	}
	async function dismiss(path: string, source: "hint" | "mismatch" = "hint") {
		// Only workspace hints have a dismiss RPC. Acknowledge a mismatch here
		// until the workspace changes; its checkout details stay available.
		if (source === "mismatch" && warningMismatch?.actualPath === path) {
			dismissedMismatch = mismatchKey;
			return;
		}
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
	const movedBack = $derived(workspaceCause === "missing");
	const movedBackLabel = "moved back: worktree removed";
	const missingFolders = $derived(workspaceMissing?.folders ?? []);
	const missingFolderLabels = $derived(labelProjectFolders(missingFolders.map(({ folder }) => folder)));
	const missingLabel = $derived(missingFolders.length ? `worktree missing: ${missingFolderLabels.map(({ label }) => label).join(", ")}` : "worktree missing");
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
	const warningMismatch = $derived(workspaceMismatch && (!row || mismatchKey !== dismissedMismatch) ? workspaceMismatch : undefined);
	const warningPath = $derived(warningMismatch?.actualPath ?? workspaceHint);
	const warningDisplayPath = $derived.by(() => {
		if (!warningPath) return "";
		const path = warningPath.replaceAll("\\", "/");
		if (!path.startsWith("/") && !/^[a-z]:\//i.test(path)) return warningPath;
		const base = directory.replaceAll("\\", "/").split("/").filter(Boolean);
		const target = path.split("/").filter(Boolean);
		if (target[0]?.includes(":") && target[0] !== base[0]) return warningPath;
		let common = 0;
		while (common < base.length && base[common] === target[common]) common++;
		return [...base.slice(common).map(() => ".."), ...target.slice(common)].join("/") || ".";
	});
	const warningLabel = $derived(warningMismatch ? `Workspace mismatch: Claude is working in ${warningMismatch.actualPath}` : workspaceHint ? hintLabel : undefined);
	const noticeLabels = $derived([warningLabel, movedBack ? movedBackLabel : undefined, workspaceMissing ? missingLabel : undefined].filter((notice) => notice !== undefined));
	const projectFloor = $derived(Math.min(project.length, 4.5));
	const branchFloor = $derived(Math.min(checkout?.length ?? 0, 6.5));
	// Floor = labels + slash, icon, padding, divider and fixed marks. It wins over the nominal cap for long operation labels.
	const minimumWidth = $derived.by(() => {
		const marks = [
			!phone && upstreamMark ? `${upstreamMark.length}ch` : null,
			operation ? `${operation.length}ch` : null,
			showMerged ? "6ch" : null,
		].filter((width) => width !== null);
		const gaps = 5 * (1 + (checkout ? 2 : 0) + marks.length + (control ? 1 : 0));
		return `calc(${projectFloor + (checkout ? 1 + branchFloor : 0)}ch + 12px + ${control ? 22 : 0}px + ${gaps}px${noticeLabels.map(() => " + 17px").join("")}${marks.map((width) => ` + ${width}`).join("")})`;
	});

	async function copy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			showToast("Could not copy to clipboard", { variant: "error" });
		}
	}
</script>

{#snippet identity()}
			<span class="relative flex size-[12px] shrink-0 items-center text-text-muted" data-part={git?.worktree ? "worktree" : undefined} data-icon={!git ? "folder" : !git.branch ? "commit" : git.worktree ? "worktree" : "branch"}>
				{#if git && !git.branch}
					<!-- Compose the commit glyph from the existing circle icon. -->
					<span class="commit-icon"><Icon name="circle" size={4} /></span>
				{:else}
					<Icon name={!git ? "folder" : git.worktree ? "folder-tree" : "git-branch"} size={12} />
				{/if}
				<!-- The dirty mark stays on the icon, which never truncates. -->
				{#if git?.dirty}
					<span data-part="dirty" class="absolute -right-[2px] -bottom-[1px] size-[6px] rounded-full bg-warning ring-[1.5px] {row ? 'ring-bg-surface' : 'ring-input-bg'}" title="Uncommitted changes"><span class="sr-only">Uncommitted changes</span></span>
				{/if}
			</span>
			<span data-part="project" class="shrink-[100000000] truncate text-text-muted" style={`min-width: calc(${projectFloor}ch + 1px)`} title={project}>{project}</span>
			{#if checkout}
				<span class="shrink-0 text-text-dimmer" aria-hidden="true">/</span>
				<span data-part="branch" class="min-w-0 truncate {git?.branch ? 'text-text-secondary' : 'text-text-muted'}" style:min-width={`${branchFloor}ch`} title={git?.branch ? `Branch: ${checkout}` : `Detached at ${checkout}`}>{checkout}</span>
			{/if}
			{#if !phone && upstreamMark}
				<span data-part="upstream" class="shrink-0 tabular-nums text-text-muted">{upstreamMark}</span>
			{/if}
			{#if operation}<span data-part="operation" class="shrink-0 text-warning">{operation}</span>{/if}
			{#if showMerged}<span data-part="merged" class="shrink-0 text-success">merged</span>{/if}
			{#if warningLabel}
				<span data-part="warning" class="inline-flex shrink-0 text-warning" role="img" aria-label={warningLabel} title={warningLabel} data-testid={warningMismatch ? "workspace-mismatch-indicator" : "workspace-hint"}><Icon name="circle-alert" size={12} /></span>
			{/if}
			{#if movedBack}
				<span class="inline-flex shrink-0 text-warning" role="img" aria-label={movedBackLabel} title={movedBackLabel} data-testid="workspace-moved-back"><Icon name="circle-alert" size={12} /></span>
			{/if}
			{#if workspaceMissing}
				<span class="inline-flex shrink-0 text-warning" role="img" aria-label={missingLabel} title={missingLabel} data-testid="workspace-missing"><Icon name="circle-alert" size={12} /></span>
			{/if}
			{#if control}<span data-part="chevron" class="inline-flex shrink-0 text-text-dimmer"><Icon name="chevron-down" size={10} /></span>{/if}
{/snippet}

{#snippet checkoutMenu()}
<Menu presentation={phone ? "sheet" : "popover"} side="top" align="end" ariaLabel="Checkout" class={phone ? undefined : "w-[280px]"} data-testid="composer-checkout-menu" onopenchange={(open) => { if (!open) showWorktrees = false; }} onCloseAutoFocus={(event) => { if (showBranchRename) event.preventDefault(); }}>
	{#snippet trigger({ props })}
		{#if row}
			<Button {...props} bind:element={identityElement} variant="ghost" size="content" tone="inherit" hoverFill="none" layout="flow"
				class="flex min-h-[50px] w-full items-center gap-[10px] rounded-none border-b border-border-subtle text-left text-[12.5px] font-normal font-brand text-text last:border-b-0 hover:bg-text/7"
				title={label} ariaLabel={`Checkout: ${[label, ...noticeLabels].join(", ")}`} data-testid="composer-checkout">
				<span data-part="label" class="w-[64px] shrink-0 text-[11px] text-text-muted">Checkout</span>
				<span data-part="value" class="flex min-w-0 flex-1 items-center gap-[5px] font-normal">{@render identity()}</span>
				<span data-part="chevron" class="inline-flex shrink-0 text-text-dimmer"><Icon name="chevron-right" size={10} /></span>
			</Button>
		{:else}
			<!-- A grid track gives the pill an honest minimum: flex parents read a truncating label's minimum as its full text width, so the bar would overflow instead of shrinking the title. -->
			<!-- The wrapper and button share a font size so the ch floors agree. -->
			<span class="git-pill {control ? 'git-control' : ''} text-[11.5px] inline-grid" style={`grid-template-columns: minmax(${minimumWidth}, max-content)`}><Button {...props} bind:element={identityElement} variant="ghost" size="content" tone="muted" hoverFill="none" touchTarget align="start" class={control ? "h-[26px] max-w-full gap-[5px] rounded-[7px] px-[6px] font-normal font-brand" : "max-w-full gap-[5px] font-normal font-brand"}
				style={`min-width: ${minimumWidth}`}
				title={label} ariaLabel={`Checkout: ${[label, ...noticeLabels].join(", ")}`} data-testid="composer-checkout">
				{@render identity()}
			</Button></span>
		{/if}
	{/snippet}
	<MenuGroup label="Checkout">
		{#if folders.length > 1 || folders.some((folder) => folder.shared) || (!git && folders.length > 0)}
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
							<dt class="text-text-muted">Changes</dt><dd class="text-right {folder.dirty ? 'text-warning' : 'text-text'}">{folder.dirty ? "uncommitted" : "clean"}</dd>
						</dl>
					{/if}
				</section>
			{/each}
		{:else}
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
		{/if}
	</MenuGroup>
	{#if workspaceMissing}
		<MenuSeparator />
		{#if missingFolders.length}
			<div class="px-[8px] py-[6px] text-[10px] text-warning">
				<p>{workspaceMissing.canRecreate ? "These worktrees are missing. They will be recreated from their branches on your next message:" : "Missing worktrees:"}</p>
				{#each missingFolders as folder, index (folder.folder)}
					<p class="mt-[4px] break-all" data-testid="workspace-missing-folder">{missingFolderLabels[index]?.label ?? folder.folder}<span class="block text-text-muted">{folder.path}</span>{#if folder.reason === "branch-missing"}<span class="block">Its branch no longer exists.</span>{/if}</p>
				{/each}
			</div>
		{:else}
			<p class="px-[8px] py-[6px] text-[10px] text-warning">{#if workspaceMissing.canRecreate}This worktree is missing. It will be recreated from its branch on your next message.{:else}The session's worktree is missing.{#if workspaceMissing.reason === "branch-missing"}<span class="mt-[4px] block">Its branch no longer exists.</span>{/if}{/if}</p>
		{/if}
		{#if workspaceMissing.canRecreate && onrecreate}<MenuItem disabled={moving || dismissing} data-testid="workspace-recreate" onselect={() => void recover("recreate")}>Recreate worktree</MenuItem>{/if}
		{#if oncontinue}<MenuItem disabled={moving || dismissing} data-testid="workspace-continue-main" onselect={() => void recover("continue")}>Continue in main folder</MenuItem>{/if}
	{/if}
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
	{#if onrenamebranch}<MenuItem data-testid="session-branch-rename" onselect={openBranchRename}>Rename branch</MenuItem>{/if}
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
{/snippet}

{#snippet warningRow()}
	{#if warningPath}
		<div data-testid="composer-checkout-warning" class="flex min-h-[50px] flex-wrap items-center gap-x-[10px] gap-y-[6px] py-[8px] text-[11.5px] text-warning">
			<span class="flex min-w-0 items-center gap-[5px]"><span class="inline-flex shrink-0"><Icon name="circle-alert" size={12} /></span><span class="min-w-0 break-all">Claude is working in {warningDisplayPath}</span></span>
			<span class="ml-auto flex shrink-0 gap-[6px]">
				{#if onmove}<Button variant="ghost" size="content" tone="inherit" hoverFill="none" class="rounded-[7px] border border-border px-[10px] py-[3px] text-[11.5px] font-normal text-text" disabled={moving || dismissing} data-testid="workspace-hint-move" onclick={() => warningPath && void move(warningMismatch ? directory : warningPath)}>Move</Button>{/if}
				{#if ondismiss || warningMismatch}<Button variant="ghost" size="content" tone="inherit" hoverFill="none" class="rounded-[7px] border border-border px-[10px] py-[3px] text-[11.5px] font-normal text-text" disabled={moving || dismissing} data-testid="workspace-hint-dismiss" onclick={() => warningPath && void dismiss(warningPath, warningMismatch ? "mismatch" : "hint")}>Dismiss</Button>{/if}
			</span>
		</div>
	{/if}
{/snippet}

<Modal open={showBranchRename} title="Rename branch" description="Rename the branch in every worktree created for this session." size="sm" placement={phone ? "sheet" : "center"} dismissible={!renamingBranch} showClose={!renamingBranch} onclose={() => { if (!renamingBranch) showBranchRename = false; }} returnFocus={() => identityElement ?? null}>
	<form id={branchRenameFormId} onsubmit={(event) => { event.preventDefault(); void renameBranch(); }} aria-busy={renamingBranch}>
		<Field label="Branch name" error={branchRenameError}>
			<TextInput bind:value={branchName} readonly={renamingBranch} autofocus={showBranchRename} autocomplete="off" autocapitalize="off" spellcheck={false} data-testid="session-branch-rename-input" oninput={() => { branchRenameError = undefined; }} />
		</Field>
	</form>
	{#snippet footer()}
		<Button variant="secondary" size="sm" disabled={renamingBranch} onclick={() => { showBranchRename = false; }} data-testid="session-branch-rename-cancel">Cancel</Button>
		<Button variant="primary" size="sm" type="submit" form={branchRenameFormId} disabled={renamingBranch || !branchName.trim()} data-testid="session-branch-rename-submit">{renamingBranch ? "Renaming…" : "Rename"}</Button>
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
	.git-pill.git-control { min-width: 0; }
	.commit-icon { display: flex; align-items: center; width: 12px; }
	.commit-icon::before, .commit-icon::after { content: ""; flex: 1; border-top: 1px solid currentColor; }
</style>
