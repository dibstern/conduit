<!-- ─── Attention Banner ───────────────────────────────────────────── -->
<!-- Cross-session attention banner for permissions and questions in OTHER    -->
<!-- sessions. Shows session count + clickable session titles. Fixed top-right.-->
<!-- Dismiss button hides until new remote items arrive.                       -->

<script lang="ts">
	import { getRemotePermissions, getRemoteQuestionCount, getRemoteQuestionSessions, removeRemoteQuestion } from "../../stores/permissions.svelte.js";
	import { findSession, sessionState, switchToSession } from "../../stores/session.svelte.js";
	import { wsSend } from "../../stores/ws.svelte.js";

	const remotePermissions = $derived(getRemotePermissions(sessionState.currentId));
	const remoteQuestionSessionIds = $derived(getRemoteQuestionSessions(sessionState.currentId));

	/** Merge permissions and questions into a unified session → labels map. */
	const sessionGroups = $derived.by(() => {
		const groups = new Map<string, { permissions: number; questions: number }>();

		for (const perm of remotePermissions) {
			const entry = groups.get(perm.sessionId) ?? { permissions: 0, questions: 0 };
			entry.permissions++;
			groups.set(perm.sessionId, entry);
		}

		for (const sid of remoteQuestionSessionIds) {
			const entry = groups.get(sid) ?? { permissions: 0, questions: 0 };
			entry.questions = getRemoteQuestionCount(sid);
			groups.set(sid, entry);
		}

		return groups;
	});

	const sessionCount = $derived(sessionGroups.size);
	const totalItems = $derived(remotePermissions.length + remoteQuestionSessionIds.length);
	const hasRemote = $derived(totalItems > 0);

	/** Track dismissed state — resets when new items arrive. */
	let dismissed = $state(false);
	let lastSeenCount = $state(0);

	$effect(() => {
		if (totalItems > lastSeenCount) {
			dismissed = false;
		}
		lastSeenCount = totalItems;
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
		// Remove from remote set — this session is now "local" once we switch.
		removeRemoteQuestion(sessionId);
		switchToSession(sessionId, wsSend);
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
		<div class="bg-bg-alt border border-border rounded-xl p-3 shadow-lg">
			<div class="flex items-start justify-between gap-2 mb-2">
				<div class="text-base font-medium text-text">
					{sessionCount === 1 ? "1 session" : `${sessionCount} sessions`} need{sessionCount === 1 ? "s" : ""} attention
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
				{#each [...sessionGroups] as [sessionId, entry] (sessionId)}
					<button
						class="text-left text-xs text-accent hover:text-accent/80 hover:underline cursor-pointer truncate px-1 py-0.5 rounded transition-colors"
						onclick={() => goToSession(sessionId)}
					>
						{getSessionTitle(sessionId)} ({itemLabel(entry)})
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
