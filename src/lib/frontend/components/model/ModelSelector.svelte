<!-- ─── Model Selector ──────────────────────────────────────────────────────── -->
<!-- Clickable model name with dropdown picker grouped by provider. -->
<!-- Dropdown shows cost per 1K tokens, checkmark on active model. -->
<!-- Variant badge is rendered by the sibling ModelVariant component. -->

<script lang="ts">
	import Icon from "../shared/Icon.svelte";
	// biome-ignore lint/style/useImportType: ModelVariant is used as a value for bind:this
	import ModelVariant from "./ModelVariant.svelte";
	import { clickOutside } from "../shared/use-click-outside.svelte.js";
	import {
		discoveryState,
		getActiveModel,
		getProviderGroups,
		formatModelName,
		isProviderConfigured,
	} from "../../stores/discovery.svelte.js";
	import { wsSend } from "../../stores/ws.svelte.js";
	import type { ModelCost, ModelInfo, ProviderGroup } from "../../types.js";

	// ─── State ──────────────────────────────────────────────────────────────────

	let dropdownOpen = $state(false);
	let variantRef: ModelVariant | undefined = $state();

	// ─── Derived ────────────────────────────────────────────────────────────────

	const activeModel = $derived(getActiveModel());

	/** All provider groups (including unconfigured ones that have models). */
	const allGroups = $derived(getProviderGroups());

	/** Display name for the current model button, with date suffix stripped. */
	const displayName = $derived.by(() => {
		if (activeModel) return stripDateSuffix(formatModelName(activeModel));
		if (discoveryState.currentModelId) {
			return stripDateSuffix(discoveryState.currentModelId);
		}
		return "Select model";
	});

	const hasModel = $derived(!!discoveryState.currentModelId);

	// ─── Pure helpers ───────────────────────────────────────────────────────────

	/** Strip date suffixes like -20250514 from model names. */
	function stripDateSuffix(name: string): string {
		return name.replace(/-\d{8}$/, "");
	}

	/** Format cost for display as per 1K tokens. */
	function formatCost(cost?: ModelCost): string {
		if (!cost) return "";
		const parts: string[] = [];
		if (cost.input != null) {
			parts.push(`$${formatCostValue(cost.input * 1000)}/1K in`);
		}
		if (cost.output != null) {
			parts.push(`$${formatCostValue(cost.output * 1000)}/1K out`);
		}
		return parts.join(", ");
	}

	function formatCostValue(value: number): string {
		if (value === 0) return "0";
		return Number.parseFloat(value.toFixed(6)).toString();
	}

	function isActiveModel(model: ModelInfo): boolean {
		return model.id === discoveryState.currentModelId;
	}

	function isDefaultModel(model: ModelInfo): boolean {
		return (
			model.id === discoveryState.defaultModelId &&
			model.provider === discoveryState.defaultProviderId
		);
	}

	function providerSectionClass(group: ProviderGroup): string {
		const base = "model-provider";
		if (!isProviderConfigured(group.provider)) {
			return `${base} model-provider-disabled opacity-45`;
		}
		return base;
	}

	function modelItemClass(model: ModelInfo): string {
		const base =
			"model-item flex items-baseline justify-between gap-2 w-full py-1.5 px-3.5 m-0 border-none bg-transparent text-text text-base text-left cursor-pointer transition-colors duration-100 leading-[1.4] hover:bg-bg-alt";
		if (isActiveModel(model)) {
			return `${base} model-item-active text-accent`;
		}
		return base;
	}

	// ─── Handlers ───────────────────────────────────────────────────────────────

	function toggleDropdown(e: MouseEvent) {
		e.stopPropagation();
		variantRef?.close();
		dropdownOpen = !dropdownOpen;
	}

	function handleModelClick(model: ModelInfo, e: MouseEvent) {
		e.stopPropagation();
		wsSend({
			type: "switch_model",
			modelId: model.id,
			providerId: model.provider,
		});
		discoveryState.currentModelId = model.id;
		discoveryState.currentProviderId = model.provider;
		dropdownOpen = false;
	}

	function handleSetDefault(model: ModelInfo, e: MouseEvent) {
		e.stopPropagation();
		wsSend({
			type: "set_default_model",
			provider: model.provider,
			model: model.id,
		});
		discoveryState.defaultModelId = model.id;
		discoveryState.defaultProviderId = model.provider;
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === "Escape" && dropdownOpen) {
			dropdownOpen = false;
		}
	}

	// ─── Lifecycle ──────────────────────────────────────────────────────────────

	$effect(() => {
		document.addEventListener("keydown", handleKeydown);
		return () => {
			document.removeEventListener("keydown", handleKeydown);
		};
	});
</script>

<div id="model-display" class="relative inline-flex items-center" use:clickOutside={() => { dropdownOpen = false; }}>
	<!-- Model button -->
	<button
	class="model-btn inline-flex items-center gap-[2px] h-9 px-2 border-none bg-transparent text-text-muted text-xs font-medium cursor-pointer whitespace-nowrap transition-[background,color] duration-150 rounded-[10px] max-w-[180px] max-sm:max-w-[120px] hover:bg-bg-alt hover:text-text-secondary font-brand {hasModel ? '' : 'opacity-50'}"
		title="Switch model"
		onclick={toggleDropdown}
	>
		<span class="model-label overflow-hidden text-ellipsis whitespace-nowrap">
			{displayName}
		</span>
		<Icon name="chevron-down" size={10} class="shrink-0 opacity-50" />
	</button>

	<!-- Variant badge (extracted component) -->
	<ModelVariant bind:this={variantRef} onOpen={() => { dropdownOpen = false }} />

	<!-- Model dropdown -->
	{#if dropdownOpen}
		<div
		class="model-dropdown absolute bottom-[calc(100%+4px)] left-0 min-w-80 max-w-[90vw] max-h-[400px] overflow-y-auto bg-bg-alt border border-border rounded-xl shadow-[0_-4px_24px_rgba(var(--shadow-rgb),0.4)] z-[200] py-1.5 font-brand"
		>
			{#if allGroups.length === 0}
				<div
					class="model-empty py-4 px-3.5 text-center text-base text-text-dimmer"
				>
					No models available
				</div>
			{:else}
				{#each allGroups as group (group.provider.id)}
					<div class={providerSectionClass(group)}>
						<div
							class="model-provider-header py-2 px-3.5 pt-2 text-sm font-semibold uppercase tracking-[0.5px] text-text-dimmer"
						>
							{group.provider.name || group.provider.id}
						</div>
						{#each group.models as model (model.id)}
							{@const cost = formatCost(model.cost)}
							<div class="flex items-center">
								<button
									class={modelItemClass(model)}
									data-model-id={model.id}
									data-provider-id={model.provider}
									onclick={(e) => handleModelClick(model, e)}
								>
									<span
										class="model-item-name flex-1 whitespace-nowrap"
									>
										{#if isActiveModel(model)}
											<span class="model-check text-accent font-bold mr-0.5"
												>&#10003;</span
											>
										{/if}
										{stripDateSuffix(formatModelName(model))}
										{#if isDefaultModel(model)}
											<span
												class="ml-1 text-xs text-text-dimmer font-normal"
												title="Default model">(default)</span
											>
										{/if}
									</span>
									{#if cost}
										<span
											class="model-item-cost shrink-0 text-xs text-text-dimmer whitespace-nowrap"
										>
											{cost}
										</span>
									{/if}
								</button>
								{#if !isDefaultModel(model)}
									<button
										class="shrink-0 px-1.5 py-1 mr-1 text-xs text-text-dimmer bg-transparent border-none cursor-pointer rounded hover:bg-bg hover:text-text-secondary transition-colors duration-100"
										title="Set as default model"
										onclick={(e) => handleSetDefault(model, e)}
									>
										<Icon name="star" size={12} />
									</button>
								{:else}
									<span
										class="shrink-0 px-1.5 py-1 mr-1 text-text [&>svg]:fill-current"
										title="Default model"
									>
										<Icon name="star" size={12} />
									</span>
								{/if}
							</div>
						{/each}
					</div>
				{/each}
			{/if}
		</div>
	{/if}
</div>
