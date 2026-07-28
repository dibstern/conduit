<script lang="ts">
	import type { Snippet } from "svelte";
	import type { HTMLSelectAttributes } from "svelte/elements";
	import {
		CONTROL_SIZE_CLASSES,
		FIELD_BASE_CLASSES,
		type FieldSize,
	} from "./field-styles";
	import { getFieldContext } from "./field-context";

	type SelectProps = {
		value?: string | number;
		size?: FieldSize;
		/** Standalone invalid flag; a wrapping <Field> also forces it. */
		invalid?: boolean;
		class?: string;
		children: Snippet;
	} & Omit<
		HTMLSelectAttributes,
		"class" | "size" | "value" | "multiple" | "aria-invalid"
	>;

	// Undefined default (not "") so Svelte keeps the native first-option selection
	// instead of rendering a blank, option-less control.
	let {
		value = $bindable(),
		size = "md",
		invalid = false,
		class: className,
		children,
		...rest
	}: SelectProps = $props();

	const field = getFieldContext();
	const inputId = $derived(field?.inputId ?? rest.id);
	// aria-describedby is additive: keep the consumer's ids AND the Field's.
	const describedBy = $derived(
		[field?.describedBy, rest["aria-describedby"]].filter(Boolean).join(" ") ||
			undefined,
	);
	// invalid/required are additive too — a Field never silently clears them.
	const isInvalid = $derived((field?.invalid ?? false) || invalid);
	const isRequired = $derived(
		(field?.required ?? false) || Boolean(rest.required),
	);

	const selectClass = $derived(
		[FIELD_BASE_CLASSES, CONTROL_SIZE_CLASSES[size], className]
			.filter(Boolean)
			.join(" "),
	);
</script>

<select
	{...rest}
	id={inputId}
	class={selectClass}
	bind:value
	aria-invalid={isInvalid || undefined}
	aria-describedby={describedBy}
	required={isRequired || undefined}
>
	{@render children()}
</select>
