<!--
	Highlight backdrop for the composer textarea.

	The textarea renders its text transparent (caret only); this mirror sits behind
	it and paints the same text, styling recognised `/skill` and `$builtin` tokens as soft pills,
	unknown ones as red underlines, and URLs in the link colour. Both wear `composer-text-metrics`, which is the
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
	class="composer-text-metrics mirror pointer-events-none relative text-text"
	class:opacity-0={dimmed}
>{#each segments as seg (seg.key)}{#if seg.kind === "reference" && seg.reference}{@const reference = seg.reference}{@const category = "ordinal" in reference ? BUILTIN_CATEGORIES.find(({ id }) => id === reference.builtinCategory) : undefined}<ComposerReferenceToken label={referenceLabel(reference)} colour={categoryColour(category)} ask={"ordinal" in reference && !reference.builtinCategory && reference.category === "Ask"} title={reference.text} onremove={() => onremove?.(seg.start ?? 0)} />{:else if seg.kind === "skill"}<ComposerToken goal={/^[/$]goal$/.test(seg.text)}>{seg.text}</ComposerToken>{:else if seg.kind === "unknown"}<span class="skill-unknown">{seg.text}</span>{:else}{#each splitUrls(seg.text) as part, i}{#if i % 2}<span class="composer-url">{part}</span>{:else}{part}{/if}{/each}{/if}{/each}</div>

<style>
	/* A zero-width space forcing a final line box, which the row's height depends
	   on: an empty draft would otherwise collapse to its padding, and one ending in
	   a newline would come up a line short of the textarea. It lives in a pseudo
	   element so the mirror's own text stays byte-for-byte the draft — anything
	   stray in the projected text shifts glyphs out from under the caret. */
	.mirror::after {
		content: "\200b";
	}

	/* Colour only: any change to font or spacing moves glyphs out from under the
	   caret (see composer-text-metrics). */
	.composer-url {
		color: var(--color-accent);
	}

	.skill-unknown {
		color: var(--color-error);
		text-decoration: underline;
		text-decoration-color: currentColor;
		text-underline-offset: 2px;
	}
</style>
