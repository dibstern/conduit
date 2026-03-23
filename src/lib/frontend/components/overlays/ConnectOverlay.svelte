<!-- ─── Connect Overlay ───────────────────────────────────────────────────── -->
<!-- OpenCode "O" mark animation overlay shown during WebSocket connection.    -->

<script lang="ts">
	import { fade } from "svelte/transition";
	import { wsState, getIsConnected, wsSend } from "../../stores/ws.svelte.js";
	import { projectState } from "../../stores/project.svelte.js";
	import { getInstanceById, getCachedInstanceById, instanceState } from "../../stores/instance.svelte.js";
	import { navigate } from "../../stores/router.svelte.js";
	import type { InstanceStatus } from "../../types.js";
	import { CONNECT_FADEOUT_MS } from "../../ui-constants.js";
	import ConduitLogo from '../shared/ConduitLogo.svelte';

	// ─── State ──────────────────────────────────────────────────────────────────

	let fadeOut = $state(false);
	let displayNone = $state(false);

	// ─── Derived ────────────────────────────────────────────────────────────────

	const connected = $derived(getIsConnected());
	const relayStatus = $derived(wsState.relayStatus);
	const relayError = $derived(wsState.relayError);

	// Cached instance name — survives store clearing on WS disconnect.
	// Updated whenever a fresh value is derived from the store; retains
	// last-known name so the overlay can show "Reconnecting to Personal..."
	// even after clearInstanceState() runs.
	let cachedInstanceName = $state("OpenCode");
	let cachedInstanceId = $state<string | null>(null);
	let cachedInstanceStatus = $state<InstanceStatus | null>(null);
	let cachedMultiInstance = $state(false);

	const instanceName = $derived.by(() => {
		const slug = projectState.currentSlug;
		if (!slug) return cachedInstanceName;
		const project = projectState.projects.find((p) => p.slug === slug);
		if (project?.instanceId) {
			// Try live store first, fall back to cache (survives WS disconnect)
			const instance = getInstanceById(project.instanceId) ?? getCachedInstanceById(project.instanceId);
			if (instance?.name) return instance.name;
		}
		// Only update cache when we have fresh store data (instances loaded)
		return cachedInstanceName;
	});

	// Keep the cache in sync whenever instanceName resolves from real data
	$effect(() => {
		if (instanceName && instanceName !== cachedInstanceName) {
			cachedInstanceName = instanceName;
		}
	});

	// Cache the current instance id, status, and whether multi-instance is active
	$effect(() => {
		const slug = projectState.currentSlug;
		if (!slug) return;
		const project = projectState.projects.find((p) => p.slug === slug);
		if (project?.instanceId) {
			// Try live store first, fall back to cache
			const instance = getInstanceById(project.instanceId) ?? getCachedInstanceById(project.instanceId);
			if (instance) {
				cachedInstanceId = instance.id;
				cachedInstanceStatus = instance.status;
			}
		}
		cachedMultiInstance = instanceState.instances.length > 1;
	});

	// Show instance action buttons when overlay is visible, instance was unhealthy/stopped,
	// and there are multiple instances
	const showInstanceActions = $derived(
		!connected && cachedMultiInstance && cachedInstanceStatus != null &&
		cachedInstanceStatus !== "healthy" && cachedInstanceStatus !== "starting",
	);

	// ─── Status display text ────────────────────────────────────────────────────
	// When statusText is set (e.g. "Disconnected"), incorporate the instance name
	// so the overlay always shows which instance we're connected/reconnecting to.

	const displayStatusText = $derived.by(() => {
		if (
			wsState.statusText === "Connecting" ||
			wsState.statusText === "" ||
			!wsState.statusText
		) {
			return `Connecting to ${instanceName}...`;
		}
		if (wsState.statusText === "Disconnected") {
			return `Reconnecting to ${instanceName}...`;
		}
		return wsState.statusText;
	});

	// ─── Escape hatch: show "Back to dashboard" after prolonged disconnect ──────

	let showEscapeLink = $state(false);

	$effect(() => {
		if (connected) {
			showEscapeLink = false;
			return;
		}
		if (relayStatus === "error") {
			showEscapeLink = true;
			return;
		}
		// Show escape link after 4 seconds of failed connection
		const timer = setTimeout(() => {
			showEscapeLink = true;
		}, 4_000);
		return () => clearTimeout(timer);
	});

	function handleEscape(e: MouseEvent) {
		e.preventDefault();
		navigate("/");
	}

	// ─── Reset on disconnect ────────────────────────────────────────────────────

	$effect(() => {
		if (!connected) {
			fadeOut = false;
			displayNone = false;
		}
	});

	// ─── Hide animation when connected ──────────────────────────────────────────
	$effect(() => {
		if (!connected) return;

		fadeOut = true;
		const hideTimer = setTimeout(() => {
			displayNone = true;
		}, CONNECT_FADEOUT_MS);

		return () => clearTimeout(hideTimer);
	});

	// ─── Computed visibility ────────────────────────────────────────────────────
	const isHidden = $derived(connected && displayNone);

	// ─── Instance action handlers ──────────────────────────────────────────────
	function handleStartInstance() {
		if (cachedInstanceId) {
			wsSend({ type: "instance_start", instanceId: cachedInstanceId });
		}
	}

	function handleSwitchInstance() {
		window.dispatchEvent(new CustomEvent("settings:open", { detail: { tab: "instances" } }));
	}
</script>

{#if !isHidden}
	<div
		id="connect-overlay"
		class="connect-overlay fixed inset-0 z-50 flex items-center justify-center bg-bg"
		style="opacity: {fadeOut ? '0' : '1'}; transition: opacity 600ms ease; pointer-events: {fadeOut ? 'none' : 'auto'};"
	>
		<!-- Radial glow orb -->
		<div class="absolute w-[400px] h-[400px] rounded-full pointer-events-none" style="top:50%;left:50%;transform:translate(-50%,-50%);background:radial-gradient(circle, rgba(255,45,123,0.08) 0%, rgba(0,229,255,0.05) 40%, transparent 70%);"></div>

		<div class="flex flex-col items-center gap-3 relative z-10">
			<!-- Conduit logo with animated block grid -->
			<ConduitLogo size="loading" animated={true} showText={true} />

		<!-- Status text — only one of these renders at a time, no empty wrapper -->
		{#if relayStatus === "registering"}
		<div class="text-sm font-medium text-text-muted font-brand">
			Starting relay...
		</div>
		{:else if relayStatus === "error"}
			<div class="flex flex-col items-center gap-2">
			<div class="text-sm font-medium text-red-400 font-brand">
				Relay failed to start
			</div>
				{#if relayError}
					<div class="text-xs text-text-dimmer max-w-xs text-center truncate" title={relayError}>
						{relayError}
					</div>
				{/if}
				<a
					href="/"
					class="mt-1 px-4 py-1.5 text-sm rounded-lg bg-bg-surface border border-border text-text hover:bg-bg-alt font-medium"
					onclick={handleEscape}
				>
					Back to dashboard
				</a>
			</div>
		{:else}
			<div
				class="text-sm font-medium font-brand"
				style="background: linear-gradient(90deg, var(--color-brand-b), var(--color-brand-a)); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;"
			>
				{displayStatusText}
			</div>
		{/if}

		<!-- Instance action buttons (shown when instance is down in multi-instance mode) -->
		{#if showInstanceActions}
			<div class="flex gap-3 mt-2">
				<button
					class="px-4 py-1.5 text-sm rounded-lg border border-border text-text hover:bg-bg-alt font-medium"
					onclick={handleStartInstance}
				>
					Start Instance
				</button>
				<button
					class="px-4 py-1.5 text-sm rounded-lg border border-border text-text hover:bg-bg-alt font-medium"
					onclick={handleSwitchInstance}
				>
					Switch Instance
				</button>
			</div>
		{/if}
		</div>
	</div>
{/if}
