<script lang="ts">
	import {
		refreshServerStatus,
		serverStatus,
	} from "../../stores/server-status.svelte.js";
	import { RpcLogLevelSchema, type RpcLogLevel } from "../../transport/ws-rpc.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import { failureLine } from "../../transport/rpc-errors.js";
	import Select from "../ui/Select.svelte";
	import SettingsGroup from "../ui/SettingsGroup.svelte";
	import SettingsRow from "../ui/SettingsRow.svelte";

	let logLevel = $state("");
	let saving = $state(false);
	let error = $state<string | null>(null);

	$effect(() => {
		logLevel = serverStatus.status?.logLevel ?? "";
	});

	async function changeLogLevel(level: RpcLogLevel): Promise<void> {
		if (!serverStatus.status || saving) return;
		const previousLevel = serverStatus.status.logLevel;
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

<SettingsGroup id="server-logs" title="Logs" testId="server-logs-group">
	<SettingsRow
		label="Log level"
		labelFor="server-log-level"
		description="Whole daemon · resets when conduit restarts"
	>
		{#snippet control()}
			<Select
				id="server-log-level"
				bind:value={logLevel}
				disabled={!serverStatus.status || saving}
				invalid={error !== null}
				aria-describedby={error ? "server-log-level-error" : undefined}
				onchange={(event) => changeLogLevel(event.currentTarget.value as RpcLogLevel)}
			>
				{#each RpcLogLevelSchema.literals as level (level)}
					<option value={level}>{level}</option>
				{/each}
			</Select>
		{/snippet}
	</SettingsRow>
	{#if error}
		<p id="server-log-level-error" role="alert" class="px-3 py-2 text-sm text-error">{error}</p>
	{/if}
</SettingsGroup>
