<script lang="ts">
	import { serverStatus } from "../../stores/server-status.svelte.js";
	import SettingsGroup from "../ui/SettingsGroup.svelte";
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

<SettingsGroup
	id="server-startup"
	title="Set when conduit starts"
	summary="Port · host · HTTPS · more"
	collapsible
	bind:open
	testId="server-startup-settings"
>
	<p class="px-3 py-2 text-[11px] text-text-muted">Change these from the terminal, then restart.</p>
	{#each rows as row (row.id)}
		<div data-testid="server-startup-{row.id}">
			<SettingsRow label={row.label} description={row.flag}>
				{#snippet control()}<span class="text-[11px] text-text-muted">{row.value}</span>{/snippet}
			</SettingsRow>
		</div>
	{/each}
</SettingsGroup>
