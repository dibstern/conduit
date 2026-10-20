<script lang="ts">
	import type { Snippet } from "svelte";
	let { children }: { children: Snippet } = $props();
</script>
<div data-testid="composer-send-control" class="send-group">{@render children()}</div>
<style>
	/* Above neighbours, so their widened touch targets never take a tap on Send. */
	.send-group { position: relative; z-index: 1; display: inline-flex; height: 34px; flex: none; align-items: stretch; border-radius: 999px; background: var(--color-inverse-bg); color: var(--color-inverse-text); }
	.send-group :global(button) { border-radius: 999px 0 0 999px; }
	.send-group :global([data-testid="composer-send-switch-label"]) { max-width: 120px; overflow: hidden; text-overflow: ellipsis; }
	.send-group :global([data-testid="composer-send-menu-trigger"]) { width: 28px; border-radius: 0 999px 999px 0; border-left: 1px solid color-mix(in srgb, var(--color-inverse-text) 22%, transparent); }
	@container composer (max-width: 440px) {
		.send-group :global([data-testid="composer-send-switch-prefix"]) { display: none; }
		.send-group :global([data-testid="composer-send-switch-label"]) { max-width: 64px; }
	}
	@container composer (max-width: 340px) {
		.send-group :global([data-testid="composer-send-at-label"]), .send-group :global([data-testid="composer-send-switch-label"]) { display: none; }
	}
</style>
