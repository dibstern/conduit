<script lang="ts">
	import type { HTMLInputAttributes } from "svelte/elements";
	import {
		CONTROL_SIZE_CLASSES,
		FIELD_BASE_CLASSES,
		FIELD_CHROME_CLASSES,
		type FieldChrome,
		type FieldControlSize,
	} from "./field-styles";
	import { getFieldContext } from "./field-context";

	type TextInputProps = {
		value?: string | number;
		/** Text-like inputs only — checkbox/radio/file are separate primitives. */
		type?: "text" | "search" | "email" | "url" | "tel" | "password" | "number";
		size?: FieldControlSize;
		/**
		 * How the field is painted. `bare` drops the border, background,
		 * placeholder colour and focus ring, for fields whose affordance is the
		 * bordered row AROUND them. Pair it with `size="content"`: a chromeless
		 * field that still forces `h-9` has only half opted out.
		 */
		chrome?: FieldChrome;
		/** Standalone invalid flag; a wrapping <Field> also forces it. */
		invalid?: boolean;
		/**
		 * Focus on mount. Handled here rather than passed through, because the
		 * HTML attribute only means anything while the document is first parsed:
		 * spread onto this input at runtime it sets a property nothing reads, and
		 * the field silently never takes focus. Three call sites had each worked
		 * around that with an identical one-line `use:focusOnMount` action, which
		 * is the other thing that cannot cross a component boundary
		 * (conduit-test-de3.35.7).
		 */
		autofocus?: boolean;
		/**
		 * The real `<input>` node. `bind:this` on a COMPONENT tag hands back the
		 * component instance, not the element, so without this no call site can
		 * focus the field later, `.select()` it, or read its geometry — and both
		 * chromeless call sites needed to (conduit-test-d1d4). `autofocus` below covers only the one
		 * case of focusing on mount.
		 */
		element?: HTMLInputElement | undefined;
		class?: string;
	} & Omit<
		HTMLInputAttributes,
		"class" | "size" | "type" | "value" | "aria-invalid" | "autofocus"
	>;

	let {
		value = $bindable(),
		type = "text",
		size = "md",
		chrome = "bordered",
		invalid = false,
		autofocus = false,
		element = $bindable(),
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

	// Deliberately not rendered as an `autofocus` attribute: it would do nothing
	// (see the prop doc) and would trip svelte-check's a11y_autofocus rule for
	// the trouble.
	$effect(() => {
		if (autofocus) element?.focus();
	});

	const inputClass = $derived(
		[
			FIELD_BASE_CLASSES,
			FIELD_CHROME_CLASSES[chrome],
			CONTROL_SIZE_CLASSES[size],
			className,
		]
			.filter(Boolean)
			.join(" "),
	);
</script>

<input
	{...rest}
	bind:this={element}
	{type}
	id={inputId}
	class={inputClass}
	bind:value
	aria-invalid={isInvalid || undefined}
	aria-describedby={describedBy}
	required={isRequired || undefined}
/>
