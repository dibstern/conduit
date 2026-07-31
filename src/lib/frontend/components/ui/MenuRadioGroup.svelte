<script lang="ts">
	import { DropdownMenu, type DropdownMenuRadioGroupProps } from "bits-ui";
	import type { Snippet } from "svelte";

	type MenuRadioGroupProps = {
		value?: string | undefined;
		onvaluechange?: ((value: string) => void) | undefined;
		class?: string | undefined;
		children: Snippet;
	} & Omit<
		DropdownMenuRadioGroupProps,
		| "child"
		| "children"
		| "class"
		| "onValueChange"
		| "value"
	>;

	let {
		value = $bindable(""),
		onvaluechange,
		class: className,
		children,
		...rest
	}: MenuRadioGroupProps = $props();

	function handleValueChange(nextValue: string) {
		onvaluechange?.(nextValue);
	}

	const radioGroupProps: Omit<
		DropdownMenuRadioGroupProps,
		"child" | "children" | "onValueChange" | "value"
	> = $derived({
		...rest,
		...(className === undefined ? {} : { class: className }),
	});
</script>

<DropdownMenu.RadioGroup
	{...radioGroupProps}
	bind:value
	onValueChange={handleValueChange}
>
	{@render children()}
</DropdownMenu.RadioGroup>
