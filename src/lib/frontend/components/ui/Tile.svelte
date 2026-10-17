<script lang="ts">
	import { DropdownMenu, type DropdownMenuItemProps } from "bits-ui";
	import Icon from "./Icon.svelte";

	let {
		label,
		icon,
		subLine,
		tag,
		variant = "default",
		shape = "square",
		held = false,
		triggerProps,
		disabled = false,
		onselect,
		class: className = "",
		...rest
	}: {
		label: string;
		icon: string;
		subLine?: string;
		/** The caller decides: the phone sheet passes its hold hint, the desktop popover a shortcut. */
		tag?: string;
		variant?: "default" | "primary" | "danger";
		shape?: "square" | "wide";
		held?: boolean;
		/** Use the same tile as a composite control's trigger, with that control's semantics. */
		triggerProps?: Record<string, unknown>;
		onselect?: (event: Event) => void;
	} & Omit<DropdownMenuItemProps, "children" | "child" | "onSelect" | "textValue"> = $props();
</script>

{#snippet tile(props: Record<string, unknown>)}
	<button {...props} type="button" {disabled} data-menu-tile data-held={held || undefined} class="relative flex h-[72px] min-w-0 cursor-pointer select-none touch-manipulation flex-col items-center justify-center gap-[6px] rounded-[14px] text-center text-[13px] font-medium leading-[1.2] outline-hidden transition-transform motion-reduce:scale-100 motion-reduce:transition-none data-[disabled]:cursor-not-allowed {shape === 'wide' ? 'col-span-2' : ''} {variant === 'primary' ? 'text-accent' : variant === 'danger' ? 'text-error' : 'text-text'} {held ? 'scale-105 bg-popover-bg shadow-dropdown inset-ring-[1.5px] inset-ring-accent' : variant === 'primary' ? 'bg-accent/16' : variant === 'danger' ? 'bg-error/13' : 'bg-chip'} {held ? '' : 'data-[highlighted]:ring-[1.5px] data-[highlighted]:ring-accent'} {className}">
	<span aria-hidden="true" class:opacity-35={disabled}><Icon name={icon} size={20} /></span>
	<span class:opacity-35={disabled}>{label}</span>
	{#if subLine}<small class="-mt-[4px] text-[10.5px] font-normal leading-[1.2] text-text-dimmer">{subLine}</small>{/if}
	{#if tag}<span class="absolute top-[6px] right-[8px] font-mono text-[9.5px] font-normal text-text-dimmer">{tag}</span>{/if}
	</button>
{/snippet}

{#if triggerProps}
	{@render tile(triggerProps)}
{:else}
	<DropdownMenu.Item
		{...rest}
		{disabled}
		textValue={label}
		{...onselect ? { onSelect: onselect } : {}}
	>
		{#snippet child({ props })}{@render tile(props)}{/snippet}
	</DropdownMenu.Item>
{/if}

<style>
	/* A held tile lifts out of the sheet: every other row dims to 28%. */
	:global([data-sheet-body]:has([data-menu-tile][data-held])) :global(:is([data-menu-tile]:not([data-held]), [data-menu-switch-row], [data-dropdown-menu-group-heading])),
	:global([data-sheet-chrome]:has([data-menu-tile][data-held])) :global([data-sheet-footer]) { opacity: .28; }
</style>
