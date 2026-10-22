<!--
  QuotaMeter — how much of an account's usage quota is spent: a 4px track whose
  fill is the share used, with a mono caption beside it.

  The fill is the secondary ink until 80% is used, amber from there and red when
  Account Limit says the account is limited. Two states have
  no number: `checking` (the probe is still running) dims the empty track, and
  `unknown` (the probe could not tell) leaves it empty at full strength, so a
  pending row and a row that will never get a number read differently.
-->
<script module lang="ts">
	const TRACK_WIDTH_CLASSES = {
		sm: "w-[40px]",
		md: "w-[56px]",
		lg: "w-[80px]",
	} as const;

	type QuotaUsed = number | "checking" | "unknown";

	function tone(used: QuotaUsed, warnAt: number | "off", limited: boolean): "normal" | "high" | "full" | "checking" | "unknown" {
		if (typeof used !== "number") return used;
		return limited ? "full" : used >= (warnAt === "off" ? 80 : warnAt) ? "high" : "normal";
	}

	const FILL_CLASSES = {
		normal: "bg-text-secondary",
		high: "bg-fill-amber",
		full: "bg-fill-red",
	} as const;

	const CAPTION_CLASSES = {
		normal: "text-text-secondary",
		high: "text-text-secondary",
		full: "text-error",
		checking: "text-text-dimmer",
		unknown: "text-text-muted",
	} as const;
	const USAGE_FILL_CLASSES = { normal: "bg-text-secondary", high: "bg-status-ask", full: "bg-status-red" } as const;
	const USAGE_CAPTION_CLASSES = { normal: "text-text-secondary", high: "text-status-ask", full: "text-status-red", checking: "text-text-dimmer", unknown: "text-text-dimmer" } as const;

	function defaultCaption(used: QuotaUsed, limited: boolean): string {
		if (used === "checking") return "checking…";
		if (used === "unknown") return "quota unknown";
		return limited ? "limited" : `${Math.max(0, Math.round(100 - used))}% left`;
	}
</script>

<script lang="ts">
	let {
		used,
		caption,
		warnAt = 80,
		limited = false,
		size = "md",
		track = true,
		variant = "headroom",
		trackWidth,
		gap = 8,
		trackTestId,
		captionTestId = "quota-meter-caption",
		class: className = "",
	}: {
		/** Percent of the quota used, 0 to 100, or a state with no number yet. */
		used: QuotaUsed;
		/** Replaces the default caption, e.g. "limited · Mon 9:00". */
		caption?: string | undefined;
		warnAt?: number | "off";
		/** Whether Account Limit says to wait for this account or window. */
		limited?: boolean;
		size?: keyof typeof TRACK_WIDTH_CLASSES | undefined;
		/** false keeps only the caption, for rows too narrow for the track. */
		track?: boolean | undefined;
		/** Usage values colour the caption at the same thresholds as the fill. */
		variant?: "headroom" | "usage";
		/** Compact footer tracks have literal widths from the approved design. */
		trackWidth?: number;
		gap?: 4 | 5 | 6 | 8;
		trackTestId?: string;
		captionTestId?: string;
		/** Layout only (margin, alignment). */
		class?: string | undefined;
	} = $props();

	const level = $derived(tone(used, warnAt, limited));
	const share = $derived(typeof used === "number" ? Math.max(0, Math.min(100, used)) : 0);
</script>

<span data-testid="quota-meter" data-state={level} class="inline-flex shrink-0 items-center {variant === 'usage' ? 'max-w-full' : ''} {gap === 8 ? 'gap-[8px]' : ''} {className}" style:gap={gap === 8 ? undefined : `${gap}px`}>
	{#if track}
		<span data-testid={trackTestId} aria-hidden="true" class="block h-[4px] overflow-hidden rounded-full {variant === 'usage' ? 'bg-text-dimmer/32' : 'bg-border-chip'} {TRACK_WIDTH_CLASSES[size]} {trackWidth === undefined ? '' : 'custom-track'} {variant === 'usage' ? 'usage-track' : ''} {level === 'checking' ? 'opacity-50' : ''}" style:--quota-track-width={trackWidth === undefined ? undefined : `${trackWidth}px`}>
			{#if level === "normal" || level === "high" || level === "full"}
				<span class="block h-full {variant === 'usage' ? USAGE_FILL_CLASSES[level] : FILL_CLASSES[level]}" style:width="{share}%"></span>
			{/if}
		</span>
	{/if}
	<span data-testid={captionTestId} class="whitespace-nowrap font-mono {variant === 'usage' ? 'text-[11px]' : 'text-[10.5px]'} {variant === 'usage' ? USAGE_CAPTION_CLASSES[level === 'high' && warnAt === 'off' ? 'normal' : level] : CAPTION_CLASSES[level]}">{caption ?? defaultCaption(used, limited)}</span>
</span>

<style>
	.custom-track {
		width: var(--quota-track-width);
	}

	@container sidebar (width < 210px) {
		.usage-track {
			width: min(var(--quota-track-width, 40px), 26px);
		}
	}
</style>
