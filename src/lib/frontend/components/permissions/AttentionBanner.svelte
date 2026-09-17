<!-- ─── Attention Banner ───────────────────────────────────────────── -->
<!-- Cross-session attention banner for permissions and questions in OTHER    -->
<!-- sessions. Shows session count + clickable session titles. Fixed top-right.-->
<!-- Dismiss button hides until new remote items arrive.                       -->

<script lang="ts">
	import { getAttentionSessions, dispatch } from "../../stores/notification-reducer.svelte.js";
	import { getDescendantSessionIds, getRemotePermissions } from "../../stores/permissions.svelte.js";
	import { findSession, sessionState, switchToSession } from "../../stores/session.svelte.js";
	import { wsSend } from "../../stores/ws.svelte.js";
	import Surface from "../ui/Surface.svelte";
	import Button from "../ui/Button.svelte";
	import TextButton from "../ui/TextButton.svelte";

	const remotePermissions = $derived(getRemotePermissions(sessionState.currentId));
	const attentionSessions = $derived(getAttentionSessions(sessionState.currentId, getDescendantSessionIds));

	/** Merge permissions and reducer attention into a unified session → labels map. */
	const sessionGroups = $derived.by(() => {
		const groups = new Map<string, { permissions: number; questions: number }>();

		for (const perm of remotePermissions) {
			const entry = groups.get(perm.sessionId) ?? { permissions: 0, questions: 0 };
			entry.permissions++;
			groups.set(perm.sessionId, entry);
		}

		for (const [sid, counts] of attentionSessions) {
			const entry = groups.get(sid) ?? { permissions: 0, questions: 0 };
			entry.questions = counts.questions;
			// Merge permission counts from reducer (server-reconciled) with local permissions
			entry.permissions = Math.max(entry.permissions, counts.permissions);
			groups.set(sid, entry);
		}

		return groups;
	});

	const sessionCount = $derived(sessionGroups.size);
	const hasRemote = $derived(sessionGroups.size > 0);

	/** Track dismissed state — resets when new items arrive. */
	let dismissed = $state(false);
	let lastSeenCount = $state(0);

	$effect(() => {
		if (sessionCount > lastSeenCount) {
			dismissed = false;
		}
		lastSeenCount = sessionCount;
	});

	const visible = $derived(hasRemote && !dismissed);

	function getSessionTitle(sessionId: string): string {
		const session = findSession(sessionId);
		return session?.title ?? `${sessionId.slice(0, 8)}\u2026`;
	}

	function itemLabel(entry: { permissions: number; questions: number }): string {
		const parts: string[] = [];
		if (entry.permissions > 0) parts.push(`${entry.permissions} permission${entry.permissions > 1 ? "s" : ""}`);
		if (entry.questions > 0) parts.push(`${entry.questions} question${entry.questions > 1 ? "s" : ""}`);
		return parts.join(", ");
	}

	function goToSession(sessionId: string) {
		// Mark session as viewed in the reducer, then switch to it.
		dispatch({ type: "session_viewed", sessionId });
		switchToSession(sessionId);
	}

	function dismiss() {
		dismissed = true;
	}
</script>

{#if visible}
	<div
		class="pointer-events-auto permission-notification-enter"
		role="status"
		aria-live="polite"
	>
		<Surface variant="raised" radius="lg" class="p-3 shadow-lg">
			<div class="flex items-start justify-between gap-2 mb-2">
				<div class="text-base font-medium text-text">
					{sessionCount === 1 ? "1 session" : `${sessionCount} sessions`} need{sessionCount === 1 ? "s" : ""} attention
				</div>
				<Button
					variant="ghost"
					size="content"
					tone="secondary"
					hoverFill="none"
					class="shrink-0 p-0.5 -m-0.5 rounded"
					onclick={dismiss}
					ariaLabel="Dismiss notification"
				>
					<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
						<path d="M3.5 3.5L10.5 10.5M10.5 3.5L3.5 10.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
					</svg>
				</Button>
			</div>
			<div class="flex flex-col gap-1.5">
				{#each [...sessionGroups] as [sessionId, entry] (sessionId)}
					<TextButton
						tone="accent" underline="hover" class="text-left text-xs truncate px-1 py-0.5 rounded transition-colors"
						onclick={() => goToSession(sessionId)}
					>
						{getSessionTitle(sessionId)} ({itemLabel(entry)})
					</TextButton>
				{/each}
			</div>
		</Surface>
	</div>
{/if}

<style>
	.permission-notification-enter {
		animation: slideInRight 200ms ease-out both;
	}

	@keyframes slideInRight {
		from {
			opacity: 0;
			transform: translateX(16px);
		}
		to {
			opacity: 1;
			transform: translateX(0);
		}
	}
</style>
