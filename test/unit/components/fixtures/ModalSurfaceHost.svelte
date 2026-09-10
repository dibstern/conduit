<script lang="ts">
	import Menu from "../../../../src/lib/frontend/components/ui/Menu.svelte";
	import Popover from "../../../../src/lib/frontend/components/ui/Popover.svelte";
	import Modal from "../../../../src/lib/frontend/components/ui/Modal.svelte";
	let {
		modalOpen = false,
		surfaceOpen = $bindable(false),
		inside = false,
		popover = false,
		onopenchange,
	}: {
		modalOpen?: boolean;
		surfaceOpen?: boolean;
		inside?: boolean;
		popover?: boolean;
		onopenchange?: (open: boolean) => void;
	} = $props();
</script>

<output data-testid="surface-open">{String(surfaceOpen)}</output>
{#snippet surface()}
	{#if popover}
		<Popover bind:open={surfaceOpen} {onopenchange} title="Surface popover">
			{#snippet trigger({ props })}
				<button {...props}>Open surface</button>
			{/snippet}
			<span data-testid="surface-content">Popover content</span>
		</Popover>
	{:else}
		<Menu bind:open={surfaceOpen} {onopenchange} ariaLabel="Surface menu">
			{#snippet trigger({ props })}
				<button {...props}>Open surface</button>
			{/snippet}
			<span data-testid="surface-content">Menu content</span>
		</Menu>
	{/if}
{/snippet}

{#if inside === false}
	{@render surface()}
{/if}
<Modal open={modalOpen} onclose={() => {}} title="Host modal" showClose={false}>
	<button data-testid="modal-action" type="button">Modal action</button>
	{#if inside}
		{@render surface()}
	{/if}
</Modal>
