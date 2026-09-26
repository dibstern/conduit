<!-- ─── ProjectSwitcher ──────────────────────────────────────────────────────── -->
<!-- Button with "Projects" label, current project name, count badge, and       -->
<!-- chevron. Always clickable — dropdown shows project list with indicator     -->
<!-- dots and an "Add project" footer. Selects a project hint on the list. -->

<script lang="ts">
	import type { ProjectInfo } from "../../types.js";
	import { navigate } from "../../stores/router.svelte.js";
	import { dismiss } from "../../actions/use-dismiss.svelte.js";
	import Badge from "../ui/Badge.svelte";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import Surface from "../ui/Surface.svelte";
	import ProjectManagerPanel from "./ProjectManagerPanel.svelte";

	let {
		projects,
		currentSlug,
	}: {
		projects: ProjectInfo[];
		currentSlug: string | null;
	} = $props();

	let open = $state(false);
	let panelContextMenuOpen = $state(false);

	const currentProject = $derived(
		projects.find((project) => project.slug === currentSlug) ??
			projects[0] ??
			null,
	);

	const displayName = $derived(currentProject?.title ?? "No Project");

	const countLabel = $derived.by(() => {
		const count = projects.length;
		if (count === 0) return "";
		return `${count} project${count === 1 ? "" : "s"}`;
	});

	function toggleDropdown() {
		open = !open;
	}

	function selectProject(slug: string) {
		open = false;
		navigate(`/?${new URLSearchParams({ p: slug })}`);
	}

</script>

<!-- `flex flex-col` so the trigger below, which ui/Button renders as an
     inline-flex <button>, is a flex ITEM rather than an inline-level box on a
     line box -- otherwise line-height adds a few px of descender space under
     it. The absolutely-positioned dropdown and context menu are out of flow, so
     this does not reach them. -->
<div
	class="proj-switcher relative flex flex-col"
	use:dismiss={{
		// Disabled while the per-project context menu is up. That menu is
		// ui/Menu since conduit-test-de3.35.9.3, which portals to <body>, so
		// clicking one of its items reads as an outside click here and used to
		// close the whole switcher out from under the row the click was acting
		// on -- "Rename" opened the rename field in a panel that had just
		// unmounted. The menu owns dismissal while it is open and clears the
		// panel context state on close, which re-arms this.
		enabled: !panelContextMenuOpen,
		escape: false,
		onDismiss: () => {
			if (document.getElementById("confirm-modal")) return;
			open = false;
		},
	}}
>
	<!-- Was a <div onclick> carrying two svelte-ignore comments: not reachable
	     by keyboard at all, and silent about the dropdown it opens. `toolbar` is
	     the variant whose recipe this already was, down to the 4% overlay hover
	     fill (conduit-test-de3.35.6).

	     `flex-1` on the name block is what pushes the chevron right, not a
	     `justify-between` on the button. That began as a workaround: Button used
	     to hard-code `justify-center` in BASE_CLASSES, and `.justify-between` is
	     emitted BEFORE `.justify-center` in the built stylesheet, so passing it
	     would have lost silently. `align="between"` would work now
	     (conduit-test-ixfu), but `flex-1` already leaves no free space for it to
	     distribute, so changing it would be churn for an identical render. -->
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
					<Badge variant="accent" size="sm" shape="pill"
						>{countLabel}</Badge
					>
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
		<Surface
			variant="card"
			radius="panel"
			elevation="dropdown"
			id="project-switcher-dropdown"
			data-testid="project-switcher-dropdown"
			class="absolute top-full left-0 right-0 z-[var(--z-dropdown)] mt-0.5 min-w-[240px] max-w-[320px] p-1 overflow-hidden font-brand"
		>
			<ProjectManagerPanel
				{projects}
				currentSlug={currentSlug ?? undefined}
				navigable
				onnavigate={selectProject}
				onclose={() => { open = false; }}
				oncontextmenuopenchange={(nextOpen) => { panelContextMenuOpen = nextOpen; }}
			/>
		</Surface>
	{/if}
</div>
