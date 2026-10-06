<!-- Where a draft session will start: its project and its workspace/branch.
     Both are chips on the composer, as in t3code's branch toolbar. Only the
     current checkout exists today; worktrees and other branches come later. -->

<script lang="ts">
	import { getDraftProject, projectState } from "../../stores/project.svelte.js";
	import { DRAFT_PROJECT_PARAM, getCurrentSearchParams, replaceRoute } from "../../stores/router.svelte.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
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

	const slug = $derived(getDraftProject());
	const project = $derived(projectState.projects.find((p) => p.slug === slug));
	const title = $derived(project?.title || slug || "Choose a project");
	const branch = $derived(project?.git?.branch);
	const available = $derived(projectState.projects.filter((p) => !p.missing));
	const missing = $derived(projectState.projects.filter((p) => p.missing));
	const presentation = $derived(sessionViewState.compact ? "sheet" : "popover");

	const chipClass =
		"min-w-0 gap-1 rounded-full border border-border-chip bg-bg-alt px-[8px] py-[5px] md:px-[7px] md:py-[4px] text-[11.5px] md:text-[11px] leading-none font-medium font-brand";
	const rowClass = "min-h-[44px] md:min-h-0";

	function chooseProject(next: string) {
		const params = getCurrentSearchParams();
		params.set(DRAFT_PROJECT_PARAM, next);
		replaceRoute(`/new?${params}`);
	}
</script>

<div class="flex min-w-0 items-center gap-1.5 px-1" data-testid="new-session-context">
	<Menu ariaLabel="Start in project" {presentation}>
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

	<Menu ariaLabel="Where the session starts" {presentation}>
		{#snippet trigger({ props })}
			<Button {...props} variant="ghost" size="content" tone="default" touchTarget class={chipClass} title="Where it starts" data-testid="draft-start-chip">
				<Icon name={branch ? "git-branch" : "folder"} size={12} />
				<span class="truncate">{branch ?? "Current folder"}</span>
				<Icon name="chevron-down" size={12} />
			</Button>
		{/snippet}
		<MenuGroup label="Workspace">
			<MenuRadioGroup value="current">
				<MenuRadioItem value="current" class={rowClass}>Current checkout</MenuRadioItem>
			</MenuRadioGroup>
			<MenuItem disabled class={rowClass}>New worktree <span class="ml-auto text-text-dimmer">soon</span></MenuItem>
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

	{#if branch}<span class="truncate font-brand text-[11.5px] md:text-[11px] text-text-dimmer">current checkout</span>{/if}
</div>
