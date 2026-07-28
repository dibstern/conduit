<script lang="ts">
	import type { Snippet } from "svelte";
	import type { HTMLAttributes } from "svelte/elements";
	import { setFieldContext } from "./field-context";

	type FieldProps = {
		label?: string;
		hint?: string;
		error?: string;
		required?: boolean;
		/** Override the auto-generated control id (targets the child control, not the wrapper). */
		id?: string;
		class?: string;
		children: Snippet;
	} & Omit<HTMLAttributes<HTMLDivElement>, "class" | "id">;

	let {
		label,
		hint,
		error,
		required = false,
		id,
		class: className,
		children,
		...rest
	}: FieldProps = $props();

	const uid = $props.id();
	const inputId = $derived(id ?? uid);
	const hintId = $derived(`${inputId}-hint`);
	const errorId = $derived(`${inputId}-error`);
	const describedBy = $derived(error ? errorId : hint ? hintId : undefined);
	const invalid = $derived(Boolean(error));

	// Getters keep the wiring reactive across the context boundary.
	setFieldContext({
		get inputId() {
			return inputId;
		},
		get describedBy() {
			return describedBy;
		},
		get invalid() {
			return invalid;
		},
		get required() {
			return required;
		},
	});
</script>

<div
	{...rest}
	class={["flex flex-col gap-1.5", className].filter(Boolean).join(" ")}
>
	{#if label}
		<label for={inputId} class="text-sm font-medium text-text">
			{label}{#if required}<span class="text-error" aria-hidden="true">
					*</span
				>{/if}
		</label>
	{/if}
	{@render children()}
	{#if error}
		<p id={errorId} class="text-xs text-error" role="alert">{error}</p>
	{:else if hint}
		<p id={hintId} class="text-xs text-text-secondary">{hint}</p>
	{/if}
</div>
