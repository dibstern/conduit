<script lang="ts">
	import Popover from "../Popover.svelte";
	import Textarea from "../Textarea.svelte";

	let {
		open = $bindable(true),
		headerless = false,
		presentation = "popover",
		detailText = "Arbitrary content stays composable.",
		editable = false,
	}: {
		open?: boolean;
		headerless?: boolean;
		presentation?: "popover" | "sheet" | "auto";
		detailText?: string;
		editable?: boolean;
	} = $props();

	// Fixed width keeps the floating baselines stable; the sheet body is full width, so only a floor applies there.
	const widthClass = $derived(presentation === "popover" ? "w-56" : "min-w-56");
</script>

{#if headerless}
	<Popover bind:open {presentation} ariaLabel="Quick details" class={widthClass}>
		{#snippet trigger({ props })}
			<button
				{...props}
				class="rounded-lg border border-border px-3 py-1.5 text-sm text-text hover:bg-bg-alt"
			>
				Open popover
			</button>
		{/snippet}

		<p class="px-3 py-1.5 text-sm text-text-secondary">
			{detailText}
		</p>
	</Popover>
{:else}
	<Popover bind:open {presentation} title="Details" class={widthClass}>
		{#snippet trigger({ props })}
			<button
				{...props}
				class="rounded-lg border border-border px-3 py-1.5 text-sm text-text hover:bg-bg-alt"
			>
				Open popover
			</button>
		{/snippet}

		<p class="px-3 py-1.5 text-sm text-text-secondary">
			{detailText}
		</p>
		{#if editable}<div class="px-3 pb-2"><Textarea aria-label="Draft" /></div>{/if}
	</Popover>
{/if}
