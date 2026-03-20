<!-- ─── Info Panels ───────────────────────────────────────────────────────── -->
<!-- Floating info panels (Usage, Status, Context) toggled from the header.  -->
<!-- Positioned absolute top-right, stacked vertically with gap.             -->
<!-- Data is passed as props; panel visibility is driven by uiState.openPanels. -->

<script lang="ts">
	import type { UsageData, StatusData, ContextData } from "../../types.js";
	import { uiState, closePanel } from "../../stores/ui.svelte.js";

	// ─── Props ──────────────────────────────────────────────────────────────────

	let {
		usageData,
		statusData,
		contextData,
	}: {
		usageData?: UsageData;
		statusData?: StatusData;
		contextData?: ContextData;
	} = $props();

	// ─── Derived ────────────────────────────────────────────────────────────────

	const showUsage = $derived(uiState.openPanels.has("usage-panel"));
	const showStatus = $derived(uiState.openPanels.has("status-panel"));
	const showContext = $derived(uiState.openPanels.has("context-panel"));

	const contextPercent = $derived.by(() => {
		if (!contextData?.windowSize || !contextData?.usedTokens) return 0;
		return Math.min(
			100,
			Math.round((contextData.usedTokens / contextData.windowSize) * 100),
		);
	});

	const contextBarColor = $derived.by(() => {
		if (contextPercent >= 80) return "bg-brand-a";
		if (contextPercent >= 50) return "bg-warning";
		return "bg-brand-b";
	});

	// ─── Formatting helpers ─────────────────────────────────────────────────────

	function formatCost(cost: number | undefined): string {
		if (cost === undefined || cost === null) return "--";
		return `$${cost.toFixed(4)}`;
	}

	function formatTokens(tokens: number | undefined): string {
		if (tokens === undefined || tokens === null) return "--";
		if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
		if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
		return tokens.toLocaleString();
	}

	function formatMemory(bytes: number | undefined): string {
		if (bytes === undefined || bytes === null) return "--";
		const mb = bytes / (1024 * 1024);
		if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
		return `${mb.toFixed(0)} MB`;
	}

	function formatUptime(seconds: number | undefined): string {
		if (seconds === undefined || seconds === null) return "--";
		if (seconds < 60) return `${seconds}s`;
		if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
		const h = Math.floor(seconds / 3600);
		const m = Math.floor((seconds % 3600) / 60);
		return `${h}h ${m}m`;
	}
</script>

{#if showUsage || showStatus || showContext}
	<div class="absolute top-12 right-4 z-50 flex flex-col gap-2">
		<!-- Usage Panel -->
		{#if showUsage}
			<div
				class="info-panel bg-bg-alt border border-border rounded-lg shadow-[0_4px_16px_rgba(var(--shadow-rgb),0.3)] min-w-[220px] max-w-[280px]"
			>
				<div
					class="info-panel-header flex items-center justify-between px-3 py-2 border-b border-border"
				>
					<span class="text-xs font-semibold text-text">Usage</span>
					<button
						class="text-text-muted hover:text-text text-sm leading-none cursor-pointer bg-transparent border-none p-0"
						onclick={() => closePanel("usage-panel")}
						title="Close usage panel"
					>
						&times;
					</button>
				</div>
				<div class="info-panel-body px-3 py-2 flex flex-col gap-1">
					<div class="flex justify-between text-xs">
						<span class="text-text-muted">Cost</span>
						<span class="text-text">{formatCost(usageData?.cost)}</span>
					</div>
					<div class="flex justify-between text-xs">
						<span class="text-text-muted">Input tokens</span>
						<span class="text-text"
							>{formatTokens(usageData?.inputTokens)}</span
						>
					</div>
					<div class="flex justify-between text-xs">
						<span class="text-text-muted">Output tokens</span>
						<span class="text-text"
							>{formatTokens(usageData?.outputTokens)}</span
						>
					</div>
					<div class="flex justify-between text-xs">
						<span class="text-text-muted">Cache read</span>
						<span class="text-text"
							>{formatTokens(usageData?.cacheRead)}</span
						>
					</div>
					<div class="flex justify-between text-xs">
						<span class="text-text-muted">Cache write</span>
						<span class="text-text"
							>{formatTokens(usageData?.cacheWrite)}</span
						>
					</div>
					<div class="flex justify-between text-xs">
						<span class="text-text-muted">Turns</span>
						<span class="text-text">{usageData?.turns ?? "--"}</span>
					</div>
				</div>
			</div>
		{/if}

		<!-- Status Panel -->
		{#if showStatus}
			<div
				class="info-panel bg-bg-alt border border-border rounded-lg shadow-[0_4px_16px_rgba(var(--shadow-rgb),0.3)] min-w-[220px] max-w-[280px]"
			>
				<div
					class="info-panel-header flex items-center justify-between px-3 py-2 border-b border-border"
				>
					<span class="text-xs font-semibold text-text">Status</span>
					<button
						class="text-text-muted hover:text-text text-sm leading-none cursor-pointer bg-transparent border-none p-0"
						onclick={() => closePanel("status-panel")}
						title="Close status panel"
					>
						&times;
					</button>
				</div>
				<div class="info-panel-body px-3 py-2 flex flex-col gap-1">
					<div class="flex justify-between text-xs">
						<span class="text-text-muted">PID</span>
						<span class="text-text">{statusData?.pid ?? "--"}</span>
					</div>
					<div class="flex justify-between text-xs">
						<span class="text-text-muted">Uptime</span>
						<span class="text-text"
							>{formatUptime(statusData?.uptime)}</span
						>
					</div>
					<div class="flex justify-between text-xs">
						<span class="text-text-muted">Memory</span>
						<span class="text-text"
							>{formatMemory(statusData?.memory)}</span
						>
					</div>
					<div class="flex justify-between text-xs">
						<span class="text-text-muted">Active sessions</span>
						<span class="text-text"
							>{statusData?.activeSessions ?? "--"}</span
						>
					</div>
					<div class="flex justify-between text-xs">
						<span class="text-text-muted">Processing</span>
						<span class="text-text">
							{#if statusData?.processingSessions !== undefined}
								{statusData.processingSessions > 0 ? "Yes" : "No"}
							{:else}
								--
							{/if}
						</span>
					</div>
					<div class="flex justify-between text-xs">
						<span class="text-text-muted">Clients</span>
						<span class="text-text"
							>{statusData?.clients ?? "--"}</span
						>
					</div>
					<div class="flex justify-between text-xs">
						<span class="text-text-muted">Terminals</span>
						<span class="text-text"
							>{statusData?.terminals ?? "--"}</span
						>
					</div>
				</div>
			</div>
		{/if}

		<!-- Context Panel -->
		{#if showContext}
			<div
				class="info-panel bg-bg-alt border border-border rounded-lg shadow-[0_4px_16px_rgba(var(--shadow-rgb),0.3)] min-w-[220px] max-w-[280px]"
			>
				<div
					class="info-panel-header flex items-center justify-between px-3 py-2 border-b border-border"
				>
					<span class="text-xs font-semibold text-text">Context</span>
					<button
						class="text-text-muted hover:text-text text-sm leading-none cursor-pointer bg-transparent border-none p-0"
						onclick={() => closePanel("context-panel")}
						title="Close context panel"
					>
						&times;
					</button>
				</div>
				<div class="info-panel-body px-3 py-2 flex flex-col gap-1">
					<!-- Progress bar -->
					<div class="flex flex-col gap-1 mb-1">
						<div class="flex justify-between text-xs">
							<span class="text-text-muted">Used</span>
							<span class="text-text">{contextPercent}%</span>
						</div>
						<div
							class="h-[6px] bg-border-subtle rounded-full overflow-hidden"
						>
							<div
								class="h-full rounded-full transition-[width] duration-300 ease-out {contextBarColor}"
								style="width: {contextPercent}%"
							></div>
						</div>
					</div>
					<div class="flex justify-between text-xs">
						<span class="text-text-muted">Used tokens</span>
						<span class="text-text"
							>{formatTokens(contextData?.usedTokens)}</span
						>
					</div>
					<div class="flex justify-between text-xs">
						<span class="text-text-muted">Window size</span>
						<span class="text-text"
							>{formatTokens(contextData?.windowSize)}</span
						>
					</div>
					{#if contextData?.maxOutput !== undefined}
						<div class="flex justify-between text-xs">
							<span class="text-text-muted">Max output</span>
							<span class="text-text"
								>{formatTokens(contextData.maxOutput)}</span
							>
						</div>
					{/if}
					{#if contextData?.model}
						<div class="flex justify-between text-xs">
							<span class="text-text-muted">Model</span>
							<span class="text-text">{contextData.model}</span>
						</div>
					{/if}
					{#if contextData?.cost !== undefined}
						<div class="flex justify-between text-xs">
							<span class="text-text-muted">Cost</span>
							<span class="text-text"
								>{formatCost(contextData.cost)}</span
							>
						</div>
					{/if}
					{#if contextData?.turns !== undefined}
						<div class="flex justify-between text-xs">
							<span class="text-text-muted">Turns</span>
							<span class="text-text">{contextData.turns}</span>
						</div>
					{/if}
				</div>
			</div>
		{/if}
	</div>
{/if}
