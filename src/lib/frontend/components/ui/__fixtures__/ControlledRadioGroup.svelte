<script lang="ts">
	import Radio from "../Radio.svelte";

	// Radio is controlled, not bound (`bind:group` is a DOM directive and cannot
	// cross a component boundary). This fixture is the shape every consumer has
	// to write: one piece of parent state, `checked` derived from it, `onchange`
	// writing back to it.
	let selected = $state("a");
</script>

{#each ["a", "b"] as option (option)}
	<Radio
		aria-label={option}
		name="fixture"
		value={option}
		checked={selected === option}
		onchange={() => (selected = option)}
	/>
{/each}
<output data-testid="mirror">{selected}</output>
