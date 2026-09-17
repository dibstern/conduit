<!-- ─── Instance Model Picker ───────────────────────────────────────────────── -->
<!-- Composer trigger carrying the selected harness-instance icon + model name. -->
<!-- Opens an upward popover: 48px instance rail (left) + search & model rows   -->
<!-- (right). Selecting a rail instance sets the session harness draft and      -->
<!-- re-scopes both the model list and the agent list. Once a session exists    -->
<!-- the harness is fixed: non-bound instances render disabled (locked mode).   -->

<script lang="ts">
	import Icon from "../ui/Icon.svelte";
	import Button from "../ui/Button.svelte";
	import Tooltip from "../ui/Tooltip.svelte";
	// biome-ignore lint/style/useImportType: ContextWindowSelector is used as a value for bind:this
	import ContextWindowSelector from "./ContextWindowSelector.svelte";
	// biome-ignore lint/style/useImportType: ModelVariant is used as a value for bind:this
	import ModelVariant from "./ModelVariant.svelte";
	import { dismiss } from "../../actions/use-dismiss.svelte.js";
	import {
		applyGetModelsResponse,
		applyGetAgentsResponse,
		discoveryState,
		getActiveModel,
		getAvailableInstances,
		getEffectiveInstanceId,
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
	import Surface from "../ui/Surface.svelte";
	import TextInput from "../ui/TextInput.svelte";

	// ─── State ──────────────────────────────────────────────────────────────────

	let pickerOpen = $state(false);
	let searchQuery = $state("");
	let favoritesOnly = $state(false);
	let variantRef: ModelVariant | undefined = $state();
	let searchEl: HTMLInputElement | undefined = $state();
	let contextWindowRef: ContextWindowSelector | undefined = $state();

	// Prefix for the per-provider heading ids that each group's
	// `aria-labelledby` points at. One base id per component instance, suffixed
	// with the provider id, because the picker can mount more than once.
	const groupHeadingId = $props.id();

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

	/**
	 * The one control in this file still hand-rolling its own recipe, and
	 * deliberately so. `ui/Button`'s only borderless-dim variant is `toolbar`,
	 * which hard-sets `text-text-dimmer` -- and a call-site `text-text` loses to
	 * it on stylesheet order, so the primary label of a menu row would come out
	 * dimmed. `items-baseline` loses to the base `items-center` the same way, and
	 * the cost column is a smaller type size that is baseline-aligned on purpose.
	 *
	 * What this actually wants is `ui/MenuItem`, which cannot be used here: it
	 * renders a Bits `DropdownMenu.Item` and needs a menu context this
	 * hand-rolled popover does not provide. Tracked as a design-system gap
	 * rather than papered over with `!` overrides (conduit-test-de3.35.6).
	 */
	/**
	 * `text-accent` on the active row is deleted, not ported: `.text-text` is
	 * emitted at byte 59336 and `.text-accent` at 57412, so `tone="default"`
	 * has always won and the row has never been accent-coloured. The
	 * `.model-item-active` hook stays -- test/visual/instance-model-picker
	 * locates the active row through it -- and the accent checkmark inside the
	 * row is a separate element that does render.
	 */
	function modelItemClass(model: ModelInfo): string {
		const base =
			"model-item flex items-baseline justify-between gap-2 w-full py-1.5 px-3.5 m-0 text-base text-left duration-100 leading-[1.4]";
		return isActiveModel(model) ? `${base} model-item-active` : base;
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
	}

	function handleInstanceSelect(instance: InstanceOption, e: MouseEvent) {
		e.stopPropagation();
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
					discoveryState.availableVariants = [...response.variants];
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
					discoveryState.availableVariants = [...response.variants];
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

	// Replaces the `autofocus` attribute the search input used to carry; see the
	// comment on that input for why the attribute is inert here.
	$effect(() => {
		if (pickerOpen) searchEl?.focus();
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

<div id="model-display" class="relative inline-flex items-center" use:dismiss={{ onDismiss: closePicker, escape: false, enabled: pickerOpen }}>
	<!-- Trigger: selected instance icon + current model name -->
	<!-- `toolbar` is the variant whose recipe this already was: borderless,
	     transparent, dim, with a hover step. Its own `text-text-dimmer` and
	     `hover:text-text` are overridden additively here, which works only
	     because `.text-text-muted` and `.hover:text-text-secondary` are both
	     emitted AFTER them in the built stylesheet. Every override in this file
	     was checked that way rather than assumed: Tailwind's emission order is
	     not alphabetical, and collisions within one family resolve in opposite
	     directions (conduit-test-de3.35.6).

	     Button's default `align="center"` is harmless despite `max-w-[200px]`:
	     the label span shrinks and ellipsises before the button reaches its cap,
	     so the free space justify would distribute is never non-zero. -->
	<Button
		variant="toolbar"
		size="content"
		data-testid="model-picker-trigger"
		data-instance-id={selectedId}
		class="model-btn gap-1.5 h-9 px-2 text-text-muted text-xs font-medium duration-150 rounded-[10px] max-w-[200px] max-sm:max-w-[130px] hover:bg-bg-alt hover:text-text-secondary font-brand {hasModel ? '' : 'opacity-50'}"
		title="Switch model"
		aria-expanded={pickerOpen}
		aria-controls={pickerOpen ? "model-picker" : undefined}
		onclick={togglePicker}
	>
		{@render driverIcon(selectedDriver, 18, selectedInstance?.isCustom ?? false)}
		<span class="model-label overflow-hidden text-ellipsis whitespace-nowrap">
			{displayName}
		</span>
		<Icon name="chevron-down" size={10} class="shrink-0 opacity-50" />
	</Button>

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

	<!-- Upward popover: instance rail + model list -->
	{#if pickerOpen}
		<Surface
			variant="raised"
			radius="none"
			elevation="menu-lg"
			id="model-picker"
			data-testid="model-picker"
			class="model-dropdown absolute bottom-[calc(100%+8px)] right-0 w-[404px] max-w-[90vw] h-[376px] max-sm:fixed max-sm:inset-x-2 max-sm:bottom-2 max-sm:w-auto max-sm:max-w-none max-sm:h-[70vh] flex flex-row overflow-hidden rounded-[14px] z-[var(--z-popover)] font-brand"
		>
			<!-- 48px instance rail -->
			<div
				data-testid="model-picker-rail"
				class="w-12 flex-none border-r border-border bg-bg flex flex-col gap-1 p-1 overflow-y-auto"
			>
				<!-- `data-active` rather than a conditional `text-accent` class: the variant
				     has to own both colour states, because a call-site `text-accent` LOSES to
				     `toolbar`'s own `text-text-dimmer` on stylesheet order. The unlit
				     `text-text-secondary` is passed additively because that one WINS. Same
				     rule, opposite outcome.

				     It carried `aria-pressed` but no accessible name: the only label was a
				     `title`, which is not reliably announced. -->
				<Button
					variant="toolbar"
					size="content"
					iconOnly
					icon="star"
					iconSize={14}
					ariaLabel="Favorites"
					data-testid="picker-favorites"
					data-active={favoritesOnly ? "" : undefined}
					class="h-10 flex-none border-0 border-b border-solid border-border mb-0.5 rounded-lg hover:bg-bg-alt {favoritesOnly ? '' : 'text-text-secondary'}"
					title="Favorites"
					aria-pressed={favoritesOnly}
					onclick={(e) => {
						e.stopPropagation();
						favoritesOnly = !favoritesOnly;
					}}
				/>
				{#each instances as instance (instance.id)}
					{@const disabled = isInstanceDisabled(instance)}
					{@const selected = instance.id === selectedId}
					<!-- The disabled dimming is deliberately NOT passed on. Button's base already
					     carries `aria-disabled:opacity-50`, and a variant utility beats the call
					     site, so the old `opacity-[0.38]` would have lost silently. Letting the
					     primitive own it moves locked-mode instances from Material's 0.38 to the
					     design system's own disabled step.

					     `ariaLabel` is the same string the tooltip shows, and the repetition
					     is deliberate. The button's only content is a one-letter harness
					     glyph, so without it the accessible name is "C". The tooltip is an
					     `aria-describedby` DESCRIPTION, which never substitutes for a name --
					     drop the label and a screen reader announces the button as "C". -->
					<!-- ui/Tooltip renders no wrapper element of its own -- Bits'
					     Provider and Root are context-only and the Trigger uses the
					     `child` snippet -- so the Button stays a direct flex child of
					     the rail and the layout is untouched. -->
					<Tooltip side="right">
						{#snippet trigger({ props })}
							<Button
								{...props}
								variant="toolbar"
								size="content"
								ariaLabel={instanceTooltip(instance)}
								data-testid="picker-instance-{instance.id}"
								data-driver={instance.driver}
								aria-pressed={selected}
								ariaDisabled={disabled}
								class="relative h-10 flex-none rounded-lg {disabled ? '' : 'hover:bg-bg-alt'}"
								onclick={(e) => handleInstanceSelect(instance, e)}
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
							</Button>
						{/snippet}
						{instanceTooltip(instance)}
					</Tooltip>
				{/each}
			</div>

			<!-- Search + scoped model rows -->
			<div class="flex-1 flex flex-col min-w-0">
				<div
					class="flex items-center gap-2 py-2.5 px-3.5 border-b border-border text-text-dimmer"
				>
					<Icon name="search" size={13} class="shrink-0" />
					<!-- `chrome="focus-only"` rather than `bare`: the bordered row around
					     this field is the affordance for where it sits, but it says nothing
					     about whether the field has focus, and this input is the first thing
					     the popover focuses. A keyboard user Tabbing back to it from the model
					     rows had no way to tell the search box was live
					     (conduit-test-de3.35.9.3). `focus-only` keeps the chromeless rest state
					     and adds an inset outline only under :focus-visible.

					     `aria-label` because the only name this field has is its placeholder,
					     which disappears the moment anyone types.

					     Focus is taken in an effect rather than with an `autofocus` attribute,
					     which is what this was and which never worked. Per the HTML spec an
					     autofocus candidate is ignored once the top document's
					     autofocus-processed flag is set, i.e. for anything inserted after load,
					     and this input lives inside an `if` block. Svelte does not special-case
					     the attribute the way React does, so opening the picker and typing did
					     nothing. The Open story now asserts focus, so it cannot regress. -->
					<TextInput
						bind:element={searchEl}
						data-testid="model-picker-search"
						bind:value={searchQuery}
						chrome="focus-only"
						size="content"
						aria-label="Search {selectedLabel} models"
						placeholder="Search {selectedLabel} models…"
						class="flex-1 min-w-0 text-text text-[13px] font-brand placeholder:text-text-dimmer"
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
							<!-- `role="group"` + `aria-labelledby`, not `role="listbox"`: these rows
							     are Tab-focusable buttons and some carry sibling routing buttons
							     inside the row, both of which are illegal inside a listbox option.
							     A group is what this genuinely is -- a run of controls under a
							     heading -- and it makes the provider name part of every row's
							     announced context rather than a visual-only divider
							     (conduit-test-de3.35.9.3). -->
							<div
								class={providerSectionClass(group)}
								role="group"
								aria-labelledby="{groupHeadingId}-{group.provider.id}"
							>
								<div
									id="{groupHeadingId}-{group.provider.id}"
									class="model-provider-header py-2 px-3.5 pt-2 text-sm font-semibold uppercase tracking-[0.5px] text-text-dimmer"
								>
									{group.provider.name || group.provider.id}<!--
										Was a `.model-provider-disabled .model-provider-header::after`
										recipe in style.css. Pseudo-element `content` is invisible to
										text selection and to translation, and screen-reader support
										for it is inconsistent, so the string belongs in the markup.
										The span restates the three declarations the rule used to
										reset, so it renders identically.
									-->{#if !isProviderConfigured(group.provider)}<span
											class="font-normal normal-case tracking-normal"
											>{" (not configured)"}</span
										>{/if}
								</div>
								{#each group.models as model (model.id)}
									{@const cost = formatCost(model.cost)}
									<div class="flex items-center">
										<!--
											`layout="flow"` because this row aligns on the text
											baseline, not the box centre: the default `center`
											emits `items-center` at byte 29745, which outranks a
											consumer `items-baseline` at 29708. Under `flow` the
											call site keeps the whole box, `justify-between`
											included.
										-->
										<Button
											variant="ghost"
											size="content"
											layout="flow"
											tone="default"
											hoverFill="base"
											class={modelItemClass(model)}
											data-model-id={model.id}
											data-provider-id={model.provider}
											aria-current={isActiveModel(model) ? "true" : undefined}
											onclick={(e) => handleModelClick(model, e)}
										>
											<span class="model-item-name flex-1 whitespace-nowrap">
												{#if isActiveModel(model)}
													<!-- aria-hidden: `aria-current` on the button carries the state.
													     Audible, this reads as a literal check character or, in some
													     screen readers, as nothing at all. -->
													<span
														class="model-check text-accent font-bold mr-0.5"
														aria-hidden="true">&#10003;</span
													>
												{/if}
												{stripDateSuffix(formatModelName(model))}
												{#if isDefaultModel(model)}
													<span class="ml-1 text-xs text-text-dimmer font-normal"
														>(default)</span
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
										</Button>
										{#if model.routingOptions}
											<span class="model-routing flex items-center gap-0.5 shrink-0 mr-1">
												{#each model.routingOptions as option (option.value)}
													{@const routed = option.value === discoveryState.currentModelId}
													<Button
														variant="toolbar"
														size="content"
														class="px-1.5 py-0.5 text-xs rounded duration-100 {routed ? 'bg-bg font-semibold' : 'hover:bg-bg hover:text-text-secondary'}"
														title="Route via {option.label}{option.isDefault ? ' (default)' : ''}"
														data-routing-value={option.value}
														data-active={routed ? "" : undefined}
														onclick={(e) => handleModelClick(model, e, option.value)}
													>
														{option.label}
													</Button>
												{/each}
											</span>
										{/if}
										{#if !isDefaultModel(model)}
											<Button
												variant="toolbar"
												size="content"
												iconOnly
												icon="star"
												iconSize={12}
												ariaLabel={`Set ${formatModelName(model)} as default model`}
												class="shrink-0 px-1.5 py-1 mr-1 text-xs rounded duration-100 hover:bg-bg hover:text-text-secondary"
												title="Set as default model"
												onclick={(e) => handleSetDefault(model, e)}
											/>
										{:else}
											<span
												class="shrink-0 px-1.5 py-1 mr-1 text-text [&>svg]:fill-current"
												title="Default model"
											>
												<Icon name="star" size={12} />
												<span class="sr-only">Default model</span>
											</span>
										{/if}
									</div>
								{/each}
							</div>
						{/each}
					{/if}

					<!-- Reload footer -->
					<div class="model-reload-footer border-t border-border mt-1 pt-1">
						<Button
							variant="toolbar"
							size="content"
							align="start"
							class="reload-btn w-full gap-2 py-1.5 px-3.5 text-sm text-left duration-100 hover:bg-bg hover:text-text-secondary"
							title="Reload skills and commands from disk"
							onclick={handleReload}
						>
							<Icon name="refresh-cw" size={12} />
							<span>Reload skills &amp; commands</span>
						</Button>
					</div>
				</div>
			</div>
		</Surface>
	{/if}
</div>
