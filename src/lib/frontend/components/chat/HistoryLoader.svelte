<!-- Headless component: owns IntersectionObserver for infinite scroll up. -->
<!-- Pages older projected rows through the transcript module. -->
<!-- Renders nothing — all messages are rendered by MessageList's {#each}. -->

<script lang="ts">
	import { currentChat, sessionMessages } from "../../stores/chat.svelte.js";
	import { loadOlderTranscript, placedSessionId } from "../../stores/transcript.svelte.js";

	let {
		sentinelEl,
		sessionId,
		scrollRoot,
	}: {
		sentinelEl?: HTMLElement | undefined;
		sessionId?: string | undefined;
		scrollRoot?: HTMLElement | undefined;
	} = $props();

	$effect(() => {
		if (sentinelEl && (sessionId === undefined || scrollRoot)) {
			const observer = new IntersectionObserver(
				(entries) => {
					for (const entry of entries) {
						if (entry.isIntersecting) {
							loadMore();
						}
					}
				},
				{ root: scrollRoot ?? null, rootMargin: "200px" },
			);
			observer.observe(sentinelEl);
			return () => observer.disconnect();
		}
		return undefined;
	});

	function loadMore() {
		const id = sessionId ?? placedSessionId();
		const chat = sessionId === undefined
			? currentChat()
			: sessionMessages.get(sessionId);
		if (
			!id ||
			!chat ||
			chat.historyLoading ||
			!chat.historyHasMore
		)
			return;

		void loadOlderTranscript(id).catch(() => undefined);
	}
</script>

<!-- Headless — no template output -->
