<script lang="ts">
	import { isKnownDriverKind } from "../../../contracts/provider-instance.js";
	import { getCachedInstances, getDriverTraits } from "../../stores/instance.svelte.js";
	import { PROVIDER_PRESENTATION } from "../../utils/provider-presentation.js";
	import Button from "../ui/Button.svelte";
	import SegmentedControl from "../ui/SegmentedControl.svelte";
	import SettingsGroup from "../ui/SettingsGroup.svelte";
	import SettingsRow from "../ui/SettingsRow.svelte";
	import Textarea from "../ui/Textarea.svelte";
	import TextInput from "../ui/TextInput.svelte";
	import type { AccountFormController } from "./account-form.svelte.js";

	let { form }: { form: AccountFormController } = $props();
	const state = $derived(form.state);
	const instanceFormMode = $derived(form.mode);
	const editingInstanceId = $derived(form.editingId);
	const formTraits = $derived(form.traits);
	const formPresentation = $derived(form.presentation);
	const instances = $derived(getCachedInstances());
	const DRIVER_OPTIONS = Object.keys(PROVIDER_PRESENTATION).filter(isKnownDriverKind);
	const DRIVER_TAB_OPTIONS = $derived(DRIVER_OPTIONS.map((driver) => ({
		value: driver,
		label: `${PROVIDER_PRESENTATION[driver].label} ${getDriverTraits(driver)?.accountKind === "config-directory" ? "account" : "server"}`,
		testId: `instance-form-driver-${driver}`,
	})));
</script>

{#if instanceFormMode !== null}
	<SettingsGroup>
	<form id="instance-form" class="px-[14px] py-3 flex flex-col gap-3" data-server-form data-testid="instance-form" aria-label={instanceFormMode === "edit" ? "Edit instance" : "New instance"} novalidate onsubmit={(event) => { event.preventDefault(); void form.save(); }}>
		<div class="flex flex-wrap items-center gap-[10px] text-[13.5px] max-md:text-[15px]">
			<h4 class="font-semibold text-text">{instanceFormMode === "edit" ? `Edit ${instances.find((inst) => inst.id === editingInstanceId)?.name ?? "instance"}` : "New instance"}</h4>
			{#if instanceFormMode === "add"}
				<SegmentedControl bind:value={state.formDriver} label="Type" options={DRIVER_TAB_OPTIONS} variant="joined" class="max-w-full" />
			{/if}
		</div>
		{#if formTraits?.runsOpenCodeServer}
			<SettingsRow label="Conduit starts it" description="Off: connect to one you run" checked={state.formManaged} onchange={() => { state.formManaged = !state.formManaged; }} disabled={state.formSaving || instanceFormMode === "edit"} testId="instance-form-managed" class="p-0" />
		{/if}
		<div class="grid grid-cols-1 gap-2 md:grid-cols-2">
			<label for="instance-form-name" class="flex flex-col gap-1 text-[12px] text-text-muted">
				Name
				<TextInput id="instance-form-name" data-testid="instance-form-name" placeholder={formPresentation.namePlaceholder} bind:value={state.formName} disabled={state.formSaving} required />
			</label>
			{#if formTraits?.accountKind === "config-directory"}
				<label for="instance-form-configdir" class="flex flex-col gap-1 text-[12px] text-text-muted">
					Config directory (optional)
					<TextInput id="instance-form-configdir" data-testid="instance-form-configdir" placeholder={formPresentation.configDirPlaceholder} bind:value={state.formConfigDir} disabled={state.formSaving} />
				</label>
			{:else if state.formManaged}
				<label for="instance-form-port" class="flex flex-col gap-1 text-[12px] text-text-muted">
					Port
					<TextInput id="instance-form-port" inputmode="numeric" data-testid="instance-form-port" placeholder="4098" bind:value={state.formPort} disabled={state.formSaving} />
				</label>
			{:else}
				<label for="instance-form-url" class="flex flex-col gap-1 text-[12px] text-text-muted">
					URL (or port)
					<TextInput id="instance-form-url" data-testid="instance-form-url" placeholder="http://127.0.0.1:4098" bind:value={state.formUrl} readonly={instanceFormMode === "edit"} disabled={state.formSaving} />
				</label>
			{/if}
		</div>
		{#if formTraits?.accountKind === "config-directory"}
			<p class="text-[12px] text-text-muted">Folder changes apply on the next turn. {state.formDriver === "codex" ? "An empty folder gives named accounts a separate Conduit-managed login. The built-in account keeps the default Codex home." : "Leave the folder empty to use the login Conduit was launched with."}</p>
		{/if}
		{#if formPresentation.environment || (formTraits?.runsOpenCodeServer && state.formManaged)}
			<SettingsGroup title="Environment variables" summary="KEY=VALUE per line" collapsible bind:open={state.formEnvOpen}>
				<label for="instance-form-env" class="block p-3">
					<span class="sr-only">Environment variables</span>
					<Textarea id="instance-form-env" data-testid="instance-form-env" rows={2} class="resize-y font-mono" placeholder={formPresentation.environment?.placeholder ?? "ANTHROPIC_API_KEY=sk-ant-..."} bind:value={state.formEnv} disabled={state.formSaving} />
					{#if formPresentation.environment}<p class="mt-2 text-[12px] leading-[1.5] text-text-dimmer">{formPresentation.environment.hint}</p>{/if}
				</label>
			</SettingsGroup>
		{/if}
		<div class="flex justify-end gap-1.5">
			<Button touchTarget variant="secondary" size="sm" data-testid="instance-form-cancel" disabled={state.formSaving} onclick={form.close}>Cancel</Button>
			<Button touchTarget variant="primary" size="sm" type="submit" data-testid="instance-form-save" disabled={state.formSaving}>{state.formSaving ? "Saving..." : instanceFormMode === "edit" ? "Save" : "Add instance"}</Button>
		</div>
	</form>
	</SettingsGroup>
{/if}
