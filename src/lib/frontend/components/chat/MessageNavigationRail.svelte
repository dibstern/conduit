<script lang="ts">
	import { untrack } from "svelte";
	import type { UserMessage } from "../../types.js";
	import { extractDisplayText, formatClockTime } from "../../utils/format.js";

	let { scroller, messages, topClearance = 0, onjump, visible = $bindable(false) }: {
		scroller: HTMLElement;
		messages: readonly UserMessage[];
		topClearance?: number;
		onjump: () => void;
		visible?: boolean;
	} = $props();

	type Entry = { message: UserMessage; element: HTMLElement; top: number };
	let available = $state.raw<Entry[]>([]);
	let captured = $state.raw<Entry[] | null>(null);
	const entries = $derived(captured ?? available);
	let activeId = $state("");
	let previewId = $state<string | null>(null);
	let pointerId: number | null = null;
	let selectedScrollTop: number | null = null;
	let track: HTMLDivElement | undefined = $state();
	let availableHeight = $state(0);
	let previewHeight = $state(0);
	let paneWidth = $state(0);
	let refresh = () => {};
	const activeIndex = $derived(Math.max(0, entries.findIndex((entry) => entry.message.uuid === activeId)));
	const previewIndex = $derived(entries.findIndex((entry) => entry.message.uuid === previewId));
	const preview = $derived(entries[previewIndex]?.message);
	const trackHeight = $derived(Math.max(44, Math.min(availableHeight, (entries.length - 1) * 18 + 24)));
	const previewTop = $derived(Math.max(0, Math.min(availableHeight - previewHeight,
		(availableHeight - trackHeight) / 2 + 12 + previewIndex / Math.max(1, entries.length - 1) * (trackHeight - 24) - previewHeight / 2)));
	const previewDomId = $props.id();

	function prompt(message: UserMessage): string {
		return extractDisplayText(message.text).replace(/\s+/g, " ").trim() || "Attached files";
	}

	function followVisibleMessage() {
		if (pointerId !== null || available.length === 0) return;
		if (selectedScrollTop !== null && Math.abs(scroller.scrollTop - selectedScrollTop) < 1
			&& available.some((entry) => entry.message.uuid === activeId)) return;
		selectedScrollTop = null;
		if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 5) {
			activeId = available.at(-1)?.message.uuid ?? "";
			return;
		}
		const top = scroller.scrollTop + topClearance + 24;
		let low = 0;
		let high = available.length - 1;
		while (low < high) {
			const mid = Math.ceil((low + high) / 2);
			if ((available[mid]?.top ?? Infinity) <= top) low = mid;
			else high = mid - 1;
		}
		activeId = available[low]?.message.uuid ?? "";
	}

	function finishPointer(dismiss = false) {
		const id = pointerId;
		pointerId = null;
		captured = null;
		if (id !== null && track?.hasPointerCapture(id)) track.releasePointerCapture(id);
		if (dismiss) previewId = null;
	}

	$effect(() => {
		const container = scroller;
		let frame: number | undefined;
		const observed = new Set<Element>();
		const schedule = () => {
			if (frame === undefined) frame = requestAnimationFrame(() => untrack(measure));
		};
		const resize = new ResizeObserver(schedule);
		function measure() {
			frame = undefined;
			const byId = new Map(untrack(() => messages).map((message) => [message.uuid, message]));
			const origin = container.getBoundingClientRect().top + container.clientTop - container.scrollTop;
			available = Array.from(container.querySelectorAll<HTMLElement>(".msg-user[data-uuid]")).flatMap((element) => {
				const message = byId.get(element.dataset["uuid"] ?? "");
				return message && element.getClientRects().length > 0
					? [{ message, element, top: element.getBoundingClientRect().top - origin }]
					: [];
			});
			paneWidth = container.clientWidth;
			visible = available.length > 1;
			// A fixed viewport does not resize when a reply or expanded turn moves
			// later prompts. Observe its content blocks as well as the viewport.
			for (const element of observed) {
				if (element.parentElement !== container) { resize.unobserve(element); observed.delete(element); }
			}
			for (const element of container.children) {
				if (!observed.has(element)) { resize.observe(element); observed.add(element); }
			}
			if (captured?.some((entry) => !entry.element.isConnected)) finishPointer(true);
			followVisibleMessage();
		}
		const mutation = new MutationObserver(schedule);
		mutation.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "data-uuid"] });
		resize.observe(container);
		container.addEventListener("scroll", followVisibleMessage, { passive: true });
		refresh = schedule;
		schedule();
		return () => {
			if (frame !== undefined) cancelAnimationFrame(frame);
			resize.disconnect();
			mutation.disconnect();
			container.removeEventListener("scroll", followVisibleMessage);
			refresh = () => {};
			finishPointer(true);
			visible = false;
		};
	});
	$effect(() => { messages; topClearance; refresh(); });

	function navigate(index: number) {
		const entry = entries[Math.max(0, Math.min(entries.length - 1, index))];
		if (!entry?.element.isConnected) { finishPointer(true); return; }
		onjump();
		// Drag order is frozen, geometry is not: a history prepend can move the
		// same prompt while the pointer remains captured.
		const top = scroller.scrollTop + entry.element.getBoundingClientRect().top
			- scroller.getBoundingClientRect().top - scroller.clientTop - topClearance - 20;
		scroller.scrollTo({ top, behavior: "instant" });
		selectedScrollTop = scroller.scrollTop;
		activeId = entry.message.uuid;
		previewId = activeId;
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
		captured = available;
		pointerId = event.pointerId;
		track.setPointerCapture(event.pointerId);
		track.focus({ preventScroll: true });
		navigate(indexAt(event));
	}

	function movePointer(event: PointerEvent) {
		if (!event.isPrimary || (pointerId !== null && event.pointerId !== pointerId)) return;
		const index = indexAt(event);
		if (pointerId !== null) navigate(index);
		else if (event.pointerType !== "touch") previewId = entries[index]?.message.uuid ?? null;
	}

	function keydown(event: KeyboardEvent) {
		if (event.key === "Escape") { finishPointer(true); return; }
		const index = event.key === "Home" ? 0 : event.key === "End" ? entries.length - 1
			: event.key === "ArrowDown" ? activeIndex + 1 : event.key === "ArrowUp" ? activeIndex - 1
				: event.key === "PageDown" ? activeIndex + 10 : event.key === "PageUp" ? activeIndex - 10 : undefined;
		if (index === undefined) return;
		event.preventDefault();
		navigate(index);
	}
</script>

<svelte:document onpointerdown={(event) => {
	if (pointerId === null && event.target instanceof Node && !track?.contains(event.target)) previewId = null;
}} />

{#if visible}
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
			aria-valuenow={activeIndex + 1}
			aria-valuetext={`Message ${activeIndex + 1} of ${entries.length}: ${entries[activeIndex] ? prompt(entries[activeIndex].message) : ""}`}
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
			{#each entries as entry, index (entry.message.uuid)}
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
				<p class="text-[13px] leading-5 font-medium line-clamp-3 break-words">{prompt(preview)}</p>
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
