<script lang="ts">
	import {
		refreshServerStatus,
		serverStatus,
	} from "../../stores/server-status.svelte.js";
	import { RpcLogLevelSchema, type RpcLogLevel } from "../../transport/ws-rpc.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import { failureLine } from "../../transport/rpc-errors.js";
	import SettingsPicker from "../ui/SettingsPicker.svelte";
	import SettingsRow from "../ui/SettingsRow.svelte";

	let open = $state(false);
	let logLevel = $state("");
	let saving = $state(false);
	let error = $state<string | null>(null);

	$effect(() => {
		logLevel = serverStatus.status?.logLevel ?? "";
	});

	async function changeLogLevel(level: RpcLogLevel): Promise<void> {
		if (!serverStatus.status || saving) return;
		const previousLevel = serverStatus.status.logLevel;
		logLevel = level;
		saving = true;
		error = null;
		try {
			await rpc("SetLogLevel", { level });
			await refreshServerStatus();
			logLevel = serverStatus.status?.logLevel ?? previousLevel;
			error = serverStatus.error;
		} catch (cause) {
			logLevel = previousLevel;
			error = failureLine(cause, "Could not change log level.");
		} finally {
			saving = false;
		}
	}
</script>

<div id="server-logs" data-testid="server-logs-group">
	<SettingsRow label="Logs" summary={logLevel || undefined} expanded={open} onclick={() => (open = !open)} />
	{#if open}
	<div class="border-t border-settings-separator">
	<SettingsRow
		label="Log level"
		labelFor="server-log-level"
		description="Whole daemon · resets when conduit restarts"
	>
		{#snippet control()}
			<SettingsPicker
				id="server-log-level"
				label="Log level"
				value={logLevel}
				disabled={!serverStatus.status || saving}
				invalid={error !== null}
				aria-describedby={error ? "server-log-level-error" : undefined}
				onvaluechange={(level) => { const next = RpcLogLevelSchema.literals.find((option) => option === level); if (next) void changeLogLevel(next); }}
				options={RpcLogLevelSchema.literals.map((level) => ({ value: level, label: level }))}
			/>
		{/snippet}
	</SettingsRow>
	{#if error}
		<p id="server-log-level-error" role="alert" class="px-[14px] py-2 text-[12px] text-error">{error}</p>
	{/if}
	</div>
	{/if}
</div>
