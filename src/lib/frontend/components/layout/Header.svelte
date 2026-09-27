<!-- ─── Header ──────────────────────────────────────────────────────────────── -->
<!-- Fixed header bar with project name, status indicators, and action buttons. -->
<!-- Settings, notification, and terminal buttons live in the sidebar footer. -->

<script lang="ts">
	import Badge from "../ui/Badge.svelte";
	import Button from "../ui/Button.svelte";
	import {
		openSettings,
		shareViaQr,
		toggleDebugPanel,
		toggleTerminal,
	} from "./chrome-actions.js";
	import InstanceBadgeMenu from "./InstanceBadgeMenu.svelte";

	// The box only; ui/Button `toolbar` owns the colours and the 4% hover fill.
	// A 23px square (4px padding around a 15px glyph at the 12px root), which is
	// deliberately NOT SessionList's 18px -- see Button.svelte::toolbar.
	const HEADER_ICON_BOX =
		"p-[4px] rounded-lg border border-transparent hover:border-border shrink-0";
	import {
		uiState,
		toggleSidebar,
		expandSidebar,
		togglePanel,
	} from "../../stores/ui.svelte.js";
	import { wsState } from "../../stores/ws.svelte.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
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

	// ─── Handlers ──────────────────────────────────────────────────────────────

	function handleExpandSidebar() {
		expandSidebar();
	}

	function handleToggleUsage() {
		togglePanel("usage-panel");
	}
</script>

<div
	id="header"
	class="flex items-center justify-between px-5 py-3 min-h-[48px] shrink-0 gap-2"
>
	<!-- Left section: expand + project name -->
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
		<div id="header-project-scroll" class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap max-md:flex max-md:items-center">
			<div class="flex items-center gap-2 whitespace-nowrap">
			<h1 id="project-name" class="text-lg font-semibold tracking-[0.08em] font-brand">
				<span class="header-project-inner inline-block pr-[3em]">{getCurrentSlug() ?? "conduit"}</span>
			</h1>
				<InstanceBadgeMenu class="ml-1" />
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
					onclick={toggleDebugPanel}
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
			onclick={toggleTerminal}
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
			onclick={() => openSettings()}
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
			onclick={shareViaQr}
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
