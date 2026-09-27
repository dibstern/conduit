<!--
  Radio — the bare native radio, styled. See ui/Checkbox for why it is bare.

  CONTROLLED, not bound. `bind:group` is a DOM directive that only works on a
  real <input>, so it cannot cross a component boundary at all; and faking it
  with a bindable `group` prop would give every instance its own private group
  registry, leaving the browser's `name` attribute as the only thing actually
  enforcing single-selection. So the contract is explicit: pass `checked` and
  handle `onchange`. Give every member of a group the same `name`.

  Deliberately does NOT adopt a wrapping <Field>'s `inputId`, which ui/Checkbox
  and ui/TextInput both do. A radio is never alone: a Field around a group would
  hand the same id to every member, so its `<label for>` would point at whichever
  one mounted last and the rest would have no label. The remaining Field wiring
  (describedBy, invalid, required) applies per member and is adopted as usual.
  Label the group with a <fieldset>/<legend>, or by each option's own label.

  No `invalid` prop either, for the same reason: ARIA does not support
  `aria-invalid` on role="radio" -- validity is a property of the group, so it
  belongs on the radiogroup/fieldset the consumer owns, not on one option.
-->
<script lang="ts">
	import type { HTMLInputAttributes } from "svelte/elements";
	import { CHOICE_BASE_CLASSES } from "./field-styles";
	import { getFieldContext } from "./field-context";

	type RadioProps = {
		checked?: boolean;
		class?: string;
	} & Omit<HTMLInputAttributes, "class" | "type" | "checked" | "aria-invalid">;

	let { checked = false, class: className, ...rest }: RadioProps = $props();

	const field = getFieldContext();
	// aria-describedby is additive: keep the consumer's ids AND the Field's.
	const describedBy = $derived(
		[field?.describedBy, rest["aria-describedby"]].filter(Boolean).join(" ") ||
			undefined,
	);
	const isRequired = $derived(
		(field?.required ?? false) || Boolean(rest.required),
	);

	const inputClass = $derived(
		[CHOICE_BASE_CLASSES, className].filter(Boolean).join(" "),
	);
</script>

<input
	{...rest}
	type="radio"
	class={inputClass}
	{checked}
	aria-describedby={describedBy}
	required={isRequired || undefined}
/>
