<!-- ─── Settings Panel ────────────────────────────────────────────────────── -->
<!-- Modal settings panel with tabbed navigation. Supports an "Instances"    -->
<!-- tab for monitoring auto-discovered OpenCode instances.                  -->

<script lang="ts">
	import Icon from "../shared/Icon.svelte";
	import {
		getCachedInstances,
		getProxyDetection,
		getScanResult,
		instanceStatusColor,
		isScanInFlight,
		startProxyDetection,
		triggerScan,
	} from "../../stores/instance.svelte.js";
	import { wsSend } from "../../stores/ws.svelte.js";
	import { confirm, showToast } from "../../stores/ui.svelte.js";
	import { copyToClipboard } from "../../utils/clipboard.js";
	import { featureFlags, toggleFeature } from "../../stores/feature-flags.svelte.js";

	// ─── Props ──────────────────────────────────────────────────────────────

	let {
		visible = false,
		initialTab = "instances",
		onClose,
	}: { visible: boolean; initialTab?: string; onClose?: () => void } =
		$props();

	// ─── Local state ────────────────────────────────────────────────────────

	let activeTab = $state("instances");
	let expandedInstanceId = $state<string | null>(null);

	// Inline rename
	let renamingInstanceId = $state<string | null>(null);
	let renameValue = $state("");

	// Getting Started — expanded scenario
	let expandedScenario = $state<string | null>(null);

	// Copy feedback — tracks which command block was recently copied
	let copiedKey = $state<string | null>(null);
	let copyTimer: ReturnType<typeof setTimeout> | null = null;

	// ─── Derived ────────────────────────────────────────────────────────────

	const instances = $derived(getCachedInstances());
	const scanInFlight = $derived(isScanInFlight());
	const scanResult = $derived(getScanResult());
	const proxyResult = $derived(getProxyDetection());
	const ccsDetected = $derived(proxyResult?.found ?? false);

	// ─── Effects ────────────────────────────────────────────────────────────

	$effect(() => {
		if (visible) {
			activeTab = initialTab;
			expandedInstanceId = null;
			renamingInstanceId = null;
			expandedScenario = null;
			// Trigger CCS detection when panel opens
			startProxyDetection(wsSend);
		}
	});

	// ─── Handlers ───────────────────────────────────────────────────────────

	function handleToggleInstance(instanceId: string) {
		expandedInstanceId =
			expandedInstanceId === instanceId ? null : instanceId;
		// Close rename when collapsing
		if (expandedInstanceId !== instanceId) {
			renamingInstanceId = null;
		}
	}

	function handleStart(instanceId: string) {
		wsSend({ type: "instance_start", instanceId });
	}

	function handleStop(instanceId: string) {
		wsSend({ type: "instance_stop", instanceId });
	}

	async function handleRemove(instanceId: string, instanceName: string) {
		const confirmed = await confirm(
			`Remove instance "${instanceName}"? This cannot be undone.`,
		);
		if (confirmed) {
			wsSend({ type: "instance_remove", instanceId });
		}
	}

	function handleScanNow() {
		triggerScan(wsSend);
	}

	// ── Inline rename ───────────────────────────────────────────────────────

	function startRename(instanceId: string, currentName: string) {
		renamingInstanceId = instanceId;
		renameValue = currentName;
	}

	function submitRename() {
		if (!renamingInstanceId) return;
		const trimmed = renameValue.trim();
		if (!trimmed) {
			showToast("Instance name cannot be empty", { variant: "warn" });
			return;
		}
		wsSend({
			type: "instance_rename",
			instanceId: renamingInstanceId,
			name: trimmed,
		});
		renamingInstanceId = null;
	}

	function cancelRename() {
		renamingInstanceId = null;
	}

	function handleRenameKeydown(e: KeyboardEvent) {
		if (e.key === "Enter") {
			e.preventDefault();
			submitRename();
		} else if (e.key === "Escape") {
			e.preventDefault();
			cancelRename();
		}
	}

	// ── Copy to clipboard ───────────────────────────────────────────────────

	async function handleCopy(text: string, key: string) {
		const ok = await copyToClipboard(text);
		if (ok) {
			copiedKey = key;
			if (copyTimer) clearTimeout(copyTimer);
			copyTimer = setTimeout(() => {
				copiedKey = null;
				copyTimer = null;
			}, 2000);
		} else {
			showToast("Failed to copy — clipboard unavailable", { variant: "warn" });
		}
	}

	// ── Scenario toggle ─────────────────────────────────────────────────────

	function toggleScenario(id: string) {
		expandedScenario = expandedScenario === id ? null : id;
	}

	// ── Backdrop / escape ───────────────────────────────────────────────────

	function handleBackdropClick(e: MouseEvent) {
		if (e.target === e.currentTarget) {
			onClose?.();
		}
	}

	$effect(() => {
		if (!visible) return;
		function handleKeydown(e: KeyboardEvent) {
			if (e.key === "Escape") onClose?.();
		}
		document.addEventListener("keydown", handleKeydown);
		return () => document.removeEventListener("keydown", handleKeydown);
	});
</script>

<!-- ─── Copyable command block snippet ────────────────────────────────────── -->
{#snippet cmdBlock(cmd: string, key: string)}
	<div class="group/cmd flex items-start gap-1.5 bg-black/[0.04] dark:bg-white/[0.06] rounded px-2.5 py-1.5 font-mono text-xs text-text leading-relaxed">
		<span class="flex-1 whitespace-pre-wrap break-all select-all">{cmd}</span>
		<button
			type="button"
			class="shrink-0 p-0.5 text-text-muted hover:text-text opacity-0 group-hover/cmd:opacity-100 transition-opacity cursor-pointer"
			title="Copy"
			onclick={() => handleCopy(cmd, key)}
		>
			{#if copiedKey === key}
				<Icon name="check" size={13} class="text-green-500" />
			{:else}
				<Icon name="copy" size={13} />
			{/if}
		</button>
	</div>
{/snippet}

{#if visible}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-[200] flex items-center justify-center bg-[rgba(var(--overlay-rgb),0.6)] backdrop-blur-sm"
		onclick={handleBackdropClick}
	>
		<div
			id="settings-panel"
			class="bg-bg-surface border border-border rounded-xl shadow-2xl max-w-lg w-full mx-4 flex flex-col max-h-[80vh]"
		>
			<!-- Header -->
			<div
				class="flex items-center justify-between px-5 py-3 border-b border-border"
			>
				<h2 class="text-text font-semibold text-base">Settings</h2>
				<button
					class="text-text-muted hover:text-text p-1 cursor-pointer"
					onclick={() => onClose?.()}
				>
					<Icon name="x" size={16} />
				</button>
			</div>

			<!-- Tabs -->
			<div class="flex border-b border-border px-5">
				<button
					class="px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors cursor-pointer {activeTab ===
					'instances'
						? 'border-accent text-text'
						: 'border-transparent text-text-muted hover:text-text'}"
					onclick={() => (activeTab = "instances")}
				>
					Instances
				</button>
				<button
					class="px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors cursor-pointer {activeTab ===
					'debug'
						? 'border-accent text-text'
						: 'border-transparent text-text-muted hover:text-text'}"
					onclick={() => (activeTab = "debug")}
				>
					Debug
				</button>
			</div>

			<!-- Tab content -->
			<div class="flex-1 overflow-y-auto p-5">
				{#if activeTab === "instances"}
					<!-- ─── Instance list header with Scan Now ──────────────── -->
					<div class="flex items-center justify-between mb-3">
						<span class="text-xs text-text-muted font-medium uppercase tracking-wide">
							{instances.length} instance{instances.length !== 1 ? "s" : ""}
						</span>
						<button
							type="button"
							class="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded border border-border text-text-muted hover:text-text hover:border-text-muted transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
							data-testid="scan-now-btn"
							disabled={scanInFlight}
							onclick={handleScanNow}
						>
							<Icon
								name="refresh-cw"
								size={12}
								class={scanInFlight ? "animate-spin" : ""}
							/>
							{scanInFlight ? "Scanning..." : "Scan Now"}
						</button>
					</div>

					<!-- ─── Scan result flash ──────────────────────────────── -->
					{#if scanResult && !scanInFlight}
						<div class="mb-3 text-xs text-text-muted bg-black/[0.03] dark:bg-white/[0.04] rounded px-2.5 py-1.5">
							{#if scanResult.discovered.length > 0}
								Found {scanResult.discovered.length} new instance{scanResult.discovered.length !== 1 ? "s" : ""}
								on port{scanResult.discovered.length !== 1 ? "s" : ""} {scanResult.discovered.join(", ")}.
							{:else if scanResult.lost.length > 0}
								{scanResult.lost.length} instance{scanResult.lost.length !== 1 ? "s" : ""} lost
								(port{scanResult.lost.length !== 1 ? "s" : ""} {scanResult.lost.join(", ")}).
							{:else if scanResult.active.length > 0}
								{scanResult.active.length} active instance{scanResult.active.length !== 1 ? "s" : ""}
								on port{scanResult.active.length !== 1 ? "s" : ""} {scanResult.active.join(", ")} (no changes).
							{:else}
								No active instances found.
							{/if}
						</div>
					{/if}

					<!-- ─── Instance list ──────────────────────────────────── -->
					{#if instances.length > 0}
						<div id="instance-settings-list" class="space-y-1">
							{#each instances as inst}
								<div class="border border-border rounded-lg">
									<!-- Instance row -->
									<button
										class="flex items-center justify-between w-full px-3 py-2 text-left text-sm hover:bg-black/[0.03] dark:hover:bg-white/[0.03] cursor-pointer"
										onclick={() => handleToggleInstance(inst.id)}
									>
										<div class="flex items-center gap-2 min-w-0">
											<span
												class={"w-2 h-2 rounded-full shrink-0 " +
													instanceStatusColor(inst.status)}
											></span>
											{#if renamingInstanceId === inst.id}
												<!-- Inline rename input (stop click propagation) -->
												<!-- svelte-ignore a11y_autofocus -->
												<input
													type="text"
													class="px-1.5 py-0.5 text-sm border border-accent rounded bg-bg text-text w-36"
													bind:value={renameValue}
													onkeydown={handleRenameKeydown}
													onclick={(e) => e.stopPropagation()}
													onfocusout={submitRename}
													autofocus
												/>
											{:else}
												<span class="font-medium text-text truncate">{inst.name}</span>
											{/if}
											{#if !inst.managed}
												<span class="text-[10px] text-text-muted bg-black/[0.05] dark:bg-white/[0.08] px-1.5 py-0.5 rounded-full">discovered</span>
											{/if}
										</div>
										<span class="text-text-muted text-xs shrink-0 ml-2">:{inst.port}</span>
									</button>

									<!-- Expanded controls -->
									{#if expandedInstanceId === inst.id}
										<div
											class="flex flex-wrap gap-2 px-3 py-2 border-t border-border"
										>
											{#if inst.managed}
												<button
													class="px-3 py-1 text-xs rounded border border-border text-text hover:bg-black/[0.05] dark:hover:bg-white/[0.05] cursor-pointer"
													onclick={() => handleStart(inst.id)}
												>
													Start
												</button>
												<button
													class="px-3 py-1 text-xs rounded border border-border text-text hover:bg-black/[0.05] dark:hover:bg-white/[0.05] cursor-pointer"
													onclick={() => handleStop(inst.id)}
												>
													Stop
												</button>
											{/if}
											<button
												class="px-3 py-1 text-xs rounded border border-border text-accent hover:bg-accent/10 cursor-pointer"
												data-testid="rename-instance-btn"
												onclick={() => startRename(inst.id, inst.name)}
											>
												Rename
											</button>
											<button
												class="px-3 py-1 text-xs rounded border border-red-300 dark:border-red-700 text-red-500 hover:bg-red-500/10 cursor-pointer"
												onclick={() =>
													handleRemove(inst.id, inst.name)}
											>
												Remove
											</button>
										</div>
									{/if}
								</div>
							{/each}
						</div>
					{/if}

					<!-- ─── Getting Started panel ──────────────────────────── -->
					{#if instances.length === 0}
						<div class="mt-2 space-y-2">
							<p class="text-sm text-text-muted mb-3">
								No OpenCode instances detected. Start one from your terminal and it will appear here automatically.
							</p>

							<!-- Scenario 1: Direct API Key -->
							<div class="border border-border rounded-lg overflow-hidden">
								<button
									type="button"
									class="flex items-center gap-2 w-full px-3 py-2.5 text-left text-sm font-medium text-text hover:bg-black/[0.03] dark:hover:bg-white/[0.03] cursor-pointer"
									onclick={() => toggleScenario("direct")}
								>
									<Icon
										name={expandedScenario === "direct" ? "chevron-down" : "chevron-right"}
										size={14}
										class="text-text-muted shrink-0"
									/>
									<span>Quick Start — Direct API Key</span>
								</button>
								{#if expandedScenario === "direct"}
									<div class="px-3 pb-3 space-y-2 border-t border-border pt-2.5">
										<p class="text-xs text-text-muted">1. Start an OpenCode server:</p>
										{@render cmdBlock("opencode serve --port 4098", "direct-1")}
										<p class="text-xs text-text-muted">2. Configure your provider:</p>
										{@render cmdBlock("opencode config set provider anthropic\nopencode config set anthropic.apiKey sk-ant-...", "direct-2")}
										<p class="text-xs text-text-muted italic">It will appear here automatically.</p>
									</div>
								{/if}
							</div>

							<!-- Scenario 2: CCS Proxy -->
							<div class="border border-border rounded-lg overflow-hidden">
								<button
									type="button"
									class="flex items-center gap-2 w-full px-3 py-2.5 text-left text-sm font-medium text-text hover:bg-black/[0.03] dark:hover:bg-white/[0.03] cursor-pointer"
									onclick={() => toggleScenario("ccs")}
								>
									<Icon
										name={expandedScenario === "ccs" ? "chevron-down" : "chevron-right"}
										size={14}
										class="text-text-muted shrink-0"
									/>
									<span>Multi-Provider — Via CCS</span>
									{#if ccsDetected}
										<Icon name="circle-check" size={14} class="text-green-500 ml-auto shrink-0" />
									{:else if proxyResult === null}
										<span class="text-[9px] text-text-muted animate-pulse ml-auto">detecting...</span>
									{/if}
								</button>
								{#if expandedScenario === "ccs"}
									<div class="px-3 pb-3 space-y-2 border-t border-border pt-2.5">
										<p class="text-xs text-text-muted">CCS manages OAuth tokens and API keys for 20+ providers.</p>
										{#if ccsDetected}
											<div class="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400 bg-green-500/10 rounded px-2 py-1">
												<Icon name="circle-check" size={12} />
												CCS detected on port {proxyResult?.port ?? 8317}
											</div>
										{/if}
										<p class="text-xs text-text-muted">1. Install CCS:</p>
										{@render cmdBlock("npm install -g @anthropic-ai/ccs", "ccs-1")}
										<p class="text-xs text-text-muted">2. Authenticate your provider:</p>
										{@render cmdBlock("ccs claude --auth", "ccs-2")}
										<p class="text-xs text-text-muted">3. Start the CCS proxy:</p>
										{@render cmdBlock("ccs cliproxy start", "ccs-3")}
										<p class="text-xs text-text-muted">4. Start OpenCode pointing to CCS:</p>
										{@render cmdBlock('ANTHROPIC_API_KEY="ccs-internal-managed" \\\n  ANTHROPIC_BASE_URL="http://127.0.0.1:8317/api/provider/claude/v1" \\\n  opencode serve --port 4098', "ccs-4")}
										<div class="mt-2 pt-2 border-t border-border/50">
											<p class="text-xs text-text-muted font-medium mb-1.5">For a second isolated instance (e.g. work account):</p>
											<p class="text-xs text-text-muted">5. Create a separate CCS config:</p>
											{@render cmdBlock("CCS_DIR=~/.ccs-work ccs claude --auth\nCCS_DIR=~/.ccs-work ccs cliproxy start", "ccs-5")}
											<p class="text-xs text-text-muted mt-2">6. Start another OpenCode:</p>
											{@render cmdBlock('ANTHROPIC_API_KEY="ccs-internal-managed" \\\n  ANTHROPIC_BASE_URL="http://127.0.0.1:8318/api/provider/claude/v1" \\\n  opencode serve --port 4099', "ccs-6")}
										</div>
										<p class="text-xs text-text-muted italic mt-1">Both instances appear here automatically.</p>
									</div>
								{/if}
							</div>

							<!-- Scenario 3: Custom -->
							<div class="border border-border rounded-lg overflow-hidden">
								<button
									type="button"
									class="flex items-center gap-2 w-full px-3 py-2.5 text-left text-sm font-medium text-text hover:bg-black/[0.03] dark:hover:bg-white/[0.03] cursor-pointer"
									onclick={() => toggleScenario("custom")}
								>
									<Icon
										name={expandedScenario === "custom" ? "chevron-down" : "chevron-right"}
										size={14}
										class="text-text-muted shrink-0"
									/>
									<span>Custom Setup</span>
								</button>
								{#if expandedScenario === "custom"}
									<div class="px-3 pb-3 space-y-2 border-t border-border pt-2.5">
										<p class="text-xs text-text-muted">Configure OpenCode with environment variables:</p>
										{@render cmdBlock("ANTHROPIC_API_KEY=sk-ant-... opencode serve --port 4098", "custom-1")}
										{@render cmdBlock("OPENAI_API_KEY=sk-... opencode serve --port 4099", "custom-2")}
										<p class="text-xs text-text-muted italic">Each instance appears here automatically.</p>
									</div>
								{/if}
							</div>

							<!-- Already started prompt -->
							<div class="flex items-center justify-center gap-2 pt-2 text-xs text-text-muted">
								<span>Already started an instance?</span>
								<button
									type="button"
									class="text-accent hover:text-accent-hover font-medium cursor-pointer"
									data-testid="scan-now-link"
									onclick={handleScanNow}
								>
									{scanInFlight ? "Scanning..." : "Scan Now"}
								</button>
							</div>
						</div>
					{/if}
			{:else if activeTab === "debug"}
				<div class="space-y-4">
					<div class="flex items-center justify-between">
						<div>
							<div class="text-sm font-medium text-text">Connection debug panel</div>
							<div class="text-xs text-text-muted mt-0.5">
								Shows WebSocket state transitions, timing, and connection lifecycle events.
							</div>
						</div>
						<button
							type="button"
							role="switch"
							aria-checked={featureFlags.debug}
							aria-label="Toggle debug panel"
							class="relative w-9 h-5 rounded-full transition-colors cursor-pointer {featureFlags.debug ? 'bg-accent' : 'bg-border'}"
							onclick={() => toggleFeature("debug")}
						>
							<span
								class="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform {featureFlags.debug ? 'translate-x-4' : ''}"
							></span>
						</button>
					</div>

					<div class="text-xs text-text-dimmer space-y-1.5">
						<div>
							Also available via URL param
							<code class="px-1 py-0.5 bg-black/[0.05] dark:bg-white/[0.08] rounded text-text-muted">?feats=debug</code>
						</div>
						<div>
							Keyboard shortcut:
							<kbd class="px-1.5 py-0.5 bg-black/[0.05] dark:bg-white/[0.08] rounded text-text-muted border border-border/50">Ctrl+Shift+D</kbd>
						</div>
					</div>
				</div>
			{/if}
			</div>
		</div>
	</div>
{/if}
