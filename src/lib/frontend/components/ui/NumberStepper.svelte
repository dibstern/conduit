<script lang="ts">
	import Button from "./Button.svelte";
	// `edited` rings the stepper in accent, marking a value that differs from the saved one.
	let { value, label, min = 0, max = 100, step = 5, disabled = false, edited = false, onvaluechange }: {
		value: number; label: string; min?: number; max?: number; step?: number; disabled?: boolean; edited?: boolean; onvaluechange: (value: number) => void;
	} = $props();
	function commit(input: HTMLInputElement): void {
		const next = input.valueAsNumber;
		if (Number.isFinite(next) && next >= min && next <= max) onvaluechange(next);
		else input.value = String(value);
	}
</script>

<div role="group" aria-label={label} class="inline-flex h-[28px] max-md:h-[44px] items-center rounded-[8px] bg-chip font-mono text-[12px] focus-within:ring-[1.5px] focus-within:ring-accent {edited ? 'text-accent ring-[1.5px] ring-accent' : 'text-text'}">
	<Button variant="ghost" size="content" class="h-full w-[22px] max-md:w-[28px]" ariaLabel={`Lower ${label}`} disabled={disabled || value <= min} onclick={() => onvaluechange(Math.max(min, value - step))}>−</Button>
	<input type="number" aria-label={label} {value} {min} {max} step="any" {disabled} onchange={(event) => commit(event.currentTarget)}
		class="stepper-input min-w-0 w-[34px] bg-transparent text-center outline-none disabled:opacity-50" />
	<Button variant="ghost" size="content" class="h-full w-[22px] max-md:w-[28px]" ariaLabel={`Raise ${label}`} disabled={disabled || value >= max} onclick={() => onvaluechange(Math.min(max, value + step))}>+</Button>
</div>

<style>
	.stepper-input { appearance: textfield; -moz-appearance: textfield; }
	.stepper-input::-webkit-inner-spin-button, .stepper-input::-webkit-outer-spin-button { appearance: none; margin: 0; }
</style>
