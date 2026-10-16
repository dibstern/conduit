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

	const chat = $derived(
		sessionId === undefined ? currentChat() : sessionMessages.get(sessionId),
	);
	// A failed page stops paging this chat rather than retrying every frame.
	let failedChat = $state<typeof chat>();
	const canPage = $derived(
		!!chat?.historyHasMore && !chat.historyLoading && failedChat !== chat,
	);

	// An observer reports once on creation, then only on changes. A page that
	// leaves the sentinel in view would produce no further report, so a fresh
	// observer is made each time a page settles and paging can continue.
	$effect(() => {
		if (!canPage || !sentinelEl || (sessionId !== undefined && !scrollRoot))
			return undefined;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) loadMore();
			},
			{ root: scrollRoot ?? null, rootMargin: "200px" },
		);
		observer.observe(sentinelEl);
		return () => observer.disconnect();
	});

	function loadMore() {
		const id = sessionId ?? placedSessionId();
		const pagedChat = chat;
		if (!id || !canPage) return;
		void loadOlderTranscript(id).catch(() => {
			failedChat = pagedChat;
		});
	}
</script>

<!-- Headless — no template output -->
