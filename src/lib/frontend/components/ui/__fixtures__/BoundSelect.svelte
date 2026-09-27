<script lang="ts">
	import Select from "../Select.svelte";

	let value = $state<string>();
</script>

<Select aria-label="Bound" bind:value>
	<option value="a">A</option>
	<option value="b">B</option>
</Select>
<output data-testid="mirror">{value}</output>
