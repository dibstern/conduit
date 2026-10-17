<script lang="ts">
	import { serverStatus } from "../../stores/server-status.svelte.js";
	import SettingsRow from "../ui/SettingsRow.svelte";

	// Read-only on purpose: changing port or host from a browser can strand that browser.
	const status = $derived(serverStatus.status);
	const rows = $derived([
		{ id: "port", label: "Port", flag: "--port", value: status ? String(status.port) : "…" },
		{ id: "host", label: "Host", flag: "--host", value: status?.host ?? "…" },
		{ id: "https", label: "HTTPS", flag: "--no-https", value: status ? (status.tlsEnabled ? "On" : "Off") : "…" },
		{ id: "login", label: "Start at login", flag: "conduit service install", value: status ? (status.supervised ? "Installed" : "Not installed") : "…" },
	]);
	let open = $state(false);
</script>

<div id="server-startup" data-testid="server-startup-settings">
	<SettingsRow label="Set when conduit starts" summary="Port · host · HTTPS · more" expanded={open} onclick={() => (open = !open)} />
	{#if open}
		<div class="divide-y divide-settings-separator border-t border-settings-separator">
			<p class="px-[14px] py-2 text-[12px] text-text-muted">Change these from the terminal, then restart.</p>
			{#each rows as row (row.id)}
				<div data-testid="server-startup-{row.id}">
					<SettingsRow label={row.label} description={row.flag}>
						{#snippet control()}<span class="text-[13px] text-text-secondary">{row.value}</span>{/snippet}
					</SettingsRow>
				</div>
			{/each}
		</div>
	{/if}
</div>
