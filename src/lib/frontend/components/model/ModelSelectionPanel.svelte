<script lang="ts">
	import type { Snippet } from "svelte";
	import type { ProviderDriverKind } from "../../../contracts/provider-instance.js";
	import { formatModelName, isProviderConfigured, modelMatchesId } from "../../stores/discovery.svelte.js";
	import type { Immutable, ModelInfo, ProviderGroup } from "../../types.js";
	import { getProviderPresentation } from "../../utils/provider-presentation.js";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import OptionRow from "../ui/OptionRow.svelte";
	import SegmentedControl from "../ui/SegmentedControl.svelte";
	import TextInput from "../ui/TextInput.svelte";
	import HarnessLogo from "./HarnessLogo.svelte";
	import { createModelSelectionState, formatCost, modelContextLabel, stripDateSuffix } from "./model-selection.svelte.js";
	import type { ModelSelectionTarget } from "./model-selection-target.js";

	let {
		target, titleId, groupHeadingId, selectedLabel, title = "Harness & model", contextLabel: suppliedContextLabel,
		storedEffortLabel, view = $bindable("root"), searchQuery = $bindable(""),
		searchEl = $bindable(), backEl = $bindable(), filterModel,
		subtitle, accountControls, contextUsage, rootExtras, extraView,
		modelToolbar, modelNotice, modelLabelSuffix, modelAction, modelFooter,
	}: {
		target: ModelSelectionTarget;
		titleId: string;
		groupHeadingId: string;
		selectedLabel: string;
		title?: string;
		contextLabel?: string;
		storedEffortLabel?: string | null;
		view?: string;
		searchQuery?: string;
		searchEl?: HTMLInputElement | undefined;
		backEl?: HTMLButtonElement | HTMLAnchorElement | undefined;
		filterModel?: ((model: Immutable<ModelInfo>) => boolean) | undefined;
		subtitle?: Snippet;
		accountControls?: Snippet;
		contextUsage?: Snippet;
		rootExtras?: Snippet;
		extraView?: Snippet;
		modelToolbar?: Snippet;
		modelNotice?: Snippet;
		modelLabelSuffix?: Snippet<[model: Immutable<ModelInfo>]>;
		modelAction?: Snippet<[model: Immutable<ModelInfo>]>;
		modelFooter?: Snippet;
	} = $props();
	const selection = createModelSelectionState(() => target);
	const activeModelId = $derived(selection.activeModelId);
	const parameters = $derived(selection.parameters);
	const parameterEffort = $derived(selection.parameterEffort);
	const parameterContext = $derived(selection.parameterContext);
	const parameterToggles = $derived(selection.parameterToggles);
	const contextOptions = $derived(selection.contextOptions);
	const selectedContext = $derived(selection.selectedContext);
	const contextSegments = $derived(selection.contextSegments);
	const effortSegments = $derived(selection.effortSegments);
	const displayName = $derived(selection.displayName);
	const contextLabel = $derived(parameterContext?.label ?? suppliedContextLabel ?? (target.loading ? "" : selectedContext?.label ?? modelContextLabel(target.activeModel)));
	const harnesses = $derived([...new Set(target.accounts.map((account) => account.driver))].map((driver) => ({
		value: driver,
		label: getProviderPresentation(driver)?.label ?? driver.charAt(0).toUpperCase() + driver.slice(1),
		locked: target.pending.model || target.accounts.filter((account) => account.driver === driver).every((account) => account.available === false),
	})));
	const accountOptions = $derived(target.accounts.filter((account) => account.driver === target.pick.driver).map((account) => ({ value: account.id, label: account.label, locked: target.pending.model || account.available === false })));
	function selectHarness(driver: ProviderDriverKind) {
		const available = target.accounts.filter((account) => account.driver === driver && account.available !== false);
		const account = available.find((account) => account.isDefault) ?? available[0];
		if (account) target.selectAccount(account.id);
	}
	const selectParameter = selection.selectParameter;
	const scopedGroups = $derived(target.catalog);
	const filteredGroups = $derived.by(() => {
		const query = searchQuery.trim().toLowerCase();
		if (!query && !filterModel) return scopedGroups;
		return scopedGroups
			.map((g) => ({
				provider: g.provider,
				models: g.models.filter(
					(m) =>
						(!filterModel || filterModel(m)) &&
						stripDateSuffix(formatModelName(m)).toLowerCase().includes(query),
				),
			}))
			.filter((g) => g.models.length > 0);
	});

	function isActiveModel(model: Immutable<ModelInfo>): boolean {
		return modelMatchesId(model, activeModelId);
	}

	function providerSectionClass(group: Immutable<ProviderGroup>): string {
		const base = "model-provider";
		if (!isProviderConfigured(group.provider)) {
			return `${base} model-provider-disabled opacity-45`;
		}
		return base;
	}

	function modelItemClass(model: Immutable<ModelInfo>): string {
		const base = "model-item flex-1 leading-[1.4]";
		return isActiveModel(model) ? `${base} model-item-active` : base;
	}

	function handleModelClick(model: Immutable<ModelInfo>, e: MouseEvent, modelId?: string) {
		e.stopPropagation();
		if (target.pending.model) return;
		const targetId = modelId ?? model.id;
		target.selectModel({
			modelId: targetId,
			providerId: model.provider,
		});
		view = "root";
	}

</script>

		<div class="flex shrink-0 items-center gap-[6px] px-[10px] pt-[8px] pb-[6px]">
			{#if view !== "root"}
				<Button
					bind:element={backEl}
					variant="ghost"
					size="content"
					iconOnly
					icon="chevron-left"
					iconSize={16}
					ariaLabel="Back"
					data-testid="picker-back"
					class="h-7 w-7 rounded-lg"
					onclick={() => { view = "root"; searchQuery = ""; }}
				/>
			{/if}
			<h2 id={titleId} class="text-[12px] font-semibold text-text">{title}</h2>
			{#if view === "root"}{@render subtitle?.()}{/if}
		</div>
		<div class="min-h-0 overflow-y-auto">
			{#if view === "root"}
				{#if accountControls}{@render accountControls()}{:else}
					{#if harnesses.length > 0}
						<section data-testid="picker-harness-section" aria-label="Harness" class="pb-[6px]">
							<div class="flex items-center justify-between px-[10px] pt-[8px] pb-[6px] text-[12px] font-medium text-text-muted"><span>Harness</span></div>
							<OptionRow variant="joined" options={harnesses} value={target.pick.driver ?? ""} onChange={selectHarness} label="Harness" itemWidth={104} testId="picker-harness-options" itemTestId={(driver) => `picker-harness-${driver}`} class="mx-[4px]">
								{#snippet item(option)}<HarnessLogo driver={option.value} instanceId={target.accounts.find((account) => account.driver === option.value && account.isDefault)?.id} size={18} />{option.label}{/snippet}
							</OptionRow>
						</section>
					{/if}
					{#if accountOptions.length > 0}
						<section data-testid="picker-account-section" tabindex="-1" aria-label="Account" class="pb-[6px] outline-none">
							<div class="flex items-center justify-between px-[10px] pt-[8px] pb-[6px] text-[12px] font-medium text-text-muted"><span>Account</span></div>
							<OptionRow variant="cards" options={accountOptions} value={target.pick.account ?? ""} onChange={target.selectAccount} label="Account" itemWidth={108} testId="picker-account-options" itemTestId={(id) => `picker-account-${id}`} class="mx-[4px] gap-[6px] pt-[2px] pb-[6px]">
								{#snippet item(option)}<span class="picker-account-card" data-option-card>{option.label}</span>{/snippet}
							</OptionRow>
						</section>
						<div aria-hidden="true" class="mx-[8px] my-[4px] h-px bg-border-chip opacity-70"></div>
					{/if}
				{/if}
				<Button
					variant="picker-row"
					size="content"
					layout="flow"
					data-testid="picker-row-model"
					disabled={target.pending.model}
					onclick={() => { view = "model"; }}
				>
					<Icon name="zap" size={16} class="shrink-0 text-text-muted" />
					<span class="flex-1">Model</span>
					<span class="min-w-0 truncate text-text-secondary">{displayName}</span>
					<Icon name="chevron-right" size={13} class="shrink-0 text-text-muted" />
				</Button>
				{#if parameterContext || contextLabel}
					<div data-testid="picker-row-context" tabindex="-1" class="flex min-h-[36px] flex-wrap items-center gap-[10px] px-[10px] py-[6px] text-[13.5px] max-md:min-h-[50px]">
						<Icon name="gauge" size={16} class="shrink-0 text-text-muted" />
						<span class="flex-1">Context</span>
						{#if contextSegments.length > 1}
							<SegmentedControl
								bind:value={() => parameterContext?.value ?? selectedContext?.value ?? "", (value) => parameterContext ? selectParameter(parameterContext.id, value) : target.selectContextWindow(contextOptions.find((option) => option.value === value) ?? null)}
								options={contextSegments}
								variant="joined"
								class="flex-wrap"
								label="Context window"
							/>
						{:else}
							<span class="min-w-0 text-text-secondary">{contextLabel}</span>
						{/if}
						{@render contextUsage?.()}
					</div>
				{/if}
				{#if parameters ? parameterEffort : effortSegments.length > 0 || storedEffortLabel}
					<div data-testid="picker-row-effort" aria-disabled={effortSegments.length === 0 || undefined} tabindex="-1" class="flex min-h-[36px] flex-wrap items-center gap-[10px] px-[10px] py-[6px] text-[13.5px] max-md:min-h-[50px]">
						<Icon name="settings-2" size={16} class="shrink-0 text-text-muted" />
						<span class="flex-1">Effort</span>
						{#if effortSegments.length > (parameters ? 1 : 0)}
							<SegmentedControl
								bind:value={() => parameterEffort?.value ?? target.pick.effort ?? "", (value) => parameterEffort ? selectParameter(parameterEffort.id, value) : target.selectEffort(value)}
								options={effortSegments}
								variant="joined"
								class="flex-wrap"
								label="Effort"
							/>
						{:else}
							<span class="min-w-0 text-text-secondary">{parameterEffort?.label ?? storedEffortLabel ?? target.pick.effort}</span>
						{/if}
					</div>
				{/if}
				{#each parameterToggles as row (row.id)}
					<div data-testid="picker-row-{row.kind}" tabindex="-1" class="flex min-h-[36px] flex-wrap items-center gap-[10px] px-[10px] py-[6px] text-[13.5px] max-md:min-h-[50px]">
						<Icon name={row.kind === "thinking" ? "brain" : "zap"} size={16} class="shrink-0 text-text-muted" />
						<span class="flex-1">{row.kind === "thinking" ? "Thinking" : "Fast"}</span>
						{#if row.options.length > 1}
							<SegmentedControl
								bind:value={() => row.value, (value) => selectParameter(row.id, value)}
								options={row.options}
								variant="joined"
								class="flex-wrap"
								label={row.kind === "thinking" ? "Thinking" : "Fast"}
							/>
						{:else}
							<span class="min-w-0 text-text-secondary">{row.label}</span>
						{/if}
					</div>
				{/each}
				{@render rootExtras?.()}
			{:else if view !== "model"}
				{@render extraView?.()}
			{:else}
				<div class="mx-[10px] flex items-center gap-2 border-b border-border py-2.5 text-text-muted">
					<Icon name="search" size={13} class="shrink-0" />
					<TextInput
						bind:element={searchEl}
						data-testid="model-picker-search"
						bind:value={searchQuery}
						chrome="focus-only"
						size="content"
						aria-label="Search {selectedLabel} models"
						placeholder="Search {selectedLabel} models…"
						class="min-w-0 flex-1 text-[13px] text-text font-sans placeholder:text-text-dimmer"
					/>
					{@render modelToolbar?.()}
				</div>
				<div data-testid="model-picker-list" class="py-1.5" aria-busy={target.inventory.loading}>
					{@render modelNotice?.()}
					{#if target.inventory.loading}
						<div class="model-empty px-1 py-4 text-center text-base text-text-dimmer">Loading models…</div>
					{:else if filteredGroups.length === 0}
						<div class="model-empty px-1 py-4 text-center text-base text-text-dimmer">{searchQuery.trim() ? "No models match" : "No models available"}</div>
					{:else}
						{#each filteredGroups as group (group.provider.id)}
							<div class={providerSectionClass(group)} role="group" aria-labelledby="{groupHeadingId}-{group.provider.id}">
								<div id="{groupHeadingId}-{group.provider.id}" class="model-provider-header px-[10px] py-2 text-[12px] font-medium text-text-muted">
									{group.provider.name || group.provider.id}{#if !isProviderConfigured(group.provider)}<span class="font-normal normal-case tracking-normal">{" (not configured)"}</span>{/if}
								</div>
								{#each group.models as model (model.id)}
									{@const cost = formatCost(model.cost)}
									{@const windows = modelContextLabel(model)}
									<div class="flex items-center gap-1">
										<Button
											variant="picker-row"
											size="content"
											layout="flow"
											class={modelItemClass(model)}
											data-model-id={model.id}
											data-provider-id={model.provider}
											disabled={target.pending.model}
											aria-current={isActiveModel(model) ? "true" : undefined}
											onclick={(e) => handleModelClick(model, e)}
										>
											<Icon name="zap" size={16} class="shrink-0 text-text-muted" />
											<span class="model-item-name min-w-0 flex-1">
												{stripDateSuffix(formatModelName(model))}
												{@render modelLabelSuffix?.(model)}
											</span>
											{#if windows || cost}
												<span class="min-w-0 text-right font-mono text-[10.5px] font-normal text-text-muted">
													{#if windows}<span class="model-item-context block">{windows}</span>{/if}
													{#if cost}<span class="model-item-cost block">{cost}</span>{/if}
												</span>
											{/if}
											{#if isActiveModel(model)}<Icon name="check" size={16} class="model-check shrink-0 text-accent" />{/if}
										</Button>
										{#if model.routingOptions}
											<span class="model-routing flex shrink-0 flex-wrap items-center gap-0.5">
												{#each model.routingOptions as option (option.value)}
											{@const routed = option.value === target.pick.modelId}
													<Button
														variant="toolbar"
														size="content"
														class="rounded px-1.5 py-0.5 text-xs duration-100 {routed ? 'bg-bg font-semibold' : 'hover:bg-bg hover:text-text-secondary'}"
														title="Route via {option.label}{option.isDefault ? ' (default)' : ''}"
														data-routing-value={option.value}
														disabled={target.pending.model}
														data-active={routed ? "" : undefined}
														onclick={(e) => handleModelClick(model, e, option.value)}
													>{option.label}</Button>
												{/each}
											</span>
										{/if}
										{@render modelAction?.(model)}
									</div>
								{/each}
							</div>
						{/each}
					{/if}
					{@render modelFooter?.()}
				</div>
			{/if}
		</div>
