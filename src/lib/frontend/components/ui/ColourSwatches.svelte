<script lang="ts">
	let { value, onchange, disabled = false }: { value: string; onchange: (colour: string) => void; disabled?: boolean } = $props();
	// Persisted category colours, not theme paint. The pill maps built-ins to tokens.
	const colours = ["#8e9bff", "#2a9fd6", "#3ecf8e", "#ff9f0a", "#ff6369", "#b07cff"];
</script>

<div class="flex flex-wrap gap-[6px]" role="group" aria-label="Category colour palette">
	{#each colours as colour}
		<button type="button" {disabled} aria-label={`Use ${colour}`} aria-pressed={value.toLowerCase() === colour}
			onclick={() => onchange(colour)}
			class="flex size-[38px] max-md:size-[44px] items-center justify-center rounded-full cursor-pointer focus-visible:outline-2 focus-visible:outline-text disabled:opacity-50">
			<span class="size-[22px] rounded-full ring-offset-2 ring-offset-settings-card {value.toLowerCase() === colour ? 'ring-2 ring-text' : ''}" style:background={colour}></span>
		</button>
	{/each}
</div>
