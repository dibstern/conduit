<script lang="ts">
	import type { HTMLTextareaAttributes } from "svelte/elements";
	import {
		FIELD_BASE_CLASSES,
		TEXTAREA_SIZE_CLASSES,
		type FieldSize,
	} from "./field-styles";
	import { getFieldContext } from "./field-context";

	type TextareaProps = {
		value?: string;
		size?: FieldSize;
		/** Standalone invalid flag; a wrapping <Field> also forces it. */
		invalid?: boolean;
		class?: string;
	} & Omit<HTMLTextareaAttributes, "class" | "value" | "aria-invalid">;

	let {
		value = $bindable(),
		size = "md",
		invalid = false,
		class: className,
		...rest
	}: TextareaProps = $props();

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

	const textareaClass = $derived(
		[FIELD_BASE_CLASSES, TEXTAREA_SIZE_CLASSES[size], className]
			.filter(Boolean)
			.join(" "),
	);
</script>

<textarea
	{...rest}
	id={inputId}
	class={textareaClass}
	bind:value
	aria-invalid={isInvalid || undefined}
	aria-describedby={describedBy}
	required={isRequired || undefined}
></textarea>
