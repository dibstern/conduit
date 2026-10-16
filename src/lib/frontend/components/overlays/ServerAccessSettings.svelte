<script lang="ts">
	import { refreshServerStatus, serverStatus } from "../../stores/server-status.svelte.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import { failureLine } from "../../transport/rpc-errors.js";
	import SettingsGroup from "../ui/SettingsGroup.svelte";
	import SettingsRow from "../ui/SettingsRow.svelte";

	const status = $derived(serverStatus.status);
	const available = $derived(status?.tailscaleServeAvailable === true);
	const caption = $derived.by(() => {
		if (!status) return serverStatus.error ? "Could not load Tailscale status." : "Loading Tailscale status…";
		if (!available) return "Not available on this computer";
		const serve = status.tailscaleServe;
		return serve && "url" in serve ? serve.url : "";
	});
	let saving = $state(false);
	let error = $state<string | null>(null);

	async function toggleTailscaleServe(): Promise<void> {
		if (!status || !available || saving) return;
		saving = true;
		error = null;
		try {
			await rpc("SetTailscaleServe", { enabled: !status.tailscaleServeEnabled });
			await refreshServerStatus();
			if (serverStatus.error) error = "Could not save Tailscale Serve. Try again.";
		} catch (cause) {
			error = failureLine(cause, "Could not save Tailscale Serve. Try again.");
		} finally {
			saving = false;
		}
	}
</script>

<SettingsGroup id="server-access" title="Access" testId="server-access-settings">
	<SettingsRow
		label="Tailscale Serve"
		ariaLabel="Toggle Tailscale Serve"
		checked={status?.tailscaleServeEnabled ?? false}
		disabled={!available || saving}
		description={caption}
		onchange={() => void toggleTailscaleServe()}
	/>
	{#if error}<p data-testid="server-tailscale-error" role="alert" class="px-3 py-2 text-[11px] text-error">{error}</p>{/if}
</SettingsGroup>
