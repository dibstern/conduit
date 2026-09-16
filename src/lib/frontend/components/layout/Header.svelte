<!-- ─── Header ──────────────────────────────────────────────────────────────── -->
<!-- Fixed header bar with project name, status indicators, and action buttons. -->
<!-- Settings, notification, and terminal buttons live in the sidebar footer. -->

<script lang="ts">
	import Icon from "../ui/Icon.svelte";
	import Badge from "../ui/Badge.svelte";
	import Button from "../ui/Button.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuItem from "../ui/MenuItem.svelte";
	import MenuRadioGroup from "../ui/MenuRadioGroup.svelte";
	import MenuRadioItem from "../ui/MenuRadioItem.svelte";
	import MenuSeparator from "../ui/MenuSeparator.svelte";

	// The box only; ui/Button `toolbar` owns the colours and the 4% hover fill.
	// A 23px square (4px padding around a 15px glyph at the 12px root), which is
	// deliberately NOT SessionList's 18px -- see Button.svelte::toolbar.
	const HEADER_ICON_BOX =
		"p-[4px] rounded-lg border border-transparent hover:border-border shrink-0";
	import {
		uiState,
		toggleSidebar,
		expandSidebar,
		openMobileSidebar,
		togglePanel,
	} from "../../stores/ui.svelte.js";
	import { wsState } from "../../stores/ws.svelte.js";
	import { beginCreateTab, failCreateTab, terminalState, togglePanel as toggleTerminalPanel } from "../../stores/terminal.svelte.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { getBrowserClientId } from "../../stores/client-identity.js";
	import {
		applyProjectMutationResponse,
		projectState,
	} from "../../stores/project.svelte.js";
	import { createPtyRpc, setProjectInstanceRpc } from "../../transport/ws-rpc-client.js";
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
			case "connecting":
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

	function handleSelectInstance(instanceId: string) {
		// Rebind the current project to the selected instance
		const slug = getCurrentSlug();
		if (slug) {
			void setProjectInstanceRpc({
				projectSlug: slug,
				slug,
				instanceId,
			})
				.then(applyProjectMutationResponse)
				.catch(() => undefined);
		}
	}

	function handleManageInstances() {
		window.dispatchEvent(new CustomEvent("settings:open", { detail: { tab: "instances" } }));
	}

	function requestTerminalCreate() {
		const slug = getCurrentSlug();
		if (!slug || !beginCreateTab()) return;
		void createPtyRpc({
			projectSlug: slug,
			originId: getBrowserClientId(),
		}).catch(() => {
			failCreateTab("Failed to create terminal");
		});
	}

	function handleTerminalToggle() {
		const wasOpen = terminalState.panelOpen;
		toggleTerminalPanel();
		if (!wasOpen && terminalState.tabs.size === 0) {
			requestTerminalCreate();
		}
		// On mobile: maximize terminal so it doesn't clash with chat content
		if (!wasOpen && window.innerWidth <= 768) {
			window.dispatchEvent(new CustomEvent("terminal:mobile-maximize"));
		}
	}
</script>

<div
	id="header"
	class="flex items-center justify-between px-5 py-3 min-h-[48px] shrink-0 gap-2"
>
	<!-- Left section: hamburger/expand + project name (scrollable on mobile) -->
	<div id="header-left" class="flex items-center gap-2 min-w-0 flex-1">
		<!-- `{#if}` rather than `class:hidden`: Button's base sets `inline-flex`,
		     and Tailwind emits display utilities alphabetically, so `.hidden`
		     lands BEFORE `.inline-flex` and loses. The old markup got away with
		     it because `.header-icon-btn` set display from @layer components,
		     which utilities outrank. That class is now gone. -->
		{#if uiState.sidebarCollapsed}
			<Button
				id="sidebar-expand-btn"
				variant="toolbar"
				size="content"
				class={HEADER_ICON_BOX}
				iconOnly
				icon="panel-left-open"
				iconSize={15}
				title="Open sidebar"
				ariaLabel="Open sidebar"
				onclick={handleExpandSidebar}
			/>
		{/if}
		<!-- Visibility is purely viewport-driven and always was: the `hidden`
		     class here only ever mattered until the mobile media query in
		     style.css overrode it. That is now stated once, as a pair of
		     ID rules, instead of split between markup and a media query. -->
		<Button
			id="hamburger-btn"
			variant="toolbar"
			size="content"
			class={HEADER_ICON_BOX}
			iconOnly
			icon="menu"
			iconSize={15}
			title="Menu"
			ariaLabel="Menu"
			onclick={handleHamburger}
		/>
		<div id="header-project-scroll" class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap max-md:flex max-md:items-center">
			<div class="flex items-center gap-2 whitespace-nowrap">
			<h1 id="project-name" class="text-lg font-semibold tracking-[0.08em] font-brand">
				<span class="header-project-inner inline-block pr-[3em]">{getCurrentSlug() ?? "conduit"}</span>
			</h1>
				{#if currentInstance}
					<!-- Was a hand-rolled dropdown: a bare <button> toggling an
					     absolutely-positioned <div> of bare <button>s. It had no
					     aria-expanded, no aria-haspopup, no role, no arrow-key
					     navigation, no Escape, and no dismiss on outside click --
					     the whole menu contract, absent. ui/Menu brings all of it
					     (conduit-test-de3.35.6).

					     MenuRadioGroup rather than plain items because exactly one
					     instance is current, which the old markup knew and never
					     said: the list rendered every instance identically, so the
					     active one was indistinguishable once the badge was covered
					     by the menu itself. -->
					<Menu
						bind:open={instanceSelectorOpen}
						ariaLabel="Select instance"
						align="start"
						data-testid="instance-selector-dropdown"
					>
						{#snippet trigger({ props })}
							<Button
								{...props}
								variant="pill"
								size="content"
								class="ml-1"
								title="{currentInstance.name} ({currentInstance.status})"
								data-testid="instance-badge"
							>
								<span
									class={"w-1.5 h-1.5 rounded-full shrink-0 " +
										instanceStatusColor(currentInstance.status)}
									data-testid="instance-status-dot"
								></span>
								{currentInstance.name}
							</Button>
						{/snippet}

						<MenuRadioGroup value={currentInstance.id}>
							{#each instanceState.instances as inst (inst.id)}
								<MenuRadioItem
									value={inst.id}
									onselect={() => handleSelectInstance(inst.id)}
								>
									<span class="flex items-center gap-2">
										<span
											class={"w-1.5 h-1.5 rounded-full shrink-0 " +
												instanceStatusColor(inst.status)}
											data-testid="instance-status-dot"
										></span>
										{inst.name}
									</span>
								</MenuRadioItem>
							{/each}
						</MenuRadioGroup>

						<MenuSeparator />
						<MenuItem onselect={handleManageInstances}>
							Manage Instances
						</MenuItem>
					</Menu>
				{/if}
			</div>
		</div>
	</div>

	<!-- Right section: share, badges, status -->
	<div
		id="header-right"
		class="flex items-center gap-1.5 shrink-0 text-xs text-text-muted"
	>
		<!-- Debug panel toggle (visible when debug feature flag is on) -->
		{#if featureFlags.debug}
			<div id="debug-menu-wrap">
				<Button
					id="debug-btn"
					variant="toolbar"
					size="content"
					class={HEADER_ICON_BOX}
					iconOnly
					icon="bug"
					iconSize={15}
					title="Toggle debug panel"
					ariaLabel="Toggle debug panel"
					onclick={() => window.dispatchEvent(new CustomEvent("debug:toggle"))}
				/>
			</div>
		{/if}

		<!-- Terminal -->
		<Button
			id="header-terminal-btn"
			variant="toolbar"
			size="content"
			class={HEADER_ICON_BOX}
			iconOnly
			icon="square-terminal"
			iconSize={15}
			title="Toggle terminal"
			ariaLabel="Toggle terminal"
			onclick={handleTerminalToggle}
		/>

		<!-- Settings -->
		<Button
			id="header-settings-btn"
			variant="toolbar"
			size="content"
			class={HEADER_ICON_BOX}
			iconOnly
			icon="settings"
			iconSize={15}
			title="Settings"
			ariaLabel="Settings"
			onclick={() => window.dispatchEvent(new CustomEvent("settings:open"))}
		/>

		<!-- QR share button -->
		<Button
			id="qr-btn"
			variant="toolbar"
			size="content"
			class={HEADER_ICON_BOX}
			iconOnly
			icon="share"
			iconSize={15}
			title="Share"
			ariaLabel="Share"
			onclick={handleQrShare}
		/>

		<!-- Client count badge. `{#if}` rather than `class:hidden`: Tailwind
		     emits .hidden BEFORE .inline-flex, so the utility always lost and
		     needed a style.css rule to win it back. Not rendering wins for
		     free. -->
		{#if showClientBadge}
			<Badge
				id="client-count-badge"
				variant="accent-solid"
				size="count"
				shape="pill">{uiState.clientCount}</Badge>
		{/if}

		<!-- Status dot -->
		<span
			id="status"
			class="status-dot w-[7px] h-[7px] rounded-full shrink-0 {statusClass}"
			title={statusTitle}
			role="status"
		>
			<span class="sr-only">{statusTitle}</span>
		</span>
	</div>
</div>
