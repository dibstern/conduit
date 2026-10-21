<!-- Headless component: owns the IntersectionObserver for infinite scroll down -->
<!-- in the session sidebar. Mirrors chat/HistoryLoader.svelte, which does the  -->
<!-- same job for scroll-up in the transcript.                                  -->
<!-- Renders nothing — the rows are rendered by SessionList's {#each}.          -->

<script lang="ts">
	import { onDestroy, onMount } from "svelte";
	import { browsePage, currentSearchQuery, sessionList } from "../../stores/session-list.svelte.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { sessionState } from "../../stores/session.svelte.js";

	let {
		sentinelEl,
		hasMore,
	}: {
		sentinelEl?: HTMLElement;
		hasMore: boolean;
	} = $props();

	let observer: IntersectionObserver | null = null;

	onMount(() => {
		if (!sentinelEl) return;
		observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) loadMore();
				}
			},
			// Ask one screen early so the next page is usually already in place by
			// the time the sentinel would have been reached.
			{ rootMargin: "200px" },
		);
		observer.observe(sentinelEl);
	});

	// The observer reports only changes. A page that leaves the sentinel on
	// screen (few rows, or most of them in a collapsed shelf) would never ask
	// for the next one, so re-observe whenever the visible limit or cursor moves.
	// That re-reports whether the sentinel is still in view.
	$effect(() => {
		void hasMore;
		void browsePage.limit;
		void sessionState.searchCursor;
		if (!observer || !sentinelEl) return;
		observer.unobserve(sentinelEl);
		observer.observe(sentinelEl);
	});

	onDestroy(() => {
		observer?.disconnect();
	});

	// Search asks the server for another page; browse reveals rows already held.
	function loadMore() {
		if (!hasMore) return;
		const query = currentSearchQuery();
		if (query !== null) {
			void query.loadMore();
			return;
		}
		void sessionList.loadMore(getCurrentSlug() ?? "");
	}
</script>
