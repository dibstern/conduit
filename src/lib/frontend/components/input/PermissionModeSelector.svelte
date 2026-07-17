<!-- ─── Permission Mode (Approvals) Picker ───────────────────────────────── -->
<!-- Pill + dropdown for the session's approval mode: Ask / Edits / All.     -->
<!-- Amber tint when not "ask" so an auto-approving session is visibly so.   -->

<script lang="ts">
	import Icon from "../shared/Icon.svelte";
	import { clickOutside } from "../shared/use-click-outside.svelte.js";
	import { discoveryState } from "../../stores/discovery.svelte.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { sessionState } from "../../stores/session.svelte.js";
	import { switchPermissionModeRpc } from "../../transport/ws-rpc-client.js";
	import type { SessionPermissionMode } from "../../types.js";

	const MODES: ReadonlyArray<{
		mode: SessionPermissionMode;
		label: string;
	}> = [
		{ mode: "ask", label: "Ask" },
		{ mode: "acceptEdits", label: "Edits" },
		{ mode: "auto", label: "All" },
	];

	// ─── State ──────────────────────────────────────────────────────────────

	let dropdownOpen = $state(false);

	// ─── Derived ────────────────────────────────────────────────────────────

	const currentMode = $derived(discoveryState.permissionMode);
	const currentLabel = $derived(
		MODES.find((m) => m.mode === currentMode)?.label ?? "Ask",
	);
	/** Non-default mode: auto-approval is active, tint the pill. */
	const isElevated = $derived(currentMode !== "ask");

	// ─── Handlers ───────────────────────────────────────────────────────────

	function toggleDropdown(e: MouseEvent) {
		e.stopPropagation();
		dropdownOpen = !dropdownOpen;
	}

	function selectMode(mode: SessionPermissionMode, e: MouseEvent) {
		e.stopPropagation();
		dropdownOpen = false;
		if (mode === discoveryState.permissionMode) return;
		const previousMode = discoveryState.permissionMode;
		discoveryState.permissionMode = mode;
		const projectSlug = getCurrentSlug();
		const sessionId = sessionState.currentId;
		if (projectSlug && sessionId) {
			void switchPermissionModeRpc({ projectSlug, sessionId, mode }).catch(
				() => {
					if (discoveryState.permissionMode === mode) {
						discoveryState.permissionMode = previousMode;
					}
				},
			);
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === "Escape" && dropdownOpen) dropdownOpen = false;
	}

	$effect(() => {
		document.addEventListener("keydown", handleKeydown);
		return () => document.removeEventListener("keydown", handleKeydown);
	});
</script>

<div class="relative" use:clickOutside={() => { dropdownOpen = false; }}>
	<button
		data-testid="permission-mode-badge"
		class="inline-flex items-center gap-1 h-6 px-2 ml-0.5 border text-xs font-medium cursor-pointer whitespace-nowrap rounded-full transition-colors duration-100 font-brand {isElevated
			? 'border-warning/30 bg-warning-bg text-warning'
			: 'border-border bg-bg-alt text-text-muted hover:bg-bg hover:text-text-secondary'}"
		title="Approvals ({currentLabel})"
		onclick={toggleDropdown}
	>
		{currentLabel}
		<Icon name="chevron-down" size={8} class="shrink-0 opacity-50" />
	</button>

	{#if dropdownOpen}
		<div
			data-testid="permission-mode-dropdown"
			class="absolute bottom-[calc(100%+4px)] right-0 w-40 bg-bg-alt border border-border rounded-lg shadow-[0_-4px_16px_rgba(var(--shadow-rgb),0.3)] z-[210] py-1 font-brand"
		>
			{#each MODES as { mode, label } (mode)}
				<button
					data-testid="permission-mode-option-{mode}"
					class="flex items-center gap-2 w-full py-1.5 px-3 border-none bg-transparent text-text text-base text-left cursor-pointer transition-colors duration-100 hover:bg-bg {currentMode === mode ? 'text-accent' : ''}"
					onclick={(e) => selectMode(mode, e)}
				>
					{#if currentMode === mode}
						<span class="text-accent font-bold text-xs">&#10003;</span>
					{:else}
						<span class="w-[10px]"></span>
					{/if}
					{label}
				</button>
			{/each}
		</div>
	{/if}
</div>
