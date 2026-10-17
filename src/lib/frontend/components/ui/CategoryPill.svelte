<script lang="ts">
	import type { Category } from "../../../contracts/category-set.js";
	let { category }: { category: Category } = $props();
	const colour = $derived(category.origin === "builtin"
		? category.id === "ask" ? "var(--color-status-ask)"
		: category.id === "blocked" ? "var(--color-status-red)"
		: category.id === "risk" ? "var(--color-status-risk)"
		: category.id === "milestone" ? "var(--color-status-green)"
		: "var(--color-text-muted)"
		: category.colour);
</script>

<span class="inline-flex w-fit shrink-0 items-center gap-[4px] rounded-full px-[7px] py-[2px] text-[11.5px] font-medium whitespace-nowrap"
	style:color={category.origin === "custom" ? "var(--color-text)" : colour}
	style:background="color-mix(in srgb, {colour} 14%, var(--color-settings-card))">
	<span aria-hidden="true">{category.glyph}</span>{category.label}
</span>
