<script lang="ts">
	import type { HTMLTextareaAttributes } from "svelte/elements";
	import {
		FIELD_BASE_CLASSES,
		FIELD_CHROME_CLASSES,
		TEXTAREA_SIZE_CLASSES,
		type FieldChrome,
		type FieldControlSize,
	} from "./field-styles";
	import { getFieldContext } from "./field-context";

	type TextareaProps = {
		value?: string;
		size?: FieldControlSize;
		/**
		 * How the field is painted. `bare` drops the border, background, radius,
		 * text colour, transition and focus ring, for a textarea whose affordance
		 * is the row AROUND it. Pair it with `size="content"`.
		 */
		chrome?: FieldChrome;
		/** Standalone invalid flag; a wrapping <Field> also forces it. */
		invalid?: boolean;
		/**
		 * The real `<textarea>` node. `bind:this` on a COMPONENT tag hands back
		 * the component instance, so this is the only way out. The composer's
		 * auto-resize reads scrollHeight and writes style.height on every
		 * keystroke, and its mention menus read and move selectionStart
		 * (conduit-test-1k0g).
		 */
		element?: HTMLTextAreaElement | undefined;
		class?: string;
	} & Omit<HTMLTextareaAttributes, "class" | "value" | "aria-invalid">;

	let {
		value = $bindable(),
		size = "md",
		chrome = "bordered",
		invalid = false,
		element = $bindable(),
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
		[
			FIELD_BASE_CLASSES,
			FIELD_CHROME_CLASSES[chrome],
			TEXTAREA_SIZE_CLASSES[size],
			className,
		]
			.filter(Boolean)
			.join(" "),
	);
</script>

<textarea
	{...rest}
	bind:this={element}
	id={inputId}
	class={textareaClass}
	bind:value
	aria-invalid={isInvalid || undefined}
	aria-describedby={describedBy}
	required={isRequired || undefined}
></textarea>
