<!--
	Highlight backdrop for the composer textarea.

	The textarea renders its text transparent (caret only); this mirror sits behind
	it and paints the same text, styling recognised `/skill` and `$builtin` tokens as soft pills and
	unknown ones as red underlines. Both wear `composer-text-metrics`, which is the
	single definition of the layout that decides where a glyph lands.

	This mirror is the one in flow, so its natural height sizes the composer row and
	the textarea is stretched over it. That leaves the scroll container above them
	as the only thing in the composer that scrolls — the caret cannot drift away
	from the text because there is no second scroll position to drift against.

	Segments use a keyed `{#each}`: a token's node is only recreated when the token
	itself changes, so the recognition shimmer plays exactly once and survives later
	keystrokes. `dimmed` hides the mirror during IME composition, when the textarea
	must show its own (pre-commit) text instead.
-->
<script lang="ts">
	import { tokenizeSkills } from "../../../skill-recognition.js";
	import ComposerToken from "../ui/ComposerToken.svelte";

	interface Props {
		text: string;
		commandNames: ReadonlySet<string>;
		builtinNames?: ReadonlySet<string>;
		dimmed?: boolean;
	}
	let { text, commandNames, builtinNames, dimmed = false }: Props = $props();

	const segments = $derived(tokenizeSkills(text, commandNames, builtinNames));
</script>

<div
	aria-hidden="true"
	class="composer-text-metrics mirror pointer-events-none relative z-0 text-text"
	class:opacity-0={dimmed}
>{#each segments as seg (seg.key)}{#if seg.kind === "skill"}<ComposerToken goal={/^[/$]goal$/.test(seg.text)}>{seg.text}</ComposerToken>{:else if seg.kind === "unknown"}<span class="skill-unknown">{seg.text}</span>{:else}{seg.text}{/if}{/each}</div>

<style>
	/* A zero-width space forcing a final line box, which the row's height depends
	   on: an empty draft would otherwise collapse to its padding, and one ending in
	   a newline would come up a line short of the textarea. It lives in a pseudo
	   element so the mirror's own text stays byte-for-byte the draft — anything
	   stray in there shifts the glyphs out from under the caret. */
	.mirror::after {
		content: "\200b";
	}

	.skill-unknown {
		color: var(--color-error);
		text-decoration: underline;
		text-decoration-color: currentColor;
		text-underline-offset: 2px;
	}
</style>
