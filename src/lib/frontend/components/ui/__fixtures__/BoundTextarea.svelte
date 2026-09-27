<script lang="ts">
	import Textarea from "../Textarea.svelte";

	// The composer's auto-resize reads scrollHeight and writes style.height on
	// every keystroke, which is only possible if the parent holds the real node.
	// `bind:this` on a component tag hands back the component instance instead.
	let element = $state<HTMLTextAreaElement>();
</script>

<Textarea aria-label="Bound" bind:element />
<output data-testid="element-tag">{element?.tagName ?? ""}</output>
<button type="button" data-testid="focus-it" onclick={() => element?.focus()}>
	focus
</button>
