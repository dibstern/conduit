<script lang="ts">
	import { MARK_GLYPHS, type SurfacingFeedback } from "../../stores/surfacing-feedback.svelte.js";
	import type { SurfacePin } from "../../utils/surface-turn.js";
	import Button from "../ui/Button.svelte";
	let { pin, feedback, place = "card", canSave = true }: { pin: SurfacePin; feedback: SurfacingFeedback; place?: string; canSave?: boolean } = $props();
	const inCard = $derived(place === "card");
	const actions = [
		{ direction: "raise", label: "Raise", pressed: "bg-success/16 text-success" },
		{ direction: "lower", label: "Lower", pressed: "bg-selection text-text" },
		{ direction: "retype", label: "Retype", pressed: "bg-accent/18 text-accent" },
	] as const;
</script>

<!-- The step log reports misses and false alarms, so it offers ▲ and ▼ only, as glyphs. -->
{#each inCard ? actions : actions.slice(0, 2) as { direction, label, pressed } (direction)}
	{@const active = pin.part.surfacingMark?.direction === direction}
	<Button variant="ghost" size="content" tone="inherit" hoverFill="none" class="gap-[4px] h-[26px] min-w-[26px] max-md:h-[32px] max-md:min-w-[32px] rounded-full text-[12.5px] font-medium {inCard ? 'px-[9px]' : ''} {active ? pressed : 'bg-chip text-text-secondary'}" data-testid="surfacing-mark-{direction}" ariaLabel={label} aria-pressed={active} disabled={feedback.saving || !canSave || !pin.part.partId || (!active && (direction === "raise" && pin.level === "key" || direction === "lower" && pin.level === "hidden"))} onclick={() => feedback.begin(pin, direction, place)}>
		<span>{MARK_GLYPHS[direction]}</span>{#if inCard}<span class="hidden md:inline">{label}</span>{/if}
	</Button>
{/each}
