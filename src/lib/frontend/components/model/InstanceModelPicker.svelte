<!-- Harness tabs and model options: a phone sheet or a desktop drop-up. -->

<script lang="ts">
	import { onDestroy, tick, untrack } from "svelte";
	import type { ProviderDriverKind } from "../../../contracts/provider-instance.js";
	import Icon from "../ui/Icon.svelte";
	import HarnessLogo from "./HarnessLogo.svelte";
	import HandoffDialog from "../overlays/HandoffDialog.svelte";
	import Button from "../ui/Button.svelte";
	import Dialog from "../ui/Dialog.svelte";
	import SegmentedControl from "../ui/SegmentedControl.svelte";
	import OptionRow from "../ui/OptionRow.svelte";
	import AccountDot from "../ui/AccountDot.svelte";
	// biome-ignore lint/style/useImportType: ModelVariant is used as a value for bind:this
	import ModelVariant from "./ModelVariant.svelte";
	import { dismiss } from "../../actions/use-dismiss.svelte.js";
	import {
		model as composerModel,
		contextWindow,
		effort,
	} from "../../stores/composer-settings.svelte.js";
	import {
		applyDefaultModelSet,
		applyGetModelsResponse,
		chooseAgent,
		chooseDefaultModel,
		discoveryState,
		formatAgentLabel,
		getActiveAgent,
		getActiveModel,
		modelMatchesId,
		getVisibleAgents,
		getAvailableInstances,
		getEffectiveInstanceId,
		getProviderGroupsForInstance,
		getSessionInstanceId,
		formatModelName,
		type InstanceOption,
		isProviderConfigured,
	} from "../../stores/discovery.svelte.js";
	import { currentChat } from "../../stores/chat.svelte.js";
	import { composerPreferences, isContextWarning } from "../../stores/composer-preferences.svelte.js";
	import { composerPickerState, openPicker, type PickerSection } from "../../stores/composer-picker.svelte.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { composerAccountId } from "../../stores/usage.svelte.js";
	import { getClaudeAccounts, type AccountAvailability } from "../../stores/claude-accounts.svelte.js";
	import { instanceStatusColor } from "../../stores/instance.svelte.js";
	import { accountColorClass } from "../../utils/account-color.js";
	import { usageResetTime } from "../../utils/continuation.js";
	import { bindProjectInstance, getDraftProject, projectState } from "../../stores/project.svelte.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { findSession, reloadProviderSession, sessionState } from "../../stores/session.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import {
		getModelsRpc,
		setDefaultModelRpc,
		switchAgentRpc,
	} from "../../transport/ws-rpc-client.js";
	import type { AgentInfo, Immutable, InstanceStatus, ModelCost, ModelInfo, ProviderGroup } from "../../types.js";
	import Surface from "../ui/Surface.svelte";
	import TextInput from "../ui/TextInput.svelte";

	let { variant = "icons" }: { variant?: "icons" | "words" | undefined } = $props();

	const pickerOpen = $derived(composerPickerState.request !== null);
	let view = $state<"root" | "model" | "agent">("root");
	const phone = $derived(sessionViewState.composerTier === "phone");
	let searchQuery = $state("");
	let favoritesOnly = $state(false);
	let variantRef: ModelVariant | undefined = $state();
	let searchEl: HTMLInputElement | undefined = $state();
	let triggerEl: HTMLButtonElement | HTMLAnchorElement | undefined = $state();
	let pickerTriggerEl: HTMLElement | undefined = $state();
	let backEl: HTMLButtonElement | HTMLAnchorElement | undefined = $state();
	const draftChosen = $derived(discoveryState.hasModelChoice);

	// Prefix for the per-provider heading ids that each group's
	// `aria-labelledby` points at. One base id per component instance, suffixed
	// with the provider id, because the picker can mount more than once.
	const groupHeadingId = $props.id();
	const titleId = `${groupHeadingId}-title`;
	const title = $derived(
		view === "root" ? "Harness & model" : view === "agent" ? "Agent" : "Model",
	);

	const instances = $derived(getAvailableInstances());

	/** Instance bound to the active session — non-null means locked mode. */
	const boundInstanceId = $derived(
		sessionState.currentId ? getSessionInstanceId(sessionState.currentId) : null,
	);
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
			// getSessionInstanceId resolves a session to its driver, not an instance id.
			boundInstanceId ??
			(selectedId === "claude" ? ("claude" as const) : ("opencode" as const)),
	);
	const selectedLogoInstanceId = $derived(
		sessionState.currentId
			? composerAccountId(findSession(sessionState.currentId), undefined) ?? selectedId
			: selectedId,
	);
	const harnesses = $derived(
		[...new Set(instances.map((instance) => instance.driver))].map((driver) => ({
			value: driver,
			label: driverLabel(driver),
			locked: locked && driver !== selectedDriver,
		})),
	);
	const driverInstances = $derived(instances.filter((instance) => instance.driver === selectedDriver));
	const accountProjectSlug = $derived(
		sessionState.currentId
			? findSession(sessionState.currentId)?.projectSlug ?? getCurrentSlug() ?? ""
			: getDraftProject() ?? getCurrentSlug() ?? "",
	);
	const accounts = $derived(getClaudeAccounts(accountProjectSlug));
	let presentedRequest = $state<number | undefined>();
	const handoff = $derived(accounts.pendingHandoff?.requestId === presentedRequest ? accounts.pendingHandoff : undefined);
	type AccountCard = { value: string; label: string; locked: boolean } & (
		| { kind: "usage"; availability: AccountAvailability }
		| { kind: "status"; status: InstanceStatus }
	);
	const accountCards = $derived.by<AccountCard[]>(() => {
		if (selectedDriver === "claude") {
			return accounts.accounts.map((account) => {
				// Cards show every account's own usage; only the lock depends on the open session.
				const availability = accounts.availabilityOf(account.id, "");
				return {
					value: account.id,
					label: accounts.nameOf(account.id),
					locked: availability.kind === "limited" || (locked && account.id === selectedLogoInstanceId),
					kind: "usage",
					availability,
				};
			});
		}
		return driverInstances.map((instance) => ({
			value: instance.id,
			label: accounts.nameOf(instance.id, instance.label),
			locked,
			kind: "status",
			// Built-in instances carry no managed status; they serve the catalog, so they're up.
			status: instance.status ?? "healthy",
		}));
	});

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

	const activeModelId = $derived(
		sessionState.currentId || draftChosen
			? discoveryState.currentModelId
			: discoveryState.defaultModelId,
	);
	const activeModel = $derived(
		getActiveModel(
			activeModelId,
			sessionState.currentId || draftChosen
				? discoveryState.currentProviderId
				: discoveryState.defaultProviderId,
		),
	);
	const hasModel = $derived(!!activeModelId);
	// A draft model change has no server context-info refresh. Prefer its catalog
	// so the new harness cannot inherit the previous model's window choices.
	const contextOptions = $derived(
		selectedDriver === "claude"
			? (activeModel?.contextWindowOptions ?? [])
			: activeModel?.contextWindowOptions ??
				(!sessionState.currentId && draftChosen && activeModel?.limit?.context ? [] : contextWindow.options),
	);
	const selectedContext = $derived(
		contextOptions.find((option) => option.value === contextWindow.current?.value) ??
			contextOptions.find((option) => option.isDefault) ?? contextOptions[0] ?? null,
	);
	const contextLabel = $derived(selectedContext?.label ?? modelContextLabel(activeModel));
	const contextPercent = $derived(currentChat().contextPercent);
	const contextWarning = $derived(isContextWarning(contextPercent, composerPreferences.contextWarning));
	const contextSegments = $derived(contextOptions.map((option) => ({
		value: option.value,
		label: option.label,
		testId: `picker-context-option-${option.value}`,
		disabled: contextWindow.pending,
	})));
	const effortSegments = $derived(effort.options.map((variant) => ({
		value: variant,
		label: variant === "medium" ? "med" : variant,
		testId: `picker-effort-option-${variant}`,
		disabled: effort.pending,
	})));
	$effect(() => {
		// Refetch once each turn ends.
		const endedGeneration = currentChat().endedGeneration;
		const projectSlug = getCurrentSlug();
		const sessionId = sessionState.currentId;
		if (endedGeneration < 0 || !projectSlug || !sessionId) return;

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
				(option) => option.value === activeModelId,
			);
			return scope ? `${base} · ${scope.label}` : base;
		}
		if (activeModelId) {
			return stripDateSuffix(activeModelId);
		}
		return "Select model";
	});

	/** The phone button's two-or-three letter model tag: "Sonnet 5" → S5, "GPT-6 Sol" → Sol. */
	const shortModelLabel = $derived.by(() => {
		const name = activeModel ? stripDateSuffix(formatModelName(activeModel)) : stripDateSuffix(activeModelId ?? "");
		if (!name) return "—";
		const words = (/\s/.test(name) ? name.split(/\s+/) : name.split("-")).filter((word) => !/^claude$/i.test(word));
		const index = words.findIndex((word, i) => /^[a-z]+$/i.test(word) && /^\d+(\.\d+)?$/.test(words[i + 1] ?? ""));
		const word = words[index];
		if (word) return `${word.charAt(0).toUpperCase()}${words[index + 1]}`;
		const last = words.at(-1) ?? name;
		return last.length <= 4 ? last : last.slice(0, 3);
	});

	const visibleAgents = $derived(getVisibleAgents());
	const activeAgent = $derived(getActiveAgent() ?? visibleAgents[0]);
	// Regular OpenCode Plan sessions lock the agent; Side Threads use session rules.
	const planLocked = $derived(
		selectedDriver === "opencode" &&
			!!sessionState.currentId &&
			!findSession(sessionState.currentId)?.sideThread &&
			discoveryState.permissionMode === "plan",
	);

	/** Capitalise all-lowercase agent names ("code" → "Code"). */
	function agentLabel(agent: AgentInfo): string {
		const label = formatAgentLabel(agent);
		return label === label.toLowerCase() ? label.charAt(0).toUpperCase() + label.slice(1) : label;
	}

	function handleAgentSelect(agent: AgentInfo) {
		view = "root";
		if (agent.id === activeAgent?.id) return;
		const undoAgent = chooseAgent(agent.id);
		const projectSlug = getCurrentSlug();
		const sessionId = sessionState.currentId;
		if (projectSlug && sessionId) {
			void switchAgentRpc({ projectSlug, sessionId, agentId: agent.id }).catch(undoAgent);
		}
	}

	function driverLabel(id: ProviderDriverKind): string {
		if (id === "claude") return "Claude";
		if (id === "opencode") return "OpenCode";
		return id.charAt(0).toUpperCase() + id.slice(1);
	}

	function instanceForDriver(driver: ProviderDriverKind): InstanceOption | undefined {
		const binding = projectState.projects.find((project) => project.slug === getDraftProject())?.instanceId;
		return instances.find((instance) => instance.driver === driver && instance.id === binding)
			?? instances.find((instance) => instance.driver === driver);
	}

	/** Strip date suffixes like -20250514 from model names. */
	function stripDateSuffix(name: string): string {
		return name.replace(/-\d{8}$/, "");
	}

	function modelContextLabel(model: Immutable<ModelInfo> | undefined): string {
		if (model?.contextWindowOptions?.length) {
			return model.contextWindowOptions.map((option) => option.label).join(" / ");
		}
		const limit = model?.limit?.context;
		if (!limit) return "";
		return limit >= 1_000_000 ? `${limit / 1_000_000}M` : `${Math.round(limit / 1_000)}K`;
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

	function isActiveModel(model: Immutable<ModelInfo>): boolean {
		return modelMatchesId(model, activeModelId);
	}

	function isDefaultModel(model: Immutable<ModelInfo>): boolean {
		return (
			model.id === discoveryState.defaultModelId &&
			model.provider === discoveryState.defaultProviderId
		);
	}

	function isInstanceDisabled(instance: InstanceOption): boolean {
		return locked && instance.id !== boundInstanceId;
	}

	function providerSectionClass(group: Immutable<ProviderGroup>): string {
		const base = "model-provider";
		if (!isProviderConfigured(group.provider)) {
			return `${base} model-provider-disabled opacity-45`;
		}
		return base;
	}

	function modelItemClass(model: Immutable<ModelInfo>): string {
		const base =
			"model-item flex items-center gap-2 min-w-0 flex-1 min-h-[46px] py-2.5 px-1 m-0 text-[13px] text-left duration-100 leading-[1.4]";
		return isActiveModel(model) ? `${base} model-item-active` : base;
	}

	function togglePicker(e: MouseEvent, section: PickerSection = "harness") {
		e.stopPropagation();
		pickerTriggerEl = e.currentTarget as HTMLButtonElement;
		if (pickerOpen) closePicker();
		else {
			openPicker(section);
			// Touch browsers can keep the textarea focused when a button is tapped.
			const request = composerPickerState.request;
			if (request) request.opener = pickerTriggerEl;
		}
	}

	function closePicker() {
		composerPickerState.request = null;
		(pickerTriggerEl ?? triggerEl)?.focus({ preventScroll: true });
	}

	function handleInstanceSelect(instance: InstanceOption, e?: MouseEvent) {
		e?.stopPropagation();
		if (isInstanceDisabled(instance)) return;
		view = "root";
		if (instance.id === selectedId) return;
		// The draft's harness is its project's binding, the same one the header
		// badge sets, so the two pickers cannot disagree. Binding also re-aims
		// the draft's model and agents.
		const draftProject = getDraftProject();
		if (draftProject) bindProjectInstance(draftProject, instance.id);
		searchQuery = "";
	}

	function handleHarnessSelect(driver: ProviderDriverKind) {
		if (locked) return;
		const instance = instanceForDriver(driver);
		if (instance) handleInstanceSelect(instance);
	}

	function handleAccountSelect(id: string) {
		const card = accountCards.find((card) => card.value === id);
		if (!card || card.locked) return;
		if (locked) {
			if (selectedDriver === "claude" && sessionState.currentId) {
				closePicker();
				void accounts.beginSwitch(sessionState.currentId, id, selectedLogoInstanceId);
				presentedRequest = accounts.handoff.kind === "previewing" ? accounts.handoff.requestId : undefined;
			}
			return;
		}
		const instance = instances.find((instance) => instance.id === id)
			?? (selectedDriver === "claude" && id === "claude"
				? { id, driver: "claude" as const, label: card.label, isCustom: false }
				: undefined);
		if (instance) handleInstanceSelect(instance);
	}

	function handleModelClick(model: Immutable<ModelInfo>, e: MouseEvent, modelId?: string) {
		e.stopPropagation();
		const targetId = modelId ?? model.id;
		composerModel.select({
			modelId: targetId,
			providerId: model.provider,
		});
		view = "root";
	}

	function handleSetDefault(model: Immutable<ModelInfo>, e: MouseEvent) {
		e.stopPropagation();
		const undoDefault = chooseDefaultModel({
			modelId: model.id,
			providerId: model.provider,
		});
		const projectSlug = getCurrentSlug();
		if (projectSlug) {
			void setDefaultModelRpc({
				projectSlug,
				model: model.id,
				provider: model.provider,
			})
				.then(applyDefaultModelSet)
				.catch(undoDefault);
		}
	}

	function handleReload(e: MouseEvent) {
		e.stopPropagation();
		const projectSlug = getCurrentSlug();
		const sessionId = sessionState.currentId;
		if (projectSlug && sessionId) {
			void reloadProviderSession(projectSlug, sessionId).catch(() => undefined);
		}
		showToast("Reloading skills…", { duration: 1500 });
		closePicker();
	}

	$effect(() => {
		const request = composerPickerState.request;
		if (!request) return;
		untrack(() => {
			void accounts.refreshQuotas();
			pickerTriggerEl = request.opener ?? pickerTriggerEl ?? triggerEl;
			variantRef?.close();
			searchQuery = "";
			view = request.section === "model" || request.section === "agent"
				? request.section
				: "root";
		});
	});

	$effect(() => {
		if (!pickerOpen) return;
		const section = composerPickerState.request?.section;
		const root = view === "root";
		// Phones skip the search box: focusing it would raise the keyboard over the list.
		const target = view === "model" && !phone ? searchEl : backEl;
		let cancelled = false;
		void tick().then(() => {
			if (cancelled) return;
			if (!root) {
				target?.focus({ preventScroll: true });
				return;
			}
			const panel = document.getElementById("model-picker");
			const selectedTab = panel?.querySelector<HTMLElement>('[data-testid="picker-harness-options"] [aria-checked="true"]');
			const selectedCard = panel?.querySelector<HTMLElement>('[data-testid="picker-account-options"] [aria-checked="true"]');
			const row = (section === "harness" ? selectedTab : section === "account" ? selectedCard : panel?.querySelector<HTMLElement>(
				`[data-testid="picker-row-${section}"]`,
			)) ?? selectedTab ?? selectedCard ?? panel?.querySelector<HTMLElement>('[data-testid="picker-row-model"]');
			row?.scrollIntoView({ block: "nearest", inline: "nearest" });
			row?.focus({ preventScroll: true });
		});
		return () => { cancelled = true; };
	});

	onDestroy(() => { composerPickerState.request = null; });
</script>

{#snippet pickerSurface(sheet: boolean)}
	<Surface
		variant={sheet ? "plain" : "card"}
		radius="none"
		elevation={sheet ? "modal" : "menu-lg"}
		id="model-picker"
		data-testid="model-picker"
		data-phone={sheet ? "true" : undefined}
		role={sheet ? undefined : "dialog"}
		aria-labelledby={sheet ? undefined : titleId}
		class="model-dropdown flex flex-col overflow-hidden font-brand {sheet
			? 'w-full max-h-[85dvh] rounded-t-[22px] border-t border-border px-[16px] pt-2 pb-[max(30px,env(safe-area-inset-bottom))]'
			: 'absolute bottom-[calc(100%+8px)] right-0 w-[404px] max-w-[90vw] max-h-[min(70vh,480px)] rounded-[12px] px-[12px] pt-[9px] pb-[4px] z-[var(--z-popover)]'}"
	>
		{#if sheet}
			<div class="mx-auto mb-2.5 h-1 w-9 shrink-0 rounded-full bg-border-chip" aria-hidden="true"></div>
		{/if}
		<div class="mb-[2px] flex shrink-0 items-center gap-[6px]">
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
			<h2 id={titleId} class="text-[11.5px] font-semibold text-text">{title}</h2>
			{#if view === "root"}
				<span data-testid="picker-subtitle" class="ml-auto text-[10.5px] text-text-dimmer">{locked ? "this session" : "new session"}</span>
			{/if}
		</div>
		<div class="min-h-0 overflow-y-auto">
			{#if view === "root"}
				{#if harnesses.length > 1}
					<section data-testid="picker-harness-section" aria-label="Harness" class="pb-[4px]">
						<div class="mt-[9px] mb-[5px] flex justify-between text-[10px] uppercase tracking-[0.07em] text-text-dimmer">
							<span>Harness</span>
							{#if locked}
								<span data-testid="picker-harness-caption" class="inline-flex items-center gap-[4px]">
									<Icon name="lock" size={9} /> fixed for this session
								</span>
							{/if}
						</div>
						<OptionRow
							options={harnesses}
							value={selectedDriver}
							onChange={handleHarnessSelect}
							label="Harness"
							lockedReason="Harness is fixed for this session"
							itemWidth={104}
							testId="picker-harness-options"
							itemTestId={(driver) => `picker-harness-${driver}`}
							class={harnesses.length < 4 ? "gap-[2px] rounded-[9px] border border-border p-[2px]" : ""}
							itemClass="flex h-[32px] min-w-0 items-center justify-center gap-[6px] rounded-[7px] text-[12px] text-text-muted whitespace-nowrap data-[state=checked]:bg-bg-alt data-[state=checked]:text-text data-[state=checked]:font-semibold aria-disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2"
						>
							{#snippet item(option)}
								<HarnessLogo
									driver={option.value}
									instanceId={option.value === selectedDriver ? selectedLogoInstanceId : instanceForDriver(option.value)?.id ?? option.value}
									size={14}
									surface="surface"
								/>
								{option.label}
								{#if option.locked}<Icon name="lock" size={10} />{/if}
							{/snippet}
						</OptionRow>
					</section>
				{/if}
				{#if accountCards.length > 1}
					<section data-testid="picker-account-section" aria-label={selectedDriver === "claude" ? "Account" : "Instance"} class="pb-[4px]">
						<div class="mt-[9px] mb-[5px] flex justify-between text-[10px] uppercase tracking-[0.07em] text-text-dimmer">
							<span>{selectedDriver === "claude" ? "Account" : "Instance"}</span>
							<span data-testid="picker-account-section-caption">{selectedDriver === "claude" ? "5-hour use" : "status"}</span>
						</div>
						<OptionRow
							options={accountCards}
							value={selectedLogoInstanceId}
							onChange={handleAccountSelect}
							label={selectedDriver === "claude" ? "Account" : "Instance"}
							lockedReason={selectedDriver === "claude" ? "" : "Harness is fixed for this session"}
							itemWidth={108}
							testId="picker-account-options"
							itemTestId={(id) => `picker-account-${id}`}
							class="mb-[2px] gap-[6px]"
							itemClass="block min-w-0 rounded-[9px] text-left focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2"
						>
							{#snippet item(option, selected)}
								{@const card = accountCards.find((card) => card.value === option.value)}
								{#if card}
									{@const availability = card.kind === "usage" ? card.availability : undefined}
									<span
										class="picker-account-card"
										class:selected
										class:limited={availability?.kind === "limited"}
										class:locked={card.kind === "status" && locked && !selected}
										style="--account-color:var({accountColorClass(card.value).replace('bg-', '--color-')})"
									>
										<span class="flex min-w-0 items-center gap-[6px]">
											<AccountDot instanceId={card.value} size={7} />
											<span data-testid="picker-account-name" class="min-w-0 truncate">{card.label}</span>
											{#if card.kind === "usage" && availability?.kind === "selectable"}
												<small data-testid="picker-account-usage" class="ml-auto whitespace-nowrap text-[10px] text-text-muted">{availability.usagePct === null ? "—" : `${Math.round(availability.usagePct)}%`}</small>
											{/if}
										</span>
										{#if card.kind === "status"}
											<span data-testid="picker-account-caption" class="flex items-center gap-[6px] text-[10px] text-text-muted">
												<span data-testid="picker-instance-status-dot" class="size-[7px] shrink-0 rounded-full {instanceStatusColor(card.status)}" aria-hidden="true"></span>
												{card.status}
											</span>
										{:else if availability?.kind === "limited"}
											{@const reset = usageResetTime(availability.resetsAt)}
											<span data-testid="picker-account-caption" class="text-[10px] text-error">limit{reset ? ` · resets ${reset}` : ""}</span>
										{:else if availability?.kind === "selectable" && availability.usagePct !== null}
											<span data-testid="picker-account-meter" class="block h-[4px] overflow-hidden rounded-[2px] bg-border">
												<span class="block h-full bg-[var(--account-color)]" style="width:{Math.max(0, Math.min(100, availability.usagePct))}%"></span>
											</span>
										{:else}
											<span data-testid="picker-account-caption" class="text-[10px] text-text-muted">usage unknown</span>
										{/if}
									</span>
								{/if}
							{/snippet}
						</OptionRow>
						{#if locked && selectedDriver === "claude"}
							<div data-testid="picker-account-note" class="mt-[8px] border-t border-border-subtle pt-[6px] text-[10.5px] text-text-muted">You'll see what carries over before anything changes.</div>
						{/if}
					</section>
				{/if}
				<Button
					variant="ghost"
					size="content"
					tone="default"
					hoverFill="base"
					layout="flow"
					data-testid="picker-row-model"
					class="flex min-h-[46px] w-full items-center gap-2.5 rounded-none border-b border-border-subtle px-1 py-2.5 text-left last:border-b-0"
					onclick={() => { view = "model"; }}
				>
					<span class="w-16 shrink-0 text-[11.5px] text-text-muted">Model</span>
					<span class="min-w-0 flex-1 text-[13px] font-semibold">{displayName}</span>
					<Icon name="chevron-right" size={14} class="text-text-dimmer" />
				</Button>
				{#if contextLabel}
					<div data-testid="picker-row-context" tabindex="-1" class="flex min-h-[46px] items-center gap-2.5 border-b border-border-subtle px-1 py-2.5 last:border-b-0">
						<span class="w-16 shrink-0 text-[11.5px] text-text-muted">Context</span>
						{#if contextOptions.length > 1}
							<SegmentedControl
								bind:value={() => selectedContext?.value ?? "", (value) => contextWindow.select(contextOptions.find((option) => option.value === value) ?? null)}
								options={contextSegments}
								variant="picker-context"
								label="Context window"
							/>
						{:else}
							<span class="min-w-0 flex-1 text-[13px] text-text">{contextLabel}</span>
						{/if}
						{#if contextPercent > 0}
							<span data-testid="picker-context-usage" data-warning={contextWarning ? "true" : undefined} class="shrink-0 text-[11px] {contextWarning ? 'text-status-amber' : 'text-text-muted'}">{Math.round(contextPercent)}% used</span>
						{/if}
					</div>
				{/if}
				{#if effortSegments.length > 0}
					<div data-testid="picker-row-effort" tabindex="-1" class="flex min-h-[46px] items-center gap-2.5 border-b border-border-subtle px-1 py-2.5 last:border-b-0">
						<span class="w-16 shrink-0 text-[11.5px] text-text-muted">Effort</span>
						<SegmentedControl
							bind:value={() => effort.current ?? "", (value) => effort.select(value)}
							options={effortSegments}
							variant="picker"
							label="Effort"
						/>
					</div>
				{/if}
				{#if planLocked}
					<div data-testid="picker-row-agent" data-locked="plan" class="flex min-h-[46px] items-center gap-2.5 px-1 py-2.5">
						<span class="w-16 shrink-0 text-[11.5px] text-text-muted">Agent</span>
						<span class="min-w-0 flex-1 truncate text-[13px] text-text">Plan</span>
						<span class="shrink-0 text-[11px] text-text-dimmer">Set by approvals</span>
					</div>
				{:else if visibleAgents.length > 1}
					<Button
						variant="ghost"
						size="content"
						tone="default"
						hoverFill="base"
						layout="flow"
						data-testid="picker-row-agent"
						class="flex min-h-[46px] w-full items-center gap-2.5 rounded-none border-b border-border-subtle px-1 py-2.5 text-left last:border-b-0"
						onclick={() => { view = "agent"; }}
					>
						<span class="w-16 shrink-0 text-[11.5px] text-text-muted">Agent</span>
						<span class="min-w-0 flex-1 truncate text-[13px] font-semibold">{activeAgent ? agentLabel(activeAgent) : "Default"}</span>
						<Icon name="chevron-right" size={14} class="text-text-dimmer" />
					</Button>
				{:else if activeAgent}
					<div data-testid="picker-row-agent" class="flex min-h-[46px] items-center gap-2.5 px-1 py-2.5">
						<span class="w-16 shrink-0 text-[11.5px] text-text-muted">Agent</span>
						<span class="min-w-0 flex-1 truncate text-[13px] text-text">{agentLabel(activeAgent)}</span>
					</div>
				{/if}
			{:else if view === "agent"}
				{#each visibleAgents as agent (agent.id)}
					{@const selected = agent.id === activeAgent?.id}
					<Button
						variant="ghost"
						size="content"
						tone={selected ? "accent" : "default"}
						hoverFill="base"
						layout="flow"
						aria-pressed={selected}
						data-testid="picker-agent-{agent.id}"
						class="flex min-h-[46px] w-full items-center gap-2.5 rounded-none border-b border-border-subtle px-1 py-2.5 text-left last:border-b-0"
						onclick={() => handleAgentSelect(agent)}
					>
						<span class="min-w-0 flex-1">
							<span class="block text-[13px] font-semibold">{agentLabel(agent)}</span>
							{#if agent.description}<span class="block text-[11px] text-text-muted">{agent.description}</span>{/if}
						</span>
						{#if selected}<Icon name="check" size={16} class="text-accent" />{/if}
					</Button>
				{/each}
			{:else}
				<div class="flex items-center gap-2 border-b border-border py-2.5 text-text-dimmer">
					<Icon name="search" size={13} class="shrink-0" />
					<TextInput
						bind:element={searchEl}
						data-testid="model-picker-search"
						bind:value={searchQuery}
						chrome="focus-only"
						size="content"
						aria-label="Search {selectedLabel} models"
						placeholder="Search {selectedLabel} models…"
						class="min-w-0 flex-1 text-[13px] text-text font-brand placeholder:text-text-dimmer"
					/>
					<Button
						variant="toolbar"
						size="content"
						iconOnly
						icon="star"
						iconSize={14}
						ariaLabel="Favorites"
						data-testid="picker-favorites"
						data-active={favoritesOnly ? "" : undefined}
						aria-pressed={favoritesOnly}
						title="Favorites"
						class="h-7 w-7 rounded-lg"
						onclick={() => { favoritesOnly = !favoritesOnly; }}
					/>
				</div>
				<div data-testid="model-picker-list" class="py-1.5">
					{#if locked}
						<div class="my-1.5 flex items-start gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-[11px] leading-[1.4] text-text-dimmer">
							<Icon name="lock" size={12} class="shrink-0" />
							<span>Harness fixed at creation — showing <b class="font-semibold text-text-secondary">{selectedLabel}</b> only. Model switching within it is allowed.</span>
						</div>
					{/if}
					{#if filteredGroups.length === 0}
						<div class="model-empty px-1 py-4 text-center text-base text-text-dimmer">{searchQuery.trim() ? "No models match" : "No models available"}</div>
					{:else}
						{#each filteredGroups as group (group.provider.id)}
							<div class={providerSectionClass(group)} role="group" aria-labelledby="{groupHeadingId}-{group.provider.id}">
								<div id="{groupHeadingId}-{group.provider.id}" class="model-provider-header px-1 py-2 text-sm font-semibold uppercase tracking-[0.5px] text-text-dimmer">
									{group.provider.name || group.provider.id}{#if !isProviderConfigured(group.provider)}<span class="font-normal normal-case tracking-normal">{" (not configured)"}</span>{/if}
								</div>
								{#each group.models as model (model.id)}
									{@const cost = formatCost(model.cost)}
									{@const windows = modelContextLabel(model)}
									<div class="flex items-center gap-1 border-b border-border-subtle last:border-b-0">
										<Button
											variant="ghost"
											size="content"
											layout="flow"
											tone={isActiveModel(model) ? "accent" : "default"}
											hoverFill="base"
											class={modelItemClass(model)}
											data-model-id={model.id}
											data-provider-id={model.provider}
											aria-current={isActiveModel(model) ? "true" : undefined}
											onclick={(e) => handleModelClick(model, e)}
										>
											<span class="model-item-name min-w-0 flex-1 font-semibold">
												{stripDateSuffix(formatModelName(model))}
												{#if isDefaultModel(model)}<span class="ml-1 text-xs font-normal text-text-dimmer">(default)</span>{/if}
											</span>
											{#if windows || cost}
												<span class="min-w-0 text-right text-[11px] font-normal text-text-muted">
													{#if windows}<span class="model-item-context block">{windows}</span>{/if}
													{#if cost}<span class="model-item-cost block">{cost}</span>{/if}
												</span>
											{/if}
											{#if isActiveModel(model)}<Icon name="check" size={16} class="model-check shrink-0 text-accent" />{/if}
										</Button>
										{#if model.routingOptions}
											<span class="model-routing flex shrink-0 flex-wrap items-center gap-0.5">
												{#each model.routingOptions as option (option.value)}
											{@const routed = option.value === discoveryState.currentModelId}
													<Button
														variant="toolbar"
														size="content"
														class="rounded px-1.5 py-0.5 text-xs duration-100 {routed ? 'bg-bg font-semibold' : 'hover:bg-bg hover:text-text-secondary'}"
														title="Route via {option.label}{option.isDefault ? ' (default)' : ''}"
														data-routing-value={option.value}
														data-active={routed ? "" : undefined}
														onclick={(e) => handleModelClick(model, e, option.value)}
													>{option.label}</Button>
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
												class="shrink-0 rounded px-1.5 py-1 text-xs duration-100 hover:bg-bg hover:text-text-secondary"
												title="Set as default model"
												onclick={(e) => handleSetDefault(model, e)}
											/>
										{:else}
											<span class="shrink-0 px-1.5 py-1 text-text [&>svg]:fill-current" title="Default model">
												<Icon name="star" size={12} />
												<span class="sr-only">Default model</span>
											</span>
										{/if}
									</div>
								{/each}
							</div>
						{/each}
					{/if}
					<div class="mt-1 border-t border-border pt-1">
						<Button
							variant="toolbar"
							size="content"
							class="flex w-full items-center justify-center gap-1.5 px-3 py-1.5 text-xs duration-100 hover:bg-bg hover:text-text-secondary"
							title="Reload skills and commands from disk"
							onclick={handleReload}
						>
							<Icon name="refresh-cw" size={12} />
							<span>Reload skills &amp; commands</span>
						</Button>
					</div>
				</div>
			{/if}
		</div>
	</Surface>
{/snippet}

<div
	id="model-display"
	class="relative inline-flex min-w-0 items-center {variant === 'words' ? 'gap-px' : ''}"
	use:dismiss={{ onDismiss: closePicker, enabled: pickerOpen && !phone }}
>
	{#if variant === "words"}
		<Button
			bind:element={triggerEl}
			variant="ghost"
			size="content"
			tone="muted"
			hoverFill="none"
			data-testid="composer-word-model"
			data-instance-id={selectedId}
			class="min-w-0 gap-[5px] rounded-md px-[5px] py-[2px] text-[11.5px] font-normal font-brand max-w-[200px] max-sm:max-w-[130px] overflow-hidden"
			title="Switch model"
			ariaLabel={`Harness and model: ${selectedLabel}, ${displayName}${contextLabel ? `, context ${contextLabel}` : ""}`}
			aria-haspopup="dialog"
			aria-expanded={pickerOpen}
			aria-controls={pickerOpen ? "model-picker" : undefined}
			onclick={togglePicker}
		>
			<HarnessLogo driver={selectedDriver} instanceId={selectedLogoInstanceId} size={13} surface="page" />
			<span class="min-w-0 truncate border-b border-dotted border-border-chip">{displayName}</span>
		</Button>
		{#if contextLabel}
			<span aria-hidden="true" class="text-border-chip">·</span>
			<Button
				variant="ghost"
				size="content"
				tone="muted"
				hoverFill="none"
				data-testid="composer-word-context"
				class="shrink-0 rounded-md px-[5px] py-[2px] text-[11.5px] font-normal font-brand"
				ariaLabel={`Context window: ${contextLabel}. Open harness and model options`}
				aria-haspopup="dialog"
				aria-expanded={pickerOpen}
				aria-controls={pickerOpen ? "model-picker" : undefined}
				onclick={(e) => togglePicker(e, "context")}
			>
				<span class="border-b border-dotted border-border-chip">{contextLabel}</span>
			</Button>
		{/if}
		{#if effort.options.length > 0}
			<span aria-hidden="true" class="text-border-chip">·</span>
		{/if}
	{:else}
		<!-- Phone: logo + short tag (O5). Desktop: logo + "Name · ctx" + chevron. -->
		<Button
			bind:element={triggerEl}
			variant="ghost"
			size="content"
			tone="inherit"
			hoverFill="none"
			data-testid="model-picker-trigger"
			data-instance-id={selectedId}
			class="model-btn min-w-0 h-[32px] text-text-secondary font-brand hover:bg-text/7 {phone
				? 'gap-[3px] px-[5px] rounded-[10px]'
				: 'gap-[6px] px-[9px] rounded-[9px] text-[12px] font-semibold max-w-[260px]'} {hasModel ? '' : 'opacity-50'}"
			title="Switch model"
			ariaLabel={`Harness and model: ${selectedLabel}, ${displayName}${contextLabel ? `, context ${contextLabel}` : ""}`}
			aria-haspopup="dialog"
			aria-expanded={pickerOpen}
			aria-controls={pickerOpen ? "model-picker" : undefined}
			onclick={togglePicker}
		>
			{#if phone}
				<HarnessLogo driver={selectedDriver} instanceId={selectedLogoInstanceId} size={17} surface="box" />
				<span class="model-label text-[10px] font-bold whitespace-nowrap">{shortModelLabel}</span>
			{:else}
				<HarnessLogo driver={selectedDriver} instanceId={selectedLogoInstanceId} size={15} surface="box" />
				<span class="model-label min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
					{displayName}{#if contextLabel}<span data-testid="picker-selected-context">{` · ${contextLabel}`}</span>{/if}
				</span>
				<span data-testid="model-chip-chevron" class="inline-flex shrink-0 text-text-dimmer"><Icon name="chevron-down" size={11} /></span>
			{/if}
		</Button>
	{/if}

	<ModelVariant bind:this={variantRef} onOpen={closePicker} {variant} />

	{#if pickerOpen}
		{#if phone}
			<Dialog
				open={pickerOpen}
				onclose={closePicker}
				placement="sheet"
				labelledBy={titleId}
				returnFocus={() => pickerTriggerEl ?? triggerEl ?? null}
				initialFocus="dialog"
			>
				{@render pickerSurface(true)}
			</Dialog>
		{:else}
			{@render pickerSurface(false)}
		{/if}
	{/if}
</div>

{#if handoff}
	<HandoffDialog
		open
		onclose={() => accounts.cancel()}
		to={handoff.to}
		summary={handoff.summary}
		confirm={{
			from: handoff.from,
			fromQuota: accounts.fromQuota(handoff),
			quota: accounts.quotaOf(handoff.to),
			cutOff: handoff.limit?.cutOffMessageId !== undefined,
			busy: accounts.switching,
			onconfirm: () => void accounts.confirm(),
		}}
	/>
{/if}

<style>
	.picker-account-card {
		display: grid;
		width: 100%;
		height: 100%;
		min-width: 0;
		gap: 6px;
		border: 1px solid var(--color-border);
		border-radius: 9px;
		padding: 7px 9px;
		font-size: 11.5px;
	}
	.picker-account-card.selected {
		border-color: var(--account-color);
		background: color-mix(in srgb, var(--account-color) 10%, transparent);
	}
	.picker-account-card.limited { opacity: .6; }
	.picker-account-card.locked { opacity: .5; }
	:global(.model-dropdown [data-testid="picker-harness-options"][data-layout="scroll"] > [data-radio-group-item]) {
		border: 1px solid var(--color-border);
	}
	:global(.model-dropdown [data-testid="picker-harness-options"][data-layout="scroll"] > [data-state="checked"]) {
		border-color: var(--color-text-secondary);
	}
	:global(.model-dropdown[data-phone="true"] [data-testid^="picker-row-"]),
	:global(.model-dropdown[data-phone="true"] [data-testid^="picker-agent-"]),
	:global(.model-dropdown[data-phone="true"] .model-item) {
		min-height: 50px;
	}
</style>
