<script module lang="ts">
	const TONES = {
		muted: "bg-text-muted", secondary: "bg-text-secondary", thinking: "bg-thinking",
		success: "bg-success", agent: "bg-harness-claude", error: "bg-error",
		compaction: "bg-text", live: "bg-accent",
	} as const;
</script>

<script lang="ts">
	let { segments, active = null, emphasis = null, onhover, onjump, interactive = true }: {
		segments: readonly { id: string; left: number; width: number; label: string; tone: keyof typeof TONES; running?: boolean }[];
		active?: number | null;
		emphasis?: ReadonlySet<number> | null;
		onhover?: ((index: number | null) => void) | undefined;
		onjump?: ((index: number) => void) | undefined;
		interactive?: boolean;
	} = $props();
	let cursor = $state(0);
	let hovered = $state<number | null>(null);
	let trackEl: HTMLDivElement | undefined = $state();
	let pointerId: number | undefined;
	const selected = $derived(Math.min(cursor, Math.max(0, segments.length - 1)));
	const highlighted = $derived(active ?? hovered);

	function hover(index: number | null) {
		hovered = index;
		onhover?.(index);
	}

	function stepAt(clientX: number): number {
		const rect = trackEl?.getBoundingClientRect();
		if (!rect?.width) return 0;
		const percent = Math.max(0, Math.min(100, (clientX - rect.left) / rect.width * 100));
		const index = segments.findIndex((segment) => percent <= segment.left + segment.width);
		return index < 0 ? segments.length - 1 : index;
	}

	function choose(index: number) {
		if (segments.length === 0) return;
		cursor = index;
		hover(index);
	}

	function scrub(event: KeyboardEvent) {
		let index: number;
		switch (event.key) {
			case "ArrowLeft": index = Math.max(0, selected - 1); break;
			case "ArrowRight": index = Math.min(segments.length - 1, selected + 1); break;
			case "Home": index = 0; break;
			case "End": index = segments.length - 1; break;
			case "Enter": case " ": index = selected; break;
			default: return;
		}
		event.preventDefault();
		event.stopPropagation();
		choose(index);
		if (segments.length > 0) onjump?.(index);
	}
</script>

<svelte:window
	onpointermove={(event) => {
		if (event.pointerId === pointerId) choose(stepAt(event.clientX));
	}}
	onpointerup={(event) => {
		if (event.pointerId !== pointerId) return;
		pointerId = undefined;
		const index = stepAt(event.clientX);
		choose(index);
		if (segments.length > 0) onjump?.(index);
	}}
	onpointercancel={() => { pointerId = undefined; hover(null); }}
/>

<div class={interactive ? "relative h-[44px] md:h-[16px] min-w-[44px]" : "relative h-[16px] min-w-[44px]"}>
	<!-- The nonnegative tabindex exists only together with the slider role. -->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div
		bind:this={trackEl}
		class="absolute inset-0 cursor-pointer touch-pan-y select-none outline-none focus-visible:ring-1 focus-visible:ring-accent"
		role={interactive ? "slider" : undefined}
		tabindex={interactive ? 0 : undefined}
		aria-label="Activity timeline — {segments.length} steps"
		aria-valuemin={interactive ? 0 : undefined}
		aria-valuemax={interactive ? Math.max(0, segments.length - 1) : undefined}
		aria-valuenow={interactive ? selected : undefined}
		aria-valuetext={interactive ? segments[selected]?.label ?? "No activity" : undefined}
		aria-disabled={segments.length === 0}
		onkeydown={interactive ? scrub : undefined}
		onfocus={() => { if (segments.length > 0) hover(selected); }}
		onblur={() => hover(null)}
		onpointerdown={(event) => {
			if (!interactive || event.button !== 0 || segments.length === 0) return;
			pointerId = event.pointerId;
			choose(stepAt(event.clientX));
		}}
		onpointermove={(event) => {
			if (event.pointerType === "mouse" && pointerId === undefined && segments.length > 0) hover(stepAt(event.clientX));
		}}
		onpointerleave={() => { if (pointerId === undefined) hover(null); }}
	>
		<div class="absolute top-1/2 inset-x-0 h-[4px] -translate-y-1/2 rounded-[2px] bg-chip" aria-hidden="true"></div>
		{#each segments as segment, index (segment.id)}
			<span
				data-step-id={segment.id}
				aria-hidden="true"
				class="absolute top-1/2 h-[4px] -translate-y-1/2 rounded-[1px] transition-opacity {TONES[segment.tone]} {segment.running ? 'animate-pulse' : ''} {highlighted === index || emphasis?.has(index) ? 'opacity-100' : emphasis ? 'opacity-20' : 'opacity-60'}"
				style="left: {segment.left}%; width: {segment.width}%;"
			></span>
		{/each}
	</div>
</div>
