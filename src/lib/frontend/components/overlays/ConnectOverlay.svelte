<!-- OpenCode "O" mark animation overlay shown during WebSocket connection.    -->

<script lang="ts">
	import { connectionState, getIsConnected } from "../../transport/connection-status.svelte.js";
	import { projectState } from "../../stores/project.svelte.js";
	import { getEffectiveInstanceId } from "../../stores/discovery.svelte.js";
	import { findSession, sessionState } from "../../stores/session.svelte.js";
	import {
		applyInstanceListResponse,
		getInstanceById,
		getCachedInstanceById,
		getInstanceTraits,
		instanceState,
	} from "../../stores/instance.svelte.js";
	import { startInstanceRpc } from "../../transport/ws-rpc-client.js";
	import type { InstanceStatus } from "../../types.js";
	import { CONNECT_FADEOUT_MS } from "../../ui-constants.js";
	import { openSettings } from "../layout/chrome-actions.js";
	import ConduitLogo from '../ui/ConduitLogo.svelte';
	import Button from '../ui/Button.svelte';

	let fadeOut = $state(false);
	let displayNone = $state(false);

	const connected = $derived(getIsConnected());
	const relayStatus = $derived(connectionState.relayStatus);
	const relayError = $derived(connectionState.relayError);

	// Cached instance name — survives store clearing on WS disconnect.
	// Updated whenever a fresh value is derived from the store; retains
	// last-known name so reconnect actions still target the right instance even
	// after clearInstanceState() runs.
	let cachedInstanceName = $state("OpenCode");
	let cachedInstanceId = $state<string | null>(null);
	let cachedInstanceStatus = $state<InstanceStatus | null>(null);
	let cachedMultiInstance = $state(false);
	let cachedRunsServer = $state(false);
	let cachedSessionId = $state<string | null>(null);
	const sameSession = $derived(cachedSessionId === sessionState.currentId);
	const instanceId = $derived(sessionState.currentId
		? findSession(sessionState.currentId)?.accountId
		: getEffectiveInstanceId());
	const currentInstance = $derived(instanceId
		? getInstanceById(instanceId) ?? getCachedInstanceById(instanceId)
		: undefined);

	const instanceName = $derived.by(() => {
		if (currentInstance?.name) return currentInstance.name;
		return instanceId && instanceId === cachedInstanceId ? cachedInstanceName : "Conduit";
	});

	// Keep the cache in sync whenever instanceName resolves from real data
	$effect(() => {
		if (instanceName && instanceName !== cachedInstanceName) {
			cachedInstanceName = instanceName;
		}
	});

	// Cache the current instance id, status, and whether multi-instance is active.
	// Only update cached values when the store has real data — NOT when cleared
	// on WS disconnect. This lets the overlay show "Start Instance" / "Switch
	// Instance" buttons even after clearInstanceState() empties the store.
	$effect(() => {
		if (currentInstance) {
			cachedSessionId = sessionState.currentId;
			cachedInstanceId = currentInstance.id;
			cachedInstanceStatus = currentInstance.status;
			cachedRunsServer = getInstanceTraits(currentInstance.id)?.runsOpenCodeServer ?? false;
		}
		// Only update when instances are loaded (not after clearInstanceState)
		if (instanceState.instances.length > 0) {
			cachedMultiInstance = instanceState.instances.length > 1;
		}
	});

	// Show instance action buttons when overlay is visible, instance was unhealthy/stopped,
	// and there are multiple instances
	const showInstanceActions = $derived(
		sameSession && instanceId === cachedInstanceId && cachedRunsServer && !connected && cachedMultiInstance && cachedInstanceStatus != null &&
		cachedInstanceStatus !== "healthy" && cachedInstanceStatus !== "starting",
	);

	// Keep reconnect copy generic; instance/provider names remain available for
	// action buttons and connecting state.

	const displayStatusText = $derived.by(() => {
		if (
			connectionState.statusText === "Connecting" ||
			connectionState.statusText === "" ||
			!connectionState.statusText
		) {
			return instanceName ? `Connecting to ${instanceName} server...` : "Connecting...";
		}
		if (connectionState.statusText === "Disconnected") {
			return "Reconnecting...";
		}
		return connectionState.statusText;
	});

	$effect(() => {
		if (!connected) {
			fadeOut = false;
			displayNone = false;
		}
	});

	$effect(() => {
		if (!connected) return;

		fadeOut = true;
		const hideTimer = setTimeout(() => {
			displayNone = true;
		}, CONNECT_FADEOUT_MS);

		return () => clearTimeout(hideTimer);
	});

	const isHidden = $derived(connected && displayNone);

	function handleStartInstance() {
		if (sameSession && instanceId === cachedInstanceId && cachedInstanceId) {
			void startInstanceRpc({
				instanceId: cachedInstanceId,
			})
				.then(applyInstanceListResponse)
				.catch(() => undefined);
		}
	}

	function handleSwitchInstance() {
		openSettings("server", "instances");
	}
</script>

{#if !isHidden}
	<div
		id="connect-overlay"
		class="connect-overlay fixed inset-0 z-50 flex items-center justify-center bg-bg"
		style="opacity: {fadeOut ? '0' : '1'}; transition: opacity 600ms ease; pointer-events: {fadeOut ? 'none' : 'auto'};"
	>
		<!-- Radial glow orb -->
		<div class="absolute w-[400px] h-[400px] rounded-full pointer-events-none" style="top:50%;left:50%;transform:translate(-50%,-50%);background:radial-gradient(circle, rgb(from var(--color-accent) r g b / 0.08) 0%, rgb(from var(--color-success) r g b / 0.05) 40%, transparent 70%);"></div>

		<div class="flex flex-col items-center gap-3 relative z-10">
			<!-- Conduit logo with animated block grid -->
			<ConduitLogo size="loading" animated={true} showText={true} />

		<!-- Status text — only one of these renders at a time, no empty wrapper -->
		{#if relayStatus === "registering"}
		<div class="text-sm font-medium text-text-muted font-sans">
			Starting relay...
		</div>
		{:else if relayStatus === "error"}
			<div class="flex flex-col items-center gap-2">
			<div class="text-sm font-medium text-red-400 font-sans">
				Relay failed to start
			</div>
				{#if relayError}
					<div
						class="text-xs text-text-dimmer max-w-xs max-h-[200px] overflow-y-auto break-words whitespace-pre-wrap text-left font-mono"
					>
						{relayError}
					</div>
				{/if}
			</div>
		{:else}
			<div
				class="text-sm font-medium font-sans"
				style="background: linear-gradient(90deg, var(--color-success), var(--color-accent)); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;"
			>
				{displayStatusText}
			</div>
		{/if}

		<!-- Instance action buttons (shown when instance is down in multi-instance mode) -->
		{#if showInstanceActions}
			<div class="flex gap-3 mt-2">
				<Button
					variant="secondary"
					size="content"
					class="px-4 py-1.5 text-sm rounded-lg font-medium"
					onclick={handleStartInstance}
				>
					Start Instance
				</Button>
				<Button
					variant="secondary"
					size="content"
					class="px-4 py-1.5 text-sm rounded-lg font-medium"
					onclick={handleSwitchInstance}
				>
					Switch Instance
				</Button>
			</div>
		{/if}
		</div>
	</div>
{/if}
