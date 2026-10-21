<script lang="ts">
	import { surfacingLevel, type CategorySet } from "../../../contracts/category-set.js";
	import { MARK_GLYPHS, type SurfacingFeedback } from "../../stores/surfacing-feedback.svelte.js";
	import { SURFACE_LABELS, type SurfacePin } from "../../utils/surface-turn.js";
	import Button from "../ui/Button.svelte";
	import TextInput from "../ui/TextInput.svelte";
	let { pin, feedback, categorySet, place = "card" }: { pin: SurfacePin; feedback: SurfacingFeedback; categorySet: CategorySet; place?: string } = $props();
	const pending = $derived(feedback.pending?.pin.part.uuid === pin.part.uuid && feedback.pending.place === place ? feedback.pending : null);
	const jev = $derived(surfacingLevel({ probabilities: pin.part.surfacingProbabilities ?? null }, categorySet));
	const category = $derived(categorySet.categories.find(({ id }) => id === jev.category));
	const probability = $derived(category ? pin.part.surfacingProbabilities?.[category.id] : undefined);
	const arithmetic = $derived(
		category ? `Jev: ${category.glyph} ${category.label}${probability === undefined ? "" : ` · p ${probability.toFixed(2).replace(/^0/, "")} × ${category.weight} = ${Math.round(probability * category.weight)}`}`
		: `Jev: ${pin.part.surfacingProbabilities ? "Routine" : "Not judged"}`,
	);
	const selected = $derived(categorySet.categories.find(({ id }) => id === pending?.mark?.category));
</script>

{#if pending}
	<!-- Esc bubbles to the turn's key handler, which cancels and returns focus. -->
	<div class="mark-why" data-testid="surfacing-mark-why" role="group" aria-label="Why this correction?">
		<div class="mark-question">
			<strong data-testid="surfacing-mark-prompt">{MARK_GLYPHS[pending.direction]} {pending.direction === "raise" ? "Raise" : pending.direction === "lower" ? "Lower" : "Retype"} #{pin.number ?? "?"}{#if pending.direction === "retype"}{pending.mark ? ` as ${selected?.label ?? "Message"} → ${SURFACE_LABELS[pending.mark.level]}. Why?` : " as…"}{:else}<span class="max-md:hidden">: {SURFACE_LABELS[pin.level]}</span> → {pending.mark ? SURFACE_LABELS[pending.mark.level] : ""}. Why?{/if}</strong>
			<Button variant="ghost" size="content" tone="muted" class="size-[26px] max-md:size-[32px] rounded-full shrink-0" ariaLabel="Cancel correction" data-testid="surfacing-mark-cancel" disabled={feedback.saving} onclick={() => feedback.cancel()}>✕</Button>
		</div>
		<div class="mark-arithmetic">{arithmetic}</div>
		<div class="mark-reasons">
			{#if pending.direction === "retype" && !pending.mark}
				{#each categorySet.categories.filter(({ retired, id }) => !retired && id !== pin.category) as category (category.id)}
					<Button variant="ghost" size="content" tone="default" class="mark-chip" data-testid="surfacing-mark-category-{category.id}" onclick={() => feedback.retype(category.id)}>{category.glyph} {category.label}</Button>
				{/each}
			{:else}
				{#each feedback.reasons() as reason (reason)}
					<Button variant="ghost" size="content" tone="default" class="mark-chip" data-testid="surfacing-mark-reason-chip" disabled={feedback.saving} onclick={() => feedback.submit(reason)}>{reason}</Button>
				{/each}
				<form onsubmit={(event) => { event.preventDefault(); void feedback.submit(); }}>
					<TextInput chrome="bare" size="content" class="mark-input" data-testid="surfacing-mark-reason" aria-label="Your reason" placeholder="Your reason… ↵" bind:value={feedback.reason} disabled={feedback.saving} maxlength={2000} />
				</form>
				<Button variant="ghost" size="content" tone="secondary" class="mark-chip mark-skip" data-testid="surfacing-mark-no-reason" disabled={feedback.saving} onclick={() => feedback.submit("")}>No reason</Button>
			{/if}
		</div>
		{#if feedback.error}<p role="alert" class="mt-[6px] text-[12px] text-error">{feedback.error}</p>{/if}
	</div>
{/if}

<style>
	.mark-why { margin-top:10px; padding:9px 10px 10px; border-radius:10px; background:var(--color-turn-bg); }
	.mark-question { display:flex; align-items:flex-start; gap:6px; font-size:13px; }
	.mark-question strong { flex:1; font-weight:600; overflow-wrap:anywhere; }
	.mark-arithmetic { margin-top:2px; font:11.5px var(--font-mono); color:var(--color-text-muted); }
	.mark-reasons { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
	.mark-reasons :global(.mark-chip),.mark-reasons :global(.mark-input) { display:inline-flex; align-items:center; gap:5px; min-height:26px; padding:0 10px; border-radius:999px; font-size:12.5px; font-weight:500; }
	.mark-reasons :global(.mark-chip) { background:var(--color-bg); }
	.mark-reasons :global(.mark-skip) { background:none; border:1px dashed color-mix(in srgb,var(--color-text) 30%,transparent); }
	.mark-reasons :global(.mark-input) { box-sizing:border-box; width:160px; max-width:100%; box-shadow:inset 0 0 0 1px var(--color-border); color:var(--color-text); font-weight:400; outline:none; }
	.mark-reasons :global(.mark-input:focus-visible) { box-shadow:inset 0 0 0 1px var(--color-text); }
	.mark-reasons :global(.mark-input::placeholder) { color:var(--color-text-muted); }
	@media(max-width:767px) { .mark-reasons :global(.mark-chip),.mark-reasons :global(.mark-input) { min-height:32px; } }
</style>
