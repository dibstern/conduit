<script lang="ts">
	import { refreshServerStatus, serverStatus } from "../../stores/server-status.svelte.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import { failureLine } from "../../transport/rpc-errors.js";
	import Button from "../ui/Button.svelte";
	import SettingsGroup from "../ui/SettingsGroup.svelte";
	import SettingsRow from "../ui/SettingsRow.svelte";
	import TextInput from "../ui/TextInput.svelte";
	import type { ServerForm } from "./ServerSettingsTab.svelte";

	let { openForm, onToggleForm }: { openForm: ServerForm | null; onToggleForm: (form: ServerForm) => void } = $props();
	const status = $derived(serverStatus.status);
	let command = $state("");
	let args = $state("");
	let saving = $state(false);
	let error = $state<string | null>(null);

	// GetStatus single-quotes argv parts that contain spaces; split them back out.
	const splitArgv = (text: string) => (text.match(/'[^']*'|\S+/g) ?? []).map((part) => part.replace(/^'(.*)'$/, "$1"));

	function toggleCommandForm(): void {
		const [executable = "", ...arguments_] = splitArgv(status?.keepAwakeCommand ?? "");
		command = executable;
		args = arguments_.map((part) => (/\s/.test(part) ? `'${part}'` : part)).join(" ");
		error = null;
		onToggleForm("keep-awake-command");
	}

	async function toggleKeepAwake(): Promise<void> {
		if (!status || status.keepAwakeCommand === null || saving) return;
		saving = true;
		error = null;
		try {
			await rpc("SetKeepAwake", { enabled: !status.keepAwake });
			await refreshServerStatus();
			if (serverStatus.error) {
				error = "Could not change keep-awake setting. Try again.";
				return;
			}
			if (!serverStatus.status?.keepAwake && openForm === "keep-awake-command") onToggleForm("keep-awake-command");
		} catch (cause) {
			error = failureLine(cause, "Could not change keep-awake setting. Try again.");
		} finally {
			saving = false;
		}
	}

	async function saveCommand(): Promise<void> {
		if (openForm !== "keep-awake-command" || !status?.keepAwake || saving) return;
		error = null;
		const executable = command.trim();
		if (!executable) {
			error = "Enter a command.";
			return;
		}
		saving = true;
		try {
			await rpc("SetKeepAwakeCommand", { command: executable, args: splitArgv(args) });
			await refreshServerStatus();
			if (serverStatus.error) {
				if (openForm === "keep-awake-command") error = "Could not save command. Try again.";
				return;
			}
			if (openForm === "keep-awake-command") onToggleForm("keep-awake-command");
		} catch (cause) {
			if (openForm === "keep-awake-command") error = failureLine(cause, "Could not save command. Try again.");
		} finally {
			saving = false;
		}
	}
</script>

<SettingsGroup id="server-power" title="Power" testId="server-power-settings">
	<SettingsRow
		label="Keep computer awake"
		description={status ? status.keepAwakeCommand === null ? "Not available on this computer" : "Stops this computer sleeping while conduit runs" : serverStatus.error ? "Could not load power status." : "Loading power status…"}
		checked={status?.keepAwake ?? false}
		disabled={!status || status.keepAwakeCommand === null || saving}
		onchange={() => { void toggleKeepAwake(); }}
	/>
	{#if status?.keepAwake && status.keepAwakeCommand !== null}
		<SettingsRow label="Command">
			{#snippet control()}
				<span class="min-w-0 break-all font-mono text-[11px] text-text" data-testid="server-power-command-value">{status.keepAwakeCommand}</span>
				<Button variant="secondary" size="sm" data-testid="server-power-edit" aria-expanded={openForm === "keep-awake-command"} aria-controls="server-power-form" disabled={saving} onclick={toggleCommandForm}>Edit</Button>
			{/snippet}
		</SettingsRow>
		{#if openForm === "keep-awake-command"}
			<form
				id="server-power-form"
				class="flex flex-col gap-3 px-3 py-3"
				aria-label="Keep-awake command"
				data-server-form
				data-testid="server-power-form"
				novalidate
				onsubmit={(event) => { event.preventDefault(); void saveCommand(); }}
			>
				<div class="grid grid-cols-1 gap-2 md:grid-cols-2">
					<label for="server-power-command" class="flex flex-col gap-1 text-[11px] text-text-muted">
						Command
						<TextInput id="server-power-command" data-testid="server-power-command" bind:value={command} placeholder="caffeinate" autocomplete="off" required disabled={saving} aria-describedby={error ? "server-power-error" : undefined} />
					</label>
					<label for="server-power-args" class="flex flex-col gap-1 text-[11px] text-text-muted">
						Args
						<TextInput id="server-power-args" data-testid="server-power-args" bind:value={args} placeholder="-di" autocomplete="off" disabled={saving} aria-describedby={error ? "server-power-error" : undefined} />
					</label>
				</div>
				<div class="flex flex-wrap items-center justify-end gap-1.5">
					<Button variant="secondary" size="sm" data-testid="server-power-cancel" disabled={saving} onclick={() => { error = null; onToggleForm("keep-awake-command"); }}>Cancel</Button>
					<Button variant="primary" size="sm" type="submit" data-testid="server-power-save" disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
				</div>
			</form>
		{/if}
	{/if}
	{#if error}<p id="server-power-error" data-testid="server-power-error" role="alert" class="px-3 py-2 text-[11px] text-error">{error}</p>{/if}
</SettingsGroup>
