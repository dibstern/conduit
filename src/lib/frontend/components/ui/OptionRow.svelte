<script lang="ts" generics="T extends string">
	import { RadioGroup } from "bits-ui";
	import { tick, type Snippet } from "svelte";
	import { SEGMENTED_VARIANTS, segmentedItemClass } from "./segmented-styles.js";

	let {
		options,
		value,
		onChange,
		onActivate,
		item,
		label,
		lockedReason,
		scrollThreshold = 4,
		itemWidth,
		variant = "plain",
		class: className = "",
		itemClass = "",
		testId,
		itemTestId,
	}: {
		options: readonly { value: T; label: string; locked?: boolean; lockedReason?: string | undefined }[];
		value: T;
		onChange: (value: T) => void;
		/** Explicit activation, even when the option is already selected. */
		onActivate?: ((value: T) => void) | undefined;
		item: Snippet<[{ value: T; label: string; locked?: boolean }, boolean]>;
		label: string;
		lockedReason?: string;
		scrollThreshold?: number;
		/** Width of an option when the row scrolls. */
		itemWidth?: number;
		variant?: "plain" | "joined" | "cards";
		class?: string;
		itemClass?: string;
		testId?: string;
		itemTestId?: (value: T) => string;
	} = $props();

	const id = $props.id();
	const reasonId = `${id}-locked`;
	const scrolling = $derived(options.length >= scrollThreshold);
	let row: HTMLDivElement | null = $state(null);
	let moreToRight = $state(false);

	function updateFade() {
		moreToRight = !!row && scrolling && row.scrollWidth - row.clientWidth - row.scrollLeft > 1;
	}

	$effect(() => {
		const element = row;
		const selected = options.find((option) => option.value === value);
		if (!element) return;
		const scroll = scrolling;
		let cancelled = false;
		void tick().then(() => {
			if (cancelled) return;
			if (scroll && selected) {
				const tab = Array.from(element.querySelectorAll<HTMLElement>("[data-radio-group-item]"))
					.find((tab) => tab.dataset["value"] === selected.value);
				tab?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
			}
			updateFade();
		});
		return () => { cancelled = true; };
	});

	$effect(() => {
		if (!row) return;
		const resize = new ResizeObserver(updateFade);
		resize.observe(row);
		return () => resize.disconnect();
	});
</script>

<RadioGroup.Root
	bind:ref={row}
	bind:value={() => value, (next) => {
		const option = options.find((option) => option.value === next);
		if (option && !option.locked) onChange(option.value);
	}}
	orientation="horizontal"
	aria-label={label}
	data-testid={testId}
	data-layout={scrolling ? "scroll" : "segmented"}
	data-variant={variant}
	data-fade={moreToRight ? "true" : "false"}
	class="option-row {variant === 'joined' ? SEGMENTED_VARIANTS.joined.list : ''} {className}"
	style="--option-count:{Math.max(options.length, 1)};--option-width:{itemWidth === undefined ? 'max-content' : `${itemWidth}px`};"
	onscroll={updateFade}
>
	{#each options as option (option.value)}
		<RadioGroup.Item
			type="button"
			value={option.value}
			disabled={option.locked}
			aria-label={option.label}
			aria-disabled={option.locked ? "true" : undefined}
			aria-describedby={option.locked ? (option.lockedReason ? `${reasonId}-${option.value}` : lockedReason ? reasonId : undefined) : undefined}
			data-testid={itemTestId?.(option.value)}
			class={variant === "joined"
				? segmentedItemClass("joined", option.value === value, `min-w-0 flex-1 gap-[6px] ${itemClass}`)
				: variant === "cards"
					? `block min-w-0 rounded-[10px] text-left focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2 ${itemClass}`
					: itemClass}
			onclick={() => { if (!option.locked) onActivate?.(option.value); }}
			onkeydowncapture={(event) => {
				if (event.key === " " && !option.locked) onActivate?.(option.value);
			}}
		>
			{@render item(option, option.value === value)}
		</RadioGroup.Item>
	{/each}
</RadioGroup.Root>
{#if lockedReason && options.some((option) => option.locked)}
	<span id={reasonId} class="sr-only">{lockedReason}</span>
{/if}
{#each options as option (option.value)}
	{#if option.locked && option.lockedReason}
		<span id={`${reasonId}-${option.value}`} class="sr-only">{option.lockedReason}</span>
	{/if}
{/each}

<style>
	:global(.option-row[data-variant="joined"] > [data-radio-group-item]) {
		min-height: 30px;
		font-size: 13px;
	}
	:global(.option-row[data-variant="cards"] [data-option-card]) {
		display: grid;
		width: 100%;
		height: 100%;
		min-width: 0;
		gap: 6px;
		border-radius: 10px;
		padding: 8px 9px;
		background: var(--color-chip);
		font-size: 12.5px;
		font-weight: 500;
	}
	:global(.option-row[data-variant="cards"] [data-state="checked"] > [data-option-card]) {
		box-shadow: inset 0 0 0 1.5px var(--color-accent);
	}
	:global(.option-row[data-variant="cards"] [data-option-card][data-limited="true"]) { opacity: .55; }
	:global(.option-row[data-variant="cards"] [data-option-card][data-locked="true"]) { opacity: .5; }
	@media (max-width: 767px) {
		:global(.option-row[data-variant="joined"] > [data-radio-group-item]) { min-height: 44px; }
		:global(.option-row[data-variant="cards"] [data-option-card]) { min-height: 44px; }
	}
	:global(.option-row[data-layout="segmented"]) {
		display: grid;
		grid-template-columns: repeat(var(--option-count), minmax(0, 1fr));
	}
	:global(.option-row[data-layout="scroll"]) {
		display: flex;
		gap: 6px;
		overflow-x: auto;
		scrollbar-width: none;
		scroll-snap-type: x mandatory;
		scroll-padding-inline-end: 28px;
		padding-right: 28px;
	}
	:global(.option-row[data-layout="scroll"]::-webkit-scrollbar) { display: none; }
	:global(.option-row[data-layout="scroll"] > [data-radio-group-item]) {
		flex: none;
		width: var(--option-width);
		scroll-snap-align: start;
	}
	/* Match the joined track's 2px inset, or mandatory snapping parks scrollLeft at 2. */
	:global(.option-row[data-variant="joined"][data-layout="scroll"]) { scroll-padding-inline-start: 2px; }
	:global(.option-row[data-variant="joined"][data-layout="scroll"] > [data-radio-group-item]) {
		padding-inline: 4px;
		font-size: 12px;
		white-space: nowrap;
	}
	:global(.option-row[data-fade="true"]) {
		-webkit-mask-image: linear-gradient(to right, #000 calc(100% - 28px), transparent);
		mask-image: linear-gradient(to right, #000 calc(100% - 28px), transparent);
	}
</style>
