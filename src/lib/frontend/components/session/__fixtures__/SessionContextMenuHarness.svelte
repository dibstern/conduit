<script lang="ts">
	import type { SessionInfo, ToastCard } from "../../../types.js";
	import SessionContextMenu from "../SessionContextMenu.svelte";
	import SnoozePickerHost from "../SnoozePickerHost.svelte";
	import Toast from "../../overlays/Toast.svelte";
	import { snoozePicker } from "../../../stores/snooze-picker.svelte.js";
	import Button from "../../ui/Button.svelte";
	import { chromeMenuActions } from "../../layout/chrome-actions.js";
	import { featureFlags } from "../../../stores/feature-flags.svelte.js";
	import { showToast, uiState } from "../../../stores/ui.svelte.js";
	import { untrack } from "svelte";
	import { wsDebugState } from "../../../stores/ws-debug.svelte.js";

	let { session, projectLabel, branch, presentation = "menu", selectable = false, withFooter = false, debug = false, now = Date.now(), initialToasts = [] }: { session: SessionInfo; projectLabel?: string; branch?: string; presentation?: "menu" | "sheet"; selectable?: boolean; withFooter?: boolean; debug?: boolean; now?: number; initialToasts?: readonly ToastCard[] } = $props();
	$effect(() => {
		const previous = untrack(() => featureFlags.debug);
		featureFlags.debug = debug;
		wsDebugState.panelOpen = false;
		const toasts = initialToasts;
		untrack(() => {
			uiState.toasts = [];
			for (const toast of toasts) showToast(toast);
		});
		return () => { featureFlags.debug = previous; wsDebugState.panelOpen = false; uiState.toasts = []; snoozePicker.session = null; };
	});

	/**
	 * A real element, not a `getBoundingClientRect` stub. Since
	 * the menu is positioned by floating-ui through
	 * bits-ui's `customAnchor`, which needs a live node to measure and to
	 * collide against — a stub returning only `bottom`/`right` silently
	 * produced a menu pinned to the top-left corner.
	 */
	let anchor: HTMLButtonElement | HTMLAnchorElement | undefined = $state();
</script>

<div class="flex h-40 items-start justify-end p-4">
	<Button
		bind:element={anchor}
		variant="ghost"
		size="sm"
		ariaLabel="Session actions"
	>
		…
	</Button>
</div>

<SnoozePickerHost />
<Toast />

{#if anchor}
	<SessionContextMenu
		{session}
		{anchor}
		{projectLabel}
		{branch}
		{presentation}
		{now}
		host={{ rename: () => {}, ...(selectable ? { select: () => {} } : {}) }}
		extras={withFooter ? chromeMenuActions().map((action) => ({ ...action, testId: `overflow-${action.id}` })) : []}
		onclose={() => {}}
	/>
{/if}
