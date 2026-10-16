<script lang="ts">
	import { untrack } from "svelte";
	import type { HarnessDefaultState } from "../../transport/ws-rpc.js";
	import { catalogFromProviderList, findCatalogModel, type Harness, harnessForModelProvider, offeredOptions } from "../../../provider/turn-settings.js";
	import Select from "../ui/Select.svelte";
	import SettingsGroup from "../ui/SettingsGroup.svelte";
	import SettingsRow from "../ui/SettingsRow.svelte";
	import TextButton from "../ui/TextButton.svelte";
	import TextInput from "../ui/TextInput.svelte";
	import { createFrontendLogger } from "../../utils/logger.js";
	import { isKnownDriverKind } from "../../../contracts/provider-instance.js";
	import { getDriverTraits } from "../../stores/instance.svelte.js";
	import { PROVIDER_PRESENTATION } from "../../utils/provider-presentation.js";
	import { applyGetAgentsResponse, followModelsRead, applyHarnessDefaultSet, applyHiddenEntriesSet, chooseHiddenEntries, discoveryState } from "../../stores/discovery.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { sessionState } from "../../stores/session.svelte.js";
	import { getAgentsRpc, getModelsRpc, setHarnessDefaultRpc, setHiddenEntriesRpc } from "../../transport/ws-rpc-client.js";
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
		const providers = modelProviders.filter((provider) => harnessForModelProvider(provider.id) === row.harness);
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

	async function updateDefault(harness: Harness, setting: "model" | "effort" | "contextWindow", event: Event): Promise<void> {
		const select = event.currentTarget;
		const projectSlug = getCurrentSlug();
		if (!(select instanceof HTMLSelectElement) || !projectSlug || saving[harness]) return;
		const value = select.value;
		const current = discoveryState.harnessDefaults[harness].pick;
		const separator = value.indexOf("/");
		// A new model omits effort so the server applies the one saved for it.
		const pick = setting === "model"
			? separator > 0 ? { providerId: value.slice(0, separator), modelId: value.slice(separator + 1), contextWindow: "" } : undefined
			: current && { ...current, [setting]: value };
		if (!pick) return;
		saving[harness] = true;
		try {
			applyHarnessDefaultSet(await setHarnessDefaultRpc({ projectSlug, harness, ...pick }));
		} catch {
			// Restore the server value, including when the native select changed first.
			const current = discoveryState.harnessDefaults[harness].pick;
			select.value = setting === "model"
				? current ? `${current.providerId}/${current.modelId}` : ""
				: current?.[setting] ?? "";
			showToast("Failed to save default model", { variant: "warn" });
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
			// Scoped, so the reply describes the open session's model, not the
			// project default.
			const sessionId = sessionState.currentId;
			const applyModels = followModelsRead(sessionId ?? undefined);
			void getModelsRpc({ ...(sessionId ? { sessionId } : { projectSlug }) })
				.then((response) => {
					if (sessionState.currentId === sessionId) applyModels(response);
				})
				.catch((err) => log.warn("Visibility models fetch failed:", err))
				.finally(() => {
					modelsFetchPending = false;
				});
			void getAgentsRpc({ ...(sessionId ? { sessionId } : { projectSlug }) })
				.then((response) => {
					if (sessionState.currentId === sessionId) applyGetAgentsResponse(response, sessionId ?? undefined);
				})
				.catch((err) => log.warn("Visibility agents fetch failed:", err));
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
			applyHiddenEntriesSet(await setHiddenEntriesRpc({ projectSlug, ...update }));
		} catch {
			undoHidden();
			showToast("Failed to save visibility settings", { variant: "warn" });
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
					<Select
						id="settings-harness-default-{row.harness}-model"
						value={value}
						invalid={Boolean(pick && !row.model)}
						disabled={saving[row.harness]}
						class="w-[220px] max-w-full"
						data-testid="settings-harness-default-{row.harness}-model"
						onchange={(event) => void updateDefault(row.harness, "model", event)}
					>
						{#if !pick}<option value="" disabled>Not set</option>{/if}
						{#if pick && !row.model}<option {value} disabled>{pick.modelId} (unavailable)</option>{/if}
						{#each row.providers as provider (provider.id)}
							<optgroup label={provider.name || provider.id}>
								{#each provider.models as model (model.id)}
									{#if model.routingOptions?.length}
										{#each model.routingOptions as option (option.value)}
											<option value="{provider.id}/{option.value}">{model.name} · {option.label}</option>
										{/each}
									{:else}
										<option value="{provider.id}/{model.id}">{model.name || model.id}</option>
									{/if}
								{/each}
							</optgroup>
						{/each}
					</Select>
					{#if pick && row.options.efforts.length > 0}
						<Select value={pick.effort} disabled={saving[row.harness]} class="w-[100px]" aria-label="{row.label} effort"
							data-testid="settings-harness-default-{row.harness}-effort" onchange={(event) => void updateDefault(row.harness, "effort", event)}>
							<option value="">Default</option>
							{#if pick.effort && !row.options.efforts.includes(pick.effort)}<option value={pick.effort} disabled>{pick.effort} (unavailable)</option>{/if}
							{#each row.options.efforts as effort}<option value={effort}>{effort}</option>{/each}
						</Select>
					{/if}
					{#if pick && row.options.contextWindows.length > 0}
						<Select value={pick.contextWindow} disabled={saving[row.harness]} class="w-[100px]" aria-label="{row.label} context window"
							data-testid="settings-harness-default-{row.harness}-context" onchange={(event) => void updateDefault(row.harness, "contextWindow", event)}>
							<option value="">Default</option>
							{#if pick.contextWindow && !row.options.contextWindows.some((option) => option.value === pick.contextWindow)}<option value={pick.contextWindow} disabled>{pick.contextWindow} (unavailable)</option>{/if}
							{#each row.options.contextWindows as option}<option value={option.value}>{option.label}</option>{/each}
						</Select>
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
