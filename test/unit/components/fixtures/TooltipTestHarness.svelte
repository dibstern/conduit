<script lang="ts">
	import Modal from "../../../../src/lib/frontend/components/ui/Modal.svelte";
	import Tooltip from "../../../../src/lib/frontend/components/ui/Tooltip.svelte";

	let {
		open = $bindable(false),
		onopenchange,
		portalTo,
		insideModal = false,
		emptyContent = false,
	}: {
		open?: boolean;
		onopenchange?: (open: boolean) => void;
		portalTo?: HTMLElement | string;
		insideModal?: boolean;
		emptyContent?: boolean;
	} = $props();
</script>

{#snippet trigger({ props }: { props: Record<string, unknown> })}
	<button {...props}>Show details</button>
{/snippet}

{#snippet content()}
	{emptyContent ? " " : "Verbose logging · Ctrl+L"}
{/snippet}

<output data-testid="tooltip-open">{String(open)}</output>

{#if insideModal}
	<Modal open title="Modal with tooltip" onclose={() => {}} showClose={false}>
		<Tooltip
			bind:open
			{onopenchange}
			{portalTo}
			{trigger}
			children={content}
			data-testid="tooltip"
		/>
	</Modal>
{:else}
	<Tooltip
		bind:open
		{onopenchange}
		{portalTo}
		{trigger}
		children={content}
		data-testid="tooltip"
	/>
{/if}
