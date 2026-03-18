<!-- ─── Connect Overlay ───────────────────────────────────────────────────── -->
<!-- OpenCode "O" mark animation overlay shown during WebSocket connection.    -->
<!-- The inner fill sweeps up and down with smooth easing while random         -->
<!-- thinking verbs cycle with a shimmer gradient text effect.                 -->

<script lang="ts">
	import { fade } from "svelte/transition";
	import { wsState, getIsConnected, wsSend } from "../../stores/ws.svelte.js";
	import { projectState } from "../../stores/project.svelte.js";
	import { getInstanceById, getCachedInstanceById, instanceState } from "../../stores/instance.svelte.js";
	import { navigate } from "../../stores/router.svelte.js";
	import type { InstanceStatus } from "../../types.js";
	import { VERB_FADE_MS, VERB_CYCLE_MS, CONNECT_FADEOUT_MS } from "../../ui-constants.js";

	// ─── Thinking Verbs ─────────────────────────────────────────────────────────

	const THINKING_VERBS = [
		"Thinking",
		"Pondering",
		"Reflecting",
		"Musing",
		"Deliberating",
		"Considering",
		"Contemplating",
		"Wondering",
		"Analyzing",
		"Processing",
	];

	function randomThinkingVerb(): string {
		return THINKING_VERBS[Math.floor(Math.random() * THINKING_VERBS.length)] ?? "Thinking";
	}

	// ─── State ──────────────────────────────────────────────────────────────────

	let verb = $state(randomThinkingVerb());
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

	// ─── Verb cycling ───────────────────────────────────────────────────────────
	// Uses a {#key} block in the template so Svelte destroys the old element and
	// creates a new one on each cycle. Each element only ever renders one verb,
	// which completely sidesteps WebKit's GPU compositor caching stale
	// background-clip:text layers — there is no "old text" to leak through.

	$effect(() => {
		if (connected) return;
		if (relayStatus === "registering" || relayStatus === "error") return;
		const interval = setInterval(() => {
			let next: string;
			do { next = randomThinkingVerb(); } while (next === verb);
			verb = next;
		}, VERB_CYCLE_MS);
		return () => clearInterval(interval);
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
		class="connect-overlay fixed inset-0 z-50 flex items-center justify-center bg-bg/95"
		style="opacity: {fadeOut ? '0' : '1'}; transition: opacity 600ms ease; pointer-events: {fadeOut ? 'none' : 'auto'};"
	>
		<div class="flex flex-col items-center gap-6">
			<!-- OpenCode "O" Mark with animated fill -->
			<svg
				viewBox="0 0 16 20"
				fill="none"
				xmlns="http://www.w3.org/2000/svg"
				width="80"
				height="100"
				aria-hidden="true"
			>
				<defs>
					<clipPath id="o-hole-clip">
						<rect x="4" y="4" width="8" height="12" />
					</clipPath>
				</defs>

				<!-- Animated fill that sweeps through the "O" hole -->
				<g clip-path="url(#o-hole-clip)">
					<rect x="4" y="16" width="8" height="12" fill="currentColor" opacity="0.45" class="text-text-muted">
						<animate
							attributeName="y"
							values="16;-8;16"
							dur="2.5s"
							repeatCount="indefinite"
							calcMode="spline"
							keySplines="0.4 0 0.6 1;0.4 0 0.6 1"
						/>
					</rect>
				</g>

				<!-- Outer "O" frame (drawn on top to mask fill edges) -->
				<path
					d="M12 4H4V16H12V4ZM16 20H0V0H16V20Z"
					fill="currentColor"
					class="text-text"
				/>
			</svg>

		<!-- Thinking verb / relay status display -->
		<div class="relative flex flex-col items-center justify-center" style="min-height: 1.75rem;">
			{#if relayStatus === "registering"}
				<div class="text-lg font-medium text-text-muted">
					Starting relay...
				</div>
			{:else if relayStatus === "error"}
				<div class="text-lg font-medium text-red-400">
					Relay failed to start
				</div>
				{#if relayError}
					<div class="text-xs text-text-dimmer mt-1 max-w-xs text-center truncate" title={relayError}>
						{relayError}
					</div>
				{/if}
				<div class="flex gap-3 mt-3">
					<a
						href="/"
						class="px-4 py-1.5 text-sm rounded-lg border border-border text-text hover:bg-black/[0.05] font-medium"
						onclick={handleEscape}
					>
						Back to dashboard
					</a>
				</div>
			{:else}
				{#key verb}
					<div
						class="connect-verb text-lg font-medium absolute"
						in:fade={{ duration: VERB_FADE_MS, delay: VERB_FADE_MS }}
						out:fade={{ duration: VERB_FADE_MS }}
						style="
							background: linear-gradient(90deg, var(--color-accent), var(--color-text), var(--color-accent));
							background-size: 200%;
							animation: shimmer 2s linear infinite;
							-webkit-background-clip: text;
							background-clip: text;
							-webkit-text-fill-color: transparent;
						"
					>
						{verb}...
					</div>
				{/key}
			{/if}
		</div>

		<!-- Status text (hidden during relay registration/error — those states have their own messaging) -->
		{#if relayStatus !== "registering" && relayStatus !== "error"}
			<div class="text-sm text-text-muted">
				{displayStatusText}
			</div>
		{/if}

		<!-- Instance action buttons (shown when instance is down in multi-instance mode) -->
		{#if showInstanceActions}
			<div class="flex gap-3 mt-2">
				<button
					class="px-4 py-1.5 text-sm rounded-lg border border-border text-text hover:bg-black/[0.05] font-medium"
					onclick={handleStartInstance}
				>
					Start Instance
				</button>
				<button
					class="px-4 py-1.5 text-sm rounded-lg border border-border text-text hover:bg-black/[0.05] font-medium"
					onclick={handleSwitchInstance}
				>
					Switch Instance
				</button>
			</div>
		{/if}

		<!-- Escape hatch: appears after prolonged connection failure -->
		{#if showEscapeLink}
			{#if relayStatus !== "registering" && relayStatus !== "error"}
				<div class="text-[11px] text-text-dimmer mt-2" transition:fade={{ duration: 200 }}>
					Attempt {wsState.attempts}
				</div>
			{/if}
			<a
				href="/"
				class="mt-2 text-xs text-text-dimmer hover:text-text-muted transition-colors"
				onclick={handleEscape}
				transition:fade={{ duration: 200 }}
			>
				Back to dashboard
			</a>
		{/if}
		</div>
	</div>
{/if}
