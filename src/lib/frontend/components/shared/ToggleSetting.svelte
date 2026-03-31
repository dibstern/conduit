<!--
  ToggleSetting — A labeled toggle switch row.
  Renders: [icon?] [label + description?] .............. [switch]
  The entire row is a single <button> — no nested interactive elements,
  proper semantics, and the full row is the touch target on mobile.
-->
<script lang="ts">
	import Icon from "./Icon.svelte";

	let {
		icon,
		label,
		description,
		checked = false,
		onchange,
		disabled = false,
		dimmed = false,
		ariaLabel,
		class: className,
	}: {
		icon?: string;
		label: string;
		description?: string;
		checked?: boolean;
		onchange?: () => void;
		disabled?: boolean;
		dimmed?: boolean;
		ariaLabel?: string;
		class?: string;
	} = $props();
</script>

<button
	type="button"
	role="switch"
	aria-checked={checked}
	aria-label={ariaLabel ?? `Toggle ${label.toLowerCase()}`}
	class="flex items-center w-full text-left select-none touch-manipulation cursor-pointer disabled:cursor-not-allowed {className ?? 'gap-3 px-3.5 py-2.5 border-none bg-transparent'}"
	{disabled}
	onclick={onchange}
>
	{#if icon}
		<span class="text-text-muted shrink-0">
			<Icon name={icon} size={16} />
		</span>
	{/if}
	<div class="flex-1 min-w-0">
		<div class="text-sm text-text {description ? 'font-medium' : ''}">{label}</div>
		{#if description}
			<div class="text-xs text-text-muted mt-0.5">{description}</div>
		{/if}
	</div>
	<span
		class="relative w-9 h-5 rounded-full shrink-0 transition-[background,box-shadow] {checked ? 'bg-brand-a' : 'bg-text-dimmer'} {dimmed ? 'opacity-40' : ''}"
		style={checked ? "box-shadow: 0 0 8px rgba(255,45,123,0.4);" : ""}
	>
		<span class="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm pointer-events-none transition-transform {checked ? 'translate-x-4' : ''}"></span>
	</span>
</button>
