<script lang="ts">
	import Popover from "../Popover.svelte";

	let {
		open = $bindable(true),
		headerless = false,
	}: {
		open?: boolean;
		headerless?: boolean;
	} = $props();
</script>

{#if headerless}
	<Popover bind:open ariaLabel="Quick details" class="w-56">
		{#snippet trigger({ props })}
			<button
				{...props}
				class="rounded-lg border border-border px-3 py-1.5 text-sm text-text hover:bg-bg-alt"
			>
				Open popover
			</button>
		{/snippet}

		<p class="px-3 py-1.5 text-sm text-text-secondary">
			Arbitrary content stays composable.
		</p>
	</Popover>
{:else}
	<Popover bind:open title="Details" class="w-56">
		{#snippet trigger({ props })}
			<button
				{...props}
				class="rounded-lg border border-border px-3 py-1.5 text-sm text-text hover:bg-bg-alt"
			>
				Open popover
			</button>
		{/snippet}

		<p class="px-3 py-1.5 text-sm text-text-secondary">
			Arbitrary content stays composable.
		</p>
	</Popover>
{/if}
