<script lang="ts">
	import Menu from "../Menu.svelte";
	import MenuItem from "../MenuItem.svelte";
	import Modal from "../Modal.svelte";
	import Popover from "../Popover.svelte";
	import Tooltip from "../Tooltip.svelte";

	let selected = $state("none");
</script>

<Modal open title="Modal with menu" onclose={() => {}} showClose={false}>
	<output data-testid="modal-selection">{selected}</output>
	<Menu ariaLabel="Modal actions">
		{#snippet trigger({ props })}
			<button {...props}>Open modal actions</button>
		{/snippet}
		<MenuItem onselect={() => { selected = "keyboard"; }}>Choose by keyboard</MenuItem>
		<MenuItem onselect={() => { selected = "pointer"; }}>Choose by pointer</MenuItem>
	</Menu>
	<Popover title="Modal popover">
		{#snippet trigger({ props })}<button {...props}>Open modal popover</button>{/snippet}
		<p>Popover content</p>
	</Popover>
	<Tooltip delayDuration={0}>
		{#snippet trigger({ props })}<button {...props}>Show modal tip</button>{/snippet}
		Modal tooltip content
	</Tooltip>
</Modal>
