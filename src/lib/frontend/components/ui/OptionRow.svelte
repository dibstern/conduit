<script lang="ts" generics="T extends string">
	import { RadioGroup } from "bits-ui";
	import { tick, type Snippet } from "svelte";

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
		/** Width in the scroll row; height and item appearance belong to the caller. */
		itemWidth?: number;
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
	data-fade={moreToRight ? "true" : "false"}
	class="option-row {className}"
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
			class={itemClass}
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
	:global(.option-row[data-fade="true"]) {
		-webkit-mask-image: linear-gradient(to right, #000 calc(100% - 28px), transparent);
		mask-image: linear-gradient(to right, #000 calc(100% - 28px), transparent);
	}
</style>
