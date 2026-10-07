<!--
  Toggle — a labeled switch row, in Settings' frame H shape:
  [switch] [bold title / one-line description], separated by a hairline.
  The entire row is a single <button> — no nested interactive elements,
  proper semantics, and the full row is the touch target on mobile.

  `disabled` dims the whole row, matching ui/Button's disabled convention.
  There used to be a separate `dimmed` prop that faded only the switch, and
  every call site passed it alongside `disabled` — so a call site that forgot
  it got a disabled toggle indistinguishable from an enabled one.

  `class` REPLACES the row's padding and hairline, for a toggle that sits
  inside a row someone else already draws (ClaudeSettingRow).
-->
<script lang="ts">
	let {
		label,
		description,
		checked = false,
		onchange,
		disabled = false,
		ariaLabel,
		class: className,
	}: {
		label: string;
		description?: string;
		checked?: boolean;
		onchange?: () => void;
		disabled?: boolean;
		ariaLabel?: string;
		class?: string;
	} = $props();
</script>

<button
	type="button"
	role="switch"
	aria-checked={checked}
	aria-label={ariaLabel ?? `Toggle ${label.toLowerCase()}`}
	class="flex items-start gap-[10px] w-full text-left text-[11.5px] select-none touch-manipulation cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 {className ?? 'py-[8px] border-b border-border-subtle'}"
	{disabled}
	onclick={onchange}
>
	<span
		class="relative mt-[2px] h-[17px] w-[30px] shrink-0 rounded-full transition-colors {checked ? 'bg-brand-b' : 'bg-border-chip'}"
	>
		<span
			class="absolute left-[2px] top-[2px] h-[13px] w-[13px] rounded-full pointer-events-none transition-[translate,background-color] {checked ? 'translate-x-[13px] bg-white' : 'bg-text-secondary'}"
		></span>
	</span>
	<span class="min-w-0 flex-1">
		<span class="block text-text {description ? 'font-semibold mb-[2px]' : ''}">{label}</span>
		{#if description}
			<span class="block text-text-secondary">{description}</span>
		{/if}
	</span>
</button>
