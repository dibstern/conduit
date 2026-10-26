<!-- Rain-on-the-grid overlay shown while the WebSocket connects. -->

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
	import { rpc } from "../../transport/ws-rpc-client.js";
	import type { InstanceStatus } from "../../types.js";
	import { CONNECT_FADEOUT_MS } from "../../ui-constants.js";
	import { openSettings } from "../layout/chrome-actions.js";
	import ConduitLogo from '../ui/ConduitLogo.svelte';
	import DripText from '../ui/DripText.svelte';
	import Button from '../ui/Button.svelte';
	import ConnectRain from './ConnectRain.svelte';

	const VERBS = ["Plugging in", "Patching through", "Tuning in", "Dialing up", "Handshaking", "Waking the wires", "Routing", "Piping up", "Bridging", "Pinging", "Hailing", "Splicing", "Wiring up", "Channelling", "Relaying", "Conducting", "Knocking", "Syncing", "Unspooling", "Untangling", "Plumbing", "Beaming", "Signalling", "Percolating", "Summoning", "Rendezvousing"];

	let fadeOut = $state(false);
	let displayNone = $state(false);
	let everConnected = $state(false);
	let hits = $state(0);
	let verb = $state("Connecting…");
	let verbQueue: string[] = [];
	let heroBox = $state<HTMLElement>();
	const tile = $derived(heroBox?.querySelector<HTMLElement>("[data-conduit-mark]") ?? undefined);

	const connected = $derived(getIsConnected());
	const relayStatus = $derived(connectionState.relayStatus);
	const relayError = $derived(connectionState.relayError);

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

	// The first connect plays with verbs; after a drop, say plainly that it is reconnecting.
	const reconnecting = $derived(everConnected && !connected);
	const statusLine = $derived(reconnecting ? "Reconnecting…" : verb);

	function handleTileHit() {
		hits++;
		if (connected || reconnecting) return;
		if (!verbQueue.length) verbQueue = VERBS.map((v) => ({ v, k: Math.random() })).sort((a, b) => a.k - b.k).map(({ v }) => `${v}…`);
		verb = verbQueue.pop() ?? verb;
	}

	$effect(() => {
		if (!connected) {
			fadeOut = false;
			displayNone = false;
		}
	});

	$effect(() => {
		if (!connected) return;

		everConnected = true;
		fadeOut = true;
		const hideTimer = setTimeout(() => {
			displayNone = true;
		}, CONNECT_FADEOUT_MS);

		return () => clearTimeout(hideTimer);
	});

	const isHidden = $derived(connected && displayNone);

	function handleStartInstance() {
		if (sameSession && instanceId === cachedInstanceId && cachedInstanceId) {
			void rpc("StartInstance", {
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
		<ConnectRain {tile} onhit={handleTileHit} />
		<!-- Radial glow orb -->
		<div class="absolute w-[400px] h-[400px] rounded-full pointer-events-none" style="top:50%;left:50%;transform:translate(-50%,-50%);background:radial-gradient(circle, rgb(from var(--color-accent) r g b / 0.08) 0%, rgb(from var(--color-success) r g b / 0.05) 40%, transparent 70%);"></div>

		<div class="flex flex-col items-center gap-3 relative z-10">
			<div bind:this={heroBox}><ConduitLogo size="loading" showText={true} {hits} /></div>

		<!-- Status text — only one of these renders at a time, no empty wrapper -->
		{#if relayStatus === "registering"}
		<div class="text-[14px] font-medium text-text-muted font-sans">
			Starting relay...
		</div>
		{:else if relayStatus === "error"}
			<div class="flex flex-col items-center gap-2">
			<div class="text-[14px] font-medium text-red-400 font-sans">
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
			<div class="text-[14px] font-medium font-sans" role="status">
				<span class="sr-only">{reconnecting ? "Reconnecting…" : "Connecting…"}</span>
				<DripText text={statusLine} />
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
