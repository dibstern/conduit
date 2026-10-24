<!--
	Highlight backdrop for the composer textarea.

	The textarea paints the text and the caret; this mirror sits behind it and paints
	only decorations: recognised `/skill` and `$builtin` tokens as soft pills, unknown
	ones as red underlines, URLs with an accent underline. It never paints a glyph
	(see `.mirror` below), so caret and text always come from one layout and cannot
	drift apart. Both wear `composer-text-metrics` so the decorations land under the
	right words.

	This mirror is the one in flow, so its natural height sizes the composer row and
	the textarea is stretched over it. That leaves the scroll container above them
	as the only thing in the composer that scrolls — the caret cannot drift away
	from the text because there is no second scroll position to drift against.

	Segments use a keyed `{#each}`: a token's node is only recreated when the token
	itself changes, so the recognition shimmer plays exactly once and survives later
	keystrokes. `dimmed` hides the decorations during IME composition, while the
	textarea holds pre-commit text the mirror has not seen.
-->
<script lang="ts">
	import { tokenizeSkills } from "../../../skill-recognition.js";
	import { referenceLabel } from "../../../composer-references.js";
	import { splitUrls } from "../../utils/links.js";
	import { BUILTIN_CATEGORIES } from "../../../contracts/category-set.js";
	import { categoryColour } from "../../utils/category-colour.js";
	import ComposerToken from "../ui/ComposerToken.svelte";
	import ComposerReferenceToken from "../ui/ComposerReferenceToken.svelte";

	interface Props {
		text: string;
		commandNames: ReadonlySet<string>;
		builtinNames?: ReadonlySet<string>;
		dimmed?: boolean;
		onremove?: (start: number) => void;
	}
	let { text, commandNames, builtinNames, dimmed = false, onremove }: Props = $props();

	const segments = $derived(tokenizeSkills(text, commandNames, builtinNames));
</script>

<div
	aria-hidden="true"
	class="composer-text-metrics mirror pointer-events-none relative"
	class:opacity-0={dimmed}
>{#each segments as seg (seg.key)}{#if seg.kind === "reference" && seg.reference}{@const reference = seg.reference}{@const category = "ordinal" in reference ? BUILTIN_CATEGORIES.find(({ id }) => id === reference.builtinCategory) : undefined}<ComposerReferenceToken label={referenceLabel(reference)} colour={categoryColour(category)} ask={"ordinal" in reference && !reference.builtinCategory && reference.category === "Ask"} title={reference.text} onremove={() => onremove?.(seg.start ?? 0)} />{:else if seg.kind === "skill"}<ComposerToken goal={/^[/$]goal$/.test(seg.text)}>{seg.text}</ComposerToken>{:else if seg.kind === "unknown"}<span class="skill-unknown">{seg.text}</span>{:else}{#each splitUrls(seg.text) as part, i}{#if i % 2}<span class="composer-url">{part}</span>{:else}{part}{/if}{/each}{/if}{/each}</div>

<style>
	/* The invariant that keeps the caret on the text: the mirror never paints a
	   glyph. Text fill is inherited and wins over any child's `color`, which is
	   left to drive underlines. iOS lays out text in the textarea that the mirror
	   never sees (inline predictions, marked text), so painted mirror glyphs can
	   disagree with the caret no matter how carefully the metrics match. */
	.mirror {
		-webkit-text-fill-color: transparent;
	}

	/* A zero-width space forcing a final line box, which the row's height depends
	   on: an empty draft would otherwise collapse to its padding, and one ending in
	   a newline would come up a line short of the textarea. It lives in a pseudo
	   element so the mirror's own text stays byte-for-byte the draft — anything
	   stray in the projected text shifts glyphs out from under the caret. */
	.mirror::after {
		content: "\200b";
	}

	/* Decoration only: any change to font or spacing moves pills off their words
	   (see composer-text-metrics). */
	.composer-url {
		color: var(--color-accent);
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.skill-unknown {
		color: var(--color-error);
		text-decoration: underline;
		text-decoration-color: currentColor;
		text-underline-offset: 2px;
	}
</style>
