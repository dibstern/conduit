<!-- Where a draft session will start: its project and its workspace/branch.
     Both are chips on the composer, as in t3code's branch toolbar. -->

<script lang="ts">
	import type { WorktreeInfo } from "../../../shared-types.js";
	import { getAvailableInstances, getEffectiveInstanceId } from "../../stores/discovery.svelte.js";
	import { getInstanceById } from "../../stores/instance.svelte.js";
	import { getDraftProject, projectState } from "../../stores/project.svelte.js";
	import { DRAFT_PROJECT_PARAM, getCurrentSearchParams, replaceRoute } from "../../stores/router.svelte.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import { listBranchesRpc, listWorktreesRpc, type resolveSessionModeRpc } from "../../transport/ws-rpc-client.js";
	import { projectAccent } from "../session/session-list-project.js";
	import ProjectSquare from "../session/ProjectSquare.svelte";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuGroup from "../ui/MenuGroup.svelte";
	import MenuItem from "../ui/MenuItem.svelte";
	import MenuRadioGroup from "../ui/MenuRadioGroup.svelte";
	import MenuRadioItem from "../ui/MenuRadioItem.svelte";
	import MenuSeparator from "../ui/MenuSeparator.svelte";

	let { worktree = $bindable<WorktreeInfo | null>(null), newWorktree = $bindable(false), worktreeBase = $bindable<string | null>(null), modeChosen = $bindable(false), sessionModeDefault, focusComposer, loadWorktrees = listWorktreesRpc, loadBranches = listBranchesRpc }: {
		worktree?: WorktreeInfo | null;
		newWorktree?: boolean;
		worktreeBase?: string | null;
		modeChosen?: boolean;
		sessionModeDefault?: Awaited<ReturnType<typeof resolveSessionModeRpc>> | undefined;
		focusComposer?: (() => void) | undefined;
		loadWorktrees?: (projectSlug: string) => Promise<{ readonly worktrees: readonly WorktreeInfo[] }>;
		loadBranches?: typeof listBranchesRpc;
	} = $props();
	let showWorktrees = $state(false);
	let worktrees = $state<readonly WorktreeInfo[] | undefined>();
	let branchList = $state<Awaited<ReturnType<typeof listBranchesRpc>> | undefined>();

	const slug = $derived(getDraftProject());
	const project = $derived(projectState.projects.find((p) => p.slug === slug));
	const title = $derived(project?.title || slug || "Choose a project");
	const branch = $derived(project?.git?.branch);
	const currentBranch = $derived(branchList === undefined ? branch : branchList.current);
	const baseBranch = $derived(worktreeBase ?? currentBranch);
	$effect(() => {
		slug;
		branchList = undefined;
	});
	const multiFolder = $derived((project?.folders.length ?? 0) > 1);
	const instance = $derived(getAvailableInstances().find((provider) => provider.id === getEffectiveInstanceId()));
	const providerName = $derived(getInstanceById(instance?.id ?? "")?.name ?? instance?.label ?? "This provider");
	const supportsWorktree = $derived(instance?.capabilities?.supportsWorktree !== false);
	const supportsNewWorktree = $derived(instance?.capabilities?.supportsNewWorktree ?? instance?.capabilities?.supportsWorktree ?? false);
	const hasGitFolder = $derived(Boolean(project?.git?.folders?.length || branch || project?.git?.head || Object.keys(project?.repositoryIdentities ?? {}).length));
	const canCreateWorktree = $derived(Boolean(slug && hasGitFolder && instance && supportsNewWorktree));
	$effect(() => {
		if (!sessionModeDefault || modeChosen) return;
		const useWorktree = sessionModeDefault.mode === "worktree" && canCreateWorktree;
		newWorktree = useWorktree;
		worktree = null;
		if (!useWorktree) worktreeBase = null;
	});
	const checkout = $derived(newWorktree ? "New worktree" : worktree ? worktree.branch ?? "Detached HEAD" : branch ?? "Current folder");
	const worktreeContext = $derived(`${slug ?? ""}:${instance?.id ?? ""}:${supportsWorktree}`);
	$effect(() => {
		worktreeContext;
		showWorktrees = false;
		worktrees = undefined;
		if (!supportsWorktree) worktree = null;
		if (!canCreateWorktree) {
			newWorktree = false;
			worktreeBase = null;
		}
	});
	const uid = $props.id();
	const explanationId = `${uid}-provider-explanation`;
	const warningId = `${uid}-session-mode-warning`;
	const startDescription = $derived([
		multiFolder && instance?.capabilities?.supportsMultiFolder === false ? explanationId : "",
		sessionModeDefault?.warning ? warningId : "",
	].filter(Boolean).join(" ") || undefined);
	const available = $derived(projectState.projects.filter((p) => !p.missing));
	const missing = $derived(projectState.projects.filter((p) => p.missing));
	const presentation = $derived(sessionViewState.compact ? "sheet" : "popover");

	const chipClass =
		"min-w-0 gap-1 rounded-full border border-border-chip bg-bg-alt px-[8px] py-[5px] md:px-[7px] md:py-[4px] text-[11.5px] md:text-[11px] leading-none font-medium font-brand";
	const rowClass = "min-h-[44px] md:min-h-0";
	let picked = false;

	// A pick hands focus to the composer, where the prompt goes next. Left on the
	// chip, the prompt's first space reopened the menu and its letters picked
	// again by typeahead. Escape still returns focus to the chip.
	function focusComposerAfterPick(event: Event) {
		const handOff = picked ? focusComposer : undefined;
		picked = false;
		if (!handOff) return;
		event.preventDefault();
		handOff();
	}

	function chooseProject(next: string) {
		picked = true;
		worktree = null;
		newWorktree = false;
		worktreeBase = null;
		modeChosen = false;
		const params = getCurrentSearchParams();
		params.set(DRAFT_PROJECT_PARAM, next);
		replaceRoute(`/new?${params}`);
	}

	async function openWorktrees() {
		if (!slug || !supportsWorktree) return;
		const context = worktreeContext;
		showWorktrees = true;
		worktrees = undefined;
		try {
			const result = await loadWorktrees(slug);
			if (context === worktreeContext) worktrees = result.worktrees;
		} catch {
			if (context !== worktreeContext) return;
			worktrees = [];
			showToast("Could not list worktrees", { variant: "error" });
		}
	}

	async function openBranches() {
		if (!slug) return;
		const projectSlug = slug;
		branchList = undefined;
		try {
			const result = await loadBranches(projectSlug);
			if (projectSlug !== slug) return;
			branchList = result;
			if (worktreeBase === result.current) worktreeBase = null;
		} catch {
			if (projectSlug !== slug) return;
			branchList = { branches: [] };
			showToast("Could not list branches", { variant: "error" });
		}
	}
</script>

<div class="flex min-w-0 items-center gap-1.5 px-1" data-testid="new-session-context">
	<Menu ariaLabel="Start in project" {presentation} onCloseAutoFocus={focusComposerAfterPick}>
		{#snippet trigger({ props })}
			<Button {...props} variant="ghost" size="content" tone="default" touchTarget class={chipClass} title="Project" data-testid="draft-project-chip">
				{#if slug}<ProjectSquare label={title} accent={projectAccent(slug)} />{/if}
				<span class="truncate">{title}</span>
				<Icon name="chevron-down" size={12} />
			</Button>
		{/snippet}
		<MenuGroup label="Start in…">
			<MenuRadioGroup value={slug ?? ""} onvaluechange={chooseProject}>
				{#each available as p (p.slug)}
					<MenuRadioItem value={p.slug} class={rowClass}>
						<span class="flex min-w-0 items-center gap-2">
							<ProjectSquare label={p.title || p.slug} accent={projectAccent(p.slug)} />
							<span class="truncate">{p.title || p.slug}</span>
							{#if p.git?.branch}<span class="truncate text-text-dimmer">{p.git.branch}</span>{/if}
						</span>
					</MenuRadioItem>
				{/each}
			</MenuRadioGroup>
		</MenuGroup>
		{#if missing.length > 0}
			<MenuSeparator />
			<MenuGroup label="Folder missing">
				{#each missing as p (p.slug)}
					<MenuItem disabled class={rowClass}>{p.title || p.slug}</MenuItem>
				{/each}
			</MenuGroup>
		{/if}
	</Menu>

	<Menu ariaLabel="Where the session starts" {presentation} onCloseAutoFocus={focusComposerAfterPick} onopenchange={(open) => { if (!open) showWorktrees = false; }}>
		{#snippet trigger({ props })}
			<Button {...props} variant="ghost" size="content" tone="default" touchTarget class={chipClass} title="Where it starts" data-testid="draft-start-chip" aria-describedby={startDescription}>
				<Icon name={worktree || newWorktree ? "worktree" : branch ? "git-branch" : "folder"} size={12} />
				<span class="truncate">{checkout}</span>
				<Icon name="chevron-down" size={12} />
			</Button>
		{/snippet}
		<MenuGroup label="Workspace">
			<MenuRadioGroup value={worktree || newWorktree ? "" : "current"}>
				<MenuRadioItem value="current" onselect={() => { picked = true; modeChosen = true; worktree = null; newWorktree = false; worktreeBase = null; }} class={rowClass}>Current checkout</MenuRadioItem>
			</MenuRadioGroup>
			<MenuItem disabled={!slug || !supportsWorktree} closeOnSelect={false} onselect={() => void openWorktrees()} class={rowClass}>Existing worktree {#if !supportsWorktree}<span class="ml-auto text-text-dimmer">Not supported by {providerName}</span>{/if}</MenuItem>
			{#if showWorktrees}
				<MenuGroup label="Worktrees">
					{#if worktrees === undefined}
						<MenuItem disabled class={rowClass}>Loading worktrees…</MenuItem>
					{:else if worktrees.length === 0}
						<MenuItem disabled class={rowClass}>No worktrees available</MenuItem>
					{:else}
						<MenuRadioGroup value={worktree?.path ?? ""} onvaluechange={(path) => { picked = true; modeChosen = true; newWorktree = false; worktreeBase = null; worktree = worktrees?.find((entry) => entry.path === path) ?? null; }}>
							{#each worktrees as entry (entry.path)}
								<MenuRadioItem value={entry.path} class={rowClass}>
									<span class="flex min-w-0 flex-1 flex-col">
										<span>{entry.branch ?? (entry.main ? "Main folder" : "Detached HEAD")}{entry.main ? " · main worktree" : ""}</span>
										<span class="break-all text-text-muted">{entry.path}</span>
										</span>
								</MenuRadioItem>
							{/each}
						</MenuRadioGroup>
					{/if}
				</MenuGroup>
			{/if}
			<MenuItem disabled={!canCreateWorktree} onselect={() => { picked = true; modeChosen = true; worktree = null; newWorktree = true; }} class={rowClass}>New worktree {#if !canCreateWorktree}<span class="ml-auto text-text-dimmer">{!supportsNewWorktree ? `Not supported by ${providerName}` : !slug ? "Choose a project" : !hasGitFolder ? "Requires a Git folder" : "Choose a provider"}</span>{/if}</MenuItem>
		</MenuGroup>
		{#if branch}
			<MenuSeparator />
			<MenuGroup label="Branch">
				<MenuRadioGroup value={branch}>
					<MenuRadioItem value={branch} class={rowClass}>{branch}</MenuRadioItem>
				</MenuRadioGroup>
				<MenuItem disabled class={rowClass}>New branch… <span class="ml-auto text-text-dimmer">soon</span></MenuItem>
			</MenuGroup>
		{/if}
	</Menu>

	{#if newWorktree}
		<Menu ariaLabel="Base branch" {presentation} onCloseAutoFocus={focusComposerAfterPick} onopenchange={(open) => { if (open) void openBranches(); }}>
			{#snippet trigger({ props })}
				<Button {...props} variant="ghost" size="content" tone="default" touchTarget class={chipClass} title="Base branch" data-testid="draft-base-branch-chip">
					<Icon name="git-branch" size={12} />
					<span class="truncate">from {baseBranch ?? "committed HEAD"}</span>
					<Icon name="chevron-down" size={12} />
				</Button>
			{/snippet}
			<MenuGroup label="Base branch">
				{#if branchList === undefined}
					<MenuItem disabled class={rowClass}>Loading branches…</MenuItem>
				{:else if branchList.branches.length === 0}
					<MenuItem disabled class={rowClass}>No local branches available</MenuItem>
				{:else}
					<MenuRadioGroup value={baseBranch ?? ""} onvaluechange={(value) => { picked = true; modeChosen = true; worktreeBase = value === currentBranch ? null : value; }}>
						{#each branchList.branches as name (name)}
							<MenuRadioItem value={name} class={rowClass}>{name}</MenuRadioItem>
						{/each}
					</MenuRadioGroup>
				{/if}
			</MenuGroup>
		</Menu>
	{:else if worktree || branch}
		<span class="truncate font-brand text-[11.5px] md:text-[11px] text-text-muted">{worktree ? "existing worktree" : "current checkout"}</span>
	{/if}
</div>

{#if sessionModeDefault?.warning}
	<p id={warningId} role="status" data-testid="draft-session-mode-warning" class="px-1 pt-1 break-words text-[11px] text-warning">{sessionModeDefault.warning}</p>
{/if}

{#if multiFolder && instance?.capabilities?.supportsMultiFolder === false}
	<p id={explanationId} role="status" data-testid="draft-provider-explanation" class="px-1 pt-1 text-[11px] text-text-secondary">{providerName} works in the main folder only. Pick another provider to use every folder.</p>
{/if}
