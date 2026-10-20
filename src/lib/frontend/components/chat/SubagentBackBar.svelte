<!-- Context bar above the input box for subagents and Side Threads. -->
<!-- Shows parent session title and a "← Parent" button to navigate back. -->

<script lang="ts">
	import Button from "../ui/Button.svelte";
	import { findSession, isSessionBusy, sessionState } from "../../stores/session.svelte.js";
	import { selection } from "../../stores/selection.svelte.js";
	import DitherGlyph from "../ui/DitherGlyph.svelte";
	import Surface from "../ui/Surface.svelte";
	import { returnFromTask } from "../session/background-tasks.svelte.js";

	// Find the active session and check if it has a parent
	const activeSession = $derived(findSession(sessionState.currentId ?? ""));

	const parentId = $derived(sessionState.currentParentId);

	const parentSession = $derived(parentId ? findSession(parentId) : null);
	// Matches the sidebar: a parent whose turn is over but whose background agents or shells run reads as monitoring, not idle.
	const parentStatus = $derived(
		!parentId
			? "idle"
			: isSessionBusy(parentId) || parentSession?.processing === true || parentSession?.backgroundWork === "working"
				? "working"
				: parentSession?.backgroundWork === "monitoring"
					? "monitoring"
					: "idle",
	);

	const parentTitle = $derived(
		parentSession?.title ?? "parent session"
	);

	const visible = $derived(!!parentId && (activeSession?.sideThread || (!activeSession?.forkMessageId && !activeSession?.forkPointTimestamp && !sessionState.currentFork?.forkMessageId && !sessionState.currentFork?.forkPointTimestamp)));

	function navigateBack() {
		// A task opened from the pull-down or a launching row goes back there.
		if (parentId && !returnFromTask()) {
			selection.open(parentId);
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
		<Surface variant="card" radius="panel" class="flex items-center gap-2 py-1.5 px-3.5 max-md:gap-1.5 max-md:py-1 max-md:px-3">
			<span class="w-1.5 h-1.5 rounded-full bg-success shrink-0"></span>
			<span class="flex-1 min-w-0 text-sm font-mono text-text-muted truncate max-md:text-xs">
				{activeSession?.sideThread ? "Side Thread" : "Subagent"} of <strong class="text-text-secondary font-semibold">{parentTitle}</strong>
			</span>
			<span data-testid="parent-session-status" aria-label="Parent {parentStatus}" class="flex items-center gap-1.5 shrink-0 text-xs font-mono text-text-muted">
				<DitherGlyph state={parentStatus} size={12} />
				{parentStatus === "working" ? "Working" : parentStatus === "monitoring" ? "Monitoring" : "Idle"}
			</span>
			<Button
				variant="capsule-primary"
				size="content"
				hoverFill="none"
				touchTarget
				type="button"
				class="subagent-back-btn h-[28px] gap-[6px] rounded-full px-[12px] text-[13px] font-medium"
				onclick={navigateBack}
				title="Back to {parentTitle}"
			>
				<span class="text-base leading-none">&#8592;</span>
				Parent
				<kbd class="hidden md:inline font-mono text-mono-time font-normal text-text-dimmer">Esc</kbd>
			</Button>
		</Surface>
	</div>
{/if}
