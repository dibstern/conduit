<script lang="ts">
	import Surface from "../ui/Surface.svelte";
	import Toggle from "../ui/Toggle.svelte";
	import TextButton from "../ui/TextButton.svelte";
	import { createFrontendLogger } from "../../utils/logger.js";
	import { applyGetAgentsResponse, applyGetModelsResponse, applyHiddenEntriesSet, chooseHiddenEntries, discoveryState } from "../../stores/discovery.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { getAgentsRpc, getModelsRpc, setHiddenEntriesRpc } from "../../transport/ws-rpc-client.js";
	const log = createFrontendLogger("push");
	let { visible, state = $bindable() }: { visible: boolean; state: { modelsFetchPending: boolean } } = $props();
	function getRpcProjectSlug(): string | null {
		const slug = getCurrentSlug();
		if (!slug) {
			showToast("No active project connection", { variant: "warn" });
			return null;
		}
		return slug;
	}
	const hiddenModelSet = $derived(new Set(discoveryState.hiddenModels));
	const hiddenAgentSet = $derived(new Set(discoveryState.hiddenAgents));
	const agentScopeId = $derived(discoveryState.agentProviderScope?.id ?? null);
	const modelProviders = $derived(
		discoveryState.providers.filter((p) => p.models.length > 0),
	);

	// Lazy-load lists when the tab opens with empty discovery state.
	$effect(() => {
		if (!visible) return;
		const projectSlug = getCurrentSlug();
		if (!projectSlug) return;
		if (discoveryState.providers.length === 0) {
			state.modelsFetchPending = true;
			void getModelsRpc({ projectSlug })
				.then(applyGetModelsResponse)
				.catch((err) => log.warn("Visibility models fetch failed:", err))
				.finally(() => {
					state.modelsFetchPending = false;
				});
		}
		if (discoveryState.agents.length === 0) {
			void getAgentsRpc({ projectSlug })
				.then(applyGetAgentsResponse)
				.catch((err) => log.warn("Visibility agents fetch failed:", err));
		}
	});

	// No busy-guard by design: every call sends the ABSOLUTE hidden lists
	// computed from current state, so rapid toggles are last-write-wins safe;
	// a guard would silently drop input and desync the toggles.
	async function persistHidden(update: {
		hiddenModels?: string[];
		hiddenAgents?: string[];
	}): Promise<void> {
		const projectSlug = getRpcProjectSlug();
		if (!projectSlug) return;
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
</script>

<div class="space-y-4">
	<div class="px-1 text-xs text-text-muted font-brand">
		Unchecked items are hidden from the input-area dropdowns. New
		models and agents appear automatically.
	</div>

	<!-- Models -->
	{#if modelProviders.length === 0}
		<div class="px-1 text-xs text-text-muted font-brand">
			{state.modelsFetchPending ? "Loading models…" : "No models available"}
		</div>
	{/if}
	{#each modelProviders as provider (provider.id)}
		{@const allHidden = provider.models.every((m) => hiddenModelSet.has(`${provider.id}/${m.id}`))}
		<div>
			<div class="flex items-center justify-between px-1 mb-2">
				<div class="text-xs font-semibold uppercase tracking-widest text-text-muted font-brand">{provider.name}</div>
				<TextButton
					class="text-xs font-brand"
					onclick={() => toggleProviderAll(provider.id, !allHidden)}
				>
					{allHidden ? "Show all" : "Hide all"}
				</TextButton>
			</div>
			<Surface variant="card" radius="panel" class="space-y-1 px-4 py-2">
				{#each provider.models as model (model.id)}
					<Toggle
						label={model.name || model.id}
						checked={!hiddenModelSet.has(`${provider.id}/${model.id}`)}
						onchange={() => toggleModel(provider.id, model.id)}
						class="py-1.5 gap-3 font-brand border-none bg-transparent"
					/>
				{/each}
			</Surface>
		</div>
	{/each}

	<!-- Agents (current provider scope only) -->
	{#if agentScopeId && discoveryState.agents.length > 0}
		<div>
			<div class="text-xs font-semibold uppercase tracking-widest text-text-muted px-1 mb-2 font-brand">
				{discoveryState.agentProviderScope?.name} agents
			</div>
			<Surface variant="card" radius="panel" class="space-y-1 px-4 py-2">
				{#each discoveryState.agents as agent (agent.id)}
					<Toggle
						label={agent.name || agent.id}
						checked={!hiddenAgentSet.has(`${agentScopeId}/${agent.id}`)}
						onchange={() => toggleAgent(agent.id)}
						class="py-1.5 gap-3 font-brand border-none bg-transparent"
					/>
				{/each}
			</Surface>
		</div>
	{/if}
</div>
