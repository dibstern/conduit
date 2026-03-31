<!-- ─── Subagent Context Bar ──────────────────────────────────────────────────── -->
<!-- Standalone context bar above the input box when viewing a subagent session. -->
<!-- Shows parent session title and a "← PARENT" button to navigate back. -->

<script lang="ts">
	import { wsSend } from "../../stores/ws.svelte.js";
	import { findSession, sessionState } from "../../stores/session.svelte.js";

	// Find the active session and check if it has a parent
	const activeSession = $derived(findSession(sessionState.currentId ?? ""));

	const parentId = $derived(activeSession?.parentID ?? null);

	const parentSession = $derived(parentId ? findSession(parentId) : null);

	const parentTitle = $derived(
		parentSession?.title ?? "parent session"
	);

	// Show for subagent sessions (parentID but no forkMessageId).
	// Hide for user forks (parentID + forkMessageId) — they get the fork divider instead.
	const visible = $derived(!!parentId && !activeSession?.forkMessageId && !activeSession?.forkPointTimestamp);

	function navigateBack() {
		if (parentId) {
			wsSend({ type: "switch_session", sessionId: parentId });
		}
	}

	/** Exposed so the parent can trigger navigation (e.g. via ESC key). */
	export function triggerNavigateBack(): boolean {
		if (parentId) {
			navigateBack();
			return true;
		}
		return false;
	}
</script>

{#if visible}
	<div class="subagent-back-bar mb-1.5">
		<div class="flex items-center gap-2 py-1.5 px-3.5 bg-bg-surface border border-border rounded-[10px] max-md:gap-1.5 max-md:py-1 max-md:px-3">
			<span class="w-1.5 h-1.5 rounded-full bg-brand-b shrink-0"></span>
			<span class="flex-1 min-w-0 text-sm font-mono text-text-muted truncate max-md:text-xs">
				Subagent of <strong class="text-text-secondary font-semibold">{parentTitle}</strong>
			</span>
			<button
				type="button"
				class="subagent-back-btn inline-flex items-center gap-1 py-0.5 px-2.5 rounded border-none bg-brand-a text-white font-mono text-sm font-semibold cursor-pointer whitespace-nowrap transition-opacity duration-150 tracking-wide hover:opacity-85 max-md:text-xs max-md:px-2"
				onclick={navigateBack}
				title="Back to {parentTitle}"
			>
				<span class="text-base leading-none">&#8592;</span>
				PARENT
				<span class="hidden md:inline-flex items-center py-px px-1 rounded-sm bg-white/20 text-xs font-bold tracking-wider ml-0.5">ESC</span>
			</button>
		</div>
	</div>
{/if}
