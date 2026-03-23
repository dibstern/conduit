<!-- ─── History Loader ─────────────────────────────────────────────────────── -->
<!-- Headless component: owns IntersectionObserver for infinite scroll up. -->
<!-- Sends load_more_history requests; responses are handled by ws-dispatch -->
<!-- which converts and prepends into chatState.messages. -->
<!-- Renders nothing — all messages are rendered by MessageList's {#each}. -->

<script lang="ts">
	import { onMount, onDestroy } from "svelte";
	import { historyState } from "../../stores/chat.svelte.js";
	import { sessionState } from "../../stores/session.svelte.js";
	import { wsSend } from "../../stores/ws.svelte.js";

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
		historyState.loading = true;
		// offset = number of REST-level messages already loaded (tracked by ws-dispatch)
		wsSend({
			type: "load_more_history",
			sessionId: sessionState.currentId,
			offset: historyState.messageCount,
		});
	}
</script>

<!-- Headless — no template output -->
