<script lang="ts">
	import { DropdownMenu, type DropdownMenuCheckboxItemProps } from "bits-ui";
	import Icon from "./Icon.svelte";
	import Switch from "./Switch.svelte";

	let {
		checked = $bindable(false),
		label,
		description,
		icon = "zap",
		saving = false,
		disabled = false,
		oncheckedchange,
		class: className = "",
		...rest
	}: {
		label: string;
		description?: string;
		icon?: string;
		saving?: boolean;
		oncheckedchange?: (checked: boolean) => void;
	} & Omit<DropdownMenuCheckboxItemProps, "child" | "children" | "onCheckedChange" | "closeOnSelect" | "textValue"> = $props();
</script>

<DropdownMenu.CheckboxItem {...rest} {checked} disabled={disabled || saving} closeOnSelect={false} textValue={label} aria-busy={saving} data-menu-switch-row
	onCheckedChange={(next) => { checked = next; oncheckedchange?.(next); }}
	class="mt-[10px] flex h-[60px] w-full items-center gap-[12px] rounded-[14px] bg-chip px-[14px] text-text cursor-pointer select-none touch-manipulation outline-hidden data-[highlighted]:ring-[1.5px] data-[highlighted]:ring-accent data-[disabled]:cursor-not-allowed {className}"
>
	<span aria-hidden="true" class={checked ? "text-success" : "text-text-dimmer"}><Icon name={icon} size={20} /></span>
	<span class="min-w-0 flex-1 text-[14.5px] font-medium leading-[1.2]">
		{label}
		<span class="mt-[2px] block text-[12.5px] font-normal text-text-dimmer"><b class="font-semibold {checked ? 'text-success' : 'text-text-secondary'}">{checked ? "On" : "Off"}</b>{#if description}{` · ${description}`}{/if}</span>
	</span>
	{#if saving}<span aria-hidden="true" class="animate-spin text-text-dimmer"><Icon name="loader-circle" size={16} /></span>{/if}
	<Switch {checked} size="lg" pending={saving} />
</DropdownMenu.CheckboxItem>
