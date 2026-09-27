<!--
  Checkbox — the bare native checkbox, styled.

  Bare on purpose: it renders an <input> and nothing else. Every call site
  already owns its own row or card chrome, and those chromes have nothing in
  common -- QuestionCard wraps each option in a bordered card that turns accent
  when selected, SettingsPanel puts one inline in a form row. Only the control
  itself was ever shared, so only the control lives here. Same split as
  ui/TextInput, which likewise leaves the label and layout to ui/Field or the
  consumer.

  For a labelled on/off row with a switch, use ui/Toggle instead. This is the
  control you reach for when the thing being ticked sits inside a list or form
  the feature already lays out.
-->
<script lang="ts">
	import type { HTMLInputAttributes } from "svelte/elements";
	import { CHOICE_BASE_CLASSES } from "./field-styles";
	import { getFieldContext } from "./field-context";

	type CheckboxProps = {
		checked?: boolean;
		/** Standalone invalid flag; a wrapping <Field> also forces it. */
		invalid?: boolean;
		class?: string;
	} & Omit<HTMLInputAttributes, "class" | "type" | "checked" | "aria-invalid">;

	let {
		checked = $bindable(false),
		invalid = false,
		class: className,
		...rest
	}: CheckboxProps = $props();

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
		[CHOICE_BASE_CLASSES, className].filter(Boolean).join(" "),
	);
</script>

<input
	{...rest}
	type="checkbox"
	id={inputId}
	class={inputClass}
	bind:checked
	aria-invalid={isInvalid || undefined}
	aria-describedby={describedBy}
	required={isRequired || undefined}
/>
