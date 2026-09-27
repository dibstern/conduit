<script lang="ts">
	import TextInput from "../TextInput.svelte";

	let value = $state("");
	// `bind:this` on a component tag hands back the component instance, so the
	// only way a parent reaches the real node is the `element` prop. The three
	// call sites use it to focus and select on demand; this mirrors that.
	let element = $state<HTMLInputElement>();
</script>

<TextInput aria-label="Bound" bind:value bind:element />
<output data-testid="mirror">{value}</output>
<output data-testid="element-tag">{element?.tagName ?? ""}</output>
<button type="button" data-testid="focus-it" onclick={() => element?.focus()}>
	focus
</button>
