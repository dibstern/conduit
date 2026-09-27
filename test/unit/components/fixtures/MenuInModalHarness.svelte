<script lang="ts">
	import Menu from "../../../../src/lib/frontend/components/ui/Menu.svelte";
	import Modal from "../../../../src/lib/frontend/components/ui/Modal.svelte";

	let menuOpen = $state(false);
</script>

<Modal open title="Modal with menu" onclose={() => {}} showClose={false}>
	<output data-testid="modal-menu-open">{String(menuOpen)}</output>
	<Menu bind:open={menuOpen} ariaLabel="Modal actions">
		{#snippet trigger({ props })}
			<button {...props}>Open modal actions</button>
		{/snippet}

		<span>Modal menu content</span>
	</Menu>
</Modal>
