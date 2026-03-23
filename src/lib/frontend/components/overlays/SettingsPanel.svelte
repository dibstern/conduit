<!-- ─── Settings Panel ────────────────────────────────────────────────────── -->
<!-- Modal settings panel with tabbed navigation. Uses the 68-mockup card   -->
<!-- design. Tabs: Notifications, Appearance, Instances, Debug.             -->

<script lang="ts">
	import Icon from "../shared/Icon.svelte";
	import type { Base16Theme } from "../../stores/theme-compute.js";
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
	import {
		themeState,
		getThemeLists,
		applyTheme,
	} from "../../stores/theme.svelte.js";
	import {
		type NotifSettings,
		getNotifSettings,
		saveNotifSettings,
	} from "../../utils/notif-settings.js";
	import { setPushActive } from "../../stores/ws.svelte.js";

	// ─── Props ──────────────────────────────────────────────────────────────

	let {
		visible = false,
		initialTab = "notifications",
		onClose,
	}: { visible: boolean; initialTab?: string; onClose?: () => void } =
		$props();

	// ─── Local state ────────────────────────────────────────────────────────

	let activeTab = $state("notifications");

	// Instance management
	let expandedInstanceId = $state<string | null>(null);
	let renamingInstanceId = $state<string | null>(null);
	let renameValue = $state("");
	let expandedScenario = $state<string | null>(null);
	let copiedKey = $state<string | null>(null);
	let copyTimer: ReturnType<typeof setTimeout> | null = null;

	// Notification settings
	let notifSettings: NotifSettings = $state(getNotifSettings());
	let pushBlocked = $state(
		typeof Notification !== "undefined" && Notification.permission === "denied",
	);
	let browserBlocked = $state(
		typeof Notification !== "undefined" && Notification.permission === "denied",
	);
	let pushBusy = $state(false);
	let pushError = $state("");
	const pushUnavailable =
		typeof Notification === "undefined" ||
		!("serviceWorker" in navigator) ||
		(typeof window !== "undefined" && !window.isSecureContext);

	// ─── Derived ────────────────────────────────────────────────────────────

	const instances = $derived(getCachedInstances());
	const scanInFlight = $derived(isScanInFlight());
	const scanResult = $derived(getScanResult());
	const proxyResult = $derived(getProxyDetection());
	const ccsDetected = $derived(proxyResult?.found ?? false);
	const themeLists = $derived(getThemeLists());

	const SWATCH_KEYS = ["base00", "base01", "base09", "base0B", "base0D"] as const;

	// ─── Effects ────────────────────────────────────────────────────────────

	$effect(() => {
		if (visible) {
			activeTab = initialTab;
			expandedInstanceId = null;
			renamingInstanceId = null;
			expandedScenario = null;
			notifSettings = getNotifSettings();
			startProxyDetection(wsSend);
		}
	});

	// ─── Instance handlers ──────────────────────────────────────────────────

	function handleToggleInstance(instanceId: string) {
		expandedInstanceId = expandedInstanceId === instanceId ? null : instanceId;
		if (expandedInstanceId !== instanceId) renamingInstanceId = null;
	}
	function handleStart(instanceId: string) { wsSend({ type: "instance_start", instanceId }); }
	function handleStop(instanceId: string) { wsSend({ type: "instance_stop", instanceId }); }
	async function handleRemove(instanceId: string, instanceName: string) {
		const confirmed = await confirm(`Remove instance "${instanceName}"? This cannot be undone.`);
		if (confirmed) wsSend({ type: "instance_remove", instanceId });
	}
	function handleScanNow() { triggerScan(wsSend); }
	function startRename(instanceId: string, currentName: string) {
		renamingInstanceId = instanceId;
		renameValue = currentName;
	}
	function submitRename() {
		if (!renamingInstanceId) return;
		const trimmed = renameValue.trim();
		if (!trimmed) { showToast("Instance name cannot be empty", { variant: "warn" }); return; }
		wsSend({ type: "instance_rename", instanceId: renamingInstanceId, name: trimmed });
		renamingInstanceId = null;
	}
	function cancelRename() { renamingInstanceId = null; }
	function handleRenameKeydown(e: KeyboardEvent) {
		if (e.key === "Enter") { e.preventDefault(); submitRename(); }
		else if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
	}
	async function handleCopy(text: string, key: string) {
		const ok = await copyToClipboard(text);
		if (ok) {
			copiedKey = key;
			if (copyTimer) clearTimeout(copyTimer);
			copyTimer = setTimeout(() => { copiedKey = null; copyTimer = null; }, 2000);
		} else { showToast("Failed to copy — clipboard unavailable", { variant: "warn" }); }
	}
	function toggleScenario(id: string) { expandedScenario = expandedScenario === id ? null : id; }

	// ─── Notification handlers ──────────────────────────────────────────────

	async function togglePush(): Promise<void> {
		if (pushBusy) return;
		pushBusy = true;
		pushError = "";
		try {
			if (!notifSettings.push) {
				if (pushUnavailable) { pushError = "Push notifications require a secure connection (HTTPS)."; return; }
				const permission = await Notification.requestPermission();
				pushBlocked = permission === "denied";
				if (permission !== "granted") return;
				const { enablePushSubscription } = await import("../../utils/notifications.js");
				await enablePushSubscription();
				notifSettings.push = true;
				setPushActive(true);
				try {
					const swReg = await navigator.serviceWorker.ready;
					await swReg.showNotification("Push Enabled", { body: "Push notifications are now active.", tag: "opencode-push-enabled" });
				} catch { /* non-fatal */ }
			} else {
				notifSettings.push = false;
				setPushActive(false);
				const swReg = await navigator.serviceWorker.ready;
				await swReg.showNotification("Push Disabled", { body: "Browser alerts will be used instead.", tag: "opencode-push-disabled" });
				const sub = await swReg.pushManager.getSubscription();
				if (sub) {
					const endpoint = sub.endpoint;
					await sub.unsubscribe();
					await fetch("/api/push/unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint }) });
				}
				await swReg.unregister();
			}
		} catch (err) {
			console.warn("[push] Toggle failed:", err);
			notifSettings.push = false;
			setPushActive(false);
			pushError = err instanceof Error ? err.message : "Push notification setup failed.";
		} finally {
			saveNotifSettings(notifSettings);
			pushBusy = false;
		}
	}
	async function toggleBrowser(): Promise<void> {
		const newValue = !notifSettings.browser;
		if (newValue && typeof Notification !== "undefined") {
			if (Notification.permission === "denied") { browserBlocked = true; return; }
			if (Notification.permission !== "granted") {
				const perm = await Notification.requestPermission();
				browserBlocked = perm === "denied";
				if (perm !== "granted") return;
			}
			try { const n = new Notification("Browser Alerts Enabled", { body: "You will be notified when tasks complete.", tag: "opencode-browser-test" }); setTimeout(() => n.close(), 5000); } catch { /* */ }
		}
		notifSettings.browser = newValue;
		saveNotifSettings(notifSettings);
	}
	function toggleSound(): void {
		notifSettings.sound = !notifSettings.sound;
		saveNotifSettings(notifSettings);
	}

	// ─── Backdrop / escape ──────────────────────────────────────────────────

	function handleBackdropClick(e: MouseEvent) {
		if (e.target === e.currentTarget) onClose?.();
	}
	$effect(() => {
		if (!visible) return;
		function handleKeydown(e: KeyboardEvent) { if (e.key === "Escape") onClose?.(); }
		document.addEventListener("keydown", handleKeydown);
		return () => document.removeEventListener("keydown", handleKeydown);
	});
</script>

<!-- ─── Copyable command block snippet ────────────────────────────────────── -->
{#snippet cmdBlock(cmd: string, key: string)}
	<div class="group/cmd flex items-start gap-1.5 bg-black/[0.04] dark:bg-white/[0.06] rounded px-2.5 py-1.5 font-mono text-xs text-text leading-relaxed">
		<span class="flex-1 whitespace-pre-wrap break-all select-all">{cmd}</span>
		<button type="button" class="shrink-0 p-0.5 text-text-muted hover:text-text opacity-0 group-hover/cmd:opacity-100 transition-opacity cursor-pointer" title="Copy" onclick={() => handleCopy(cmd, key)}>
			{#if copiedKey === key}<Icon name="check" size={13} class="text-green-500" />{:else}<Icon name="copy" size={13} />{/if}
		</button>
	</div>
{/snippet}

<!-- ─── Toggle switch snippet ────────────────────────────────────────────── -->
{#snippet toggleSwitch(checked: boolean, onclick: () => void, disabled?: boolean, dimmed?: boolean, label?: string)}
	<button
		type="button"
		role="switch"
		aria-checked={checked}
		aria-label={label}
		class="relative w-9 h-5 rounded-full transition-[background,box-shadow] cursor-pointer border-none shrink-0 {checked ? 'bg-brand-a' : 'bg-text-dimmer'} {dimmed ? 'opacity-40' : ''}"
		style={checked ? "box-shadow: 0 0 8px rgba(255,45,123,0.4);" : ""}
		{disabled}
		{onclick}
	>
		<span class="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform {checked ? 'translate-x-4' : ''}"></span>
	</button>
{/snippet}

{#if visible}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="fixed inset-0 z-[200] flex items-center justify-center bg-[rgba(var(--overlay-rgb),0.15)] backdrop-blur-sm" onclick={handleBackdropClick}>
		<div id="settings-panel" class="bg-bg border border-border rounded-xl shadow-2xl max-w-lg w-full mx-4 flex flex-col max-h-[80vh]">
			<!-- Header -->
			<div class="flex items-center justify-between px-5 py-3 border-b border-border">
				<h2 class="text-lg font-semibold text-text font-brand">Settings</h2>
				<button class="text-text-muted hover:text-text p-1 cursor-pointer border-none bg-transparent" onclick={() => onClose?.()}>
					<Icon name="x" size={16} />
				</button>
			</div>

			<!-- Tabs -->
			<div class="flex border-b border-border px-5 gap-1 font-brand">
				{#each [
					{ id: "notifications", label: "Alerts" },
					{ id: "appearance", label: "Theme" },
					{ id: "instances", label: "Instances" },
					{ id: "debug", label: "Debug" },
				] as tab}
					<button
						class="px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors cursor-pointer border-none bg-transparent {activeTab === tab.id ? 'border-brand-a text-text' : 'border-transparent text-text-muted hover:text-text'}"
						style="border-bottom: 2px solid {activeTab === tab.id ? 'var(--color-brand-a)' : 'transparent'};"
						onclick={() => (activeTab = tab.id)}
					>
						{tab.label}
					</button>
				{/each}
			</div>

			<!-- Tab content -->
			<div class="flex-1 overflow-y-auto p-5">

				<!-- ═══ Notifications ═══ -->
				{#if activeTab === "notifications"}
					<div class="space-y-2">
					<div class="bg-bg-surface border border-border rounded-[10px] px-5 py-4 flex items-center justify-between gap-4 font-brand">
						<div class="flex items-center gap-3 flex-1 min-w-0">
							<Icon name="smartphone" size={16} class="text-text-muted shrink-0" />
							<div><div class="text-sm font-medium text-text">Push notifications</div><div class="text-xs text-text-muted mt-0.5">Receive push notifications even when the tab is closed</div></div>
						</div>
						{@render toggleSwitch(notifSettings.push, togglePush, pushBusy || pushUnavailable, pushUnavailable, "Push notifications")}
					</div>
					<div class="bg-bg-surface border border-border rounded-[10px] px-5 py-4 flex items-center justify-between gap-4 font-brand">
						<div class="flex items-center gap-3 flex-1 min-w-0">
							<Icon name="bell" size={16} class="text-text-muted shrink-0" />
							<div><div class="text-sm font-medium text-text">Browser alerts</div><div class="text-xs text-text-muted mt-0.5">Show desktop notifications when tasks complete</div></div>
						</div>
						{@render toggleSwitch(notifSettings.browser, toggleBrowser, undefined, undefined, "Browser alerts")}
					</div>
					<div class="bg-bg-surface border border-border rounded-[10px] px-5 py-4 flex items-center justify-between gap-4 font-brand">
							<div class="flex items-center gap-3 flex-1 min-w-0">
								<Icon name="volume-2" size={16} class="text-text-muted shrink-0" />
								<div><div class="text-sm font-medium text-text">Sound</div><div class="text-xs text-text-muted mt-0.5">Play a sound when notifications are triggered</div></div>
							</div>
							{@render toggleSwitch(notifSettings.sound, toggleSound, undefined, undefined, "Sound")}
						</div>
						{#if pushUnavailable}
							<div class="px-2 py-1.5 text-xs text-text-muted">Push notifications require HTTPS. Enable a certificate in the CLI settings.</div>
						{:else if pushError}
							<div class="px-2 py-1.5 text-xs text-error">{pushError}</div>
						{:else if pushBlocked}
							<div class="px-2 py-1.5 text-xs text-error">Push notifications are blocked by your browser. Update site settings to allow notifications.</div>
						{:else if browserBlocked}
							<div class="px-2 py-1.5 text-xs text-error">Browser alerts are blocked. Update site settings to allow notifications.</div>
						{/if}
					</div>

				<!-- ═══ Appearance ═══ -->
				{:else if activeTab === "appearance"}
					<div class="space-y-4">
						{#each [
							{ key: "dark", label: "Dark", items: themeLists.dark },
							{ key: "light", label: "Light", items: themeLists.light },
							{ key: "custom", label: "Custom", items: themeLists.custom },
						] as section}
							{#if section.items.length > 0}
								<div>
									<div class="text-xs font-semibold uppercase tracking-widest text-text-muted px-1 mb-2 font-brand">{section.label}</div>
									<div class="space-y-1">
										{#each section.items as { id, theme }}
											<button
												class="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors cursor-pointer bg-transparent {themeState.currentThemeId === id ? 'border-brand-a bg-brand-a/5' : 'border-transparent hover:bg-bg-surface'}"
												onclick={() => applyTheme(id)}
											>
												<div class="flex gap-[2px] shrink-0">
													{#each SWATCH_KEYS as key}
														<span class="w-3 h-3 rounded-sm border border-white/10" style="background: #{theme[key]};"></span>
													{/each}
												</div>
												<span class="flex-1 text-left text-base font-brand {themeState.currentThemeId === id ? 'text-text font-medium' : 'text-text-secondary'}">
													{theme.name}
												</span>
												{#if themeState.currentThemeId === id}
													<Icon name="check" size={14} class="text-success shrink-0" />
												{/if}
											</button>
										{/each}
									</div>
								</div>
							{/if}
						{/each}
					</div>

				<!-- ═══ Instances ═══ -->
				{:else if activeTab === "instances"}
					<div class="flex items-center justify-between mb-3">
						<span class="text-xs text-text-muted font-medium uppercase tracking-wide font-brand">
							{instances.length} instance{instances.length !== 1 ? "s" : ""}
						</span>
					<button
						type="button"
					class="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded border border-border text-text-muted hover:text-text hover:border-text-muted transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed font-brand"
						data-testid="scan-now-btn"
						disabled={scanInFlight}
						onclick={handleScanNow}
					>
							<Icon name="refresh-cw" size={12} class={scanInFlight ? "animate-spin" : ""} />
							{scanInFlight ? "Scanning..." : "Scan Now"}
						</button>
					</div>

					{#if scanResult && !scanInFlight}
					<div class="mb-3 text-xs text-text-muted bg-white/[0.04] rounded px-2.5 py-1.5 font-brand">
							{#if scanResult.discovered.length > 0}
								Found {scanResult.discovered.length} new instance{scanResult.discovered.length !== 1 ? "s" : ""} on port{scanResult.discovered.length !== 1 ? "s" : ""} {scanResult.discovered.join(", ")}.
							{:else if scanResult.lost.length > 0}
								{scanResult.lost.length} instance{scanResult.lost.length !== 1 ? "s" : ""} lost (port{scanResult.lost.length !== 1 ? "s" : ""} {scanResult.lost.join(", ")}).
							{:else if scanResult.active.length > 0}
								{scanResult.active.length} active instance{scanResult.active.length !== 1 ? "s" : ""} on port{scanResult.active.length !== 1 ? "s" : ""} {scanResult.active.join(", ")} (no changes).
							{:else}
								No active instances found.
							{/if}
						</div>
					{/if}

					{#if instances.length > 0}
					<div id="instance-settings-list" class="space-y-1 font-brand">
							{#each instances as inst}
								<div class="border border-border rounded-lg">
									<button class="flex items-center justify-between w-full px-3 py-2 text-left text-sm hover:bg-white/[0.03] cursor-pointer bg-transparent border-none" onclick={() => handleToggleInstance(inst.id)}>
										<div class="flex items-center gap-2 min-w-0">
											<span class={"w-2 h-2 rounded-full shrink-0 " + instanceStatusColor(inst.status)}></span>
											{#if renamingInstanceId === inst.id}
												<!-- svelte-ignore a11y_autofocus -->
												<input type="text" class="px-1.5 py-0.5 text-sm border border-accent rounded bg-bg text-text w-36" bind:value={renameValue} onkeydown={handleRenameKeydown} onclick={(e) => e.stopPropagation()} onfocusout={submitRename} autofocus />
											{:else}
												<span class="font-medium text-text truncate">{inst.name}</span>
											{/if}
											{#if !inst.managed}
												<span class="text-xs text-text-muted bg-white/[0.08] px-1.5 py-0.5 rounded-full">discovered</span>
											{/if}
										</div>
										<span class="text-text-muted text-xs shrink-0 ml-2">:{inst.port}</span>
									</button>
									{#if expandedInstanceId === inst.id}
										<div class="flex flex-wrap gap-2 px-3 py-2 border-t border-border">
											{#if inst.managed}
												<button class="px-3 py-1 text-xs rounded border border-border text-text hover:bg-white/[0.05] cursor-pointer bg-transparent" onclick={() => handleStart(inst.id)}>Start</button>
												<button class="px-3 py-1 text-xs rounded border border-border text-text hover:bg-white/[0.05] cursor-pointer bg-transparent" onclick={() => handleStop(inst.id)}>Stop</button>
											{/if}
											<button class="px-3 py-1 text-xs rounded border border-border text-accent hover:bg-accent/10 cursor-pointer bg-transparent" data-testid="rename-instance-btn" onclick={() => startRename(inst.id, inst.name)}>Rename</button>
											<button class="px-3 py-1 text-xs rounded border border-red-700 text-red-500 hover:bg-red-500/10 cursor-pointer bg-transparent" onclick={() => handleRemove(inst.id, inst.name)}>Remove</button>
										</div>
									{/if}
								</div>
							{/each}
						</div>
					{/if}

					{#if instances.length === 0}
					<div class="mt-2 space-y-2 font-brand">
							<p class="text-sm text-text-muted mb-3">No OpenCode instances detected. Start one from your terminal and it will appear here automatically.</p>
							<div class="border border-border rounded-lg overflow-hidden">
								<button type="button" class="flex items-center gap-2 w-full px-3 py-2.5 text-left text-sm font-medium text-text hover:bg-white/[0.03] cursor-pointer bg-transparent border-none" onclick={() => toggleScenario("direct")}>
									<Icon name={expandedScenario === "direct" ? "chevron-down" : "chevron-right"} size={14} class="text-text-muted shrink-0" />
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
							<div class="border border-border rounded-lg overflow-hidden">
								<button type="button" class="flex items-center gap-2 w-full px-3 py-2.5 text-left text-sm font-medium text-text hover:bg-white/[0.03] cursor-pointer bg-transparent border-none" onclick={() => toggleScenario("ccs")}>
									<Icon name={expandedScenario === "ccs" ? "chevron-down" : "chevron-right"} size={14} class="text-text-muted shrink-0" />
									<span>Multi-Provider — Via CCS</span>
									{#if ccsDetected}<Icon name="circle-check" size={14} class="text-green-500 ml-auto shrink-0" />{:else if proxyResult === null}<span class="text-xs text-text-muted animate-pulse ml-auto">detecting...</span>{/if}
								</button>
								{#if expandedScenario === "ccs"}
									<div class="px-3 pb-3 space-y-2 border-t border-border pt-2.5">
										<p class="text-xs text-text-muted">CCS manages OAuth tokens and API keys for 20+ providers.</p>
										{#if ccsDetected}
											<div class="flex items-center gap-1.5 text-xs text-green-400 bg-green-500/10 rounded px-2 py-1"><Icon name="circle-check" size={12} />CCS detected on port {proxyResult?.port ?? 8317}</div>
										{/if}
										<p class="text-xs text-text-muted">1. Install CCS:</p>
										{@render cmdBlock("npm install -g @anthropic-ai/ccs", "ccs-1")}
										<p class="text-xs text-text-muted">2. Authenticate:</p>
										{@render cmdBlock("ccs claude --auth", "ccs-2")}
										<p class="text-xs text-text-muted">3. Start proxy:</p>
										{@render cmdBlock("ccs cliproxy start", "ccs-3")}
										<p class="text-xs text-text-muted">4. Start OpenCode:</p>
										{@render cmdBlock('ANTHROPIC_API_KEY="ccs-internal-managed" \\\n  ANTHROPIC_BASE_URL="http://127.0.0.1:8317/api/provider/claude/v1" \\\n  opencode serve --port 4098', "ccs-4")}
									</div>
								{/if}
							</div>
							<div class="border border-border rounded-lg overflow-hidden">
								<button type="button" class="flex items-center gap-2 w-full px-3 py-2.5 text-left text-sm font-medium text-text hover:bg-white/[0.03] cursor-pointer bg-transparent border-none" onclick={() => toggleScenario("custom")}>
									<Icon name={expandedScenario === "custom" ? "chevron-down" : "chevron-right"} size={14} class="text-text-muted shrink-0" />
									<span>Custom Setup</span>
								</button>
								{#if expandedScenario === "custom"}
									<div class="px-3 pb-3 space-y-2 border-t border-border pt-2.5">
										<p class="text-xs text-text-muted">Configure with environment variables:</p>
										{@render cmdBlock("ANTHROPIC_API_KEY=sk-ant-... opencode serve --port 4098", "custom-1")}
									</div>
								{/if}
							</div>
							<div class="flex items-center justify-center gap-2 pt-2 text-xs text-text-muted">
								<span>Already started?</span>
								<button type="button" class="text-accent hover:text-accent font-medium cursor-pointer border-none bg-transparent" data-testid="scan-now-link" onclick={handleScanNow}>{scanInFlight ? "Scanning..." : "Scan Now"}</button>
							</div>
						</div>
					{/if}

				<!-- ═══ Debug ═══ -->
				{:else if activeTab === "debug"}
					<div class="space-y-2">
					<div class="bg-bg-surface border border-border rounded-[10px] px-5 py-4 flex items-center justify-between gap-4 font-brand">
						<div class="flex-1 min-w-0">
							<div class="text-sm font-medium text-text">Connection debug panel</div>
								<div class="text-xs text-text-muted mt-0.5">Shows WebSocket state transitions, timing, and lifecycle events.</div>
							</div>
							{@render toggleSwitch(featureFlags.debug, () => toggleFeature("debug"), undefined, undefined, "Connection debug panel")}
						</div>
						<div class="text-xs text-text-dimmer space-y-1.5 px-1 font-brand">
							<div>URL param: <code class="px-1 py-0.5 bg-white/[0.08] rounded text-text-muted">?feats=debug</code></div>
							<div>Keyboard: <kbd class="px-1.5 py-0.5 bg-white/[0.08] rounded text-text-muted border border-border/50">Ctrl+Shift+D</kbd></div>
						</div>
					</div>
				{/if}
			</div>
		</div>
	</div>
{/if}
