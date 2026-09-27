<!--
  The ownership relationship DetachedListbox exists to complete: an external
  text input owns focus and the combobox attributes, while the listbox owns the
  options. Mounted as a fixture so addon-a11y evaluates the whole relationship
  instead of an orphan listbox.
-->
<script lang="ts">
	import DetachedListbox from "../DetachedListbox.svelte";

	type DetachedListboxDemoProps = {
		open?: boolean;
		busy?: boolean;
		options?: readonly string[];
		activeIndex?: number;
	};

	let {
		open = true,
		busy = false,
		options = ["src/lib/", "src/routes/"],
		activeIndex = 0,
	}: DetachedListboxDemoProps = $props();

	const uid = $props.id();
	const listboxId = `${uid}-listbox`;
	const optionId = (index: number) => `${listboxId}-option-${index}`;

	// Loading has no active option, exactly like FileMenu's busy surface.
	const activeOptionId = $derived(
		open && !busy && options.length > 0 ? optionId(activeIndex) : undefined,
	);
</script>

<div class="relative w-72 p-4">
	<input
		type="text"
		role="combobox"
		aria-label="Directory filter"
		aria-autocomplete="list"
		aria-haspopup="listbox"
		aria-expanded={open}
		aria-controls={open ? listboxId : undefined}
		aria-activedescendant={activeOptionId}
		class="w-full rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-text"
	/>

	{#if open}
		<DetachedListbox
			id={listboxId}
			ariaLabel="Directory suggestions"
			aria-busy={busy}
			data-testid="detached-listbox"
			class="absolute top-full left-0 right-0 mt-1 max-h-[200px] overflow-y-auto"
		>
			{#if busy}
				<div class="px-3 py-1.5 text-sm text-text">Loading directories…</div>
			{:else}
				{#each options as entry, index (entry)}
					<div
						id={optionId(index)}
						role="option"
						aria-selected={index === activeIndex}
						class="px-3 py-1.5 text-sm text-text {index === activeIndex
							? 'bg-accent-bg'
							: ''}"
					>
						{entry}
					</div>
				{/each}
			{/if}
		</DetachedListbox>
	{/if}
</div>
