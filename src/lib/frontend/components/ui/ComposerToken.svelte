<script lang="ts">
	import type { Snippet } from "svelte";

	let { goal = false, children }: { goal?: boolean; children: Snippet } = $props();
</script>

<span class="skill-pill composer-pill" class:goal-token={goal}>{@render children()}</span>

<style>
	/* Padding and margin cancel, so glyphs sit exactly where the textarea draws
	   them. A slim 1.5px side bleed keeps most of each neighbouring space clear. */
	.composer-pill {
		background:
			linear-gradient(
				100deg,
				transparent 40%,
				color-mix(in srgb, var(--color-inverse-bg) 55%, transparent) 50%,
				transparent 60%
			)
			no-repeat,
			var(--color-accent-bg);
		background-size: 250% 100%, auto;
		background-position: 0% 0%, 0% 0%;
		padding: 2px 1.5px;
		margin: 0 -1.5px;
		animation: skill-shimmer 0.7s ease-out 1;
	}

	.goal-token {
		background: color-mix(in srgb, var(--color-status-goal) 16%, transparent);
	}

	@keyframes skill-shimmer {
		from {
			background-position: 100% 0%, 0% 0%;
		}
		to {
			background-position: 0% 0%, 0% 0%;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.composer-pill {
			animation: none;
		}
	}
</style>
