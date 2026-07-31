<!--
	Highlight backdrop for the composer textarea.

	The textarea renders its text transparent (caret only); this mirror sits behind
	it and paints the same text, styling recognised `/skill` tokens as soft pills and
	unknown ones as red underlines. Font metrics, padding, wrapping and scroll are
	kept identical to the textarea so the (transparent) caret stays glyph-aligned.

	Segments use a keyed `{#each}`: a token's node is only recreated when the token
	itself changes, so the recognition shimmer plays exactly once and survives later
	keystrokes. `dimmed` hides the mirror during IME composition, when the textarea
	must show its own (pre-commit) text instead.
-->
<script lang="ts">
	import { tokenizeSkills } from "./skill-highlight.js";

	interface Props {
		text: string;
		commandNames: ReadonlySet<string>;
		scrollTop?: number;
		dimmed?: boolean;
	}
	let { text, commandNames, scrollTop = 0, dimmed = false }: Props = $props();

	const segments = $derived(tokenizeSkills(text, commandNames));
	let el: HTMLDivElement | undefined = $state();

	// Mirror the textarea's internal scroll position.
	$effect(() => {
		if (el) el.scrollTop = scrollTop;
	});
</script>

<div
	bind:this={el}
	aria-hidden="true"
	class="pointer-events-none absolute inset-0 z-0 overflow-hidden whitespace-pre-wrap break-words text-text text-base font-sans leading-[1.4] pt-2 pb-1 px-2.5"
	class:opacity-0={dimmed}
>{#each segments as seg (seg.key)}{#if seg.kind === "skill"}<span class="skill-pill">{seg.text}</span>{:else if seg.kind === "unknown"}<span class="skill-unknown">{seg.text}</span>{:else}{seg.text}{/if}{/each}</div>

<style>
	/* Plain inline (not inline-block) so the token stays on the text baseline at the
	   same size as its neighbours. Vertical padding only extends the tint — inline
	   boxes ignore it for line layout — while horizontal padding is cancelled by an
	   equal negative margin so the pill takes zero net width and the transparent
	   textarea caret stays glyph-aligned. No font-weight change, for the same reason. */
	.skill-pill {
		color: var(--color-accent);
		/* Layer 1: the shimmer light (moves on recognition). Layer 2: the soft tint.
		   Backgrounds are auto-clipped to the box, so no overflow/inline-block needed. */
		background:
			linear-gradient(
				100deg,
				transparent 40%,
				color-mix(in srgb, #fff 55%, transparent) 50%,
				transparent 60%
			)
			no-repeat,
			var(--color-accent-bg);
		background-size: 250% 100%, auto;
		background-position: 0% 0%, 0% 0%;
		border-radius: 6px;
		padding: 2px 4px;
		margin: 0 -4px;
		-webkit-box-decoration-break: clone;
		box-decoration-break: clone;
		animation: skill-shimmer 0.7s ease-out 1;
	}

	/* One-shot light sweep on recognition; settles with the light off-screen right. */
	@keyframes skill-shimmer {
		from {
			background-position: 100% 0%, 0% 0%;
		}
		to {
			background-position: 0% 0%, 0% 0%;
		}
	}

	.skill-unknown {
		color: var(--color-error);
		text-decoration: underline;
		text-decoration-color: currentColor;
		text-underline-offset: 2px;
	}

	@media (prefers-reduced-motion: reduce) {
		.skill-pill {
			animation: none;
		}
	}
</style>
