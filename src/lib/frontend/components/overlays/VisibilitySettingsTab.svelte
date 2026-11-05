<script lang="ts">
	import { selection } from "../../stores/selection.svelte.js";
	import type { HarnessDefaultState } from "../../transport/ws-rpc.js";
	import { catalogFromProviderList, findCatalogModel, type Harness, offeredOptions } from "../../../provider/turn-settings.js";
	import SettingsPicker from "../ui/SettingsPicker.svelte";
	import SettingsGroup from "../ui/SettingsGroup.svelte";
	import SettingsRow from "../ui/SettingsRow.svelte";
	import TitleGenerationPicker from "../model/TitleGenerationPicker.svelte";
	import { resolveModelParameters } from "../model/model-parameters.js";
	import { isKnownDriverKind } from "../../../contracts/provider-instance.js";
	import { getDriverTraits } from "../../stores/instance.svelte.js";
	import { PROVIDER_PRESENTATION } from "../../utils/provider-presentation.js";
	import { applyHarnessDefaultSet, discoveryState, getHarnessDefaultProviders } from "../../stores/discovery.svelte.js";
	import { toastFailure } from "../../transport/rpc-errors.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import ModelVisibilityList from "./ModelVisibilityList.svelte";
	let saving = $state<Partial<Record<Harness, boolean>>>({});
	const defaultRows = $derived(Object.keys(PROVIDER_PRESENTATION).filter(isKnownDriverKind).map((harness) => {
		const row = { harness, label: PROVIDER_PRESENTATION[harness].label };
		const state = discoveryState.harnessDefaults[row.harness];
		const providers = getHarnessDefaultProviders(row.harness);
		const catalog = catalogFromProviderList(providers);
		const model = state.pick ? findCatalogModel(row.harness, state.pick, catalog) : undefined;
		return { ...row, state, providers, model, parameters: resolveModelParameters(model, state.pick?.effort), options: model ? offeredOptions(model) : { efforts: [], contextWindows: [] } };
	}));

	function defaultProblem(state: HarnessDefaultState, harness: Harness, label: string): string {
		if (state.status === "missing") return `No default. New chats on ${label} start with no model.`;
		if (state.status === "unverified") return getDriverTraits(harness)?.runsOpenCodeServer ? `Start ${label} to check this default.` : `Connect ${label} to check this default.`;
		if (state.problem?.startsWith("ModelParametersUnavailable")) return `Effort "${state.pick?.effort}" is no longer available for ${state.pick?.modelId}.`;
		if (state.problem?.startsWith("ContextWindowNotOffered")) return `Context window "${state.pick?.contextWindow}" is no longer available for ${state.pick?.modelId}.`;
		return `${state.pick?.modelId ?? "This model"} is no longer available.`;
	}

	async function updateDefault(harness: Harness, setting: "model" | "effort" | "contextWindow", value: string): Promise<void> {
		const projectSlug = selection.scope?.project;
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
</script>

<SettingsGroup id="settings-default-models" title="Default models">
	{#each defaultRows as row (row.harness)}
		{@const pick = row.state.pick}
		{@const value = pick ? `${pick.providerId}/${pick.modelId}` : ""}
		<div>
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
					{#if pick && row.model?.parameters}
						{#if row.parameters.variantUnavailable}
							<SettingsPicker value={pick.effort} disabled label="{row.label} unavailable parameters"
								data-testid="settings-harness-default-{row.harness}-unavailable" onvaluechange={() => {}} options={[
									{ value: pick.effort, label: `${pick.effort} (unavailable)`, disabled: true },
								]} />
						{/if}
						{#each row.parameters.rows as parameter (parameter.id)}
							<SettingsPicker value={parameter.value} disabled={saving[row.harness]} label="{row.label} {parameter.title}"
								data-testid="settings-harness-default-{row.harness}-{parameter.kind}" options={parameter.options}
								onvaluechange={(value) => {
									const choice = row.parameters.withValue(parameter.id, value);
									if (choice !== undefined) void updateDefault(row.harness, "effort", choice);
								}} />
						{/each}
					{:else if pick && row.options.efforts.length > 0}
						<SettingsPicker value={pick.effort} disabled={saving[row.harness]} label="{row.label} effort"
							data-testid="settings-harness-default-{row.harness}-effort" onvaluechange={(value) => void updateDefault(row.harness, "effort", value)} options={[
								{ value: "", label: "Default" },
								...(pick.effort && !row.options.efforts.includes(pick.effort) ? [{ value: pick.effort, label: `${pick.effort} (unavailable)`, disabled: true }] : []),
								...row.options.efforts.map((effort) => ({ value: effort, label: effort })),
							]} />
					{/if}
					{#if pick && !row.model?.parameters && row.options.contextWindows.length > 0}
						<SettingsPicker value={pick.contextWindow} disabled={saving[row.harness]} label="{row.label} context window"
							data-testid="settings-harness-default-{row.harness}-context" onvaluechange={(value) => void updateDefault(row.harness, "contextWindow", value)} options={[
								{ value: "", label: "Default" },
								...(pick.contextWindow && !row.options.contextWindows.some((option) => option.value === pick.contextWindow) ? [{ value: pick.contextWindow, label: `${pick.contextWindow} (unavailable)`, disabled: true }] : []),
								...row.options.contextWindows,
							]} />
					{/if}
				</div>
			{/snippet}
			<SettingsRow label={row.label} labelFor="settings-harness-default-{row.harness}-model" control={controls} />
			{#if row.state.status !== "ok"}
				<p class="px-[14px] pb-[10px] text-[12px] leading-[1.4] text-text-muted" data-testid="settings-harness-default-{row.harness}-status" data-status={row.state.status}>{defaultProblem(row.state, row.harness, row.label)}</p>
			{/if}
		</div>
	{/each}
</SettingsGroup>

<SettingsGroup id="settings-title-generation-group" title="Session titles">
	<TitleGenerationPicker />
	{#if discoveryState.titleGeneration.status === "missing" || discoveryState.titleGeneration.status === "invalid"}
		<p class="px-[14px] pb-[10px] text-[12px] leading-[1.4] text-text-muted" data-testid="settings-title-generation-problem" data-status={discoveryState.titleGeneration.status}>
			{discoveryState.titleGeneration.status === "missing" ? "The saved account is gone." : "The saved model is no longer available."} Titles use the default Claude account until you pick another.
		</p>
	{/if}
</SettingsGroup>

<ModelVisibilityList accountId={discoveryState.catalogAccountId} />
