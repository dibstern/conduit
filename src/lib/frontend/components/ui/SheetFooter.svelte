<script lang="ts">
	import { DropdownMenu } from "bits-ui";
	import { getContext } from "svelte";
	import { menuDensityContextKey, type MenuDensityContext } from "./menu-context.js";
	import Icon from "./Icon.svelte";
	import Switch from "./Switch.svelte";

	let { actions }: {
		actions: readonly { label: string; ariaLabel?: string; testId?: string; icon?: string; tag?: string; checked?: boolean; onselect: (event: Event) => void; disabled?: boolean }[];
	} = $props();
	const menuDensity = getContext<MenuDensityContext | undefined>(menuDensityContextKey);
	const sheet = $derived(menuDensity?.() === "sheet");
</script>

<div class="flex items-center justify-around gap-[4px] px-[8px] pt-[6px]">
	{#each actions as action (action.label)}
		<DropdownMenu.Item disabled={action.disabled ?? false} closeOnSelect={action.checked === undefined} onSelect={action.onselect} textValue={action.label} aria-label={action.ariaLabel} data-testid={action.testId} class="flex min-h-[44px] min-w-[44px] items-center justify-center gap-[6px] rounded-[8px] px-[6px] text-[13.5px] text-text-secondary cursor-pointer select-none touch-manipulation outline-hidden data-[highlighted]:bg-hover data-[disabled]:opacity-35">
			{#snippet child({ props })}
				<button {...props} {...(sheet ? { tabindex: 0 } : {})} type="button" role={action.checked === undefined ? (sheet ? "button" : "menuitem") : sheet ? "switch" : "menuitemcheckbox"} aria-checked={action.checked} disabled={action.disabled ?? false}>
					{#if action.icon}<span aria-hidden="true"><Icon name={action.icon} size={14} /></span>{/if}
					<span>{action.label}</span>
					{#if action.checked !== undefined}<Switch checked={action.checked} size="xs" />
					{:else if action.tag}<span class="rounded-[4px] bg-chip px-[5px] py-[1px] font-mono text-[10px] leading-[normal] text-text-dimmer">{action.tag}</span>{/if}
				</button>
			{/snippet}
		</DropdownMenu.Item>
	{/each}
</div>
