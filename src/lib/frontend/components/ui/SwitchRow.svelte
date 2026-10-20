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
		controlled = false,
		showState = true,
		disabled = false,
		oncheckedchange,
		class: className = "",
		...rest
	}: {
		label: string;
		description?: string | undefined;
		icon?: string;
		saving?: boolean;
		controlled?: boolean;
		showState?: boolean;
		oncheckedchange?: (checked: boolean) => void;
	} & Omit<DropdownMenuCheckboxItemProps, "child" | "children" | "onCheckedChange" | "onSelect" | "closeOnSelect" | "textValue"> = $props();
</script>

<DropdownMenu.CheckboxItem {...rest} {checked} disabled={disabled || saving} closeOnSelect={false} textValue={label} aria-busy={saving} data-menu-switch-row
	onSelect={(event) => {
		if (controlled) {
			event.preventDefault();
			oncheckedchange?.(!checked);
		}
	}}
	onCheckedChange={(next) => { if (!controlled) checked = next; oncheckedchange?.(next); }}
	class="mt-[10px] flex h-[60px] w-full items-center gap-[12px] rounded-[14px] bg-chip px-[14px] text-text cursor-pointer select-none touch-manipulation outline-hidden data-[highlighted]:ring-[1.5px] data-[highlighted]:ring-accent data-[disabled]:cursor-not-allowed {className}"
>
	<span aria-hidden="true" class={checked ? "text-success" : "text-text-dimmer"}><Icon name={icon} size={16} /></span>
	<span class="min-w-0 flex-1 text-[14.5px] font-medium leading-[1.5]">
		{label}
		<span data-switch-status class="mt-[2px] block min-h-[18.75px] text-[12.5px] font-normal text-text-muted">{#if showState}<b class="font-semibold {checked ? 'text-success' : 'text-text-secondary'}">{checked ? "On" : "Off"}</b>{/if}{#if description}{showState ? ` · ${description}` : description}{/if}</span>
	</span>
	{#if saving}<span aria-hidden="true" class="size-[16px] shrink-0 animate-spin rounded-full border-2 border-border-chip border-t-accent [animation-duration:800ms]"></span>{/if}
	<Switch {checked} size="lg" pending={saving} />
</DropdownMenu.CheckboxItem>
