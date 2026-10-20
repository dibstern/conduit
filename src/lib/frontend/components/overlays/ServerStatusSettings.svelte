<script lang="ts">
	import { refreshServerStatus, restartServer, serverStatus, shutdownServer } from "../../stores/server-status.svelte.js";
	import { toastFailure } from "../../transport/rpc-errors.js";
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
		} catch (error) {
			toastFailure("Failed to shut down conduit")(error);
		}
	}
</script>

<SettingsGroup id="server-status" title="Status" testId="server-status-card">
	{#if status}
		<div class="flex flex-wrap items-center gap-x-3 gap-y-3 px-[14px] py-[8px]">
			<div class="w-full md:w-auto md:flex-1 min-w-0" data-testid="server-status-details">
				<div class="flex items-center gap-[7px] text-[13.5px] font-semibold text-text max-md:text-[15px]">
					<span class="h-[8px] w-[8px] shrink-0 rounded-full bg-fill-green ring-[3px] ring-fill-green/20"></span>
					Running
				</div>
				<div class="mt-px flex flex-wrap items-center gap-x-1 gap-y-1 text-[12px] leading-[1.4] text-text-dimmer">
					<span class="whitespace-nowrap">conduit <span data-testid="server-status-version">{status.version}</span></span>
					<span class="whitespace-nowrap"><span aria-hidden="true">·</span>{" "}<span data-testid="server-status-uptime">up {uptime(status.uptime)}</span></span>
					<span class="whitespace-nowrap"><span aria-hidden="true">·</span>{" "}<span data-testid="server-status-port">port {status.port}</span></span>
					<span class="whitespace-nowrap" data-testid="server-status-browsers"><span aria-hidden="true">·</span>{" "}{status.clientCount} browser{status.clientCount === 1 ? "" : "s"} connected</span>
				</div>
				{#if !status.supervised}
					<p class="mt-1 text-[12px] text-text-muted">Start conduit again from the terminal with <code class="font-mono">conduit serve</code>.</p>
				{/if}
			</div>
			<div class="flex w-full gap-[6px] md:w-auto md:shrink-0" data-testid="server-status-actions">
				{#if status.supervised}
					<Button touchTarget variant="settings" size="content" icon="refresh-cw" iconSize={13} class="flex-1 md:flex-none max-md:h-[34px] max-md:text-[14px]" data-testid="server-restart-btn" disabled={busy} onclick={restartServer}>{restarting ? "Restarting…" : "Restart"}</Button>
				{/if}
				<Button touchTarget variant="settings" tone="error" size="content" icon="power" iconSize={13} class="flex-1 md:flex-none max-md:h-[34px] max-md:text-[14px]" data-testid="server-shutdown-btn" aria-expanded={openForm === "shutdown"} disabled={busy} onclick={() => onToggleForm("shutdown")}>Stop</Button>
			</div>
		</div>
		{#if openForm === "shutdown"}
			<div class="flex flex-col gap-3 px-[14px] py-3" data-server-form data-testid="server-shutdown-confirmation">
				<p class="text-[13.5px] font-semibold text-text">Stop conduit?</p>
				<p class="text-[12px] text-text-muted">
					{#if status.supervised}
						Every browser disconnects. The login service will start it straight back.
					{:else}
						Every browser disconnects. Start it again from the terminal with <code class="font-mono">conduit serve</code>.
					{/if}
				</p>
				<div class="flex justify-end gap-1.5">
					<Button touchTarget variant="settings" size="content" data-testid="server-shutdown-cancel" disabled={serverStatus.shutdownInFlight} onclick={() => onToggleForm("shutdown")}>Cancel</Button>
					<Button touchTarget variant="settings" tone="error" size="content" data-testid="server-shutdown-confirm" disabled={busy} onclick={confirmShutdown}>{serverStatus.shutdownInFlight ? "Stopping…" : "Stop"}</Button>
				</div>
			</div>
		{/if}
	{:else}
		<div class="flex items-center justify-between gap-3 px-3 py-3">
			<p>{serverStatus.error ? "Could not load server status." : "Loading server status…"}</p>
			{#if serverStatus.error}<Button touchTarget variant="settings" size="content" disabled={serverStatus.loading} onclick={refreshServerStatus}>Retry</Button>{/if}
		</div>
	{/if}
</SettingsGroup>
