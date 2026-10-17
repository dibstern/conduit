<script lang="ts">
	import type { HTMLButtonAttributes } from "svelte/elements";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import Icon from "./Icon.svelte";
	import Menu from "./Menu.svelte";
	import MenuGroup from "./MenuGroup.svelte";
	import MenuRadioGroup from "./MenuRadioGroup.svelte";
	import MenuRadioItem from "./MenuRadioItem.svelte";

	let {
		value,
		options,
		label,
		onvaluechange,
		disabled = false,
		invalid = false,
		class: className,
		...rest
	}: {
		value: string;
		options: readonly { value: string; label: string; disabled?: boolean; testId?: string; group?: string }[];
		label: string;
		onvaluechange: (value: string) => void;
		invalid?: boolean;
	} & Omit<HTMLButtonAttributes, "value" | "children" | "onclick"> = $props();

	const selected = $derived(options.find((option) => option.value === value));
	const groups = $derived([...new Set(options.map((option) => option.group))]);
</script>

<Menu ariaLabel={label} align="end" presentation={sessionViewState.compact ? "sheet" : "popover"}>
	{#snippet trigger({ props })}
		<!-- svelte-ignore a11y_role_supports_aria_props_implicit (This picker replaces a select and must preserve its validation state.) -->
		<button
			{...props}
			{...rest}
			type="button"
			{disabled}
			aria-label={`${rest["aria-label"] ?? label}: ${selected?.label ?? value}`}
			aria-invalid={invalid || undefined}
			data-invalid={invalid || undefined}
			data-value={value}
			class={["group inline-flex max-w-full min-h-[28px] items-center justify-end gap-[4px] text-[13px] text-text-secondary max-md:min-h-[44px] cursor-pointer rounded-md focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-text disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:text-error", className].filter(Boolean).join(" ")}
		>
			<span class="truncate">{selected?.label ?? value}</span>
			<Icon name="chevron-down" size={13} class="shrink-0 text-text-dimmer group-aria-invalid:text-error" />
		</button>
	{/snippet}
	<MenuRadioGroup {value} {onvaluechange}>
		{#each groups as group (group)}
			<MenuGroup label={group ?? label}>
				{#each options.filter((option) => option.group === group) as option (option.value)}
					<MenuRadioItem value={option.value} disabled={option.disabled} data-value={option.value} data-testid={option.testId}>{option.label}</MenuRadioItem>
				{/each}
			</MenuGroup>
		{/each}
	</MenuRadioGroup>
</Menu>
