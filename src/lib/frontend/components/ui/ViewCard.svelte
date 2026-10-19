<script lang="ts">
	import { DropdownMenu, type DropdownMenuRadioItemProps } from "bits-ui";
	import Icon from "./Icon.svelte";

	let { value, label, icon, preview, badge = 0, disabled = false, onselect, class: className = "", ...rest }: {
		value: string;
		label: string;
		icon: string;
		preview: "chat" | "terminal" | "diff" | "files";
		badge?: number | undefined;
		onselect?: (event: Event) => void;
	} & Omit<DropdownMenuRadioItemProps, "children" | "child" | "onSelect" | "onselect" | "textValue"> = $props();
	const badgeId = $props.id();
	const itemProps: Omit<DropdownMenuRadioItemProps, "child" | "children"> = $derived({
		...rest,
		value,
		disabled,
		textValue: label,
		onSelect: (event) => onselect?.(event),
	});
</script>

<DropdownMenu.RadioItem {...itemProps}>
	{#snippet child({ props, checked })}
		<!-- The current view has nothing unread to point at. -->
		{@const showBadge = badge > 0 && !checked}
		<button {...props} type="button" {disabled} aria-label={label} aria-describedby={showBadge ? badgeId : undefined} data-view-card class="relative min-h-[44px] min-w-0 cursor-pointer rounded-[14px] bg-chip p-[5px] text-left text-text outline-hidden disabled:cursor-not-allowed disabled:opacity-38 data-[highlighted]:ring-2 data-[highlighted]:ring-accent {checked ? 'inset-ring-[1.5px] inset-ring-accent' : ''} {className}">
			<div aria-hidden="true" class="h-[60px] overflow-hidden whitespace-nowrap rounded-[9px] bg-bg px-[7px] py-[6px] font-mono text-[8px] leading-[11.04px] text-text-secondary">
				{#if preview === "chat"}
					{#each [62, 92, 78, 50, 58] as width, index (index)}
						<i class="mb-[5px] block h-[5px] rounded-[3px] bg-text-dimmer opacity-35" style:width={`${width}%`} style:margin-left={index === 0 || index === 4 ? `${100 - width}%` : undefined}></i>
					{/each}
				{:else if preview === "terminal"}
					<span class="text-accent">❯</span> pnpm test<br />
					<span class="text-success">✓ 43 passed</span><br />
					<span class="text-accent">❯</span> git status<br />M unread.ts
				{:else if preview === "diff"}
					<span class="text-success">+ const seen =</span><br />
					<span class="text-error">- row.count</span><br />
					<span class="text-success">+ m.at &gt; seen</span>
				{:else}
					▾ stores<br />&nbsp;unread.ts <span class="text-status-pinned">M</span><br />
					▾ test<br />&nbsp;unread.test.ts <span class="text-success">A</span>
				{/if}
			</div>
			<span class="flex h-[26px] items-center gap-[5px] px-[3px] text-[12.5px] font-medium {checked ? 'text-accent' : ''}"><Icon name={icon} size={14} />{label}</span>
			{#if showBadge}<span id={badgeId} class="absolute -top-[5px] -right-[5px] grid size-[18px] place-items-center rounded-full bg-accent font-sans text-[11px] font-semibold text-bg">{badge}<span class="sr-only"> unread view updates</span></span>{/if}
		</button>
	{/snippet}
</DropdownMenu.RadioItem>
