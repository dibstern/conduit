<!-- ─── ProjectSwitcher ──────────────────────────────────────────────────────── -->
<!-- Button with "Projects" label, current project name, count badge, and       -->
<!-- chevron. Always clickable — dropdown shows project list with indicator     -->
<!-- dots and an "Add project" footer. Navigates to /p/{slug}/ on selection.   -->

<script lang="ts">
	import { onMount, onDestroy } from "svelte";
	import type { ProjectInfo } from "../../types.js";
	import { ADD_PROJECT_TIMEOUT_MS } from "../../ui-constants.js";
	import { navigate } from "../../stores/router.svelte.js";
	import { onProject } from "../../stores/ws.svelte.js";
	import { closeMobileSidebar } from "../../stores/ui.svelte.js";
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
	import Icon from "../ui/Icon.svelte";
	import Badge from "../ui/Badge.svelte";
	import Button from "../ui/Button.svelte";
	import TextInput from "../ui/TextInput.svelte";
	import Select from "../ui/Select.svelte";
	import { dismiss } from "../../actions/use-dismiss.svelte.js";
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
				open = false;
			})
			.catch(() => {
				window.clearTimeout(timeout);
				adding = false;
				addError = "No response from server — please try again";
			});
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
			const projectSlug = getRpcProjectSlug(slug);
			if (projectSlug == null) return;
			void removeProjectRpc({ projectSlug, slug }).then(
				applyProjectMutationResponse,
			).catch(() => undefined);
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

<!-- `flex flex-col` so the trigger below, which ui/Button renders as an
     inline-flex <button>, is a flex ITEM rather than an inline-level box on a
     line box -- otherwise line-height adds a few px of descender space under
     it. The absolutely-positioned dropdown and context menu are out of flow, so
     this does not reach them. -->
<div
	class="proj-switcher relative flex flex-col"
	use:dismiss={{
		onDismiss: () => {
			if (document.getElementById("confirm-modal")) return;
			open = false;
			showAddForm = false;
			addError = "";
		},
	}}
>
	<!-- Was a <div onclick> carrying two svelte-ignore comments: not reachable
	     by keyboard at all, and silent about the dropdown it opens. `toolbar` is
	     the variant whose recipe this already was, down to the 4% overlay hover
	     fill (conduit-test-de3.35.6).

	     `justify-between` is deliberately NOT passed here even though that is
	     the layout. Tailwind emits colliding properties in its own order and
	     `.justify-center`, which Button's BASE_CLASSES sets, is emitted AFTER
	     `.justify-between` in the built stylesheet -- the override would lose
	     silently. `flex-1` on the name block pushes the chevron right instead,
	     which needs no precedence at all. (`justify-start` and `justify-end`
	     happen to be emitted after and DO win; do not generalise from them.) -->
	<Button
		id="project-switcher-btn"
		variant="toolbar"
		size="content"
		class="w-full gap-2 rounded-lg px-2 py-1.5 duration-150 font-brand"
		aria-haspopup="true"
		aria-expanded={open}
		aria-controls={open ? "project-switcher-dropdown" : undefined}
		onclick={toggleDropdown}
	>
		<div class="flex-1 flex flex-col min-w-0 text-left">
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
					<span class="sr-only">{currentProject?.directory ?? ""}</span>
				</span>
				{#if countLabel}
					<Badge variant="accent" size="sm" shape="pill">{countLabel}</Badge>
				{/if}
			</div>
		</div>
		<span
			class={"shrink-0 text-text-dimmer transition-transform duration-200" +
				(open ? " rotate-180" : "")}
		>
			<Icon name="chevron-down" size={14} />
		</span>
	</Button>

	<!-- Dropdown menu -->
	{#if open}
		<div
			id="project-switcher-dropdown"
			class="absolute top-full left-0 right-0 z-[var(--z-dropdown)] mt-0.5 min-w-[240px] max-w-[320px] bg-bg-surface border border-border rounded-panel shadow-dropdown p-1 overflow-hidden font-brand"
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
							title={project.directory}
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
						<!-- Name and directory -->
						<div class="flex-1 min-w-0 flex flex-col">
								{#if isRenaming}
									<TextInput
										size="sm"
										class="min-w-0 font-brand"
										autofocus
										aria-label="Rename project"
										bind:value={renameValue}
										onkeydown={(e) => handleRenameKeydown(e, project.slug)}
										onblur={() => commitProjectRename(project.slug)}
										onclick={(e) => { e.preventDefault(); e.stopPropagation(); }}
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
								<span
									class="shrink-0 text-xs text-text-dimmer tabular-nums"
								>
									{project.clientCount}
								</span>
							{/if}
							<!-- `proj-more-btn` is kept as a plain hook: two e2e specs
							     locate this control by it. -->
							<Button
								variant="toolbar"
								size="content"
								iconOnly
								icon="ellipsis"
								iconSize={13}
								ariaLabel="More options"
								class="proj-more-btn shrink-0 w-5 h-5 rounded duration-100"
								title="More options"
								onclick={(e) => {
									e.preventDefault();
									e.stopPropagation();
									handleProjectContextMenu(project, e.currentTarget as HTMLElement);
								}}
							/>
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
						title={project.directory}
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
						<!-- Name and directory -->
						<div class="flex-1 min-w-0 flex flex-col">
								{#if isRenaming}
									<TextInput
										size="sm"
										class="min-w-0 font-brand"
										autofocus
										aria-label="Rename project"
										bind:value={renameValue}
										onkeydown={(e) => handleRenameKeydown(e, project.slug)}
										onblur={() => commitProjectRename(project.slug)}
										onclick={(e) => { e.preventDefault(); e.stopPropagation(); }}
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
								<span
									class="shrink-0 text-xs text-text-dimmer tabular-nums"
								>
									{project.clientCount}
								</span>
							{/if}
							<!-- `proj-more-btn` is kept as a plain hook: two e2e specs
							     locate this control by it. -->
							<Button
								variant="toolbar"
								size="content"
								iconOnly
								icon="ellipsis"
								iconSize={13}
								ariaLabel="More options"
								class="proj-more-btn shrink-0 w-5 h-5 rounded duration-100"
								title="More options"
								onclick={(e) => {
									e.preventDefault();
									e.stopPropagation();
									handleProjectContextMenu(project, e.currentTarget as HTMLElement);
								}}
							/>
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
							<!-- `sm` to match the DirectoryAutocomplete field directly
							     above it; the two were a size apart before. -->
							<Select
								name="instance"
								id="instance-selector"
								size="sm"
								aria-label="Instance"
								bind:value={addInstanceId}
							>
								{#each instanceState.instances as inst}
									<option value={inst.id}>{inst.name}</option>
								{/each}
							</Select>
						{/if}
						{#if addError}
							<span class="text-sm text-error">{addError}</span>
						{/if}
						<div class="flex items-center gap-1.5 justify-end">
							<!-- Both were <span onclick>. A project could not be added
							     from the keyboard at all (conduit-test-de3.35.6). -->
							<Button
								variant="ghost"
								size="content"
								class="text-sm px-1.5 py-0.5 rounded"
								onclick={handleCancelAdd}
							>
								Cancel
							</Button>
							<!-- `disabled` rather than the old `class:opacity-50`: the
							     dimming was decorative, so a second click while a slow
							     add was in flight sent a second request. -->
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
						<!-- `justify-start` DOES override Button's base `justify-center`
						     (it is emitted later in the built stylesheet). Unlike
						     `justify-between` on the trigger above -- same rule, opposite
						     outcome, which is why both are verified rather than reasoned
						     about. -->
						<Button
							variant="toolbar"
							size="content"
							class="w-full justify-start gap-2 px-3 py-2 text-xs duration-150"
							onclick={handleShowAddForm}
						>
							<Icon name="plus" size={13} />
							<span>Add project</span>
						</Button>
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
