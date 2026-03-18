<!-- ─── Debug Panel ──────────────────────────────────────────────────────────── -->
<!-- Floating panel showing live WebSocket connection state and event history.    -->
<!-- Terminal aesthetic: dark background, green monospace text, compact layout.   -->

<script lang="ts">
	import { wsState } from "../../stores/ws.svelte.js";
	import { wsDebugState, getDebugEvents, clearDebugLog } from "../../stores/ws-debug.svelte.js";

	function toggleVerbose() {
		wsDebugState.verboseMessages = !wsDebugState.verboseMessages;
	}

	// ─── Props ──────────────────────────────────────────────────────────────
	let {
		visible = false,
		onClose,
	}: { visible: boolean; onClose?: () => void } = $props();

	// ─── Reactive event list ────────────────────────────────────────────────
	// Touch eventCount to trigger reactivity when events are added.
	const eventCount = $derived(wsDebugState.eventCount);
	const events = $derived.by(() => {
		void eventCount;
		return getDebugEvents();
	});

	// ─── Live "time in state" counter ───────────────────────────────────────
	let now = $state(Date.now());
	$effect(() => {
		if (!visible) return;
		const interval = setInterval(() => {
			now = Date.now();
		}, 1000);
		return () => clearInterval(interval);
	});

	const timeInState = $derived(
		Math.round((now - wsDebugState.lastTransitionTime) / 1000),
	);

	// ─── Helpers ────────────────────────────────────────────────────────────

	/** Format timestamp as HH:MM:SS.mmm */
	function fmtTime(time: number): string {
		const d = new Date(time);
		const h = String(d.getHours()).padStart(2, "0");
		const m = String(d.getMinutes()).padStart(2, "0");
		const s = String(d.getSeconds()).padStart(2, "0");
		const ms = String(d.getMilliseconds()).padStart(3, "0");
		return `${h}:${m}:${s}.${ms}`;
	}

	/** Status dot color class. */
	function statusColor(status: string): string {
		switch (status) {
			case "connected":
			case "processing":
				return "text-green-400";
			case "connecting":
				return "text-yellow-400";
			case "disconnected":
			case "error":
				return "text-red-400";
			default:
				return "text-gray-400";
		}
	}

	/** Event name color for the log. */
	function eventColor(event: string): string {
		if (event.startsWith("ws:open") || event === "self-heal") return "text-green-400";
		if (event.startsWith("ws:close") || event === "timeout" || event === "ws:error") return "text-red-400";
		if (event === "connect" || event === "reconnect:fire") return "text-yellow-400";
		if (event === "relay:status") return "text-cyan-400";
		return "text-gray-300";
	}

	// ─── Auto-scroll to bottom ──────────────────────────────────────────────
	let logEl: HTMLDivElement | undefined = $state(undefined);
	$effect(() => {
		void eventCount;
		if (logEl) {
			// Use requestAnimationFrame to ensure DOM has updated
			requestAnimationFrame(() => {
				if (logEl) logEl.scrollTop = logEl.scrollHeight;
			});
		}
	});

	// ─── Dragging support ───────────────────────────────────────────────────
	let isDragging = $state(false);
	let dragOffset = $state({ x: 0, y: 0 });
	let panelPos = $state({ x: -1, y: -1 }); // -1 = use CSS default

	function touchXY(e: MouseEvent | TouchEvent): { x: number; y: number } {
		if ("touches" in e && e.touches[0]) {
			return { x: e.touches[0].clientX, y: e.touches[0].clientY };
		}
		return { x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY };
	}

	function handleDragStart(e: MouseEvent | TouchEvent) {
		isDragging = true;
		const { x: clientX, y: clientY } = touchXY(e);
		const panel = (e.target as HTMLElement).closest(".debug-panel") as HTMLElement;
		if (!panel) return;
		const rect = panel.getBoundingClientRect();
		dragOffset = { x: clientX - rect.left, y: clientY - rect.top };
		if (panelPos.x === -1) {
			panelPos = { x: rect.left, y: rect.top };
		}
	}

	function handleDragMove(e: MouseEvent | TouchEvent) {
		if (!isDragging) return;
		e.preventDefault();
		const { x: clientX, y: clientY } = touchXY(e);
		panelPos = {
			x: Math.max(0, clientX - dragOffset.x),
			y: Math.max(0, clientY - dragOffset.y),
		};
	}

	function handleDragEnd() {
		isDragging = false;
	}

	// Register global mouse/touch listeners for dragging
	$effect(() => {
		if (!isDragging) return;
		window.addEventListener("mousemove", handleDragMove);
		window.addEventListener("mouseup", handleDragEnd);
		window.addEventListener("touchmove", handleDragMove, { passive: false });
		window.addEventListener("touchend", handleDragEnd);
		return () => {
			window.removeEventListener("mousemove", handleDragMove);
			window.removeEventListener("mouseup", handleDragEnd);
			window.removeEventListener("touchmove", handleDragMove);
			window.removeEventListener("touchend", handleDragEnd);
		};
	});
</script>

{#if visible}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="debug-panel fixed z-[9999] flex flex-col bg-black/90 backdrop-blur-sm border border-green-900/50 rounded-lg shadow-2xl font-mono text-[11px] leading-relaxed select-none overflow-hidden resize"
		style={panelPos.x === -1
			? "bottom: 1rem; right: 1rem; width: 460px; height: 320px; min-width: 300px; min-height: 160px; max-width: 90vw; max-height: 80vh;"
			: `left: ${panelPos.x}px; top: ${panelPos.y}px; width: 460px; height: 320px; min-width: 300px; min-height: 160px; max-width: 90vw; max-height: 80vh;`}
	>
		<!-- Header (draggable) -->
		<div
			class="flex items-center justify-between px-3 py-1.5 border-b border-green-900/30 cursor-move"
			onmousedown={handleDragStart}
			ontouchstart={handleDragStart}
		>
			<span class="text-green-500 font-semibold text-xs">WS Debug</span>
			<div class="flex items-center gap-2">
				<button
					class="cursor-pointer text-[10px] {wsDebugState.verboseMessages ? 'text-yellow-400' : 'text-gray-500 hover:text-gray-300'}"
					onclick={toggleVerbose}
					title={wsDebugState.verboseMessages ? "Showing all messages — click to throttle" : "Showing 1 per 100 messages — click for all"}
				>
					{wsDebugState.verboseMessages ? "msgs:all" : "msgs:100"}
				</button>
				<button
					class="text-gray-500 hover:text-gray-300 cursor-pointer text-[10px]"
					onclick={() => clearDebugLog()}
					title="Clear log"
				>
					clear
				</button>
				<button
					class="text-gray-500 hover:text-gray-300 cursor-pointer text-xs leading-none"
					onclick={() => onClose?.()}
					title="Close panel"
				>
					&times;
				</button>
			</div>
		</div>

		<!-- Status summary -->
		<div class="px-3 py-1.5 border-b border-green-900/30 text-gray-300 space-y-0.5">
			<div class="flex items-center gap-2">
				<span class={statusColor(wsState.status)}>&#9679;</span>
				<span class="text-white">{wsState.status || "(none)"}</span>
				<span class="text-gray-500">({timeInState}s)</span>
			</div>
			<div class="flex gap-4 text-gray-400">
				<span>attempts: {wsState.attempts}</span>
				{#if wsState.relayStatus}
					<span>relay: {wsState.relayStatus}</span>
				{/if}
			</div>
			{#if wsState.statusText}
				<div class="text-gray-500 truncate">{wsState.statusText}</div>
			{/if}
		</div>

		<!-- Event log -->
		<div
			bind:this={logEl}
			class="overflow-y-auto px-3 py-1 flex-1 min-h-0"
		>
			{#if events.length === 0}
				<div class="text-gray-600 py-2 text-center">No events yet</div>
			{:else}
				{#each events as evt}
					<div class="flex gap-1.5 py-px">
						<span class="text-gray-600 shrink-0 w-[84px] text-right">{fmtTime(evt.time)}</span>
						<span class="{eventColor(evt.event)} shrink-0">{evt.event}</span>
						{#if evt.detail}
							<span class="text-gray-500 truncate">{evt.detail}</span>
						{/if}
					</div>
				{/each}
			{/if}
		</div>
	</div>
{/if}
