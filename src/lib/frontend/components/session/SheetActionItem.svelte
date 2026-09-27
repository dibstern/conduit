<script lang="ts">
	import type { Snippet } from "svelte";
	import Icon from "../ui/Icon.svelte";
	import Button from "../ui/Button.svelte";

	let {
		children,
		onselect,
		disabled = false,
		variant = "default",
		class: className = "",
		"data-testid": testId,
		"aria-checked": checked,
	}: {
		children: Snippet;
		onselect: () => void;
		disabled?: boolean;
		variant?: "default" | "danger";
		class?: string;
		"data-testid"?: string;
		"aria-checked"?: boolean;
	} = $props();
</script>

<Button
	variant="ghost"
	size="content"
	layout="flow"
	tone="inherit"
	hoverFill="none"
	disabledStyle="none"
	type="button"
	role={checked !== undefined ? "checkbox" : undefined}
	{disabled}
	data-testid={testId}
	aria-checked={checked}
	class="flex min-h-[44px] w-full items-center gap-3 px-4 text-left font-brand text-[14px] {variant === 'danger' ? 'text-error' : 'text-text'} disabled:text-text-dimmer disabled:opacity-50 {className}"
	onclick={onselect}
>
	{#if variant === "danger"}<Icon name="trash-2" size={13} />{/if}
	{@render children()}
</Button>
