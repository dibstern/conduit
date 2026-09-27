<script lang="ts">
	import Modal from "../../../../src/lib/frontend/components/ui/Modal.svelte";

	let {
		firstOpen = true,
		secondOpen = true,
	}: {
		firstOpen?: boolean;
		secondOpen?: boolean;
	} = $props();
</script>

{#snippet firstBody()}
	<p>First modal body.</p>
{/snippet}

{#snippet secondBody()}
	<p>Second modal body.</p>
{/snippet}

<button data-testid="background-control" type="button">Background</button>
<Modal
	open={firstOpen}
	onclose={() => {}}
	title="First modal"
	showClose={false}
	children={firstBody}
/>
<Modal
	open={secondOpen}
	onclose={() => {}}
	title="Second modal"
	showClose={false}
	children={secondBody}
/>
