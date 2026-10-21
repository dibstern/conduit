<script lang="ts">
	import ChoiceLabel from "../ChoiceLabel.svelte";
	import Checkbox from "../Checkbox.svelte";
	import { untrack } from "svelte";
	let { selected = false, disabled = false }: { selected?: boolean; disabled?: boolean } = $props();
	let checked = $state(untrack(() => selected));
	const id = $props.id();
</script>

<div class="max-w-[360px] p-[12px]">
	<ChoiceLabel forId={id} selected={checked} {disabled}>
		<Checkbox {id} bind:checked {disabled} class="mt-[2px]" />
		<span class="flex flex-col gap-[2px] text-text-secondary">
			<span class="font-medium">src/auth.ts</span>
			<span class="text-[12px] text-text-muted">Authentication module</span>
		</span>
	</ChoiceLabel>
</div>
