<script lang="ts">
	import Popover from "../../../../src/lib/frontend/components/ui/Popover.svelte";
	import Modal from "../../../../src/lib/frontend/components/ui/Modal.svelte";

	let {
		open = $bindable(false),
		headerless = false,
		insideModal = false,
		onopenchange,
		portalTo,
		accessibleName = "Quick details",
	}: {
		open?: boolean;
		headerless?: boolean;
		insideModal?: boolean;
		onopenchange?: (open: boolean) => void;
		portalTo?: HTMLElement | string;
		accessibleName?: string;
	} = $props();
</script>

{#snippet trigger({ props }: { props: Record<string, unknown> })}
	<button {...props}>Open details</button>
{/snippet}

{#snippet content()}
	<p>Arbitrary popover content</p>
{/snippet}

<output data-testid="popover-open">{String(open)}</output>

{#if insideModal}
	<Modal open title="Modal with popover" onclose={() => {}} showClose={false}>
		<Popover
			bind:open
			{onopenchange}
			{portalTo}
			ariaLabel="Modal details"
			{trigger}
			children={content}
			data-testid="popover"
		/>
	</Modal>
{:else if headerless}
	<Popover
		bind:open
		{onopenchange}
		{portalTo}
		ariaLabel={accessibleName}
		{trigger}
		children={content}
		data-testid="popover"
	/>
{:else}
	<Popover
		bind:open
		{onopenchange}
		{portalTo}
		title="Details"
		{trigger}
		children={content}
		data-testid="popover"
	/>
{/if}
