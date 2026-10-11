<script lang="ts">
	import { tick } from "svelte";
	import { refreshServerStatus, serverStatus } from "../../stores/server-status.svelte.js";
	import { SetPinRejected, setPinRpc } from "../../transport/ws-rpc-client.js";
	import Button from "../ui/Button.svelte";
	import SettingsGroup from "../ui/SettingsGroup.svelte";
	import SettingsRow from "../ui/SettingsRow.svelte";
	import TextInput from "../ui/TextInput.svelte";
	import type { ServerForm } from "./ServerSettingsTab.svelte";

	let { openForm, onToggleForm }: { openForm: ServerForm | null; onToggleForm: (form: ServerForm) => void } = $props();
	const status = $derived(serverStatus.status);
	const pinForm = $derived(openForm === "pin-set" || openForm === "pin-change" || openForm === "pin-remove" ? openForm : null);
	let currentPin = $state("");
	let newPin = $state("");
	let confirmation = $state("");
	let error = $state<string | null>(null);
	let saving = $state(false);
	let currentInput = $state<HTMLInputElement>();

	$effect(() => {
		// Closing or switching forms discards the PINs as well as the error.
		void openForm;
		currentPin = "";
		newPin = "";
		confirmation = "";
		error = null;
	});

	async function savePin(): Promise<void> {
		const form = pinForm;
		if (form === null || saving) return;
		error = null;
		if ((form !== "pin-set" && !/^\d{4,8}$/.test(currentPin)) || (form !== "pin-remove" && !/^\d{4,8}$/.test(newPin))) {
			error = "PIN must be 4 to 8 digits.";
			return;
		}
		if (form !== "pin-remove" && newPin !== confirmation) {
			error = "PINs don't match.";
			return;
		}
		saving = true;
		try {
			await setPinRpc({ pin: form === "pin-remove" ? null : newPin, ...(form === "pin-set" ? {} : { currentPin }) });
			if (openForm === form) onToggleForm(form);
			await refreshServerStatus();
		} catch (cause: unknown) {
			if (openForm !== form) return;
			if (cause instanceof SetPinRejected) {
				if (cause.reason === "wrong_pin") {
					error = "Wrong PIN. Try again.";
					currentPin = "";
				} else {
					const minutes = Math.max(1, Math.ceil((cause.retryAfterSeconds ?? 60) / 60));
					error = `Too many tries. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
				}
			} else {
				error = "Could not save PIN. Try again.";
			}
		} finally {
			saving = false;
		}
		if (error === "Wrong PIN. Try again.") {
			await tick();
			if (openForm === form) currentInput?.focus();
		}
	}
</script>

<SettingsGroup id="server-security" title="Security" testId="server-security-settings">
	<SettingsRow
		label="PIN"
		description={status ? status.pinEnabled ? "On · asked once on each new device" : "Off · anyone who can reach this address can open conduit" : serverStatus.error ? "Could not load PIN status." : "Loading PIN status…"}
	>
		{#snippet control()}
			{#if status?.pinEnabled}
				<Button variant="secondary" tone="accent" size="sm" data-testid="server-pin-change-btn" aria-expanded={openForm === "pin-change"} aria-controls="server-pin-form" disabled={saving} onclick={() => onToggleForm("pin-change")}>Change</Button>
				<Button variant="secondary" size="sm" data-testid="server-pin-remove-btn" aria-expanded={openForm === "pin-remove"} aria-controls="server-pin-form" disabled={saving} onclick={() => onToggleForm("pin-remove")}>Remove</Button>
			{:else if status}
				<Button variant="secondary" tone="accent" size="sm" data-testid="server-pin-set-btn" aria-expanded={openForm === "pin-set"} aria-controls="server-pin-form" disabled={saving} onclick={() => onToggleForm("pin-set")}>Set PIN</Button>
			{/if}
		{/snippet}
	</SettingsRow>
	{#if pinForm !== null}
		<form
			id="server-pin-form"
			class="flex flex-col gap-3 px-3 py-3 {pinForm === 'pin-remove' ? 'bg-error/5' : ''}"
			aria-label={pinForm === "pin-set" ? "Set PIN" : pinForm === "pin-change" ? "Change PIN" : "Remove PIN"}
			data-server-form
			data-testid="server-pin-form"
			novalidate
			onsubmit={(event) => { event.preventDefault(); void savePin(); }}
		>
			{#if pinForm === "pin-remove"}
				<p class="text-[11px] text-text-muted">Without a PIN, anyone who can reach this address can open conduit.</p>
			{/if}
			<div class="grid grid-cols-1 gap-2 {pinForm === 'pin-change' ? 'md:grid-cols-3' : pinForm === 'pin-set' ? 'md:grid-cols-2' : ''}">
				{#if pinForm !== "pin-set"}
					<label for="server-pin-current" class="flex flex-col gap-1 text-[11px] text-text-muted">
						Current PIN
						<TextInput id="server-pin-current" data-testid="server-pin-current" bind:value={currentPin} bind:element={currentInput} type="password" inputmode="numeric" autocomplete="current-password" minlength={4} maxlength={8} pattern={"[0-9]{4,8}"} required disabled={saving} aria-describedby={error ? "server-pin-error" : undefined} />
					</label>
				{/if}
				{#if pinForm !== "pin-remove"}
					<label for="server-pin-new" class="flex flex-col gap-1 text-[11px] text-text-muted">
						New PIN
						<TextInput id="server-pin-new" data-testid="server-pin-new" bind:value={newPin} type="password" inputmode="numeric" autocomplete="new-password" placeholder="4–8 digits" minlength={4} maxlength={8} pattern={"[0-9]{4,8}"} required disabled={saving} aria-describedby={error ? "server-pin-error" : undefined} />
					</label>
					<label for="server-pin-confirm" class="flex flex-col gap-1 text-[11px] text-text-muted">
						Confirm new PIN
						<TextInput id="server-pin-confirm" data-testid="server-pin-confirm" bind:value={confirmation} type="password" inputmode="numeric" autocomplete="new-password" minlength={4} maxlength={8} pattern={"[0-9]{4,8}"} required disabled={saving} aria-describedby={error ? "server-pin-error" : undefined} />
					</label>
				{/if}
			</div>
			{#if pinForm !== "pin-remove"}
				<p class="text-[11px] text-text-muted">Every browser, including this one, will ask for the new PIN.</p>
			{/if}
			<div class="flex flex-wrap items-center justify-end gap-1.5">
				{#if error}<p id="server-pin-error" data-testid="server-pin-error" role="alert" class="mr-auto text-[11px] text-error">{error}</p>{/if}
				<Button variant="secondary" size="sm" data-testid="server-pin-cancel" disabled={saving} onclick={() => { if (pinForm) onToggleForm(pinForm); }}>Cancel</Button>
				<Button variant={pinForm === "pin-remove" ? "danger" : "primary"} size="sm" type="submit" data-testid="server-pin-save" disabled={saving}>{saving ? "Saving…" : pinForm === "pin-remove" ? "Remove PIN" : "Save PIN"}</Button>
			</div>
		</form>
	{/if}
</SettingsGroup>
