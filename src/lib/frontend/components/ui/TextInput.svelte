<script lang="ts">
	import type { HTMLInputAttributes } from "svelte/elements";
	import {
		CONTROL_SIZE_CLASSES,
		FIELD_BASE_CLASSES,
		type FieldSize,
	} from "./field-styles";
	import { getFieldContext } from "./field-context";

	type TextInputProps = {
		value?: string | number;
		/** Text-like inputs only — checkbox/radio/file are separate primitives. */
		type?: "text" | "search" | "email" | "url" | "tel" | "password" | "number";
		size?: FieldSize;
		/** Standalone invalid flag; a wrapping <Field> also forces it. */
		invalid?: boolean;
		class?: string;
	} & Omit<
		HTMLInputAttributes,
		"class" | "size" | "type" | "value" | "aria-invalid"
	>;

	let {
		value = $bindable(),
		type = "text",
		size = "md",
		invalid = false,
		class: className,
		...rest
	}: TextInputProps = $props();

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

	const inputClass = $derived(
		[FIELD_BASE_CLASSES, CONTROL_SIZE_CLASSES[size], className]
			.filter(Boolean)
			.join(" "),
	);
</script>

<input
	{...rest}
	{type}
	id={inputId}
	class={inputClass}
	bind:value
	aria-invalid={isInvalid || undefined}
	aria-describedby={describedBy}
	required={isRequired || undefined}
/>
