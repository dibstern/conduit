<!--
  SettingsRow — one line of a settings card: label (and optional description)
  on the left, the control on the right. SettingsGroup draws the card and the
  hairlines between rows; a row draws neither.

  Two shapes, as a union:
  - toggle (`checked`, `onchange`, `disabled`): the WHOLE row is one
    role="switch" button. No nested interactive elements, and the full row is
    the touch target on phones. Acceptance steps find these by `ariaLabel`.
  - control: an optional snippet on the right (select, segments, buttons).
    Pass `labelFor` when the control is a single form field, so the label
    names it. Without one the row is just text, for rows whose editor sits
    below them.

  The row wraps rather than squeezing: the label keeps a 12rem basis, so a
  switch always fits beside it, while a wide control (segments, a full-width
  input) drops under the label on a phone.

  `disabled` dims the whole toggle row, matching ui/Button's convention.

  `class` REPLACES the row's padding, for a row that sits inside one someone
  else already pads (ClaudeSettingRow, which adds a provenance line below).
-->
<script lang="ts">
	import type { Snippet } from "svelte";

	type Common = {
		label: string;
		description?: string;
		class?: string;
		testId?: string;
	};
	type ToggleProps = Common & {
		checked: boolean;
		onchange: () => void;
		disabled?: boolean;
		ariaLabel?: string;
		control?: undefined;
		labelFor?: undefined;
	};
	type ControlProps = Common & {
		control?: Snippet;
		labelFor?: string;
		checked?: undefined;
	};

	const props: ToggleProps | ControlProps = $props();
	const padding = $derived(props.class ?? "px-[12px] py-[8px] min-h-[40px]");
</script>

{#snippet text()}
	<span class="block text-[12.5px] text-text">{props.label}</span>
	{#if props.description}
		<span class="block text-[11px] leading-[1.35] text-text-muted">{props.description}</span>
	{/if}
{/snippet}

{#if props.checked !== undefined}
	<button
		type="button"
		role="switch"
		aria-checked={props.checked}
		aria-label={props.ariaLabel ?? `Toggle ${props.label.toLowerCase()}`}
		data-testid={props.testId}
		class="flex items-center justify-between gap-[12px] w-full text-left select-none touch-manipulation cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 {padding}"
		disabled={props.disabled}
		onclick={props.onchange}
	>
		<span class="min-w-0">{@render text()}</span>
		<span
			class="relative h-[18px] w-[32px] shrink-0 rounded-full transition-colors {props.checked ? 'bg-success' : 'bg-border'}"
		>
			<span
				class="absolute left-[2px] top-[2px] h-[14px] w-[14px] rounded-full bg-white pointer-events-none transition-[translate] {props.checked ? 'translate-x-[14px]' : ''}"
			></span>
		</span>
	</button>
{:else}
	<div data-testid={props.testId} class="flex flex-wrap items-center justify-between gap-x-[12px] gap-y-1.5 {padding}">
		{#if props.labelFor}
			<label for={props.labelFor} class="min-w-0 flex-[1_1_12rem]">{@render text()}</label>
		{:else}
			<div class="min-w-0 flex-[1_1_12rem]">{@render text()}</div>
		{/if}
		{#if props.control}
			<div class="flex max-w-full shrink-0 items-center gap-1.5">{@render props.control()}</div>
		{/if}
	</div>
{/if}
