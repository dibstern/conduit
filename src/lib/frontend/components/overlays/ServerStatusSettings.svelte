<script lang="ts">
	import { refreshServerStatus, restartServer, serverStatus, shutdownServer } from "../../stores/server-status.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import Button from "../ui/Button.svelte";
	import SettingsGroup from "../ui/SettingsGroup.svelte";
	import type { ServerForm } from "./ServerSettingsTab.svelte";

	let { openForm, onToggleForm, onClose }: { openForm: ServerForm | null; onToggleForm: (form: ServerForm) => void; onClose?: (() => void) | undefined } = $props();
	const status = $derived(serverStatus.status);
	const restarting = $derived(serverStatus.restartInFlight || serverStatus.restartAccepted);
	const busy = $derived(restarting || serverStatus.shutdownInFlight);

	function uptime(seconds: number): string {
		const minutes = Math.floor(seconds / 60);
		if (minutes < 1) return "less than a minute";
		const hours = Math.floor(minutes / 60);
		if (hours < 1) return `${minutes}m`;
		const days = Math.floor(hours / 24);
		return days > 0 ? `${days}d ${hours % 24}h` : `${hours}h ${minutes % 60}m`;
	}

	async function confirmShutdown(): Promise<void> {
		try {
			await shutdownServer();
			onClose?.();
		} catch {
			showToast("Failed to shut down conduit", { variant: "error" });
		}
	}
</script>

<SettingsGroup id="server-status" testId="server-status-card">
	{#if status}
		<div class="flex flex-wrap items-center gap-x-3 gap-y-3 px-3 py-3">
			<div class="w-full md:w-auto md:flex-1 min-w-0" data-testid="server-status-details">
				<div class="flex items-center gap-1.5 text-[12.5px] font-semibold text-text">
					<span class="h-[6px] w-[6px] shrink-0 rounded-full bg-fill-green"></span>
					Running · <span data-testid="server-status-uptime">up {uptime(status.uptime)}</span>
				</div>
				<div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-text-muted">
					<span>v<span data-testid="server-status-version">{status.version}</span></span>
					<span aria-hidden="true">·</span>
					<span data-testid="server-status-port">port {status.port}</span>
					<span aria-hidden="true">·</span>
					<span data-testid="server-status-browsers">{status.clientCount} browser{status.clientCount === 1 ? "" : "s"} connected</span>
				</div>
				{#if !status.supervised}
					<p class="mt-1 text-[11px] text-text-muted">Start conduit again from the terminal with <code class="font-mono">conduit serve</code>.</p>
				{/if}
			</div>
			<div class="flex w-full gap-1.5 md:w-auto md:shrink-0" data-testid="server-status-actions">
				{#if status.supervised}
					<Button variant="secondary" size="sm" class="flex-1 md:flex-none" data-testid="server-restart-btn" disabled={busy} onclick={restartServer}>{restarting ? "Restarting…" : "Restart"}</Button>
				{/if}
				<Button variant="danger-outline" size="sm" class="flex-1 md:flex-none" data-testid="server-shutdown-btn" aria-expanded={openForm === "shutdown"} disabled={busy} onclick={() => onToggleForm("shutdown")}>Shut down</Button>
			</div>
		</div>
		{#if openForm === "shutdown"}
			<div class="flex flex-col gap-3 px-3 py-3" data-server-form data-testid="server-shutdown-confirmation">
				<p class="text-[12.5px] font-semibold text-text">Shut down conduit?</p>
				<p class="text-[11px] text-text-muted">
					{#if status.supervised}
						Every browser disconnects. The login service will start it straight back.
					{:else}
						Every browser disconnects. Start it again from the terminal with <code class="font-mono">conduit serve</code>.
					{/if}
				</p>
				<div class="flex justify-end gap-1.5">
					<Button variant="secondary" size="sm" data-testid="server-shutdown-cancel" disabled={serverStatus.shutdownInFlight} onclick={() => onToggleForm("shutdown")}>Cancel</Button>
					<Button variant="danger" size="sm" data-testid="server-shutdown-confirm" disabled={busy} onclick={confirmShutdown}>{serverStatus.shutdownInFlight ? "Shutting down…" : "Shut down"}</Button>
				</div>
			</div>
		{/if}
	{:else}
		<div class="flex items-center justify-between gap-3 px-3 py-3">
			<p>{serverStatus.error ? "Could not load server status." : "Loading server status…"}</p>
			{#if serverStatus.error}<Button variant="secondary" size="sm" disabled={serverStatus.loading} onclick={refreshServerStatus}>Retry</Button>{/if}
		</div>
	{/if}
</SettingsGroup>
