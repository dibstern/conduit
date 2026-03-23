<!-- ─── ProjectSwitcher ──────────────────────────────────────────────────────── -->
<!-- Button with "Projects" label, current project name, count badge, and       -->
<!-- chevron. Always clickable — dropdown shows project list with indicator     -->
<!-- dots and an "Add project" footer. Navigates to /p/{slug}/ on selection.   -->

<script lang="ts">
	import { onMount, onDestroy } from "svelte";
	import type { ProjectInfo } from "../../types.js";
	import { ADD_PROJECT_TIMEOUT_MS } from "../../ui-constants.js";
	import { navigate } from "../../stores/router.svelte.js";
	import { wsSend } from "../../stores/ws.svelte.js";
	import { onProject } from "../../stores/ws.svelte.js";
	import { closeMobileSidebar } from "../../stores/ui.svelte.js";
	import {
		instanceState,
		getInstanceById,
		getHealthyInstances,
		instanceStatusColor,
	} from "../../stores/instance.svelte.js";
	import Icon from "../shared/Icon.svelte";
	import { clickOutside } from "../shared/use-click-outside.svelte.js";
	import DirectoryAutocomplete from "./DirectoryAutocomplete.svelte";
	import ProjectContextMenu from "./ProjectContextMenu.svelte";
	import { confirm } from "../../stores/ui.svelte.js";

	// ─── Props ──────────────────────────────────────────────────────────────────

	let {
		projects,
		currentSlug,
	}: {
		projects: ProjectInfo[];
		currentSlug: string | null;
	} = $props();

	// ─── Local state ────────────────────────────────────────────────────────────

	let open = $state(false);
	let showAddForm = $state(false);
	let addDirectory = $state("");
	let addError = $state("");
	let adding = $state(false);
	let addInstanceId = $state("");

	// ─── Context menu state ───────────────────────────────────────────────────
	let ctxMenuProject: ProjectInfo | null = $state(null);
	let ctxMenuAnchor: HTMLElement | null = $state(null);
	let renamingSlug: string | null = $state(null);
	let renameValue = $state("");

	// ─── Derived ────────────────────────────────────────────────────────────────

	const currentProject = $derived(
		projects.find((p) => p.slug === currentSlug) ?? projects[0] ?? null,
	);

	const displayName = $derived(currentProject?.title ?? "No Project");

	const countLabel = $derived.by(() => {
		const n = projects.length;
		if (n === 0) return "";
		return `${n} project${n === 1 ? "" : "s"}`;
	});

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

	// ─── Handlers ───────────────────────────────────────────────────────────────

	function toggleDropdown() {
		open = !open;
		if (!open) {
			showAddForm = false;
			addError = "";
		}
	}

	function selectProject(e: MouseEvent, slug: string) {
		// Modifier keys (Cmd/Ctrl+click) trigger onclick but should use native
		// browser behavior (open in new tab). Middle-click and right-click don't
		// fire onclick at all — they're handled by the browser natively via href.
		if (e.metaKey || e.ctrlKey) return;
		e.preventDefault();
		open = false;
		showAddForm = false;
		closeMobileSidebar();
		navigate(`/p/${slug}/`);
	}

	function handleShowAddForm() {
		showAddForm = true;
		addDirectory = "";
		addError = "";
		// Default to first healthy instance
		const healthy = getHealthyInstances();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		addInstanceId = healthy.length > 0 ? healthy[0]!.id : (instanceState.instances[0]?.id ?? "");
	}

	function handleCancelAdd() {
		showAddForm = false;
		addDirectory = "";
		addError = "";
	}

	function handleSubmitAdd() {
		const dir = addDirectory.trim();
		if (!dir) {
			addError = "Directory path is required";
			return;
		}
		adding = true;
		addError = "";
		const msg: Record<string, unknown> = { type: "add_project", directory: dir };
		if (addInstanceId) {
			msg["instanceId"] = addInstanceId;
		}
		wsSend(msg);
		// The server responds with a project_list containing addedSlug,
		// which triggers auto-navigation in the project store.
		// The project listener below resets local form state on response.
		// Safety timeout: if the server never responds, reset the adding state.
		setTimeout(() => {
			if (adding) {
				adding = false;
				addError = "No response from server — please try again";
			}
		}, ADD_PROJECT_TIMEOUT_MS);
	}

	function handleProjectContextMenu(project: ProjectInfo, anchor: HTMLElement) {
		ctxMenuProject = project;
		ctxMenuAnchor = anchor;
	}

	function handleCloseContextMenu() {
		ctxMenuProject = null;
		ctxMenuAnchor = null;
	}

	function handleCtxRename(slug: string) {
		renamingSlug = slug;
		const proj = projects.find((p) => p.slug === slug);
		renameValue = proj?.title ?? slug;
	}

	async function handleCtxDelete(slug: string, title: string) {
		const confirmed = await confirm(
			`Remove project '${title}' from conduit?`,
			"Remove",
		);
		if (confirmed) {
			wsSend({ type: "remove_project", slug });
		}
	}

	function commitProjectRename(slug: string) {
		// Guard: if renamingSlug was already cleared (e.g. by Escape),
		// the blur handler may still fire — skip to avoid double-send.
		if (renamingSlug !== slug) return;
		const newTitle = renameValue.trim();
		renamingSlug = null;
		if (newTitle && newTitle.length > 0) {
			const proj = projects.find((p) => p.slug === slug);
			if (proj && newTitle !== proj.title) {
				wsSend({ type: "rename_project", slug, title: newTitle });
			}
		}
	}

	function cancelProjectRename() {
		renamingSlug = null;
	}

	function handleRenameKeydown(e: KeyboardEvent, slug: string) {
		if (e.key === "Enter") {
			e.preventDefault();
			e.stopPropagation();
			commitProjectRename(slug);
		} else if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			cancelProjectRename();
		}
	}

	function focusOnMount(node: HTMLElement) {
		node.focus();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === "Escape") {
			if (showAddForm) {
				e.preventDefault();
				handleCancelAdd();
			} else if (open) {
				e.preventDefault();
				open = false;
			}
		}
	}


	// ─── Lifecycle ──────────────────────────────────────────────────────────────

	let unsubProject: (() => void) | undefined;

	onMount(() => {
		document.addEventListener("keydown", handleKeydown);

		// Listen for project_list responses to reset add form state.
		// Navigation is handled by the project store (addedSlug → navigate).
		unsubProject = onProject((msg) => {
			if (msg.type === "project_list" && adding) {
				adding = false;
				showAddForm = false;
				addDirectory = "";
				open = false;
			}
		});
	});

	onDestroy(() => {
		document.removeEventListener("keydown", handleKeydown);
		unsubProject?.();
	});
</script>

<div class="proj-switcher relative" use:clickOutside={() => { if (document.getElementById("confirm-modal")) return; open = false; showAddForm = false; addError = ""; }}>
	<!-- Main button — always rendered -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		id="project-switcher-btn"
		class="flex items-center justify-between gap-2 cursor-pointer rounded-lg px-2 py-1.5 hover:bg-[rgba(var(--overlay-rgb),0.04)] transition-colors duration-150 font-brand"
		onclick={toggleDropdown}
	>
		<div class="flex flex-col min-w-0">
			<span
				class="text-sm font-semibold uppercase tracking-[0.5px] text-text-dimmer leading-tight"
				>Projects</span
			>
			<div class="flex items-center gap-1.5 min-w-0">
				<span
					class="text-sm font-semibold text-text truncate max-w-[180px]"
					title={currentProject?.directory ?? ""}
				>
					{displayName}
				</span>
				{#if countLabel}
					<span
						class="shrink-0 text-sm font-bold px-2 py-[1px] rounded-[10px] bg-accent/15 text-accent leading-normal"
					>
						{countLabel}
					</span>
				{/if}
			</div>
		</div>
		<span
			class={"shrink-0 text-text-dimmer transition-transform duration-200" +
				(open ? " rotate-180" : "")}
		>
			<Icon name="chevron-down" size={14} />
		</span>
	</div>

	<!-- Dropdown menu -->
	{#if open}
		<div
			class="absolute top-full left-0 right-0 z-[120] mt-0.5 min-w-[240px] max-w-[320px] bg-bg-surface border border-border rounded-[10px] shadow-[0_8px_32px_rgba(0,0,0,0.3)] p-1 overflow-hidden font-brand"
			data-testid="project-switcher-dropdown"
		>
			<!-- Header -->
			<div
				class="px-3 pt-2 pb-1.5 text-sm font-semibold uppercase tracking-[0.5px] text-text-dimmer"
			>
				Projects
			</div>

			<!-- Project list -->
			<div class="max-h-[280px] overflow-y-auto">
				{#if hasMultipleInstances}
					{#each [...projectsByInstance] as [instanceId, instanceProjects] (instanceId)}
						{@const instance = instanceId !== "_default" ? getInstanceById(instanceId) : undefined}
						<!-- Instance group header -->
						<div
							class="flex items-center gap-1.5 px-3 pt-2 pb-1 text-xs font-semibold uppercase tracking-[0.5px] text-text-dimmer"
							data-testid="instance-group-header"
						>
							<span
								class={"w-1.5 h-1.5 rounded-full shrink-0 " +
									instanceStatusColor(instance?.status)}
								data-testid="instance-status-dot"
							></span>
							<span class="truncate">{instance?.name ?? "Default"}</span>
						</div>
						{#each instanceProjects as project (project.slug)}
						{@const isActive = project.slug === currentSlug}
						{@const isRenaming = renamingSlug === project.slug}
						<a
							href="/p/{project.slug}/"
							data-testid="project-item"
							data-slug={project.slug}
					class={"group/proj flex items-center gap-2.5 px-3 py-2.5 cursor-pointer transition-colors duration-100 hover:bg-[rgba(var(--overlay-rgb),0.04)] rounded-md no-underline text-inherit visited:text-inherit" +
							(isActive
								? " bg-bg-surface"
								: "")}
						style={isActive ? "box-shadow: inset 3px 0 0 var(--color-brand-a), inset 3px 0 12px rgba(255,45,123,0.1);" : ""}
						onclick={(e) => {
							if (isRenaming) { e.preventDefault(); return; }
							selectProject(e, project.slug);
						}}
					>
						<!-- Indicator dot -->
						<span
							class={"w-1.5 h-1.5 rounded-full shrink-0" +
								(isActive ? " bg-accent" : " bg-text-dimmer/40")}
						></span>
						<!-- Name -->
						{#if isRenaming}
							<input
								type="text"
								class="flex-1 min-w-0 bg-input-bg border border-accent rounded py-px px-1 text-xs text-text outline-none font-brand"
								bind:value={renameValue}
								onkeydown={(e) => handleRenameKeydown(e, project.slug)}
								onblur={() => commitProjectRename(project.slug)}
								onclick={(e) => { e.preventDefault(); e.stopPropagation(); }}
								use:focusOnMount
							/>
						{:else}
							<span
								class={"flex-1 text-base truncate" +
									(isActive
										? " font-semibold text-text"
										: " text-text-secondary")}
							>
								{project.title}
							</span>
						{/if}
						{#if !isRenaming}
							<!-- Client count -->
							{#if project.clientCount && project.clientCount > 0}
								<span
									class="shrink-0 text-xs text-text-dimmer tabular-nums"
								>
									{project.clientCount}
								</span>
							{/if}
							<button
								class="proj-more-btn shrink-0 w-5 h-5 border-none rounded p-0 bg-transparent cursor-pointer flex items-center justify-center text-text-dimmer hover:text-text hover:bg-bg-alt transition-colors duration-100"
								title="More options"
								onclick={(e) => {
									e.preventDefault();
									e.stopPropagation();
									handleProjectContextMenu(project, e.currentTarget as HTMLElement);
								}}
							>
								<Icon name="ellipsis" size={13} />
							</button>
						{/if}
					</a>
				{/each}
				{/each}
			{:else}
				{#each projects as project (project.slug)}
					{@const isActive = project.slug === currentSlug}
					{@const isRenaming = renamingSlug === project.slug}
					<a
						href="/p/{project.slug}/"
						data-testid="project-item"
						data-slug={project.slug}
					class={"group/proj flex items-center gap-2.5 px-3 py-2.5 cursor-pointer transition-colors duration-100 hover:bg-[rgba(var(--overlay-rgb),0.04)] rounded-md no-underline text-inherit visited:text-inherit" +
						(isActive
							? " bg-bg-surface"
							: "")}
						style={isActive ? "box-shadow: inset 3px 0 0 var(--color-brand-a), inset 3px 0 12px rgba(255,45,123,0.1);" : ""}
						onclick={(e) => {
							if (isRenaming) { e.preventDefault(); return; }
							selectProject(e, project.slug);
						}}
					>
						<!-- Indicator dot -->
						<span
							class={"w-1.5 h-1.5 rounded-full shrink-0" +
								(isActive ? " bg-accent" : " bg-text-dimmer/40")}
						></span>
						<!-- Name -->
						{#if isRenaming}
							<input
								type="text"
								class="flex-1 min-w-0 bg-input-bg border border-accent rounded py-px px-1 text-xs text-text outline-none font-brand"
								bind:value={renameValue}
								onkeydown={(e) => handleRenameKeydown(e, project.slug)}
								onblur={() => commitProjectRename(project.slug)}
								onclick={(e) => { e.preventDefault(); e.stopPropagation(); }}
								use:focusOnMount
							/>
						{:else}
							<span
								class={"flex-1 text-base truncate" +
									(isActive
										? " font-semibold text-text"
										: " text-text-secondary")}
							>
								{project.title}
							</span>
						{/if}
						{#if !isRenaming}
							<!-- Client count -->
							{#if project.clientCount && project.clientCount > 0}
								<span
									class="shrink-0 text-xs text-text-dimmer tabular-nums"
								>
									{project.clientCount}
								</span>
							{/if}
							<button
								class="proj-more-btn shrink-0 w-5 h-5 border-none rounded p-0 bg-transparent cursor-pointer flex items-center justify-center text-text-dimmer hover:text-text hover:bg-bg-alt transition-colors duration-100"
								title="More options"
								onclick={(e) => {
									e.preventDefault();
									e.stopPropagation();
									handleProjectContextMenu(project, e.currentTarget as HTMLElement);
								}}
							>
								<Icon name="ellipsis" size={13} />
							</button>
						{/if}
					</a>
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
							<select
								name="instance"
								id="instance-selector"
								class="w-full bg-input-bg border border-border rounded-md py-1.5 px-2 text-base text-text outline-none focus:border-accent"
								bind:value={addInstanceId}
							>
								{#each instanceState.instances as inst}
									<option value={inst.id}>{inst.name}</option>
								{/each}
							</select>
						{/if}
						{#if addError}
							<span class="text-sm text-error">{addError}</span>
						{/if}
						<div class="flex items-center gap-1.5 justify-end">
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<span
								class="text-sm text-text-dimmer cursor-pointer hover:text-text-secondary px-1.5 py-0.5"
								onclick={handleCancelAdd}
							>
								Cancel
							</span>
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<span
								class="text-sm font-medium text-accent cursor-pointer hover:text-accent/80 px-1.5 py-0.5 rounded bg-accent/10 hover:bg-accent/15 transition-colors"
								class:opacity-50={adding}
								onclick={handleSubmitAdd}
							>
								{adding ? "Adding..." : "Add"}
							</span>
						</div>
					</div>
				{:else}
					<!-- Add project button -->
					<div class="py-1">
						<!-- svelte-ignore a11y_click_events_have_key_events -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div
							class="flex items-center gap-2 w-full px-3 py-2 text-xs text-text-muted cursor-pointer transition-colors duration-150 hover:bg-[rgba(var(--overlay-rgb),0.04)] hover:text-text-secondary"
							onclick={handleShowAddForm}
						>
							<Icon name="plus" size={13} />
							<span>Add project</span>
						</div>
					</div>
				{/if}
			</div>
		</div>
	{/if}

	{#if ctxMenuProject && ctxMenuAnchor}
		<ProjectContextMenu
			project={ctxMenuProject}
			anchor={ctxMenuAnchor}
			onrename={handleCtxRename}
			ondelete={handleCtxDelete}
			onclose={handleCloseContextMenu}
		/>
	{/if}
</div>
