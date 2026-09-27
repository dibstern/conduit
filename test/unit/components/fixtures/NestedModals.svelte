<script lang="ts">
	import Modal from "../../../../src/lib/frontend/components/ui/Modal.svelte";

	let { innerOpen = true }: { innerOpen?: boolean } = $props();
</script>

{#snippet innerBody()}
	<p>Inner modal body.</p>
{/snippet}

{#snippet outerBody()}
	<button data-testid="outer-action" type="button">Outer action</button>
	<Modal
		open={innerOpen}
		onclose={() => {}}
		title="Inner modal"
		showClose={false}
		children={innerBody}
	/>
{/snippet}

<Modal
	open
	onclose={() => {}}
	title="Outer modal"
	showClose={false}
	children={outerBody}
/>
