<script lang="ts">
	import { Schema } from "effect";
	import { untrack } from "svelte";
	import { CategorySchema, categoryIdFromLabel, type Category } from "../../../contracts/category-set.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import Button from "../ui/Button.svelte";
	import ColourSwatches from "../ui/ColourSwatches.svelte";
	import Field from "../ui/Field.svelte";
	import SettingsGroup from "../ui/SettingsGroup.svelte";
	import TextArea from "../ui/Textarea.svelte";
	import TextInput from "../ui/TextInput.svelte";

	let { category, creating, persisted, categories, disabled = false, onSave, onCancel }: {
		category: Category; creating: boolean; persisted: boolean; categories: readonly Category[]; disabled?: boolean;
		onSave: (category: Category) => void; onCancel: () => void;
	} = $props();
	// The keyed parent remounts the form for each edit; typing only changes this draft.
	const initial = untrack(() => category);
	let label = $state(initial.label);
	let glyph = $state(initial.glyph);
	let colour = $state(initial.colour);
	let weight = $state<string | number>(initial.weight);
	let what = $state(initial.criteria.what);
	let notFor = $state(initial.criteria.not_for ?? "");
	let examples = $state(initial.criteria.examples?.join("\n") ?? "");
	const builtin = $derived(category.origin === "builtin");
	const id = $derived(builtin || persisted ? category.id : categoryIdFromLabel(label));
	const errors = $derived({
		label: !Schema.is(CategorySchema.fields.label)(label) ? "Label must be 1–24 characters." : "",
		glyph: !Schema.is(CategorySchema.fields.glyph)(glyph) ? "Glyph must be one character." : "",
		colour: !Schema.is(CategorySchema.fields.colour)(colour) ? "Use a hex colour such as #2a9fd6." : "",
		weight: weight === "" || !Schema.is(CategorySchema.fields.weight)(Number(weight)) ? "Weight must be between 0 and 100." : "",
		id: !Schema.is(CategorySchema.fields.id)(id) ? "Label must contain a letter or number." : id === "routine" || categories.some((c) => c.id === id && (creating || c.id !== category.id)) ? "That category already exists or is reserved." : "",
		limit: creating && categories.filter((c) => !c.retired).length >= 20 ? "At most 20 categories may be active." : "",
	});
	const invalid = $derived(Object.values(errors).some(Boolean));

	function submit(): void {
		if (invalid || disabled) return;
		onSave({ ...category, id, label, glyph, colour, weight: Number(weight), criteria: {
			what, ...(notFor ? { not_for: notFor } : {}), ...(examples ? { examples: examples.split("\n") } : {}),
		} });
	}
</script>

<form aria-label={creating ? "Add category" : `Edit ${category.label}`} data-testid="surfacing-category-editor" novalidate onsubmit={(event) => { event.preventDefault(); submit(); }}>
	<!-- On a phone the pushed page's header already names the form. -->
	<SettingsGroup title={sessionViewState.compact ? "" : creating ? "Add category" : `Edit ${category.label}`}>
		<div class="flex flex-col gap-[12px] px-[14px] py-[12px]">
			{#if !builtin}
				<!-- An empty field explains itself through the disabled Apply; errors are for what was typed. -->
				<Field variant="settings" label="Label" id="surfacing-category-label" error={label ? errors.label || errors.id : ""}>
					<TextInput bind:value={label} {disabled} />
				</Field>
				<Field variant="settings" label="Glyph" id="surfacing-category-glyph" error={glyph ? errors.glyph : ""}>
					<TextInput bind:value={glyph} {disabled} />
				</Field>
				<Field variant="settings" label="Colour" id="surfacing-category-colour" error={errors.colour}>
					<div class="flex flex-wrap items-center justify-between gap-2">
						<ColourSwatches value={colour} onchange={(next) => { colour = next; }} {disabled} />
						<div class="w-[96px]"><TextInput bind:value={colour} {disabled} class="font-mono" /></div>
					</div>
				</Field>
			{/if}
			<Field variant="settings" label="Weight" id="surfacing-category-weight" error={errors.weight}>
				<div class="w-[96px]"><TextInput type="number" min="0" max="100" step="any" bind:value={weight} {disabled} /></div>
			</Field>
			<Field variant="settings" label="Surface when" id="surfacing-category-what">
				<TextArea rows={3} bind:value={what} {disabled} />
			</Field>
			<Field variant="settings" label="Not for" id="surfacing-category-not-for">
				<TextArea rows={2} bind:value={notFor} {disabled} />
			</Field>
			<Field variant="settings" label="Examples, one per line" id="surfacing-category-examples">
				<TextArea rows={3} bind:value={examples} {disabled} />
			</Field>
			{#if errors.limit}<p role="alert" class="text-[12px] text-error">{errors.limit}</p>{/if}
		</div>
	</SettingsGroup>
	<div class="my-[12px] flex justify-end gap-2">
		<Button variant="ghost" size="sm" {disabled} onclick={onCancel}>Cancel</Button>
		<Button type="submit" variant="primary" size="sm" disabled={disabled || invalid} data-testid="surfacing-category-apply">Apply to draft</Button>
	</div>
</form>
