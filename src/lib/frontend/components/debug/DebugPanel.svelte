<!-- ─── Debug Panel ──────────────────────────────────────────────────────────── -->
<!-- Floating panel showing live WebSocket connection state and event history.    -->
<!-- Terminal aesthetic: dark background, green monospace text, compact layout.   -->

<script lang="ts">
	import { wsState } from "../../stores/ws.svelte.js";
	import { wsDebugState, getDebugEvents, clearDebugLog } from "../../stores/ws-debug.svelte.js";
	import { confirm } from "../../stores/ui.svelte.js";
	import { rawSend } from "../../stores/ws-send.svelte.js";

	let copyFlash = $state(false);

	function toggleVerbose() {
		const newValue = !wsDebugState.verboseMessages;
		wsDebugState.verboseMessages = newValue;
		rawSend({ type: "set_log_level", level: newValue ? "verbose" : "info" });
	}

	async function handleClear() {
		const confirmed = await confirm("Clear debug log?", "Clear");
		if (confirmed) clearDebugLog();
	}

	async function copyLog() {
		const lines = getDebugEvents().map((e) => {
			const t = fmtTime(e.time);
			return e.detail ? `${t} ${e.event} ${e.detail}` : `${t} ${e.event}`;
		});
		try {
			await navigator.clipboard.writeText(lines.join("\n"));
			copyFlash = true;
			setTimeout(() => { copyFlash = false; }, 1200);
		} catch {
			// Fallback for contexts without clipboard API
			const ta = document.createElement("textarea");
			ta.value = lines.join("\n");
			ta.style.position = "fixed";
			ta.style.opacity = "0";
			document.body.appendChild(ta);
			ta.select();
			document.execCommand("copy");
			document.body.removeChild(ta);
			copyFlash = true;
			setTimeout(() => { copyFlash = false; }, 1200);
		}
	}

	// ─── Props ──────────────────────────────────────────────────────────────
	let {
		visible = false,
		onClose,
	}: { visible: boolean; onClose?: () => void } = $props();

	// ─── Reactive event list ────────────────────────────────────────────────
	// Touch eventCount and verboseMessages to trigger reactivity.
	const eventCount = $derived(wsDebugState.eventCount);
	const verboseMessages = $derived(wsDebugState.verboseMessages);
	// Force re-derivation by embedding the revision counter directly.
	// getDebugEvents() reads from a non-reactive module array, so Svelte
	// can't track it — we must explicitly depend on eventCount.
	let events = $state<readonly import("../../stores/ws-debug.svelte.js").WsDebugEvent[]>([]);
	$effect(() => {
		void eventCount;
		void verboseMessages;
		events = getDebugEvents();
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

	// ─── Resize support (top-left handle) ──────────────────────────────────
	let panelSize = $state({ width: 460, height: 320 });
	let isResizing = $state(false);
	let resizeStart = $state({ x: 0, y: 0, width: 0, height: 0, posX: 0, posY: 0 });

	function handleResizeStart(e: MouseEvent | TouchEvent) {
		e.preventDefault();
		e.stopPropagation();
		isResizing = true;
		const { x, y } = touchXY(e);
		const panel = (e.target as HTMLElement).closest(".debug-panel") as HTMLElement;
		if (!panel) return;
		const rect = panel.getBoundingClientRect();
		resizeStart = {
			x,
			y,
			width: rect.width,
			height: rect.height,
			posX: panelPos.x === -1 ? rect.left : panelPos.x,
			posY: panelPos.x === -1 ? rect.top : panelPos.y,
		};
		// Switch from CSS bottom/right positioning to explicit top/left
		if (panelPos.x === -1) {
			panelPos = { x: rect.left, y: rect.top };
		}
	}

	function handleResizeMove(e: MouseEvent | TouchEvent) {
		if (!isResizing) return;
		e.preventDefault();
		const { x, y } = touchXY(e);
		// Dragging left/up = increase size (top-left handle)
		const dx = resizeStart.x - x;
		const dy = resizeStart.y - y;
		const newWidth = Math.max(300, Math.min(window.innerWidth * 0.9, resizeStart.width + dx));
		const newHeight = Math.max(160, Math.min(window.innerHeight * 0.8, resizeStart.height + dy));
		panelSize = { width: newWidth, height: newHeight };
		panelPos = {
			x: Math.max(0, resizeStart.posX - (newWidth - resizeStart.width)),
			y: Math.max(0, resizeStart.posY - (newHeight - resizeStart.height)),
		};
	}

	function handleResizeEnd() {
		isResizing = false;
	}

	// Register global mouse/touch listeners for resizing
	$effect(() => {
		if (!isResizing) return;
		window.addEventListener("mousemove", handleResizeMove);
		window.addEventListener("mouseup", handleResizeEnd);
		window.addEventListener("touchmove", handleResizeMove, { passive: false });
		window.addEventListener("touchend", handleResizeEnd);
		return () => {
			window.removeEventListener("mousemove", handleResizeMove);
			window.removeEventListener("mouseup", handleResizeEnd);
			window.removeEventListener("touchmove", handleResizeMove);
			window.removeEventListener("touchend", handleResizeEnd);
		};
	});
</script>

{#if visible}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="debug-panel fixed z-[9999] flex flex-col bg-black/90 backdrop-blur-sm border border-green-900/50 rounded-lg shadow-2xl font-mono text-sm leading-relaxed overflow-hidden"
		style={panelPos.x === -1
			? `bottom: 1rem; right: 1rem; width: ${panelSize.width}px; height: ${panelSize.height}px; min-width: 300px; min-height: 160px; max-width: 90vw; max-height: 80vh;`
			: `left: ${panelPos.x}px; top: ${panelPos.y}px; width: ${panelSize.width}px; height: ${panelSize.height}px; min-width: 300px; min-height: 160px; max-width: 90vw; max-height: 80vh;`}
	>
		<!-- Resize handle (top-left) -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="absolute top-0 left-0 w-4 h-4 cursor-nw-resize z-10 flex items-start justify-start p-0.5 select-none"
			onmousedown={handleResizeStart}
			ontouchstart={handleResizeStart}
		>
		<svg class="w-2.5 h-2.5 text-green-700/60 hover:text-green-500/80 transition-colors" viewBox="0 0 10 10" fill="none">
			<line x1="1" y1="3" x2="3" y2="1" stroke="currentColor" stroke-width="1.5" />
			<line x1="1" y1="7" x2="7" y2="1" stroke="currentColor" stroke-width="1.5" />
		</svg>
		</div>

		<!-- Header (draggable) -->
		<div
			class="flex items-center justify-between px-3 py-1.5 border-b border-green-900/30 cursor-move select-none"
			onmousedown={handleDragStart}
			ontouchstart={handleDragStart}
		>
			<span class="text-green-500 font-semibold text-xs">WS Debug</span>
		<div class="flex items-center gap-3">
			<button
				class="cursor-pointer text-xs px-2 py-1.5 {wsDebugState.verboseMessages ? 'text-yellow-400' : 'text-gray-500 hover:text-gray-300'}"
				onclick={toggleVerbose}
				title={wsDebugState.verboseMessages ? "Verbose: showing all messages + server verbose logging" : "Normal: sampled messages + server info logging"}
			>
				{wsDebugState.verboseMessages ? "verbose:on" : "verbose:off"}
			</button>
			<button
				class="cursor-pointer text-xs px-2 py-1.5 {copyFlash ? 'text-green-400' : 'text-gray-500 hover:text-gray-300'}"
				onclick={copyLog}
				title="Copy log to clipboard"
			>
				{copyFlash ? "copied!" : "copy"}
			</button>
			<button
				class="text-gray-500 hover:text-gray-300 cursor-pointer text-xs px-2 py-1.5"
				onclick={handleClear}
				title="Clear log"
			>
				clear
			</button>
			<button
				class="text-gray-500 hover:text-gray-300 cursor-pointer text-xs leading-none px-2 py-1.5"
				onclick={() => onClose?.()}
				title="Close panel"
			>
				&times;
			</button>
		</div>
		</div>

		<!-- Status summary -->
		<div class="px-3 py-1.5 border-b border-green-900/30 text-gray-300 space-y-0.5 select-none">
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
			class="overflow-y-auto px-3 py-1 flex-1 min-h-0 select-text"
		>
			{#if events.length === 0}
				<div class="text-gray-600 py-2 text-center">No events yet</div>
			{:else}
				{#each events as evt}
					<div>
						<div class="flex gap-1.5 py-px items-start">
							<span class="text-gray-600 shrink-0 w-[84px] text-right">{fmtTime(evt.time)}</span>
							<span class="{eventColor(evt.event)} shrink-0">{evt.event}</span>
							{#if evt.detail}
								<span class="text-gray-500 truncate">{evt.detail}</span>
							{/if}
							{#if evt.payload}
								<button
									class="text-gray-600 hover:text-gray-300 text-[10px] ml-auto shrink-0 cursor-pointer"
									onclick={() => { evt._expanded = !evt._expanded; }}
								>
									{evt._expanded ? '[-]' : '[+]'}
								</button>
							{/if}
						</div>
						{#if evt._expanded && evt.payload}
							<pre class="text-[10px] text-green-300/70 ml-[90px] whitespace-pre-wrap break-all max-h-40 overflow-y-auto mb-1">{JSON.stringify(evt.payload, null, 2)}</pre>
						{/if}
					</div>
				{/each}
			{/if}
		</div>
	</div>
{/if}
