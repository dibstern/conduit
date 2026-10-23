<script lang="ts">
	import type { Category } from "../../../contracts/category-set.js";
	import { categoryColour } from "../../utils/category-colour.js";
	/** `plain` drops the tinted pill: only the glyph takes the category colour, for tables and inline prose. */
	let { category, plain = false }: { category: Category; plain?: boolean } = $props();
	const colour = $derived(categoryColour(category));
</script>

{#if plain}
	<span class="inline-flex min-w-0 items-center gap-[6px]"><span aria-hidden="true" class="shrink-0" style:color={colour}>{category.glyph}</span><span class="truncate">{category.label}</span></span>
{:else}
	<span class="inline-flex w-fit shrink-0 items-center gap-[4px] rounded-full px-[7px] py-[2px] text-[11.5px] font-medium whitespace-nowrap"
		style:color={category.origin === "custom" ? "var(--color-text)" : colour}
		style:background="color-mix(in srgb, {colour} 14%, var(--color-settings-card))">
		<span aria-hidden="true">{category.glyph}</span>{category.label}
	</span>
{/if}
