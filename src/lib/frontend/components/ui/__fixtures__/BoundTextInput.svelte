<script lang="ts">
	import TextInput from "../TextInput.svelte";

	let value = $state("");
</script>

<TextInput aria-label="Bound" bind:value />
<output data-testid="mirror">{value}</output>
