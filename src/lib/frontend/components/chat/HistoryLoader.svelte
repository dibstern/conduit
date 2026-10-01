<!-- Headless component: owns IntersectionObserver for infinite scroll up. -->
<!-- Pages older projected rows through the transcript module. -->
<!-- Renders nothing — all messages are rendered by MessageList's {#each}. -->

<script lang="ts">
	import { onMount, onDestroy } from "svelte";
	import { currentChat } from "../../stores/chat.svelte.js";
	import { sessionState } from "../../stores/session.svelte.js";
	import { loadOlderTranscript } from "../../stores/transcript.svelte.js";

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
							currentChat().historyHasMore &&
							!currentChat().historyLoading
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
		const chat = currentChat();
		if (
			!sessionState.currentId ||
			chat.historyLoading ||
			!chat.historyHasMore
		)
			return;

		void loadOlderTranscript(sessionState.currentId).catch(() => undefined);
	}
</script>

<!-- Headless — no template output -->
