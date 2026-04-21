<!-- ─── History Loader ─────────────────────────────────────────────────────── -->
<!-- Headless component: owns IntersectionObserver for infinite scroll up. -->
<!-- Sends load_more_history requests; responses are handled by ws-dispatch -->
<!-- which converts and prepends into chatState.messages. -->
<!-- Renders nothing — all messages are rendered by MessageList's {#each}. -->

<script lang="ts">
	import { onMount, onDestroy } from "svelte";
	import {
		consumeReplayBuffer,
		getOrCreateSessionSlot,
		getReplayBuffer,
		historyState,
		prependMessages,
	} from "../../stores/chat.svelte.js";
	import { sessionState } from "../../stores/session.svelte.js";
	import { wsSend } from "../../stores/ws.svelte.js";

	const HISTORY_PAGE_SIZE = 50;

	let {
		sentinelEl,
	}: {
		sentinelEl?: HTMLElement;
	} = $props();

	let observer: IntersectionObserver | null = null;

	onMount(() => {
		if (sentinelEl) {
			observer = new IntersectionObserver(
				(entries) => {
					for (const entry of entries) {
						if (
							entry.isIntersecting &&
							historyState.hasMore &&
							!historyState.loading
						) {
							loadMore();
						}
					}
				},
				{ rootMargin: "200px" },
			);
			observer.observe(sentinelEl);
		}
	});

	onDestroy(() => {
		observer?.disconnect();
	});

	function loadMore() {
		if (
			!sessionState.currentId ||
			historyState.loading ||
			!historyState.hasMore
		)
			return;

		// Buffer-first: consume from replay buffer before hitting the server.
		// After replay paging (commitReplayFinal), older messages may be in
		// a local buffer — reading from it is instant (no network round-trip).
		const sessionId = sessionState.currentId;
		const slot = getOrCreateSessionSlot(sessionId);
		const buffer = getReplayBuffer(slot.activity, slot.messages, sessionId);
		if (buffer && buffer.length > 0) {
			const page = consumeReplayBuffer(slot.activity, slot.messages, sessionId, HISTORY_PAGE_SIZE);
			prependMessages(slot.activity, slot.messages, page);
			const remaining = getReplayBuffer(slot.activity, slot.messages, sessionId);
			if (remaining !== undefined && remaining.length > 0) {
				// Buffer still has messages — keep paging locally.
				return;
			}
			// Buffer exhausted — always ask the server whether older messages
			// exist. The event cache may not cover the full session (eviction
			// at MAX_EVENTS, relay started after session creation, missed SSE
			// events, etc.). The server is the source of truth: it will return
			// { messages: [], hasMore: false } when this truly is the beginning.
			// Ensure offset > 0 so the server uses cursor-based pagination
			// rather than returning the most recent page (already displayed).
			if (historyState.messageCount === 0) {
				historyState.messageCount = 1;
			}
		}

		// Server request for older messages.
		historyState.loading = true;
		// offset = number of messages already loaded (tracked by ws-dispatch).
		// For cache→server transitions, messageCount was seeded above.
		wsSend({
			type: "load_more_history",
			sessionId,
			offset: historyState.messageCount,
		});
	}
</script>

<!-- Headless — no template output -->
