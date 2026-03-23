<!-- ─── Header ──────────────────────────────────────────────────────────────── -->
<!-- Fixed header bar with project name, status indicators, and action buttons. -->
<!-- Settings, notification, and terminal buttons live in the sidebar footer. -->

<script lang="ts">
	import Icon from "../shared/Icon.svelte";
	import {
		uiState,
		toggleSidebar,
		expandSidebar,
		openMobileSidebar,
		togglePanel,
	} from "../../stores/ui.svelte.js";
	import { wsState, wsSend } from "../../stores/ws.svelte.js";
	import { togglePanel as toggleTerminalPanel } from "../../stores/terminal.svelte.js";
	import { getCurrentSlug, navigate } from "../../stores/router.svelte.js";
	import { projectState } from "../../stores/project.svelte.js";
	import {
		instanceState,
		getInstanceById,
		instanceStatusColor,
	} from "../../stores/instance.svelte.js";
	import { featureFlags } from "../../stores/feature-flags.svelte.js";

	// ─── Derived state ─────────────────────────────────────────────────────────

	const statusTitle = $derived(wsState.statusText || "Connecting");
	const statusClass = $derived.by(() => {
		switch (wsState.status) {
			case "connected":
				return "bg-success";
			case "processing":
				return "bg-success animate-[pulse-dot_1.2s_ease-in-out_infinite]";
			case "error":
				return "bg-error";
			case "disconnected":
			case "":
				return "bg-text-muted";
		}
	});
	const showClientBadge = $derived(uiState.clientCount > 1);

	const currentInstance = $derived.by(() => {
		if (instanceState.instances.length <= 1) return undefined;
		const slug = getCurrentSlug();
		const project = slug
			? projectState.projects.find((p) => p.slug === slug)
			: undefined;
		if (project?.instanceId) {
			return getInstanceById(project.instanceId);
		}
		return undefined;
	});

	// ─── Local state ──────────────────────────────────────────────────────────

	let instanceSelectorOpen = $state(false);

	// ─── Handlers ──────────────────────────────────────────────────────────────

	function handleHamburger() {
		openMobileSidebar();
	}

	function handleExpandSidebar() {
		expandSidebar();
	}

	function handleQrShare() {
		window.dispatchEvent(new CustomEvent("qr:show"));
	}

	function handleToggleUsage() {
		togglePanel("usage-panel");
	}

	function handleToggleInstanceSelector() {
		instanceSelectorOpen = !instanceSelectorOpen;
	}

	function handleSelectInstance(instanceId: string) {
		instanceSelectorOpen = false;
		// Rebind the current project to the selected instance
		const slug = getCurrentSlug();
		if (slug) {
			wsSend({ type: "set_project_instance", slug, instanceId });
		}
	}

	function handleManageInstances() {
		instanceSelectorOpen = false;
		window.dispatchEvent(new CustomEvent("settings:open", { detail: { tab: "instances" } }));
	}
</script>

<div
	id="header"
	class="flex items-center justify-between px-5 py-3 min-h-[48px] shrink-0 gap-2"
>
	<!-- Left section: hamburger/expand + project name (scrollable on mobile) -->
	<div id="header-left" class="flex items-center gap-2 min-w-0 flex-1">
		<button
			id="sidebar-expand-btn"
			class="header-icon-btn"
			class:hidden={!uiState.sidebarCollapsed}
			title="Open sidebar"
			onclick={handleExpandSidebar}
		>
			<Icon name="panel-left-open" size={15} />
		</button>
		<button
			id="hamburger-btn"
			class="header-icon-btn hidden"
			title="Menu"
			onclick={handleHamburger}
		>
			<Icon name="menu" size={15} />
		</button>
		<div id="header-project-scroll" class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap max-md:flex max-md:items-center">
			<div class="flex items-center gap-2 whitespace-nowrap">
			<h1 id="project-name" class="text-lg font-semibold tracking-[0.08em] font-brand">
				<span class="header-project-inner inline-block pr-[3em]">{getCurrentSlug() ?? "conduit"}</span>
			</h1>
				{#if currentInstance}
					<div class="relative">
						<button
							class="inline-flex items-center gap-1 ml-1 px-1.5 py-0.5 rounded text-xs font-medium text-text-muted bg-black/[0.06] hover:bg-black/[0.1] cursor-pointer"
							title="{currentInstance.name} ({currentInstance.status})"
							data-testid="instance-badge"
							onclick={handleToggleInstanceSelector}
						>
							<span
								class={"w-1.5 h-1.5 rounded-full shrink-0 " +
									instanceStatusColor(currentInstance.status)}
								data-testid="instance-status-dot"
							></span>
							{currentInstance.name}
						</button>
						{#if instanceSelectorOpen}
							<div
								id="instance-selector-dropdown"
								class="absolute top-full left-0 mt-1 min-w-[180px] rounded-md border border-border bg-bg shadow-lg z-50 py-1 text-xs"
							>
								{#each instanceState.instances as inst}
									<button
										class="flex items-center gap-2 w-full px-3 py-1.5 text-left hover:bg-black/[0.06] text-text"
										onclick={() => handleSelectInstance(inst.id)}
									>
										<span
											class={"w-1.5 h-1.5 rounded-full shrink-0 " +
												instanceStatusColor(inst.status)}
											data-testid="instance-status-dot"
										></span>
										{inst.name}
									</button>
								{/each}
								<div class="border-t border-border mt-1 pt-1">
									<button
										class="w-full px-3 py-1.5 text-left text-text-muted hover:bg-black/[0.06]"
										onclick={handleManageInstances}
									>
										Manage Instances
									</button>
								</div>
							</div>
						{/if}
					</div>
				{/if}
			</div>
		</div>
	</div>

	<!-- Right section: share, badges, status -->
	<div
		id="header-right"
		class="flex items-center gap-1.5 shrink-0 text-xs text-text-muted"
	>
		<!-- Session select (hidden, managed by sidebar in vanilla — kept for compat) -->
		<select
			id="session-select"
			style="display:none;position:absolute;pointer-events:none"
			title="Switch session"
		></select>

		<!-- Debug panel toggle (visible when debug feature flag is on) -->
		{#if featureFlags.debug}
			<div id="debug-menu-wrap">
				<button
					id="debug-btn"
					class="header-icon-btn"
					title="Toggle debug panel"
					onclick={() => window.dispatchEvent(new CustomEvent("debug:toggle"))}
				>
					<Icon name="bug" size={15} />
				</button>
			</div>
		{/if}

		<!-- Terminal -->
		<button
			id="header-terminal-btn"
			class="header-icon-btn"
			title="Toggle terminal"
			onclick={() => toggleTerminalPanel(wsSend)}
		>
			<Icon name="square-terminal" size={15} />
		</button>

		<!-- Settings -->
		<button
			id="header-settings-btn"
			class="header-icon-btn"
			title="Settings"
			onclick={() => window.dispatchEvent(new CustomEvent("settings:open"))}
		>
			<Icon name="settings" size={15} />
		</button>

		<!-- QR share button -->
		<button
			id="qr-btn"
			class="header-icon-btn"
			title="Share"
			onclick={handleQrShare}
		>
			<Icon name="share" size={15} />
		</button>

		<!-- Client count badge -->
		<span
			id="client-count-badge"
			class="client-count-badge inline-flex items-center justify-center min-w-[18px] h-[18px] px-[5px] rounded-[9px] bg-accent text-bg text-xs font-semibold leading-none shrink-0"
			class:hidden={!showClientBadge}
		>
			{uiState.clientCount}
		</span>

		<!-- Status dot -->
		<span
			id="status"
			class="status-dot w-[7px] h-[7px] rounded-full shrink-0 {statusClass}"
			title={statusTitle}
		></span>
	</div>
</div>
