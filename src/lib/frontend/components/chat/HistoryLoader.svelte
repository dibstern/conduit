<!-- ─── History Loader ─────────────────────────────────────────────────────── -->
<!-- Headless component: owns IntersectionObserver for infinite scroll up. -->
<!-- Sends load_more_history requests; responses are handled by ws-dispatch -->
<!-- which converts and prepends into chatState.messages. -->
<!-- Renders nothing — all messages are rendered by MessageList's {#each}. -->

<script lang="ts">
	import { onMount, onDestroy } from "svelte";
	import {
		consumeReplayBuffer,
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
		const buffer = getReplayBuffer(sessionId);
		if (buffer && buffer.length > 0) {
			const page = consumeReplayBuffer(sessionId, HISTORY_PAGE_SIZE);
			prependMessages(page);
			// hasMore: true if buffer still has messages, false otherwise.
			// When the buffer is exhausted, the server has no additional
			// history to offer (the replay already covered the full session).
			const remaining = getReplayBuffer(sessionId);
			historyState.hasMore =
				remaining !== undefined && remaining.length > 0;
			return;
		}

		// Fall through to server request when no buffer is available.
		historyState.loading = true;
		// offset = number of REST-level messages already loaded (tracked by ws-dispatch)
		wsSend({
			type: "load_more_history",
			sessionId,
			offset: historyState.messageCount,
		});
	}
</script>

<!-- Headless — no template output -->
