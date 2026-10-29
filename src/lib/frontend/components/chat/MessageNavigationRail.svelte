<script lang="ts">
	import type { TranscriptView } from "../../stores/transcript.svelte.js";
	import { formatClockTime } from "../../utils/format.js";

	let { prompts, activeId, pending = false, paneWidth, topClearance = 0, onnavigate }: {
		prompts: TranscriptView["prompts"];
		activeId: string | null;
		pending?: boolean;
		paneWidth: number;
		topClearance?: number;
		onnavigate: (id: string) => void;
	} = $props();
	let captured = $state.raw<TranscriptView["prompts"] | null>(null);
	const entries = $derived(captured ?? prompts);
	let previewId = $state<string | null>(null);
	let pointerId: number | null = null;
	let track: HTMLDivElement | undefined = $state();
	let availableHeight = $state(0);
	let previewHeight = $state(0);
	const activeIndex = $derived(entries.findIndex((entry) => entry.id === activeId));
	const previewIndex = $derived(entries.findIndex((entry) => entry.id === previewId));
	const preview = $derived(entries[previewIndex]);
	const trackHeight = $derived(Math.max(44, Math.min(availableHeight, (entries.length - 1) * 18 + 24)));
	const previewTop = $derived(Math.max(0, Math.min(availableHeight - previewHeight,
		(availableHeight - trackHeight) / 2 + 12 + previewIndex / Math.max(1, entries.length - 1) * (trackHeight - 24) - previewHeight / 2)));
	const previewDomId = $props.id();

	function finishPointer(dismiss = false) {
		const id = pointerId;
		pointerId = null;
		captured = null;
		if (id !== null && track?.hasPointerCapture(id)) track.releasePointerCapture(id);
		if (dismiss) previewId = null;
	}

	function navigate(index: number) {
		const entry = entries[Math.max(0, Math.min(entries.length - 1, index))];
		if (!entry || !prompts.some((prompt) => prompt.id === entry.id)) return;
		previewId = entry.id;
		onnavigate(entry.id);
	}

	function indexAt(event: PointerEvent): number {
		if (!track) return 0;
		const bounds = track.getBoundingClientRect();
		const fraction = Math.max(0, Math.min(1, (event.clientY - bounds.top - 12) / Math.max(1, bounds.height - 24)));
		return Math.round(fraction * (entries.length - 1));
	}

	function startPointer(event: PointerEvent) {
		if (event.button !== 0 || !event.isPrimary || pointerId !== null || !track) return;
		event.preventDefault();
		captured = prompts;
		pointerId = event.pointerId;
		track.setPointerCapture(event.pointerId);
		track.focus({ preventScroll: true });
		navigate(indexAt(event));
	}

	function movePointer(event: PointerEvent) {
		if (!event.isPrimary || (pointerId !== null && event.pointerId !== pointerId)) return;
		const index = indexAt(event);
		if (pointerId !== null) {
			if (entries[index]?.id !== previewId) navigate(index);
		} else if (event.pointerType !== "touch") previewId = entries[index]?.id ?? null;
	}

	function keydown(event: KeyboardEvent) {
		if (event.key === "Escape") { finishPointer(true); return; }
		const current = previewIndex >= 0 ? previewIndex : Math.max(0, activeIndex);
		const index = event.key === "Home" ? 0 : event.key === "End" ? entries.length - 1
			: event.key === "ArrowDown" ? current + 1 : event.key === "ArrowUp" ? current - 1
				: event.key === "PageDown" ? current + 10 : event.key === "PageUp" ? current - 10 : undefined;
		if (index === undefined) return;
		event.preventDefault();
		navigate(index);
	}
</script>

<svelte:document onpointerdown={(event) => {
	if (pointerId === null && event.target instanceof Node && !track?.contains(event.target)) previewId = null;
}} />

{#if entries.length > 1}
	<div class="message-rail" style:top="{topClearance + 16}px" bind:clientHeight={availableHeight}>
		<div
			bind:this={track}
			class="message-rail-track select-none"
			style:height="{trackHeight}px"
			role="slider"
			tabindex="0"
			aria-label="User messages"
			aria-orientation="vertical"
			aria-valuemin="1"
			aria-valuemax={entries.length}
			aria-valuenow={activeIndex >= 0 ? activeIndex + 1 : undefined}
			aria-busy={pending}
			aria-valuetext={activeIndex >= 0 ? `Message ${activeIndex + 1} of ${entries.length}: ${entries[activeIndex]?.preview ?? ""}` : "No prompt visible"}
			aria-describedby={preview ? previewDomId : undefined}
			onpointerdown={startPointer}
			onpointermove={movePointer}
			onpointerup={(event) => { if (event.pointerId === pointerId) finishPointer(); }}
			onpointercancel={(event) => { if (event.pointerId === pointerId) finishPointer(true); }}
			onlostpointercapture={(event) => { if (event.pointerId === pointerId) finishPointer(true); }}
			onpointerleave={() => { if (pointerId === null) previewId = null; }}
			onfocus={() => { previewId = activeId; }}
			onblur={() => { if (pointerId === null) previewId = null; }}
			onkeydown={keydown}
		>
			{#each entries as entry, index (entry.id)}
				<span class="message-rail-tick" class:active={index === activeIndex} class:hot={index === previewIndex}
					class:near={previewIndex >= 0 && Math.abs(index - previewIndex) === 1}
					class:next={previewIndex >= 0 && Math.abs(index - previewIndex) === 2}
					style:top="{12 + index / Math.max(1, entries.length - 1) * (trackHeight - 24)}px" aria-hidden="true"></span>
			{/each}
		</div>
		{#if preview}
			<div id={previewDomId} role="tooltip" data-testid="message-rail-preview" bind:clientHeight={previewHeight}
				class="message-rail-preview bg-bg-alt border border-border rounded-xl shadow-panel text-text"
				style:top="{previewTop}px" style:width="{Math.min(300, Math.max(0, paneWidth - 56))}px">
				<div class="text-[10px] text-text-dimmer tabular-nums mb-1">
					{previewIndex + 1} / {entries.length}
					{#if preview.createdAt != null}
						<span aria-hidden="true"> · </span><time datetime={new Date(preview.createdAt).toISOString()}>{new Date(preview.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })} · {formatClockTime(preview.createdAt)}</time>
					{/if}
				</div>
				<p class="text-[13px] leading-5 font-medium line-clamp-3 break-words">{preview.preview}</p>
			</div>
		{/if}
	</div>
{/if}

<style>
	.message-rail { position: absolute; left: 0; bottom: 16px; width: 44px; display: flex; align-items: center; z-index: 6; pointer-events: none; }
	.message-rail-track { position: relative; width: 44px; flex-shrink: 0; pointer-events: auto; touch-action: none; border-radius: 10px; cursor: pointer; }
	.message-rail-track:focus-visible { outline: 2px solid var(--color-accent); outline-offset: -3px; }
	.message-rail-tick { position: absolute; left: 14px; height: 2px; width: 8px; border-radius: 4px; background: var(--color-text-dimmer); opacity: .4; transition: width 120ms, opacity 120ms; }
	.message-rail-tick.active { width: 18px; background: var(--color-accent); opacity: 1; }
	.message-rail-tick.next { width: 11px; }
	.message-rail-tick.near { width: 17px; opacity: .65; }
	.message-rail-tick.hot { width: 26px; opacity: 1; }
	.message-rail-preview { position: absolute; left: 48px; padding: 10px 12px; pointer-events: none; }
	@media (prefers-reduced-motion: reduce) { .message-rail-tick { transition: none; } }
</style>
