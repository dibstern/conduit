<!-- ─── Permission Notification ───────────────────────────────────────────── -->
<!-- Aggregated notification for permission requests in OTHER sessions.        -->
<!-- Shows session count + clickable session titles. Fixed top-right.          -->
<!-- Dismiss button hides until new remote permissions arrive.                 -->

<script lang="ts">
	import { getRemotePermissions } from "../../stores/permissions.svelte.js";
	import { findSession, sessionState, switchToSession } from "../../stores/session.svelte.js";
	import { wsSend } from "../../stores/ws.svelte.js";

	const remotePermissions = $derived(getRemotePermissions(sessionState.currentId));

	/** Group remote permissions by sessionId → count per session. */
	const sessionGroups = $derived.by(() => {
		const groups = new Map<string, number>();
		for (const perm of remotePermissions) {
			groups.set(perm.sessionId, (groups.get(perm.sessionId) ?? 0) + 1);
		}
		return groups;
	});

	const sessionCount = $derived(sessionGroups.size);
	const hasRemote = $derived(remotePermissions.length > 0);

	/** Track dismissed state — resets when new remote permissions arrive. */
	let dismissed = $state(false);
	let lastSeenCount = $state(0);

	// Reset dismissed when the set of remote permissions changes
	$effect(() => {
		const count = remotePermissions.length;
		if (count > lastSeenCount) {
			dismissed = false;
		}
		lastSeenCount = count;
	});

	const visible = $derived(hasRemote && !dismissed);

	function getSessionTitle(sessionId: string): string {
		const session = findSession(sessionId);
		return session?.title ?? `${sessionId.slice(0, 8)}\u2026`;
	}

	function goToSession(sessionId: string) {
		switchToSession(sessionId, wsSend);
	}

	function dismiss() {
		dismissed = true;
	}
</script>

{#if visible}
	<div
		class="fixed top-16 right-4 z-[350] max-w-[320px] permission-notification-enter"
		role="status"
		aria-live="polite"
	>
		<div class="bg-bg-alt border border-border rounded-xl p-3 shadow-lg">
			<div class="flex items-start justify-between gap-2 mb-2">
				<div class="text-base font-medium text-text">
					{sessionCount === 1 ? "1 session" : `${sessionCount} sessions`} need{sessionCount === 1 ? "s" : ""} permission
				</div>
				<button
					class="shrink-0 text-text-secondary hover:text-text cursor-pointer p-0.5 -m-0.5 rounded transition-colors"
					onclick={dismiss}
					aria-label="Dismiss notification"
				>
					<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
						<path d="M3.5 3.5L10.5 10.5M10.5 3.5L3.5 10.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
					</svg>
				</button>
			</div>
			<div class="flex flex-col gap-1.5">
				{#each [...sessionGroups] as [sessionId, count] (sessionId)}
					<button
						class="text-left text-xs text-accent hover:text-accent/80 hover:underline cursor-pointer truncate px-1 py-0.5 rounded transition-colors"
						onclick={() => goToSession(sessionId)}
					>
						{getSessionTitle(sessionId)}{count > 1 ? ` (${count})` : ""}
					</button>
				{/each}
			</div>
		</div>
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
