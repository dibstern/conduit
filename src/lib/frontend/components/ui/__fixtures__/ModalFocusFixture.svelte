<script lang="ts">
	import Modal from "../Modal.svelte";

	let open = $state(false);
</script>

{#snippet body()}
	<button id="first" type="button">First</button>
	<input id="middle" aria-label="Middle" />
	<button id="last" type="button" onclick={() => (open = false)}>
		Close modal
	</button>
{/snippet}

<button id="outside-btn" type="button">Outside</button>
<button id="trigger" type="button" onclick={() => (open = true)}>
	Open modal
</button>
<Modal
	{open}
	onclose={() => (open = false)}
	ariaLabel="Focus behavior"
	showClose={false}
	children={body}
/>
