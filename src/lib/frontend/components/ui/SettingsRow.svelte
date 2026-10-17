<!--
  SettingsRow — one line of a settings card: label (and optional description)
  on the left, the control on the right. SettingsGroup draws the card and the
  hairlines between rows; a row draws neither.

  Three shapes, as a union:
  - toggle (`checked`, `onchange`, `disabled`): the WHOLE row is one
    role="switch" button. No nested interactive elements, and the full row is
    the touch target on phones. Acceptance steps find these by `ariaLabel`.
  - control: an optional snippet on the right (select, segments, buttons).
    Pass `labelFor` when the control is a single form field, so the label
    names it. Without one the row is just text, for rows whose editor sits
    below them.
  - navigation (`onclick`, optional `summary` and `expanded`): a chevron-led
    row for navigation or a collapsible group's header.

  The row wraps rather than squeezing: the label keeps a 12rem basis, so a
  switch always fits beside it, while a wide control (segments, a full-width
  input) drops under the label on a phone.

  `disabled` dims the whole toggle row, matching ui/Button's convention.

  `class` REPLACES the row's padding, for a row that sits inside one someone
  else already pads (ClaudeSettingRow, which adds a provenance line below).
-->
<script lang="ts">
	import type { Snippet } from "svelte";
	import Switch from "./Switch.svelte";
	import Icon from "./Icon.svelte";

	type Common = {
		label: string;
		labelSuffix?: Snippet;
		description?: string;
		descriptionTone?: "neutral" | "success" | "warning";
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
	type NavigationProps = Common & {
		onclick: () => void;
		summary?: string;
		expanded?: boolean;
		labelId?: string;
		disabled?: boolean;
		checked?: undefined;
	};

	const props: ToggleProps | ControlProps | NavigationProps = $props();
	const padding = $derived(props.class ?? "px-[14px] py-[8px] min-h-[46px] max-md:min-h-[48px]");
</script>

{#snippet text()}
	<span class="block text-[13.5px] max-md:text-[15px] text-text">{props.label}{#if props.labelSuffix}<span class="ml-1.5 inline-flex align-middle">{@render props.labelSuffix()}</span>{/if}</span>
	{#if props.description}
		<span class="mt-px block text-[12px] leading-[1.4] {props.descriptionTone === 'success' ? 'text-success' : props.descriptionTone === 'warning' ? 'text-warning' : 'text-text-muted'}">{props.description}</span>
	{/if}
{/snippet}

{#if "onclick" in props}
	<button
		type="button"
		onclick={props.onclick}
		aria-expanded={props.expanded}
		disabled={props.disabled}
		data-testid={props.testId}
		class="flex min-h-[42px] max-md:min-h-[44px] w-full items-center gap-[8px] px-[14px] py-2 text-left text-[13.5px] text-text-secondary cursor-pointer focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-text disabled:opacity-50 disabled:cursor-not-allowed {props.class ?? ''}"
	>
		<Icon name="chevron-right" size={13} class="shrink-0 text-text-dimmer transition-transform {props.expanded ? 'rotate-90' : ''}" />
		<span id={props.labelId} class="min-w-0 flex-1">{props.label}</span>
		{#if props.summary}<span class="min-w-0 truncate text-[12px] text-text-dimmer">{props.summary}</span>{/if}
	</button>
{:else if props.checked !== undefined}
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
		<Switch checked={props.checked} />
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
