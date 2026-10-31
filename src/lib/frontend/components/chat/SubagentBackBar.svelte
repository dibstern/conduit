<!-- Context bar above the input box for subagents. Side Threads share its return path. -->
<!-- Shows parent session title and a "← Parent" button to navigate back. -->

<script module lang="ts">
	import { findSession, sessionAttention, sessionState } from "../../stores/session.svelte.js";
	import { selection } from "../../stores/selection.svelte.js";
	import { returnFromTask } from "../session/background-tasks.svelte.js";
	import { ATTENTION_DISPLAY } from "../session/SessionItem.svelte";

	export function getParentSessionContext() {
		const id = sessionState.currentParentId;
		const session = id ? findSession(id) : undefined;
		const status = session ? sessionAttention(session) : "idle";
		return { id, title: session?.title ?? "parent session", status, label: ATTENTION_DISPLAY[status].spoken || "Idle" };
	}

	export function navigateBackToParent(): boolean {
		const parentId = sessionState.currentParentId;
		if (!parentId) return false;
		// A task opened from the pull-down or a launching row goes back there.
		if (!returnFromTask()) {
			selection.open(parentId);
		}
		return true;
	}
</script>

<script lang="ts">
	import Button from "../ui/Button.svelte";
	import SessionStatusGlyph from "../ui/SessionStatusGlyph.svelte";
	import Surface from "../ui/Surface.svelte";

	const activeSession = $derived(findSession(sessionState.currentId ?? ""));
	const parent = $derived(getParentSessionContext());
	const visible = $derived(!!parent.id && !activeSession?.sideThread && !activeSession?.forkMessageId && !activeSession?.forkPointTimestamp && !sessionState.currentFork?.forkMessageId && !sessionState.currentFork?.forkPointTimestamp);

	/** Exposed so the parent can trigger navigation (e.g. via ESC key). */
	export function triggerNavigateBack(): boolean {
		return navigateBackToParent();
	}
</script>

{#if visible}
	<div class="subagent-back-bar mb-1.5">
		<Surface variant="card" radius="panel" class="flex items-center gap-2 py-1.5 px-3.5 max-md:gap-1.5 max-md:py-1 max-md:px-3">
			<span class="w-1.5 h-1.5 rounded-full bg-success shrink-0"></span>
			<span class="flex-1 min-w-0 text-sm font-mono text-text-muted truncate max-md:text-xs">
				Subagent of{" "}<strong class="text-text-secondary font-semibold">{parent.title}</strong>
			</span>
			<span data-testid="parent-session-status" aria-label="Parent {parent.label}" class="flex items-center gap-1.5 shrink-0 text-xs font-mono text-text-muted">
				<SessionStatusGlyph attention={parent.status} size={12} />
				{parent.label}
			</span>
			<Button
				variant="capsule-primary"
				size="content"
				hoverFill="none"
				touchTarget
				type="button"
				class="subagent-back-btn h-[28px] gap-[6px] rounded-full px-[12px] text-[13px] font-medium"
				onclick={navigateBackToParent}
				title="Back to {parent.title}"
			>
				<span class="text-base leading-none">&#8592;</span>
				Parent
				<kbd class="hidden md:inline font-mono text-mono-time font-normal text-text-dimmer">Esc</kbd>
			</Button>
		</Surface>
	</div>
{/if}
