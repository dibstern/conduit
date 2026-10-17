<script lang="ts">
	import { untrack } from "svelte";
	import type { HarnessDefaultState } from "../../transport/ws-rpc.js";
	import { catalogFromProviderList, findCatalogModel, type Harness, offeredOptions } from "../../../provider/turn-settings.js";
	import SettingsPicker from "../ui/SettingsPicker.svelte";
	import SettingsGroup from "../ui/SettingsGroup.svelte";
	import SettingsRow from "../ui/SettingsRow.svelte";
	import TextButton from "../ui/TextButton.svelte";
	import TextInput from "../ui/TextInput.svelte";
	import { createFrontendLogger } from "../../utils/logger.js";
	import { isKnownDriverKind } from "../../../contracts/provider-instance.js";
	import { getDriverTraits } from "../../stores/instance.svelte.js";
	import { PROVIDER_PRESENTATION } from "../../utils/provider-presentation.js";
	import { refreshCatalogs, applyHarnessDefaultSet, applyHiddenEntriesSet, chooseHiddenEntries, discoveryState, getHarnessDefaultProviders } from "../../stores/discovery.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import { toastFailure } from "../../transport/rpc-errors.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	const log = createFrontendLogger("push");
	let modelsFetchPending = $state(false);
	const hiddenModelSet = $derived(new Set(discoveryState.hiddenModels));
	const hiddenAgentSet = $derived(new Set(discoveryState.hiddenAgents));
	const agentScopeId = $derived(discoveryState.agentProviderScope?.id ?? null);
	const modelProviders = $derived(
		discoveryState.providers.filter((p) => p.models.length > 0),
	);
	let filter = $state("");
	let openProviders = $state<Record<string, boolean>>({});
	let agentsOpen = $state(false);
	const query = $derived(filter.trim().toLowerCase());
	const modelCount = $derived(
		modelProviders.reduce((count, provider) => count + provider.models.length, 0),
	);
	const shownModelCount = $derived(modelProviders.reduce((count, provider) =>
		count + provider.models.filter((model) => !hiddenModelSet.has(`${provider.id}/${model.id}`)).length, 0));
	const providerGroups = $derived(
		modelProviders.map((provider) => ({
			provider,
			models: provider.models.filter(matchesFilter),
		})).filter((group) => group.models.length > 0),
	);
	const filteredAgents = $derived(
		agentScopeId ? discoveryState.agents.filter(matchesFilter) : [],
	);
	const shownAgentCount = $derived(
		discoveryState.agents.filter((agent) => !hiddenAgentSet.has(`${agentScopeId}/${agent.id}`)).length,
	);
	const noMatches = $derived(
		query !== "" && (modelCount > 0 || (agentScopeId !== null && discoveryState.agents.length > 0))
		&& providerGroups.length === 0 && filteredAgents.length === 0,
	);

	function matchesFilter(entry: { id: string; name?: string }): boolean {
		return `${entry.name ?? ""} ${entry.id}`.toLowerCase().includes(query);
	}

	// Only the filter text opens or closes groups; a catalog refresh must not
	// collapse a group the user expanded.
	$effect(() => {
		const filtering = query !== "";
		untrack(() => {
			openProviders = Object.fromEntries(
				providerGroups.map(({ provider }) => [provider.id, filtering]),
			);
			agentsOpen = filtering && filteredAgents.length > 0;
		});
	});

	let saving = $state<Partial<Record<Harness, boolean>>>({});
	const defaultRows = $derived(Object.keys(PROVIDER_PRESENTATION).filter(isKnownDriverKind).map((harness) => {
		const row = { harness, label: PROVIDER_PRESENTATION[harness].label };
		const state = discoveryState.harnessDefaults[row.harness];
		const providers = getHarnessDefaultProviders(row.harness);
		const catalog = catalogFromProviderList(providers);
		const model = state.pick ? findCatalogModel(row.harness, state.pick, catalog) : undefined;
		return { ...row, state, providers, model, options: model ? offeredOptions(model) : { efforts: [], contextWindows: [] } };
	}));

	function defaultProblem(state: HarnessDefaultState, harness: Harness, label: string): string {
		if (state.status === "missing") return `No default. New chats on ${label} start with no model.`;
		if (state.status === "unverified") return getDriverTraits(harness)?.runsOpenCodeServer ? `Start ${label} to check this default.` : `Connect ${label} to check this default.`;
		if (state.problem?.startsWith("EffortNotOffered")) return `Effort "${state.pick?.effort}" is no longer available for ${state.pick?.modelId}.`;
		if (state.problem?.startsWith("ContextWindowNotOffered")) return `Context window "${state.pick?.contextWindow}" is no longer available for ${state.pick?.modelId}.`;
		return `${state.pick?.modelId ?? "This model"} is no longer available.`;
	}

	async function updateDefault(harness: Harness, setting: "model" | "effort" | "contextWindow", value: string): Promise<void> {
		const projectSlug = getCurrentSlug();
		if (!projectSlug || saving[harness]) return;
		const current = discoveryState.harnessDefaults[harness].pick;
		const separator = value.indexOf("/");
		// A new model omits effort so the server applies the one saved for it.
		const pick = setting === "model"
			? separator > 0 ? { providerId: value.slice(0, separator), modelId: value.slice(separator + 1), contextWindow: "" } : undefined
			: current && { ...current, [setting]: value };
		if (!pick) return;
		saving[harness] = true;
		try {
			applyHarnessDefaultSet(await rpc("SetHarnessDefault", { projectSlug, harness, ...pick }));
		} catch (error) {
			toastFailure("Failed to save default model", "warn")(error);
		} finally {
			saving[harness] = false;
		}
	}

	// Refresh both catalogs when this section opens.
	$effect(() => {
		const projectSlug = getCurrentSlug();
		if (!projectSlug) return;
		untrack(() => {
			modelsFetchPending = true;
			void refreshCatalogs()
				.catch((err) => log.warn("Visibility models fetch failed:", err))
				.finally(() => {
					modelsFetchPending = false;
				});
		});
	});

	// No busy-guard by design: every call sends the ABSOLUTE hidden lists
	// computed from current state, so rapid toggles are last-write-wins safe;
	// a guard would silently drop input and desync the toggles.
	async function persistHidden(update: {
		hiddenModels?: string[];
		hiddenAgents?: string[];
	}): Promise<void> {
		const projectSlug = getCurrentSlug();
		if (!projectSlug) {
			showToast("No active project connection", { variant: "warn" });
			return;
		}
		const undoHidden = chooseHiddenEntries(update);
		try {
			applyHiddenEntriesSet(await rpc("SetHiddenEntries", { projectSlug, ...update }));
		} catch (error) {
			undoHidden();
			toastFailure("Failed to save visibility settings", "warn")(error);
		}
	}

	function toggleModel(providerId: string, modelId: string): void {
		const key = `${providerId}/${modelId}`;
		const next = new Set(discoveryState.hiddenModels);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		void persistHidden({ hiddenModels: [...next] });
	}

	function toggleProviderAll(providerId: string, hide: boolean): void {
		const provider = discoveryState.providers.find((p) => p.id === providerId);
		if (!provider) return;
		const next = new Set(discoveryState.hiddenModels);
		for (const m of provider.models) {
			const key = `${providerId}/${m.id}`;
			if (hide) next.add(key);
			else next.delete(key);
		}
		void persistHidden({ hiddenModels: [...next] });
	}

	function toggleAgent(agentId: string): void {
		if (!agentScopeId) return;
		const key = `${agentScopeId}/${agentId}`;
		const next = new Set(discoveryState.hiddenAgents);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		void persistHidden({ hiddenAgents: [...next] });
	}

	function toggleAgentsAll(hide: boolean): void {
		if (!agentScopeId) return;
		const next = new Set(discoveryState.hiddenAgents);
		for (const agent of discoveryState.agents) {
			const key = `${agentScopeId}/${agent.id}`;
			if (hide) next.add(key);
			else next.delete(key);
		}
		void persistHidden({ hiddenAgents: [...next] });
	}
</script>

<SettingsGroup id="settings-default-models" title="Default models">
	{#each defaultRows as row (row.harness)}
		{@const pick = row.state.pick}
		{@const value = pick ? `${pick.providerId}/${pick.modelId}` : ""}
		<div class="px-3 py-2">
			{#snippet controls()}
				<div class="flex flex-wrap items-center gap-1.5 max-w-full">
					<SettingsPicker
						id="settings-harness-default-{row.harness}-model"
						label="{row.label} model"
						value={value}
						invalid={Boolean(pick && !row.model)}
						disabled={saving[row.harness]}
						class="max-w-[220px]"
						data-testid="settings-harness-default-{row.harness}-model"
						onvaluechange={(value) => void updateDefault(row.harness, "model", value)}
						options={[
							...(!pick ? [{ value: "", label: "Not set", disabled: true }] : !row.model ? [{ value, label: `${pick.modelId} (unavailable)`, disabled: true }] : []),
							...row.providers.flatMap((provider) => provider.models.flatMap((model) => model.routingOptions?.length
								? model.routingOptions.map((option) => ({ value: `${provider.id}/${option.value}`, label: `${model.name} · ${option.label}`, group: provider.name || provider.id }))
								: [{ value: `${provider.id}/${model.id}`, label: model.name || model.id, group: provider.name || provider.id }])),
						]}
					/>
					{#if pick && row.options.efforts.length > 0}
						<SettingsPicker value={pick.effort} disabled={saving[row.harness]} label="{row.label} effort"
							data-testid="settings-harness-default-{row.harness}-effort" onvaluechange={(value) => void updateDefault(row.harness, "effort", value)} options={[
								{ value: "", label: "Default" },
								...(pick.effort && !row.options.efforts.includes(pick.effort) ? [{ value: pick.effort, label: `${pick.effort} (unavailable)`, disabled: true }] : []),
								...row.options.efforts.map((effort) => ({ value: effort, label: effort })),
							]} />
					{/if}
					{#if pick && row.options.contextWindows.length > 0}
						<SettingsPicker value={pick.contextWindow} disabled={saving[row.harness]} label="{row.label} context window"
							data-testid="settings-harness-default-{row.harness}-context" onvaluechange={(value) => void updateDefault(row.harness, "contextWindow", value)} options={[
								{ value: "", label: "Default" },
								...(pick.contextWindow && !row.options.contextWindows.some((option) => option.value === pick.contextWindow) ? [{ value: pick.contextWindow, label: `${pick.contextWindow} (unavailable)`, disabled: true }] : []),
								...row.options.contextWindows,
							]} />
					{/if}
				</div>
			{/snippet}
			<SettingsRow label={row.label} labelFor="settings-harness-default-{row.harness}-model" control={controls} class="p-0" />
			{#if row.state.status !== "ok"}
				<p class="mt-1 text-[11px] text-text-muted" data-testid="settings-harness-default-{row.harness}-status" data-status={row.state.status}>{defaultProblem(row.state, row.harness, row.label)}</p>
			{/if}
		</div>
	{/each}
</SettingsGroup>

{#if modelCount > 0 || discoveryState.agents.length > 0}
<TextInput
	type="search"
	size="sm"
	aria-label="Filter models and agents"
	data-testid="settings-models-filter"
	placeholder="Filter {modelCount} models"
	bind:value={filter}
/>
{/if}
<div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
	<p>Hidden models stay out of the model picker.</p>
	{#if modelCount > 0}
		<p class="text-text-muted" data-testid="settings-models-summary">{shownModelCount} of {modelCount} shown</p>
	{/if}
</div>
<p class="text-text-muted">New models and agents appear automatically.</p>

<!-- Models -->
{#if modelProviders.length === 0}
	<p class="text-text-dimmer">{modelsFetchPending ? "Loading models…" : "No models available"}</p>
{/if}
{#if noMatches}
	<div class="flex flex-wrap items-center gap-2" data-testid="settings-models-no-match">
		<span>No models match ‘{filter}’.</span>
		<TextButton onclick={() => (filter = "")}>Clear</TextButton>
	</div>
{/if}
{#each providerGroups as { provider, models } (provider.id)}
	{@const shown = provider.models.filter((model) => !hiddenModelSet.has(`${provider.id}/${model.id}`)).length}
	{@const allShown = shown === provider.models.length}
	<SettingsGroup
		title={provider.name}
		summary="{shown} of {provider.models.length} shown"
		collapsible
		bind:open={() => openProviders[provider.id] ?? false, (open: boolean) => (openProviders[provider.id] = open)}
		testId="settings-models-group-{provider.id}"
	>
		{#snippet actions()}
			<TextButton onclick={() => toggleProviderAll(provider.id, allShown)}>
				{allShown ? "Hide all" : "Show all"}
			</TextButton>
		{/snippet}
		{#each models as model (model.id)}
			<SettingsRow
				label={model.name || model.id}
				checked={!hiddenModelSet.has(`${provider.id}/${model.id}`)}
				onchange={() => toggleModel(provider.id, model.id)}
			/>
		{/each}
	</SettingsGroup>
{/each}

<!-- Agents (current provider scope only) -->
{#if agentScopeId && filteredAgents.length > 0}
	<h3 class="mt-2 text-[12px] font-semibold text-text">Agents</h3>
	<SettingsGroup
		title="{discoveryState.agentProviderScope?.name} agents"
		summary="{shownAgentCount} of {discoveryState.agents.length} shown"
		collapsible
		bind:open={agentsOpen}
		testId="settings-agents-group"
	>
		{#snippet actions()}
			<TextButton onclick={() => toggleAgentsAll(shownAgentCount === discoveryState.agents.length)}>
				{shownAgentCount === discoveryState.agents.length ? "Hide all" : "Show all"}
			</TextButton>
		{/snippet}
		{#each filteredAgents as agent (agent.id)}
			<SettingsRow
				label={agent.name || agent.id}
				checked={!hiddenAgentSet.has(`${agentScopeId}/${agent.id}`)}
				onchange={() => toggleAgent(agent.id)}
			/>
		{/each}
	</SettingsGroup>
{/if}
