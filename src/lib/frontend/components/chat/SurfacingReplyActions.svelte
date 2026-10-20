<script lang="ts">
	import Button from "../ui/Button.svelte";

	let { source, within, replied, disabled = false, onreply }: {
		/** Who a quote belongs to; one selected under an earlier source is dropped. */
		source: string;
		within: HTMLElement | undefined;
		/** Whether the draft holds this message whole. Omitted where only quotes apply, as in the summary. */
		replied?: boolean;
		disabled?: boolean;
		onreply: (excerpt?: string) => void;
	} = $props();
	let quote = $state<{ text: string; source: string } | null>(null);
	function selectionChanged() {
		const selection = window.getSelection();
		quote = selection && !selection.isCollapsed && within?.contains(selection.anchorNode) && within.contains(selection.focusNode) ? { text: selection.toString(), source } : null;
	}
</script>

<svelte:document onselectionchange={selectionChanged} />
{#if replied !== undefined}
	<!-- The mockup's `.js-b` pill, `.on` while the draft replies to it; a phone shows just the glyph. -->
	<Button variant="ghost" size="content" touchTarget class="h-[26px] min-w-[26px] max-md:h-[30px] max-md:min-w-[30px] rounded-full bg-chip px-[9px] text-[12.5px] max-md:text-[14px] font-medium aria-pressed:bg-accent/18 aria-pressed:text-accent" ariaLabel="Reply" aria-pressed={replied} {disabled} onclick={() => onreply()}>↩<span class="max-md:hidden">&nbsp;Reply</span></Button>
{/if}
{#if quote?.source === source}
	<Button variant="accent-soft" size="content" touchTarget class="h-[26px] max-md:h-[32px] rounded-full px-[9px] font-sans text-[12.5px] font-medium" ariaLabel="Reply to this" {disabled} onpointerdown={(event) => event.preventDefault()} onclick={() => { if (quote) onreply(quote.text); window.getSelection()?.removeAllRanges(); quote = null; }}>❝ Reply to this</Button>
{:else if replied !== undefined}<span class="selection-hint">Select words to quote</span>{/if}

<style>
	.selection-hint { color: var(--color-text-muted); font-size: 11px; }
	@media (max-width: 767px) { .selection-hint { display: none; } }
</style>
