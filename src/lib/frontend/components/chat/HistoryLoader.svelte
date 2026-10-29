<!-- Automatically pages older rows only in the latest transcript window. -->
<!-- Pages older projected rows through the transcript module. -->
<!-- Renders nothing — all messages are rendered by MessageList's {#each}. -->

<script lang="ts">
	import { primaryTranscript, type TranscriptView } from "../../stores/transcript.svelte.js";

	let {
		sentinelEl,
		view = primaryTranscript,
		scrollRoot,
	}: {
		sentinelEl?: HTMLElement | undefined;
		view?: TranscriptView;
		scrollRoot?: HTMLElement | undefined;
	} = $props();

	const chat = $derived(view.chat);
	const canPage = $derived(
		view.window.kind === "latest" && view.navigation === null && !!view.sessionId && chat.historyHasMore && !chat.historyLoading && !view.pageError,
	);

	// An observer reports once on creation, then only on changes. A page that
	// leaves the sentinel in view would produce no further report, so a fresh
	// observer is made each time a page settles and paging can continue.
	$effect(() => {
		if (!canPage || !sentinelEl || (view !== primaryTranscript && !scrollRoot))
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
		if (!canPage) return;
		void view.loadOlder().catch(() => { /* The view retains the failure. */ });
	}
</script>

<!-- Headless — no template output -->
