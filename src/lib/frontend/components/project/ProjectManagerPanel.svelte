<script lang="ts">
	import { onDestroy, onMount } from "svelte";
	import type { ProjectInfo } from "../../types.js";
	import { ADD_PROJECT_TIMEOUT_MS } from "../../ui-constants.js";
	import { onProject } from "../../stores/ws.svelte.js";
	import { applyProjectMutationResponse } from "../../stores/project.svelte.js";
	import {
		addProjectRpc,
		removeProjectRpc,
		renameProjectRpc,
	} from "../../transport/ws-rpc-client.js";
	import {
		instanceState,
		getInstanceById,
		getHealthyInstances,
		instanceStatusColor,
	} from "../../stores/instance.svelte.js";
	import { confirm } from "../../stores/ui.svelte.js";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import Select from "../ui/Select.svelte";
	import TextInput from "../ui/TextInput.svelte";
	import DirectoryAutocomplete from "./DirectoryAutocomplete.svelte";
	import ProjectContextMenu from "./ProjectContextMenu.svelte";

	let {
		projects,
		currentSlug,
		navigable = false,
		onnavigate,
		onclose,
		oncontextmenuopenchange,
	}: {
		projects: ProjectInfo[];
		currentSlug: string | undefined;
		navigable?: boolean;
		onnavigate?: (slug: string) => void;
		onclose?: () => void;
		oncontextmenuopenchange?: (open: boolean) => void;
	} = $props();

	let showAddForm = $state(false);
	let addDirectory = $state("");
	let addError = $state("");
	let adding = $state(false);
	let addInstanceId = $state("");
	let ctxMenuProject: ProjectInfo | null = $state(null);
	let ctxMenuAnchor: HTMLElement | null = $state(null);
	let renamingSlug: string | null = $state(null);
	let renameValue = $state("");

	const currentProject = $derived(
		projects.find((project) => project.slug === currentSlug) ??
			projects[0] ??
			null,
	);

	const hasMultipleInstances = $derived(instanceState.instances.length > 1);

	const projectsByInstance = $derived.by(() => {
		const groups = new Map<string, ProjectInfo[]>();
		for (const project of projects) {
			const key = project.instanceId ?? "_default";
			const list = groups.get(key);
			if (list) {
				list.push(project);
			} else {
				groups.set(key, [project]);
			}
		}
		return groups;
	});

	function handleShowAddForm() {
		showAddForm = true;
		addDirectory = "";
		addError = "";
		// Default to first healthy instance
		const healthy = getHealthyInstances();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		addInstanceId =
			healthy.length > 0
				? healthy[0]!.id
				: (instanceState.instances[0]?.id ?? "");
	}

	function handleCancelAdd() {
		showAddForm = false;
		addDirectory = "";
		addError = "";
	}

	function getRpcProjectSlug(fallbackSlug?: string): string | null {
		return currentSlug ?? currentProject?.slug ?? fallbackSlug ?? null;
	}

	function handleSubmitAdd() {
		const dir = addDirectory.trim();
		if (!dir) {
			addError = "Directory path is required";
			return;
		}
		const projectSlug = getRpcProjectSlug();
		if (projectSlug == null) {
			addError = "No active project connection";
			return;
		}
		adding = true;
		addError = "";
		const timeout = window.setTimeout(() => {
			if (adding) {
				adding = false;
				addError = "No response from server — please try again";
			}
		}, ADD_PROJECT_TIMEOUT_MS);
		void addProjectRpc({
			projectSlug,
			directory: dir,
			...(addInstanceId ? { instanceId: addInstanceId } : {}),
		})
			.then((response) => {
				window.clearTimeout(timeout);
				applyProjectMutationResponse(response);
				adding = false;
				showAddForm = false;
				addDirectory = "";
				onclose?.();
			})
			.catch(() => {
				window.clearTimeout(timeout);
				adding = false;
				addError = "No response from server — please try again";
			});
	}

	function handleProjectContextMenu(
		project: ProjectInfo,
		anchor: HTMLElement,
	) {
		ctxMenuProject = project;
		ctxMenuAnchor = anchor;
		oncontextmenuopenchange?.(true);
	}

	function handleCloseContextMenu() {
		ctxMenuProject = null;
		ctxMenuAnchor = null;
		oncontextmenuopenchange?.(false);
	}

	function handleCtxRename(slug: string) {
		renamingSlug = slug;
		const project = projects.find((candidate) => candidate.slug === slug);
		renameValue = project?.title ?? slug;
	}

	async function handleCtxDelete(slug: string, title: string) {
		const confirmed = await confirm(
			`Remove project '${title}' from conduit?`,
			"Remove",
		);
		if (confirmed) {
			const projectSlug = getRpcProjectSlug(slug);
			if (projectSlug == null) return;
			void removeProjectRpc({ projectSlug, slug })
				.then(applyProjectMutationResponse)
				.catch(() => undefined);
		}
	}

	function commitProjectRename(slug: string) {
		// Guard: if renamingSlug was already cleared (e.g. by Escape),
		// the blur handler may still fire — skip to avoid double-send.
		if (renamingSlug !== slug) return;
		const newTitle = renameValue.trim();
		renamingSlug = null;
		if (newTitle && newTitle.length > 0) {
			const project = projects.find((candidate) => candidate.slug === slug);
			if (project && newTitle !== project.title) {
				const projectSlug = getRpcProjectSlug(slug);
				if (projectSlug == null) return;
				void renameProjectRpc({
					projectSlug,
					slug,
					title: newTitle,
				})
					.then(applyProjectMutationResponse)
					.catch(() => undefined);
			}
		}
	}

	function cancelProjectRename() {
		renamingSlug = null;
	}

	function handleRenameKeydown(event: KeyboardEvent, slug: string) {
		if (event.key === "Enter") {
			event.preventDefault();
			event.stopPropagation();
			commitProjectRename(slug);
		} else if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			cancelProjectRename();
		}
	}

	function handleProjectRowClick(
		event: MouseEvent,
		project: ProjectInfo,
		isRenaming: boolean,
	) {
		if (isRenaming) {
			event.preventDefault();
			return;
		}
		if (event.metaKey || event.ctrlKey) return;
		event.preventDefault();
		onnavigate?.(project.slug);
	}

	let unsubProject: (() => void) | undefined;

	function handleKeydown(event: KeyboardEvent) {
		if (event.key !== "Escape") return;
		event.preventDefault();
		if (showAddForm) {
			handleCancelAdd();
		} else {
			onclose?.();
		}
	}

	onMount(() => {
		// Listen for project_list responses to reset add form state.
		// Navigation is handled by the project store (addedSlug → navigate).
		unsubProject = onProject((message) => {
			if (message.type === "project_list" && adding) {
				adding = false;
				showAddForm = false;
				addDirectory = "";
				onclose?.();
			}
		});
	});

	onDestroy(() => {
		unsubProject?.();
		oncontextmenuopenchange?.(false);
	});
</script>

<svelte:window onkeydown={handleKeydown} />

{#snippet projectRow(project: ProjectInfo)}
	{@const isActive = navigable && project.slug === currentSlug}
	{@const isRenaming = renamingSlug === project.slug}
	<!-- The rail and manager hooks stay distinct until conduit-test-vik1.7 deletes the rail, when they collapse back. -->
	<svelte:element
		this={navigable ? "a" : "div"}
		role={navigable ? undefined : "group"}
		href={navigable ? `/p/${project.slug}/` : undefined}
		data-testid={navigable ? "project-item" : "managed-project-item"}
		data-slug={project.slug}
		title={project.directory}
		class={navigable
			? "group/proj flex items-center gap-2.5 px-3 py-2.5 cursor-pointer transition-colors duration-100 hover:bg-[rgba(var(--overlay-rgb),0.04)] rounded-md no-underline text-inherit visited:text-inherit" +
				(isActive ? " bg-bg-surface" : "")
			: "group/proj flex items-center gap-2.5 px-3 py-2.5 rounded-md"}
		style={isActive
			? "box-shadow: inset 3px 0 0 var(--color-brand-a), inset 3px 0 12px rgba(255,45,123,0.1);"
			: ""}
		onclick={navigable
			? (event: MouseEvent) =>
					handleProjectRowClick(event, project, isRenaming)
			: undefined}
	>
		<!-- Indicator dot -->
		<span
			class={"w-1.5 h-1.5 rounded-full shrink-0" +
				(isActive ? " bg-accent" : " bg-text-dimmer/40")}
		></span>
		<!-- Name and directory -->
		<div class="flex-1 min-w-0 flex flex-col">
			{#if isRenaming}
				<TextInput
					size="sm"
					class="min-w-0 font-brand"
					autofocus
					aria-label="Rename project"
					bind:value={renameValue}
					onkeydown={(event) =>
						handleRenameKeydown(event, project.slug)}
					onblur={() => commitProjectRename(project.slug)}
					onclick={(event) => {
						event.preventDefault();
						event.stopPropagation();
					}}
				/>
			{:else}
				<span
					class={"text-base truncate" +
						(isActive
							? " font-semibold text-text"
							: " text-text-secondary")}
				>
					{project.title}
				</span>
			{/if}
			<span class="text-xs text-text-dimmer font-mono truncate">
				{project.directory}
			</span>
		</div>
		{#if !isRenaming}
			<!-- Client count -->
			{#if project.clientCount && project.clientCount > 0}
				<span class="shrink-0 text-xs text-text-dimmer tabular-nums">
					{project.clientCount}
				</span>
			{/if}
			<!-- The rail hook is retained for existing e2e specs; manage mode uses a distinct hook until the rail is removed. -->
			<!-- `w-5 h-5` is 15px, not 20px: the app's root font-size is 12px so
			     every rem utility is 0.75x. That is fine for the rail, which is
			     pointer-only, but in manage mode this control IS how you reach
			     rename and remove on a phone, so it gets a literal 44px floor
			     there and drops back to the rail's glyph size at md. -->
			<Button
				variant="toolbar"
				size="content"
				iconOnly
				icon="ellipsis"
				iconSize={13}
				ariaLabel="More options for {project.title}"
				class={navigable
					? "proj-more-btn shrink-0 w-5 h-5 rounded duration-100"
					: "managed-proj-more-btn shrink-0 min-w-[44px] min-h-[44px] md:w-5 md:h-5 md:min-w-0 md:min-h-0 rounded duration-100"}
				title="More options"
				onclick={(event) => {
					event.preventDefault();
					event.stopPropagation();
					handleProjectContextMenu(
						project,
						event.currentTarget as HTMLElement,
					);
				}}
			/>
		{/if}
	</svelte:element>
{/snippet}

<!-- Header -->
<div
	class="px-3 pt-2 pb-1.5 text-sm font-semibold uppercase tracking-[0.5px] text-text-dimmer"
>
	Projects
</div>

<!-- Project list -->
<div class="max-h-[280px] overflow-y-auto">
	<!-- Manage mode always groups projects so the instance name and health stay visible. -->
	{#if !navigable || hasMultipleInstances}
		{#each [...projectsByInstance] as [instanceId, instanceProjects] (instanceId)}
			{@const instance = instanceId !== "_default" ? getInstanceById(instanceId) : undefined}
			<!-- Instance group header -->
			<div
				class="flex items-center gap-1.5 px-3 pt-2 pb-1 text-xs font-semibold uppercase tracking-[0.5px] text-text-dimmer"
				data-testid={navigable
					? "instance-group-header"
					: "managed-instance-group-header"}
			>
				<span
					class={"w-1.5 h-1.5 rounded-full shrink-0 " +
						instanceStatusColor(instance?.status)}
					data-testid={navigable
						? "instance-status-dot"
						: "managed-instance-status-dot"}
				></span>
				<span class="truncate">{instance?.name ?? "Default"}</span>
			</div>
			{#each instanceProjects as project (project.slug)}
				{@render projectRow(project)}
			{/each}
		{/each}
	{:else}
		{#each projects as project (project.slug)}
			{@render projectRow(project)}
		{/each}
	{/if}
</div>

<!-- Footer: Add project form or button -->
<div class="border-t border-border-subtle">
	{#if showAddForm}
		<!-- Add project form -->
		<div class="px-3 py-2 flex flex-col gap-1.5">
			<DirectoryAutocomplete
				bind:value={addDirectory}
				onsubmit={handleSubmitAdd}
			/>
			{#if hasMultipleInstances}
				<!-- `sm` to match the DirectoryAutocomplete field directly
				     above it; the two were a size apart before. -->
				<Select
					name="instance"
					id="instance-selector"
					size="sm"
					aria-label="Instance"
					bind:value={addInstanceId}
				>
					{#each instanceState.instances as instance}
						<option value={instance.id}>{instance.name}</option>
					{/each}
				</Select>
			{/if}
			{#if addError}
				<span class="text-sm text-error">{addError}</span>
			{/if}
			<div class="flex items-center gap-1.5 justify-end">
				<Button
					variant="ghost"
					size="content"
					class="text-sm px-1.5 py-0.5 rounded"
					onclick={handleCancelAdd}
				>
					Cancel
				</Button>
				<Button
					variant="accent-soft"
					size="content"
					class="text-sm font-medium px-1.5 py-0.5 rounded"
					disabled={adding}
					onclick={handleSubmitAdd}
				>
					{adding ? "Adding..." : "Add"}
				</Button>
			</div>
		</div>
	{:else}
		<!-- Add project button -->
		<div class="py-1">
			<Button
				variant="toolbar"
				size="content"
				align="start"
				class={"w-full gap-2 px-3 py-2 text-xs duration-150" +
					(navigable ? "" : " min-h-[44px] md:min-h-0")}
				onclick={handleShowAddForm}
			>
				<Icon name="plus" size={13} />
				<span>Add project</span>
			</Button>
		</div>
	{/if}
</div>

{#if ctxMenuProject && ctxMenuAnchor}
	<ProjectContextMenu
		project={ctxMenuProject}
		anchor={ctxMenuAnchor}
		onrename={handleCtxRename}
		ondelete={handleCtxDelete}
		onclose={handleCloseContextMenu}
	/>
{/if}
