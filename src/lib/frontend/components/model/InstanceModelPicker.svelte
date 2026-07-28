<!-- ─── Instance Model Picker ───────────────────────────────────────────────── -->
<!-- Composer trigger carrying the selected harness-instance icon + model name. -->
<!-- Opens an upward popover: 48px instance rail (left) + search & model rows   -->
<!-- (right). Selecting a rail instance sets the session harness draft and      -->
<!-- re-scopes both the model list and the agent list. Once a session exists    -->
<!-- the harness is fixed: non-bound instances render disabled (locked mode).   -->

<script lang="ts">
	import Icon from "../shared/Icon.svelte";
	// biome-ignore lint/style/useImportType: ContextWindowSelector is used as a value for bind:this
	import ContextWindowSelector from "./ContextWindowSelector.svelte";
	// biome-ignore lint/style/useImportType: ModelVariant is used as a value for bind:this
	import ModelVariant from "./ModelVariant.svelte";
	import { clickOutside } from "../shared/use-click-outside.svelte.js";
	import {
		applyGetModelsResponse,
		applyGetAgentsResponse,
		discoveryState,
		getActiveModel,
		getAvailableInstances,
		getEffectiveInstanceId,
		getModelDisplayName,
		getProviderGroupsForInstance,
		formatModelName,
		type InstanceOption,
		instanceIdForProviderId,
		isProviderConfigured,
		selectInstance,
	} from "../../stores/discovery.svelte.js";
	import { currentChat } from "../../stores/chat.svelte.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { sessionState } from "../../stores/session.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import {
		getAgentsRpc,
		getModelsRpc,
		reloadProviderSessionRpc,
		setDefaultModelRpc,
		switchModelRpc,
	} from "../../transport/ws-rpc-client.js";
	import type { ModelCost, ModelInfo, ProviderGroup } from "../../types.js";

	// ─── State ──────────────────────────────────────────────────────────────────

	let pickerOpen = $state(false);
	let searchQuery = $state("");
	let favoritesOnly = $state(false);
	let railTooltip = $state<{ label: string; top: number; left: number } | null>(
		null,
	);
	let variantRef: ModelVariant | undefined = $state();
	let contextWindowRef: ContextWindowSelector | undefined = $state();

	// ─── Derived ────────────────────────────────────────────────────────────────

	const instances = $derived(getAvailableInstances());

	/** Instance bound to the active session — non-null means locked mode. */
	const boundInstanceId = $derived.by(() => {
		if (!sessionState.currentId) return null;
		const providerId = discoveryState.currentProviderId;
		return providerId ? instanceIdForProviderId(providerId) : null;
	});
	const locked = $derived(boundInstanceId !== null);
	const selectedId = $derived(boundInstanceId ?? getEffectiveInstanceId());
	const selectedInstance = $derived(
		instances.find((i) => i.id === selectedId) ?? null,
	);
	const selectedLabel = $derived(
		selectedInstance?.label ?? driverLabel(selectedId),
	);
	const selectedDriver = $derived(
		selectedInstance?.driver ??
			(selectedId === "claude" ? ("claude" as const) : ("opencode" as const)),
	);

	const scopedGroups = $derived(getProviderGroupsForInstance(selectedId));
	const filteredGroups = $derived.by(() => {
		const query = searchQuery.trim().toLowerCase();
		if (!query && !favoritesOnly) return scopedGroups;
		return scopedGroups
			.map((g) => ({
				provider: g.provider,
				models: g.models.filter(
					(m) =>
						(!favoritesOnly || isDefaultModel(m)) &&
						stripDateSuffix(formatModelName(m)).toLowerCase().includes(query),
				),
			}))
			.filter((g) => g.models.length > 0);
	});

	const activeModel = $derived(getActiveModel());
	const hasModel = $derived(!!discoveryState.currentModelId);
	const currentDrift = $derived(
		discoveryState.modelExecution?.drifted === true &&
			discoveryState.modelExecution.requestedModel &&
			discoveryState.modelExecution.expectedModel &&
			discoveryState.modelExecution.actualModel
			? discoveryState.modelExecution
			: null,
	);

	$effect(() => {
		const turnEpoch = currentChat().turnEpoch;
		const projectSlug = getCurrentSlug();
		const sessionId = sessionState.currentId;
		if (turnEpoch === 0 || !projectSlug || !sessionId) return;

		void getModelsRpc({ projectSlug, sessionId })
			.then((response) => {
				if (sessionState.currentId === sessionId) {
					applyGetModelsResponse(response);
				}
			})
			.catch(() => undefined);
	});

	/** Display name for the trigger button, with date suffix stripped.
	 *  Grouped models (Bedrock geo routing) append the active scope label. */
	const displayName = $derived.by(() => {
		if (activeModel) {
			const base = stripDateSuffix(formatModelName(activeModel));
			const scope = activeModel.routingOptions?.find(
				(option) => option.value === discoveryState.currentModelId,
			);
			return scope ? `${base} · ${scope.label}` : base;
		}
		if (discoveryState.currentModelId) {
			return stripDateSuffix(discoveryState.currentModelId);
		}
		return "Select model";
	});

	// ─── Pure helpers ───────────────────────────────────────────────────────────

	function driverLabel(id: string): string {
		return id === "claude" ? "Claude" : id === "opencode" ? "OpenCode" : id;
	}

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
		return (
			model.id === discoveryState.currentModelId ||
			!!model.routingOptions?.some(
				(option) => option.value === discoveryState.currentModelId,
			)
		);
	}

	function isDefaultModel(model: ModelInfo): boolean {
		return (
			model.id === discoveryState.defaultModelId &&
			model.provider === discoveryState.defaultProviderId
		);
	}

	function isInstanceDisabled(instance: InstanceOption): boolean {
		return locked && instance.id !== boundInstanceId;
	}

	function instanceTooltip(instance: InstanceOption): string {
		// Surface live instance health (merged from instanceState) on hover;
		// healthy is the norm, so only annotate degraded states.
		const status =
			instance.status && instance.status !== "healthy"
				? ` · ${instance.status}`
				: "";
		return isInstanceDisabled(instance)
			? `${instance.label} — harness is fixed for this session`
			: `${instance.label}${status}`;
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
			"model-item flex items-baseline justify-between gap-2 w-full py-1.5 px-3.5 m-0 border-none bg-transparent text-text text-base text-left cursor-pointer transition-colors duration-100 leading-[1.4] hover:bg-bg";
		if (isActiveModel(model)) {
			return `${base} model-item-active text-accent`;
		}
		return base;
	}

	// ─── Handlers ───────────────────────────────────────────────────────────────

	function togglePicker(e: MouseEvent) {
		e.stopPropagation();
		variantRef?.close();
		contextWindowRef?.close();
		searchQuery = "";
		pickerOpen = !pickerOpen;
	}

	function closePicker() {
		pickerOpen = false;
		railTooltip = null;
	}

	function handleInstanceSelect(instance: InstanceOption, e: MouseEvent) {
		e.stopPropagation();
		railTooltip = null;
		if (isInstanceDisabled(instance) || instance.id === selectedId) return;
		selectInstance(instance.id);
		searchQuery = "";
		// The agent list follows the selected harness — re-fetch instance-scoped.
		const projectSlug = getCurrentSlug();
		if (projectSlug) {
			void getAgentsRpc({ projectSlug, instanceId: instance.id })
				.then(applyGetAgentsResponse)
				.catch(() => undefined);
		}
	}

	function showRailTooltip(e: MouseEvent, instance: InstanceOption) {
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		railTooltip = {
			label: instanceTooltip(instance),
			top: rect.top + 8,
			left: rect.right + 10,
		};
	}

	function hideRailTooltip() {
		railTooltip = null;
	}

	function handleModelClick(model: ModelInfo, e: MouseEvent, modelId?: string) {
		e.stopPropagation();
		const targetId = modelId ?? model.id;
		const previousModelId = discoveryState.currentModelId;
		const previousProviderId = discoveryState.currentProviderId;
		const previousVariant = discoveryState.currentVariant;
		const previousVariants = discoveryState.availableVariants;
		discoveryState.currentModelId = targetId;
		discoveryState.currentProviderId = model.provider;
		const projectSlug = getCurrentSlug();
		const sessionId = sessionState.currentId;
		if (projectSlug && sessionId) {
			void switchModelRpc({
				projectSlug,
				sessionId,
				modelId: targetId,
				providerId: model.provider,
			})
				.then((response) => {
					discoveryState.currentModelId = response.model;
					discoveryState.currentProviderId = response.provider;
					discoveryState.currentVariant = response.variant;
					discoveryState.availableVariants = response.variants;
					void getAgentsRpc({ projectSlug, sessionId })
						.then(applyGetAgentsResponse)
						.catch(() => undefined);
				})
				.catch(() => {
					discoveryState.currentModelId = previousModelId;
					discoveryState.currentProviderId = previousProviderId;
					discoveryState.currentVariant = previousVariant;
					discoveryState.availableVariants = previousVariants;
				});
		}
		closePicker();
	}

	function handleSetDefault(model: ModelInfo, e: MouseEvent) {
		e.stopPropagation();
		const previousDefaultModelId = discoveryState.defaultModelId;
		const previousDefaultProviderId = discoveryState.defaultProviderId;
		const previousVariant = discoveryState.currentVariant;
		const previousVariants = discoveryState.availableVariants;
		discoveryState.defaultModelId = model.id;
		discoveryState.defaultProviderId = model.provider;
		const projectSlug = getCurrentSlug();
		if (projectSlug) {
			void setDefaultModelRpc({
				projectSlug,
				model: model.id,
				provider: model.provider,
			})
				.then((response) => {
					discoveryState.defaultModelId = response.model;
					discoveryState.defaultProviderId = response.provider;
					discoveryState.currentVariant = response.variant;
					discoveryState.availableVariants = response.variants;
				})
				.catch(() => {
					discoveryState.defaultModelId = previousDefaultModelId;
					discoveryState.defaultProviderId = previousDefaultProviderId;
					discoveryState.currentVariant = previousVariant;
					discoveryState.availableVariants = previousVariants;
				});
		}
	}

	function handleReload(e: MouseEvent) {
		e.stopPropagation();
		const projectSlug = getCurrentSlug();
		const sessionId = sessionState.currentId;
		if (projectSlug && sessionId) {
			void reloadProviderSessionRpc({
				projectSlug,
				sessionId,
				commandId: crypto.randomUUID(),
			});
		}
		showToast("Reloading skills…", { duration: 1500 });
		closePicker();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === "Escape" && pickerOpen) {
			closePicker();
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

{#snippet driverIcon(driver: "claude" | "opencode", size: number, badge: boolean)}
	<span
		data-driver={driver}
		class="relative inline-flex flex-none items-center justify-center rounded-md font-bold text-[#0b0b0d] {driver === 'claude' ? 'bg-harness-claude' : 'bg-harness-opencode'}"
		style="width:{size}px;height:{size}px;font-size:{size >= 24 ? 12 : 11}px"
	>
		{driver === "claude" ? "C" : "O"}
		{#if badge}
			<span
				class="absolute -bottom-[3px] -right-[3px] h-3 min-w-3 rounded-full bg-accent border-[1.5px] border-bg-alt flex items-center justify-center text-white text-[7px] font-bold"
			>•</span>
		{/if}
	</span>
{/snippet}

<div id="model-display" class="relative inline-flex items-center" use:clickOutside={closePicker}>
	<!-- Trigger: selected instance icon + current model name -->
	<button
		data-testid="model-picker-trigger"
		data-instance-id={selectedId}
		class="model-btn inline-flex items-center gap-1.5 h-9 px-2 border-none bg-transparent text-text-muted text-xs font-medium cursor-pointer whitespace-nowrap transition-[background,color] duration-150 rounded-[10px] max-w-[200px] max-sm:max-w-[130px] hover:bg-bg-alt hover:text-text-secondary font-brand {hasModel ? '' : 'opacity-50'}"
		title="Switch model"
		aria-expanded={pickerOpen}
		onclick={togglePicker}
	>
		{@render driverIcon(selectedDriver, 18, selectedInstance?.isCustom ?? false)}
		<span class="model-label overflow-hidden text-ellipsis whitespace-nowrap">
			{displayName}
		</span>
		<Icon name="chevron-down" size={10} class="shrink-0 opacity-50" />
	</button>

	<!-- Variant badge (extracted component) -->
	<ModelVariant
		bind:this={variantRef}
		onOpen={() => {
			closePicker();
			contextWindowRef?.close();
		}}
	/>

	<!-- Context window badge -->
	<ContextWindowSelector
		bind:this={contextWindowRef}
		onOpen={() => {
			closePicker();
			variantRef?.close();
		}}
	/>

	{#if currentDrift}
		<span
			data-testid="current-model-drift"
			class="inline-flex items-center shrink-0 rounded-lg border border-warning/30 bg-warning-bg px-2 py-1 text-[11px] leading-[1.3] font-medium text-warning"
		>
			⚠ Running {getModelDisplayName(currentDrift.actualModel)} — you selected {getModelDisplayName(currentDrift.requestedModel)}
		</span>
	{/if}

	<!-- Upward popover: instance rail + model list -->
	{#if pickerOpen}
		<div
			id="model-picker"
			data-testid="model-picker"
			class="model-dropdown absolute bottom-[calc(100%+8px)] right-0 w-[404px] max-w-[90vw] h-[376px] max-sm:fixed max-sm:inset-x-2 max-sm:bottom-2 max-sm:w-auto max-sm:max-w-none max-sm:h-[70vh] flex flex-row overflow-hidden bg-bg-alt border border-border rounded-[14px] shadow-menu-lg z-[var(--z-popover)] font-brand"
		>
			<!-- 48px instance rail -->
			<div
				data-testid="model-picker-rail"
				class="w-12 flex-none border-r border-border bg-bg flex flex-col gap-1 p-1 overflow-y-auto"
			>
				<button
					data-testid="picker-favorites"
					class="h-10 flex-none flex items-center justify-center border-0 border-b border-solid border-border mb-0.5 rounded-lg bg-transparent cursor-pointer hover:bg-bg-alt {favoritesOnly ? 'text-accent' : 'text-text-secondary'}"
					title="Favorites"
					aria-pressed={favoritesOnly}
					onclick={(e) => {
						e.stopPropagation();
						favoritesOnly = !favoritesOnly;
					}}
				>
					<Icon name="star" size={14} />
				</button>
				{#each instances as instance (instance.id)}
					{@const disabled = isInstanceDisabled(instance)}
					{@const selected = instance.id === selectedId}
					<button
						data-testid="picker-instance-{instance.id}"
						data-driver={instance.driver}
						aria-pressed={selected}
						aria-disabled={disabled}
						class="relative h-10 flex-none rounded-lg border-none bg-transparent flex items-center justify-center {disabled ? 'opacity-[0.38] cursor-not-allowed' : 'cursor-pointer hover:bg-bg-alt'}"
						onclick={(e) => handleInstanceSelect(instance, e)}
						onmouseenter={(e) => showRailTooltip(e, instance)}
						onmouseleave={hideRailTooltip}
					>
						{@render driverIcon(instance.driver, 26, instance.isCustom)}
						{#if instance.isNew && !locked}
							<span class="absolute top-0 right-0 text-warning">
								<Icon name="sparkles" size={9} />
							</span>
						{/if}
						<span
							class="absolute -right-1 top-1/2 -translate-y-1/2 w-[3px] h-[22px] rounded-l-[3px] bg-accent transition-opacity duration-150 {selected ? 'opacity-100' : 'opacity-0'}"
						></span>
					</button>
				{/each}
			</div>

			<!-- Search + scoped model rows -->
			<div class="flex-1 flex flex-col min-w-0">
				<div
					class="flex items-center gap-2 py-2.5 px-3.5 border-b border-border text-text-dimmer"
				>
					<Icon name="search" size={13} class="shrink-0" />
					<!-- svelte-ignore a11y_autofocus -->
					<input
						data-testid="model-picker-search"
						bind:value={searchQuery}
						placeholder="Search {selectedLabel} models…"
						autofocus
						class="flex-1 min-w-0 bg-transparent border-none outline-none text-text text-[13px] font-brand placeholder:text-text-dimmer"
						onclick={(e) => e.stopPropagation()}
					/>
				</div>
				<div
					data-testid="model-picker-list"
					class="flex-1 overflow-y-auto py-1.5"
				>
					{#if locked}
						<div
							class="flex items-start gap-2 mx-2 my-1.5 py-2 px-3 border border-dashed border-border rounded-lg text-[11px] leading-[1.4] text-text-dimmer"
						>
							<span class="shrink-0">🔒</span>
							<span>
								Harness fixed at creation — showing
								<b class="text-text-secondary font-semibold">{selectedLabel}</b>
								only. Model switching within it is allowed.
							</span>
						</div>
					{/if}
					{#if filteredGroups.length === 0}
						<div
							class="model-empty py-4 px-3.5 text-center text-base text-text-dimmer"
						>
							{searchQuery.trim() ? "No models match" : "No models available"}
						</div>
					{:else}
						{#each filteredGroups as group (group.provider.id)}
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
											<span class="model-item-name flex-1 whitespace-nowrap">
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
										{#if model.routingOptions}
											<span class="model-routing flex items-center gap-0.5 shrink-0 mr-1">
												{#each model.routingOptions as option (option.value)}
													<button
														class="px-1.5 py-0.5 text-xs border-none rounded cursor-pointer transition-colors duration-100 {option.value === discoveryState.currentModelId ? 'bg-bg text-accent font-semibold' : 'bg-transparent text-text-dimmer hover:bg-bg hover:text-text-secondary'}"
														title="Route via {option.label}{option.isDefault ? ' (default)' : ''}"
														data-routing-value={option.value}
														onclick={(e) => handleModelClick(model, e, option.value)}
													>
														{option.label}
													</button>
												{/each}
											</span>
										{/if}
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

					<!-- Reload footer -->
					<div class="model-reload-footer border-t border-border mt-1 pt-1">
						<button
							class="reload-btn w-full flex items-center gap-2 py-1.5 px-3.5 m-0 border-none bg-transparent text-text-dimmer text-sm text-left cursor-pointer transition-colors duration-100 hover:bg-bg hover:text-text-secondary"
							title="Reload skills and commands from disk"
							onclick={handleReload}
						>
							<Icon name="refresh-cw" size={12} />
							<span>Reload skills &amp; commands</span>
						</button>
					</div>
				</div>
			</div>
		</div>
	{/if}
</div>

<!-- Rail hover tooltip — opens toward the rail (fixed, outside the popover clip) -->
{#if pickerOpen && railTooltip}
	<div
		class="fixed z-[var(--z-modal)] pointer-events-none bg-black text-white text-[11px] leading-[1.3] py-1.5 px-2 rounded-md border border-border whitespace-nowrap shadow-panel before:content-[''] before:absolute before:-left-[5px] before:top-[9px] before:border-y-[5px] before:border-y-transparent before:border-r-[5px] before:border-r-black"
		style="top:{railTooltip.top}px;left:{railTooltip.left}px"
	>
		{railTooltip.label}
	</div>
{/if}
