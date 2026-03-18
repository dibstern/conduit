<!-- ─── QR Modal ──────────────────────────────────────────────────────────── -->
<!-- QR code sharing modal. Renders a QR code of the current page URL         -->
<!-- (replacing localhost with LAN host when available). Click URL to copy.    -->
<!-- Escape or backdrop click to close.                                       -->

<script lang="ts">
	import QRCode from "@castlenine/svelte-qrcode";

	// ─── Props ──────────────────────────────────────────────────────────────────

	let {
		visible = false,
		onClose,
	}: { visible: boolean; onClose?: () => void } = $props();

	// ─── State ──────────────────────────────────────────────────────────────────

	let copied = $state(false);
	let copyTimer: ReturnType<typeof setTimeout> | null = null;

	// ─── Share URL logic ────────────────────────────────────────────────────────

	/** Network info fetched from /health when the modal opens. */
	let networkHost = $state<string | null>(null);

	/**
	 * Fetch daemon health to discover the best external address.
	 * Prefers Tailscale IP > LAN IP. Only needed when user is on localhost.
	 */
	async function fetchNetworkHost(): Promise<void> {
		try {
			const res = await fetch("/health");
			if (!res.ok) return;
			const data = await res.json();
			const tls = data.tlsEnabled === true;
			const scheme = tls ? "https" : "http";
			const ip = data.tailscaleIP ?? data.lanIP;
			if (ip) {
				networkHost = `${scheme}://${ip}:${data.port}`;
			}
		} catch {
			// Silently fail — share URL will just use window.location
		}
	}

	function getShareUrl(): string {
		if (typeof window === "undefined") return "";
		const h = window.location.hostname;
		// If we're on localhost and have a network host, rewrite the URL
		if ((h === "localhost" || h === "127.0.0.1") && networkHost) {
			// Replace origin (scheme + host + port) with the network host
			return window.location.href.replace(window.location.origin, networkHost);
		}
		return window.location.href;
	}

	const shareUrl = $derived(visible ? getShareUrl() : "");

	// Fetch network host when modal becomes visible
	$effect(() => {
		if (visible) {
			fetchNetworkHost();
		}
	});

	// ─── Copy to clipboard ──────────────────────────────────────────────────────

	async function copyUrl(): Promise<void> {
		const url = getShareUrl();
		try {
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(url);
			} else {
				// Fallback for older browsers
				const ta = document.createElement("textarea");
				ta.value = url;
				ta.style.position = "fixed";
				ta.style.left = "-9999px";
				document.body.appendChild(ta);
				ta.select();
				document.execCommand("copy");
				ta.remove();
			}
		} catch {
			// Silently fail if clipboard access is denied
			return;
		}

		copied = true;
		if (copyTimer) clearTimeout(copyTimer);
		copyTimer = setTimeout(() => {
			copied = false;
			copyTimer = null;
		}, 1500);
	}

	// ─── Backdrop click ─────────────────────────────────────────────────────────

	function handleBackdropClick(e: MouseEvent): void {
		if (e.target === e.currentTarget) {
			onClose?.();
		}
	}

	// ─── Escape key handler ─────────────────────────────────────────────────────

	$effect(() => {
		if (!visible) return;

		function handleKeydown(e: KeyboardEvent): void {
			if (e.key === "Escape") {
				onClose?.();
			}
		}

		document.addEventListener("keydown", handleKeydown);
		return () => document.removeEventListener("keydown", handleKeydown);
	});

	// ─── Reset copied state when closing ────────────────────────────────────────

	$effect(() => {
		if (!visible) {
			copied = false;
			if (copyTimer) {
				clearTimeout(copyTimer);
				copyTimer = null;
			}
		}
	});
</script>

{#if visible}
	<div
		class="modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-[rgba(var(--overlay-rgb),0.6)] backdrop-blur-sm"
		role="dialog"
		aria-modal="true"
		aria-label="Share Session"
		tabindex="-1"
		onclick={handleBackdropClick}
		onkeydown={(e) => { if (e.key === "Escape") onClose?.(); }}
	>
		<!-- Dialog card -->
		<div
			class="bg-bg-surface border border-border rounded-xl p-6 shadow-2xl max-w-xs w-full mx-4 flex flex-col items-center gap-4"
		>
			<!-- Title -->
			<h2 class="text-text font-semibold text-base">Share Session</h2>

			<!-- QR Code -->
			<div class="bg-white rounded-lg p-3">
				<QRCode
					data={shareUrl}
					size={200}
					errorCorrectionLevel="M"
					backgroundColor="#ffffff"
					color="#111111"
				/>
			</div>

			<!-- URL / Copied feedback -->
			<button
				type="button"
				class="text-sm font-mono px-3 py-1.5 rounded-md cursor-pointer transition-colors duration-150 max-w-full truncate
					{copied
					? 'text-success font-semibold bg-success/10'
					: 'text-text-muted hover:text-text hover:bg-bg-alt'}"
				onclick={copyUrl}
			>
				{copied ? "Copied!" : shareUrl}
			</button>

			<!-- Hint -->
			<p class="text-xs text-text-dimmer">
				Scan to open on another device
			</p>
		</div>
	</div>
{/if}
