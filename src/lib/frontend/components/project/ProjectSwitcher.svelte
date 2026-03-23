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
	let containerEl: HTMLDivElement | undefined = $state(undefined);

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

	function handleAddKeydown(e: KeyboardEvent) {
		if (e.key === "Enter") {
			e.preventDefault();
			handleSubmitAdd();
		} else if (e.key === "Escape") {
			e.preventDefault();
			handleCancelAdd();
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

	function handleOutsideClick(e: MouseEvent) {
		if (open && containerEl && !containerEl.contains(e.target as Node)) {
			open = false;
			showAddForm = false;
			addError = "";
		}
	}

	// ─── Lifecycle ──────────────────────────────────────────────────────────────

	let unsubProject: (() => void) | undefined;

	onMount(() => {
		document.addEventListener("keydown", handleKeydown);
		document.addEventListener("click", handleOutsideClick, true);

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
		document.removeEventListener("click", handleOutsideClick, true);
		unsubProject?.();
	});
</script>

<div class="proj-switcher relative" bind:this={containerEl}>
	<!-- Main button — always rendered -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		id="project-switcher-btn"
		class="flex items-center justify-between gap-2 cursor-pointer rounded-lg px-2 py-1.5 hover:bg-[rgba(var(--overlay-rgb),0.04)] transition-colors duration-150"
		style="font-family: var(--font-brand);"
		onclick={toggleDropdown}
	>
		<div class="flex flex-col min-w-0">
			<span
				class="text-[11px] font-semibold uppercase tracking-[0.5px] text-text-dimmer leading-tight"
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
						class="shrink-0 text-[11px] font-bold px-2 py-[1px] rounded-[10px] bg-accent/15 text-accent leading-normal"
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
			class="absolute top-full left-0 right-0 z-[120] mt-0.5 min-w-[240px] max-w-[320px] bg-bg-surface border border-border rounded-[10px] shadow-[0_8px_32px_rgba(0,0,0,0.3)] p-1 overflow-hidden"
			style="font-family: var(--font-brand);"
			data-testid="project-switcher-dropdown"
		>
			<!-- Header -->
			<div
				class="px-3 pt-2 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.5px] text-text-dimmer"
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
							class="flex items-center gap-1.5 px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.5px] text-text-dimmer"
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
						<a
							href="/p/{project.slug}/"
							data-testid="project-item"
							data-slug={project.slug}
					class={"flex items-center gap-2.5 px-3 py-2.5 cursor-pointer transition-colors duration-100 hover:bg-[rgba(var(--overlay-rgb),0.04)] rounded-md no-underline text-inherit visited:text-inherit" +
							(isActive
								? " bg-bg-surface"
								: "")}
						style={isActive ? "box-shadow: inset 3px 0 0 var(--color-brand-a), inset 3px 0 12px rgba(255,45,123,0.1);" : ""}
						onclick={(e) => selectProject(e, project.slug)}
					>
						<!-- Indicator dot -->
						<span
							class={"w-1.5 h-1.5 rounded-full shrink-0" +
								(isActive ? " bg-accent" : " bg-text-dimmer/40")}
						></span>
						<!-- Name -->
						<span
							class={"flex-1 text-[13px] truncate" +
								(isActive
									? " font-semibold text-text"
									: " text-text-secondary")}
						>
							{project.title}
						</span>
						<!-- Client count -->
						{#if project.clientCount && project.clientCount > 0}
							<span
								class="shrink-0 text-xs text-text-dimmer tabular-nums"
							>
								{project.clientCount}
							</span>
						{/if}
					</a>
				{/each}
				{/each}
			{:else}
				{#each projects as project (project.slug)}
					{@const isActive = project.slug === currentSlug}
					<a
						href="/p/{project.slug}/"
						data-testid="project-item"
						data-slug={project.slug}
					class={"flex items-center gap-2.5 px-3 py-2.5 cursor-pointer transition-colors duration-100 hover:bg-[rgba(var(--overlay-rgb),0.04)] rounded-md no-underline text-inherit visited:text-inherit" +
						(isActive
							? " bg-bg-surface"
							: "")}
						style={isActive ? "box-shadow: inset 3px 0 0 var(--color-brand-a), inset 3px 0 12px rgba(255,45,123,0.1);" : ""}
						onclick={(e) => selectProject(e, project.slug)}
					>
						<!-- Indicator dot -->
						<span
							class={"w-1.5 h-1.5 rounded-full shrink-0" +
								(isActive ? " bg-accent" : " bg-text-dimmer/40")}
						></span>
						<!-- Name -->
						<span
							class={"flex-1 text-[13px] truncate" +
								(isActive
									? " font-semibold text-text"
									: " text-text-secondary")}
						>
							{project.title}
						</span>
						<!-- Client count -->
						{#if project.clientCount && project.clientCount > 0}
							<span
								class="shrink-0 text-xs text-text-dimmer tabular-nums"
							>
								{project.clientCount}
							</span>
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
						<input
							type="text"
							placeholder="/path/to/project"
							autocomplete="off"
							spellcheck="false"
							class="w-full bg-input-bg border border-border rounded-md py-1.5 px-2 text-[12px] text-text font-mono outline-none focus:border-accent placeholder:text-text-dimmer"
							bind:value={addDirectory}
							onkeydown={handleAddKeydown}
						/>
						{#if hasMultipleInstances}
							<select
								name="instance"
								id="instance-selector"
								class="w-full bg-input-bg border border-border rounded-md py-1.5 px-2 text-[12px] text-text outline-none focus:border-accent"
								bind:value={addInstanceId}
							>
								{#each instanceState.instances as inst}
									<option value={inst.id}>{inst.name}</option>
								{/each}
							</select>
						{/if}
						{#if addError}
							<span class="text-[11px] text-error">{addError}</span>
						{/if}
						<div class="flex items-center gap-1.5 justify-end">
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<span
								class="text-[11px] text-text-dimmer cursor-pointer hover:text-text-secondary px-1.5 py-0.5"
								onclick={handleCancelAdd}
							>
								Cancel
							</span>
							<!-- svelte-ignore a11y_click_events_have_key_events -->
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<span
								class="text-[11px] font-medium text-accent cursor-pointer hover:text-accent/80 px-1.5 py-0.5 rounded bg-accent/10 hover:bg-accent/15 transition-colors"
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
</div>
