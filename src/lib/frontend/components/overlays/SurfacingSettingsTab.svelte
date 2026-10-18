<script lang="ts">
	import { onMount } from "svelte";
	import type { MessageSurfacingPatch, MessageSurfacingStatus } from "../../../contracts/message-surfacing.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { messageSurfacing } from "../../stores/message-surfacing.svelte.js";
	import { failureLine } from "../../transport/rpc-errors.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import Badge from "../ui/Badge.svelte";
	import Button from "../ui/Button.svelte";
	import SegmentedControl from "../ui/SegmentedControl.svelte";
	import SettingsGroup from "../ui/SettingsGroup.svelte";
	import SettingsPicker from "../ui/SettingsPicker.svelte";
	import SettingsRow from "../ui/SettingsRow.svelte";
	import Tabs from "../ui/Tabs.svelte";
	import TextInput from "../ui/TextInput.svelte";
	import SurfacingCategories from "./SurfacingCategories.svelte";
	import SurfacingFeedbackTab from "./SurfacingFeedbackTab.svelte";

	let { onPageChange }: { onPageChange?: (page: { title: string; back: () => void } | null) => void } = $props();
	let tab = $state("general");
	let editPage = $state(false);
	let settings = $state<MessageSurfacingStatus | null>(null);
	let loading = $state(true);
	let saving = $state(false);
	let error = $state("");
	let apiKey = $state("");
	// A stored key's Replace reveals the entry field; with no key it is always shown.
	let replacing = $state(false);
	let categoryRevision = $state(0);
	let feedbackOpened = $state(false);
	$effect(() => { if (tab === "feedback") feedbackOpened = true; });
	// A key request's failure is shown only through this fixed copy, never echoed, since the request carried a secret.
	const keyFailures: Record<string, string> = {
		"TypeSafe rejected the key": "Rejected by TypeSafe. Your saved key is unchanged.",
		"Saving a TypeSafe key requires TLS or loopback": "Saving a TypeSafe key requires HTTPS or localhost.",
		"TypeSafe key is set by environment": "The key is set by TYPESAFE_API_KEY and can't be edited here.",
	};
	const levels = [{ value: "final", label: "Final" }, { value: "key", label: "Key" }, { value: "balanced", label: "Balanced" }, { value: "all", label: "All" }] as const;
	const models = [{ value: "sonnet", label: "Sonnet" }, { value: "opus", label: "Opus" }, { value: "off", label: "Off" }] as const;
	const timings = [{ value: "turn-end", label: "When a turn ends" }, { value: "on-request", label: "On request" }] as const;
	const turnsOpen = [{ value: "expanded", label: "Expanded" }, { value: "auto", label: "Auto" }, { value: "minimised", label: "Minimised" }] as const;
	const tuningOptions = $derived([
		{ value: "opus", label: "Opus (newest)" }, { value: "sonnet", label: "Sonnet (newest)" },
		...(settings && !["opus", "sonnet"].includes(settings.tuningModel) ? [{ value: settings.tuningModel, label: settings.tuningModel }] : []),
	]);

	onMount(() => { void load(); });

	async function load(): Promise<void> {
		loading = true;
		error = "";
		try { settings = await rpc("GetMessageSurfacing", {}); }
		catch { error = "Could not load surfacing settings. Try again."; }
		finally { loading = false; }
	}

	async function update(patch: MessageSurfacingPatch): Promise<void> {
		if (saving || !settings) return;
		saving = true;
		error = "";
		if (patch.apiKey !== undefined) apiKey = "";
		try {
			settings = await rpc("UpdateMessageSurfacing", patch);
			messageSurfacing.status = settings;
			if (patch.apiKey !== undefined) replacing = false;
		}
		catch (cause) {
			error = (patch.apiKey !== undefined && keyFailures[failureLine(cause, "")]) || "Could not save surfacing settings. Try again.";
		}
		finally { saving = false; }
	}
</script>

{#if !editPage}
	<Tabs bind:value={tab} label="Surfacing sections" variant="joined" class="mb-[14px] max-md:flex max-md:w-full max-md:[&>*]:flex-auto" options={[
		{ value: "general", label: "General", testId: "surfacing-tab-general" },
		{ value: "categories", label: "Categories", testId: "surfacing-tab-categories" },
		{ value: "feedback", label: "Feedback and tuning", testId: "surfacing-tab-feedback" },
	]} />
{/if}

<!-- Keep both panels mounted so switching tabs preserves the category draft. -->
<div hidden={tab !== "general"} data-testid="surfacing-settings-general">
	{#if loading}<p role="status">Loading surfacing settings…</p>
	{:else if !settings}
		<p role="alert" class="text-error">{error}</p>
		<Button size="sm" onclick={() => { void load(); }}>Retry</Button>
	{:else}
		{@const status = settings}
		{@const key = status.key}
		<SettingsGroup id="surfacing-jev" title="Jev">
			<div>
				<SettingsRow label="Message surfacing" checked={status.enabled} disabled={saving} ariaLabel="Toggle message surfacing"
					description={status.active ? "● Active" : !status.enabled ? "Off" : "Inactive until a valid key is set"}
					descriptionTone={status.active ? "success" : status.enabled ? "warning" : "neutral"}
					onchange={() => { void update({ enabled: !status.enabled }); }}>
					{#snippet labelSuffix()}<Badge variant="accent" size="label">Experimental</Badge>{/snippet}
				</SettingsRow>
				<p data-testid="surfacing-disclosure" class="-mt-[2px] px-[14px] pb-[12px] text-[12px] leading-[1.5] text-text-muted">When on, conduit sends each mid-turn message, your request (first 1,000 characters) and your category definitions to TypeSafe so Jev can classify them. About $0.00005 per message. Old sessions are never judged in bulk.</p>
			</div>
			<SettingsRow label="TypeSafe API key" description={key.source === "env" && key.rejected ? "Set by TYPESAFE_API_KEY" : ""}>
				{#snippet control()}
					{#if key.source !== "none"}<code aria-label="Key is hidden" class="text-[12px] text-text-secondary">••••••••</code>{/if}
					<Badge variant={key.rejected ? "error" : key.source === "stored" ? "success" : "chip"} size="label" data-testid="surfacing-key-state">{key.rejected ? "Rejected by TypeSafe" : key.source === "env" ? "Set by TYPESAFE_API_KEY" : key.source === "stored" ? "Valid" : "Not set"}</Badge>
					{#if key.source === "stored"}
						{#if !replacing}<Button variant="ghost" size="sm" disabled={saving} data-testid="surfacing-key-replace" onclick={() => { replacing = true; }}>Replace</Button>{/if}
						<Button variant="ghost" size="sm" disabled={saving} data-testid="surfacing-key-remove" onclick={() => { void update({ apiKey: null }); }}>Remove</Button>
					{/if}
				{/snippet}
			</SettingsRow>
			{#if key.source === "none" || replacing}
				<form class="flex flex-wrap items-center gap-2 px-[14px] py-[10px]" onsubmit={(event) => { event.preventDefault(); if (apiKey.trim()) void update({ apiKey: apiKey.trim() }); }}>
					<TextInput type="password" bind:value={apiKey} aria-label="New TypeSafe API key" data-testid="surfacing-key-input" autocomplete="new-password" placeholder={replacing ? "Replacement key" : "Paste a TypeSafe API key"} disabled={saving} class="min-w-0 flex-1" />
					{#if replacing}<Button variant="ghost" size="sm" disabled={saving} onclick={() => { replacing = false; apiKey = ""; }}>Cancel</Button>{/if}
					<Button type="submit" size="sm" disabled={saving || !apiKey.trim()} data-testid="surfacing-key-save">Save key</Button>
				</form>
			{/if}
		</SettingsGroup>
		{#if error}<p role="alert" class="mt-2 text-error">{error}</p>{/if}
		<SettingsGroup id="surfacing-turns" title="Turns">
			<SettingsRow label="Default level" description="Sessions can override it from the level control on the axis.">
				{#snippet control()}
					{#if sessionViewState.compact}
						<SettingsPicker label="Default level" value={status.defaultLevel} options={levels} disabled={saving} onvaluechange={(value) => { if (levels.some((o) => o.value === value)) void update({ defaultLevel: value as MessageSurfacingStatus["defaultLevel"] }); }} />
					{:else}
						<SegmentedControl label="Default level" bind:value={() => settings?.defaultLevel ?? "balanced", (defaultLevel) => { void update({ defaultLevel }); }} options={levels.map((o) => ({ ...o, disabled: saving }))} />
					{/if}
				{/snippet}
			</SettingsRow>
			<SettingsRow label="Turns open" description="Auto minimises an older turn once it's all read and no Ask is open.">
				{#snippet control()}
					{#if sessionViewState.compact}<SettingsPicker label="Turns open" value={status.turnsOpen} options={turnsOpen} disabled={saving} onvaluechange={(value) => { if (value === "expanded" || value === "auto" || value === "minimised") void update({ turnsOpen: value }); }} />
					{:else}<SegmentedControl label="Turns open" bind:value={() => settings?.turnsOpen ?? "auto", (turnsOpen) => { void update({ turnsOpen }); }} options={turnsOpen.map((o) => ({ ...o, disabled: saving }))} />{/if}
				{/snippet}
			</SettingsRow>
		</SettingsGroup>
		<SettingsGroup id="surfacing-summaries" title="Summaries">
			<SettingsRow label="Summary model">
				{#snippet control()}
					{#if sessionViewState.compact}<SettingsPicker label="Summary model" value={status.recap.model} options={models} disabled={saving} onvaluechange={(value) => { if (value === "sonnet" || value === "opus" || value === "off") void update({ recap: { model: value } }); }} />
					{:else}<SegmentedControl label="Summary model" bind:value={() => settings?.recap.model ?? "sonnet", (model) => { void update({ recap: { model } }); }} options={models.map((o) => ({ ...o, disabled: saving }))} />{/if}
				{/snippet}
			</SettingsRow>
			<SettingsRow label="Summary timing" description="Only turns with 4+ non-routine messages.">
				{#snippet control()}
					{#if sessionViewState.compact}<SettingsPicker label="Summary timing" value={status.recap.when} options={timings} disabled={saving} onvaluechange={(value) => { if (value === "turn-end" || value === "on-request") void update({ recap: { when: value } }); }} />
					{:else}<SegmentedControl label="Summary timing" bind:value={() => settings?.recap.when ?? "turn-end", (when) => { void update({ recap: { when } }); }} options={timings.map((o) => ({ ...o, disabled: saving }))} />{/if}
				{/snippet}
			</SettingsRow>
		</SettingsGroup>
		<SettingsGroup id="surfacing-tuning" title="Tuning">
			<SettingsRow label="Tuning model">
				{#snippet control()}<SettingsPicker label="Tuning model" value={status.tuningModel} options={tuningOptions} disabled={saving} onvaluechange={(tuningModel) => { void update({ tuningModel }); }} />{/snippet}
			</SettingsRow>
		</SettingsGroup>
		<p class="mt-[12px] text-[12px] leading-[1.5] text-text-muted">Summaries and tuning run on your Claude subscription through the daemon. The TypeSafe key stays on the server and is never sent to the browser. Set by TYPESAFE_API_KEY means the key is managed through the environment and can't be edited here. Off means today's view and no calls.</p>
	{/if}
</div>
<div hidden={tab !== "categories"} data-testid="surfacing-settings-categories">
	<SurfacingCategories active={tab === "categories"} revision={categoryRevision} onPageChange={(page) => { editPage = page !== null && sessionViewState.compact; onPageChange?.(editPage ? page : null); }} />
</div>
<div hidden={tab !== "feedback"} data-testid="surfacing-settings-feedback">
	{#if feedbackOpened}<SurfacingFeedbackTab active={tab === "feedback"} onApplied={() => { categoryRevision++; }} />{/if}
</div>
