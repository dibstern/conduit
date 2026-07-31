<script lang="ts">
	import { DropdownMenu } from "bits-ui";
	import type { Snippet } from "svelte";
	import type { HTMLAttributes } from "svelte/elements";

	type MenuRadioGroupProps = {
		value?: string;
		onvaluechange?: (value: string) => void;
		class?: string;
		children: Snippet;
	} & Omit<
		HTMLAttributes<HTMLDivElement>,
		"class" | "children" | "value" | "onchange"
	>;

	let {
		value = $bindable(""),
		onvaluechange,
		class: className,
		children,
		...rest
	}: MenuRadioGroupProps = $props();
</script>

<DropdownMenu.RadioGroup
	{...rest}
	bind:value
	onValueChange={onvaluechange}
	class={className}
>
	{@render children()}
</DropdownMenu.RadioGroup>
