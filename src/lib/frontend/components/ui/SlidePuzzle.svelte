<script lang="ts">
	interface Props {
		/** Block edge in px. Default 5 */
		blockSize?: number;
		/** Gap between blocks in px. Default 1.5 */
		gap?: number;
		/** Additional CSS classes */
		class?: string;
	}

	let { blockSize = 5, gap = 1.5, class: className = "" }: Props = $props();

	const step = $derived(blockSize + gap);
</script>

<!-- Three blocks in a 2x2 frame, one sliding into the empty slot at a time.
     All three run the same keyframe a third of a cycle apart, which is the same
     as starting them in consecutive slots. The inline transform is each block's
     resting slot: the running animation overrides it, and reduced motion leaves
     the blocks there. -->
<div
	class="slide-puzzle relative shrink-0 {className}"
	style="--block: {blockSize}px; --step: {step}px; width: {blockSize + step}px; height: {blockSize + step}px;"
	role="img"
	aria-label="Conduit loading indicator"
>
	<span style="background: var(--color-brand-a);"></span>
	<span
		style="background: color-mix(in oklab, var(--color-brand-a), var(--color-brand-b)); transform: translate(var(--step), 0); animation-delay: -1s;"
	></span>
	<span
		style="background: var(--color-brand-b); transform: translate(var(--step), var(--step)); animation-delay: -2s;"
	></span>
</div>

<style>
	.slide-puzzle span {
		position: absolute;
		top: 0;
		left: 0;
		width: var(--block);
		height: var(--block);
		border-radius: calc(var(--block) / 4);
		animation: slide-puzzle 3s ease-in-out infinite;
	}

	/* Clockwise round the frame, one slot per move, holding between moves. Each
	   move is the 5% after a hold, so with three blocks a third apart exactly one
	   is ever moving. */
	@keyframes slide-puzzle {
		0%,
		16.67% {
			transform: translate(0, 0);
		}
		21.67%,
		41.67% {
			transform: translate(var(--step), 0);
		}
		46.67%,
		66.67% {
			transform: translate(var(--step), var(--step));
		}
		71.67%,
		91.67% {
			transform: translate(0, var(--step));
		}
		96.67%,
		100% {
			transform: translate(0, 0);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.slide-puzzle span {
			animation: none;
		}
	}
</style>
