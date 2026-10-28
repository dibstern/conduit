<!--
  NotificationStack — the app's notifications: the toast layer, plus one
  toast each time another session starts needing you (a permission or a
  question), with Open to go there.
-->
<script lang="ts">
	import { untrack } from "svelte";
	import { getDescendantSessionIds, getRemotePermissions } from "../../stores/permissions.svelte.js";
	import { findSession, getAttentionSessions, sessionState } from "../../stores/session.svelte.js";
	import { selection } from "../../stores/selection.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import Toast from "./Toast.svelte";

	/** Every session waiting on you, the one you are in included. */
	const waiting = $derived.by(() => {
		const sessions = new Map<string, { permissions: number; questions: number }>();
		for (const { sessionId } of getRemotePermissions(null)) {
			if (sessionId === "") continue;
			const entry = sessions.get(sessionId) ?? { permissions: 0, questions: 0 };
			entry.permissions++;
			sessions.set(sessionId, entry);
		}
		for (const [sessionId, counts] of getAttentionSessions(null, getDescendantSessionIds)) {
			const entry = sessions.get(sessionId) ?? { permissions: 0, questions: 0 };
			// The server's count and the prompts this tab holds are two views of
			// the same thing; take the larger rather than adding them.
			entry.permissions = Math.max(entry.permissions, counts.permissions);
			entry.questions = counts.questions;
			sessions.set(sessionId, entry);
		}
		return sessions;
	});

	// Plain, not $state: only the effect reads it. Null until the session list
	// first settles, so what was already waiting at load never toasts. It
	// tracks the session you are in too, so leaving one that already needed
	// you does not announce it as new.
	let seen: Set<string> | null = null;

	$effect(() => {
		if (!sessionState.settled) return;
		const now = new Set(waiting.keys());
		if (seen !== null) {
			const currentId = sessionState.currentId;
			const here = currentId ? getDescendantSessionIds(currentId).add(currentId) : new Set<string>();
			for (const [sessionId, { permissions, questions }] of waiting) {
				if (seen.has(sessionId) || here.has(sessionId)) continue;
				const title = findSession(sessionId)?.title || "A session";
				const need = permissions > 0 && questions > 0 ? "needs you" : permissions > 0 ? "needs approval" : "has a question";
				untrack(() =>
					showToast({
						title: `${title} ${need}`,
						variant: "attention",
						actions: [{ kind: "primary", label: "Open", run: () => selection.open(sessionId) }],
					}),
				);
			}
		}
		seen = now;
	});
</script>

<Toast />
