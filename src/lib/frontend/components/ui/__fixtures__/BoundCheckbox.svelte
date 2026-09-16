<script lang="ts">
	import Checkbox from "../Checkbox.svelte";

	let checked = $state(false);
</script>

<Checkbox aria-label="Bound" bind:checked />
<output data-testid="mirror">{checked}</output>
