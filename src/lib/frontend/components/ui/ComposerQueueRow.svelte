<script lang="ts">
	import type { Snippet } from "svelte";
	import type { HTMLLiAttributes } from "svelte/elements";

	let { badge, text, time, actions, ...rest }: {
		badge: Snippet;
		text: Snippet;
		time: Snippet;
		actions: Snippet;
	} & HTMLLiAttributes = $props();
</script>

<li {...rest} class="queue-row">
	<span class="queue-badge">{@render badge()}</span>
	<span class="queue-text">{@render text()}</span>
	<span class="queue-time">{@render time()}</span>
	<span class="queue-actions">{@render actions()}</span>
</li>

<style>
	.queue-row {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto auto;
		align-items: center;
		gap: 8px;
		min-height: 34px;
		padding: 0 2px 0 8px;
		font-size: 13px;
	}

	.queue-text { display: flex; align-items: center; gap: 8px; min-width: 0; }
	.queue-actions { display: flex; align-items: center; gap: 2px; }

	@container composer-strip (max-width: 420px) {
		/* The time spans the flexible column, so the badge column stays badge-wide. */
		.queue-row {
			grid-template-columns: auto minmax(0, 1fr) auto;
			row-gap: 0;
			padding-top: 4px;
			padding-bottom: 4px;
		}
		.queue-text { grid-column: 2 / 4; }
		.queue-time { grid-column: 1 / 3; grid-row: 2; }
		.queue-actions { grid-column: 3; grid-row: 2; justify-self: end; }
	}
</style>
