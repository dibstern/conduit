<script lang="ts">
	import { selection } from "../../stores/selection.svelte.js";
	import { untrack } from "svelte";
	import { refreshCatalogs, loadModelCatalog, getModelProvidersForInstance, applyHiddenEntriesSet, chooseHiddenEntries, discoveryState } from "../../stores/discovery.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import { toastFailure } from "../../transport/rpc-errors.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import { createFrontendLogger } from "../../utils/logger.js";
	import SettingsGroup from "../ui/SettingsGroup.svelte";
	import SettingsRow from "../ui/SettingsRow.svelte";
	import TextButton from "../ui/TextButton.svelte";
	import TextInput from "../ui/TextInput.svelte";

	let { accountId }: { accountId: string | undefined } = $props();
	const log = createFrontendLogger("push");
	let modelsFetchPending = $state(false);
	const hiddenModelSet = $derived(new Set(discoveryState.hiddenModels));
	const hiddenAgentSet = $derived(new Set(discoveryState.hiddenAgents));
	const agentScopeId = $derived(discoveryState.agentProviderScope?.id ?? null);
	const modelProviders = $derived(
		getModelProvidersForInstance(accountId).filter((p) => p.models.length > 0),
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

	// The prop getter tracks every catalogue read behind it; only a changed id may refetch,
	// or each reply would trigger the next refresh.
	const catalogAccount = $derived(accountId);
	// Keep today's agents refresh; only models use the requested account.
	$effect(() => {
		const projectSlug = selection.scope?.project;
		const instanceId = catalogAccount;
		if (!projectSlug) return;
		let current = true;
		untrack(() => {
			modelsFetchPending = true;
			void Promise.all([
				refreshCatalogs(),
				...(instanceId ? [loadModelCatalog(projectSlug, instanceId)] : []),
			])
				.catch((err) => log.warn("Visibility models fetch failed:", err))
				.finally(() => {
					if (current) modelsFetchPending = false;
				});
		});
		return () => { current = false; };
	});

	// No busy-guard by design: every call sends the ABSOLUTE hidden lists
	// computed from current state, so rapid toggles are last-write-wins safe;
	// a guard would silently drop input and desync the toggles.
	async function persistHidden(update: {
		hiddenModels?: string[];
		hiddenAgents?: string[];
	}): Promise<void> {
		const projectSlug = selection.scope?.project;
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
		const provider = modelProviders.find((p) => p.id === providerId);
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

<div class="mt-[16px] flex flex-col gap-[8px]">
	{#if modelCount > 0 || discoveryState.agents.length > 0}
		<TextInput
			type="search"
			aria-label="Filter models and agents"
			data-testid="settings-models-filter"
			placeholder="Filter {modelCount} models"
			bind:value={filter}
		/>
	{/if}
	<div class="flex flex-wrap items-center justify-between gap-x-[12px] gap-y-[4px] text-[12px] leading-[1.4] text-text-muted">
		<p>Hidden models stay out of the model picker.</p>
		{#if modelCount > 0}
			<p data-testid="settings-models-summary">{shownModelCount} of {modelCount} shown</p>
		{/if}
	</div>
	<p class="text-[12px] leading-[1.4] text-text-muted">New models and agents appear automatically.</p>
</div>

<!-- Models -->
{#if modelProviders.length === 0}
	<p class="mx-[4px] text-[12px] text-text-muted">{modelsFetchPending ? "Loading models…" : "No models available"}</p>
{/if}
{#if noMatches}
	<div class="flex flex-wrap items-center gap-2" data-testid="settings-models-no-match">
		<span>No models match ‘{filter}’.</span>
		<TextButton class="max-md:min-h-[44px] max-md:min-w-[44px]" onclick={() => (filter = "")}>Clear</TextButton>
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
			<TextButton class="max-md:min-h-[44px] max-md:min-w-[44px]" onclick={() => toggleProviderAll(provider.id, allShown)}>
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
	<h3 class="mx-[4px] mt-[16px] text-[12px] font-medium text-text-muted max-md:text-[13px]">Agents</h3>
	<SettingsGroup
		title="{discoveryState.agentProviderScope?.name} agents"
		summary="{shownAgentCount} of {discoveryState.agents.length} shown"
		collapsible
		bind:open={agentsOpen}
		testId="settings-agents-group"
	>
		{#snippet actions()}
			<TextButton class="max-md:min-h-[44px] max-md:min-w-[44px]" onclick={() => toggleAgentsAll(shownAgentCount === discoveryState.agents.length)}>
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
