<!--
  ToggleSetting — A labeled toggle switch row with an icon.
  Renders: [icon] [label] .............. [switch]
  Used in notification settings and anywhere a boolean setting row is needed.
-->
<script lang="ts">
	import Icon from "./Icon.svelte";

	let {
		icon,
		label,
		checked = false,
		onchange,
		disabled = false,
		dimmed = false,
		ariaLabel,
	}: {
		icon: string;
		label: string;
		checked?: boolean;
		onchange?: () => void;
		disabled?: boolean;
		dimmed?: boolean;
		ariaLabel?: string;
	} = $props();
</script>

<div class="flex items-center gap-3 px-3.5 py-2.5">
	<span class="text-text-muted shrink-0">
		<Icon name={icon} size={16} />
	</span>
	<span class="flex-1 text-sm text-text">{label}</span>
	<button
		class="relative inline-flex items-center w-[34px] h-[20px] rounded-full cursor-pointer border-none transition-colors duration-200 {checked ? 'bg-accent' : 'bg-bg-surface'} {dimmed ? 'opacity-40' : ''}"
		role="switch"
		aria-checked={checked}
		aria-label={ariaLabel ?? `Toggle ${label.toLowerCase()}`}
		{disabled}
		onclick={onchange}
	>
		<span
			class="absolute rounded-full bg-bg shadow-sm"
			style="top: 2px; width: 16px; height: 16px; left: {checked ? '16px' : '2px'}; transition: left 0.2s ease-in-out;"
		></span>
	</button>
</div>
