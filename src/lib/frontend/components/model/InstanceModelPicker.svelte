<!-- Harness tabs and model options: a phone sheet or a desktop drop-up. -->

<script lang="ts">
	import SheetChrome from "../ui/SheetChrome.svelte";
	import { onDestroy, tick, untrack, type Snippet } from "svelte";
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
		refreshCatalogs,
		chooseAgent,
		chooseDefaultModel,
		discoveryState,
		draftModelInventory,
		formatAgentLabel,
		getActiveAgent,
		getActiveModel,
		modelMatchesId,
		getVisibleAgents,
		getAvailableInstances,
		getEffectiveInstanceId,
		getProviderGroupsForInstance,
		getSessionDriver,
		getSessionPick,
		formatModelName,
		type InstanceOption,
		isProviderConfigured,
		selectInstance,
		viewDraftModels,
	} from "../../stores/discovery.svelte.js";
	import { currentChat } from "../../stores/chat.svelte.js";
	import { composerPreferences, isContextWarning } from "../../stores/composer-preferences.svelte.js";
	import { composerPickerState, openPicker, type PickerSection } from "../../stores/composer-picker.svelte.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { getClaudeAccounts, type AccountAvailability } from "../../stores/claude-accounts.svelte.js";
	import { getDriverTraits, instanceStatusColor } from "../../stores/instance.svelte.js";
	import { accountColorClass } from "../../utils/account-color.js";
	import { getProviderPresentation } from "../../utils/provider-presentation.js";
	import { cursorAuth, openCursorLogin, refreshCursorAuth } from "../../stores/cursor-auth.svelte.js";
	import { usageResetTime } from "../../utils/continuation.js";
	import { getDraftProject } from "../../stores/project.svelte.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { findSession, reloadProviderSession, sessionState } from "../../stores/session.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import { openSettings } from "../layout/chrome-actions.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import type { AgentInfo, Immutable, InstanceStatus, ModelCost, ModelInfo, ProviderGroup } from "../../types.js";
	import Surface from "../ui/Surface.svelte";
	import TextInput from "../ui/TextInput.svelte";

	let { variant = "icons", phoneControls }: {
		variant?: "icons" | "words" | undefined;
		phoneControls?: Snippet<[rows: Snippet]> | undefined;
	} = $props();

	const pickerOpen = $derived(composerPickerState.request !== null);
	let view = $state<"root" | "model" | "agent">("root");
	const phone = $derived(sessionViewState.composerTier === "phone");
	// A thin desktop composer has no room for separate harness and model chips, so it uses the phone's combined trigger.
	const combinedTrigger = $derived(phone || sessionViewState.composerTier === "thin");
	let searchQuery = $state("");
	let favoritesOnly = $state(false);
	let variantRef: ModelVariant | undefined = $state();
	let searchEl: HTMLInputElement | undefined = $state();
	let triggerEl: HTMLButtonElement | HTMLAnchorElement | undefined = $state();
	let pickerTriggerEl: HTMLElement | undefined = $state();
	let backEl: HTMLButtonElement | HTMLAnchorElement | undefined = $state();

	// Prefix for the per-provider heading ids that each group's
	// `aria-labelledby` points at. One base id per component instance, suffixed
	// with the provider id, because the picker can mount more than once.
	const groupHeadingId = $props.id();
	const titleId = `${groupHeadingId}-title`;
	const title = $derived(
		view === "root" ? "Harness & model" : view === "agent" ? "Agent" : "Model",
	);

	const instances = $derived(getAvailableInstances());

	/** The server's effective account for the active session. */
	const boundInstanceId = $derived(
		sessionState.currentId ? findSession(sessionState.currentId)?.accountId ?? undefined : undefined,
	);
	const locked = $derived(sessionState.currentId !== null);
	const sessionLoading = $derived(!!sessionState.currentId && getSessionPick(sessionState.currentId) === undefined);
	const selectedId = $derived(locked ? boundInstanceId : getEffectiveInstanceId());
	const draftModelLoading = $derived(!locked && draftModelInventory.instanceId === selectedId && draftModelInventory.loading);
	const selectedInstance = $derived(
		instances.find((i) => i.id === selectedId) ?? null,
	);
	const selectedDriver = $derived(
		// A session shows only its own stored harness: never the draft default, and nothing until its pick loads.
		sessionState.currentId ? (sessionLoading ? undefined : getSessionDriver(sessionState.currentId)) :
			selectedInstance?.driver ?? discoveryState.currentDriver,
	);
	const selectedTraits = $derived(getDriverTraits(selectedDriver));
	const hasAccountUsage = $derived(selectedTraits?.usageHarness === "claude");
	const accountLabel = $derived(selectedTraits?.accountKind === "config-directory" ? "Account" : "Instance");
	const selectedLabel = $derived(
		selectedInstance?.label ?? (locked ? "Account unavailable" : "Add account"),
	);
	const selectedLogoInstanceId = $derived(selectedId);
	const harnesses = $derived(
		[...new Set(instances.map((instance) => instance.driver))].map((driver) => {
			const accounts = instances.filter((instance) => instance.driver === driver);
			const unavailable = accounts.every((account) => account.available === false);
			const unavailableReason = unavailable
				? accounts.find((account) => account.unavailableReason)?.unavailableReason ?? "Runtime unavailable"
				: undefined;
			return {
				value: driver,
				label: driverLabel(driver),
				locked: unavailable || (locked && driver !== selectedDriver),
				lockedReason: unavailableReason,
				unavailableReason,
				authRequired: unavailable && accounts.some((account) => account.unavailableCode === "auth_required"),
			};
		}),
	);
	const driverInstances = $derived(instances.filter((instance) => instance.driver === selectedDriver));
	$effect(() => {
		if (pickerOpen && harnesses.some((harness) => getProviderPresentation(harness.value)?.auth && harness.authRequired))
			void refreshCursorAuth();
	});
	const needsAccount = $derived(selectedTraits?.accountKind === "config-directory" && driverInstances.length === 0);
	const accountProjectSlug = $derived(
		sessionState.currentId
			? findSession(sessionState.currentId)?.projectSlug ?? ""
			: getDraftProject() ?? "",
	);
	const accounts = $derived(getClaudeAccounts(accountProjectSlug));
	const switchingTo = $derived(hasAccountUsage && accounts.handoff.kind !== "idle" && accounts.handoff.sessionId === sessionState.currentId ? accounts.switchingTo : null);
	const wordAccountName = $derived(selectedInstance ? accounts.nameOf(switchingTo ?? selectedLogoInstanceId, selectedInstance.label) : selectedLabel);
	let presentedRequest = $state<number | undefined>();
	const handoff = $derived(accounts.pendingHandoff?.requestId === presentedRequest ? accounts.pendingHandoff : undefined);
	type AccountCard = { value: string; label: string; locked: boolean } & (
		| { kind: "usage"; availability: AccountAvailability }
		| { kind: "status"; status: InstanceStatus }
	);
	const accountCards = $derived.by<AccountCard[]>(() => {
		if (hasAccountUsage) {
			return [...accounts.accounts].sort((a, b) => Number(b.isDefault === true) - Number(a.isDefault === true)).map((account) => {
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
			locked: locked || instance.available === false,
			kind: "status",
			// Built-in instances carry no managed status; they serve the catalog, so they're up.
			status: instance.status ?? "healthy",
		}));
	});
	const hasAccountWord = $derived(sessionViewState.composerTier === "wide" && (hasAccountUsage ? accounts.accounts.length >= 2 : driverInstances.length >= 2));

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

	const activeModelId = $derived(discoveryState.currentModelId);
	const activeProviderId = $derived(discoveryState.currentProviderId);
	const activeModel = $derived(
		getActiveModel(activeModelId, activeProviderId),
	);
	const hasModel = $derived(!!activeModelId);
	const parameters = $derived(activeModel?.parameters);
	const defaultCombination = $derived(
		parameters?.combinations.find((entry) => entry.isDefault) ?? parameters?.combinations[0],
	);
	const combination = $derived(
		parameters?.combinations.find((entry) => entry.variant === effort.current) ?? defaultCombination,
	);
	function parameterCombination(id: string, value: string) {
		if (!combination) return undefined;
		const values = { ...combination.values, [id]: value };
		return parameters?.combinations.find((entry) =>
			Object.keys(entry.values).length === Object.keys(values).length &&
			Object.entries(values).every(([key, value]) => entry.values[key] === value),
		);
	}
	function selectParameter(id: string, value: string) {
		const next = parameterCombination(id, value);
		if (next && !effort.pending) effort.select(next.variant);
	}
	const parameterRows = $derived((parameters?.rows ?? []).flatMap((row) => {
		const kind = ["effort", "reasoning", "reasoning_effort"].includes(row.id) ? "effort" : row.id;
		if (!["effort", "context", "thinking", "fast"].includes(kind)) return [];
		const options = row.values.map(({ value, label }) => ({
			value,
			label: kind === "effort" ? (value === "medium" ? "med" : value) :
				kind === "thinking" || kind === "fast" ? (value === "true" ? "On" : "Off") : label,
			testId: `picker-${kind}-option-${value}`,
			disabled: effort.pending || !parameterCombination(row.id, value),
		}));
		const value = combination?.values[row.id] ?? "";
		return [{ id: row.id, kind, options, value, label: options.find((option) => option.value === value)?.label ?? value }];
	}));
	const parameterEffort = $derived(parameterRows.find((row) => row.kind === "effort"));
	const parameterContext = $derived(parameterRows.find((row) => row.kind === "context"));
	const parameterToggles = $derived(parameterRows.filter((row) => row.kind === "thinking" || row.kind === "fast"));
	const parameterEffortWord = $derived.by(() => {
		const thinking = parameterRows.find((row) => row.kind === "thinking");
		const fast = parameterRows.find((row) => row.kind === "fast")?.value === "true";
		const label = parameterEffort?.label ?? (thinking ? (thinking.value === "true" ? "Thinking" : "No thinking") : "");
		return label ? `${label}${fast ? " · Fast" : ""}` : fast ? "Fast" : "Standard";
	});
	const contextOptions = $derived(contextWindow.options);
	const selectedContext = $derived(contextWindow.current);
	const contextLabel = $derived(sessionLoading ? "" : parameterContext?.label ?? selectedContext?.label ??
		(sessionState.currentId && contextOptions.length ? "Default" : modelContextLabel(activeModel)));
	// Phones show the context word only when it differs from the default.
	const showContextWord = $derived(!!contextLabel && (!phone || (parameterContext
		? parameterContext.value !== defaultCombination?.values[parameterContext.id]
		: selectedContext !== null && !selectedContext.isDefault)));
	const contextPercent = $derived(currentChat().contextPercent);
	const contextWarning = $derived(isContextWarning(contextPercent, composerPreferences.contextWarning));
	const contextSegments = $derived(parameterContext?.options ?? contextOptions.map((option) => ({
		value: option.value,
		label: option.label,
		testId: `picker-context-option-${option.value}`,
		disabled: contextWindow.pending,
	})));
	const effortSegments = $derived(parameterEffort?.options ?? (parameters ? [] : effort.options.map((variant) => ({
		value: variant,
		label: variant === "medium" ? "med" : variant,
		testId: `picker-effort-option-${variant}`,
		disabled: effort.pending,
	}))));
	$effect(() => {
		// Refetch once each turn ends.
		const endedGeneration = currentChat().endedGeneration;
		const projectSlug = getCurrentSlug();
		const sessionId = sessionState.currentId;
		if (endedGeneration < 0 || !projectSlug || !sessionId) return;

		untrack(() => { void refreshCatalogs(); });
	});

	/** Display name for the trigger button, with date suffix stripped.
	 *  Grouped models (Bedrock geo routing) append the active scope label. */
	const displayName = $derived.by(() => {
		if (draftModelLoading) return "Loading…";
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
		return sessionLoading ? "Loading…" : "Select model";
	});

	/** The phone button's two-or-three letter model tag: "Sonnet 5" → S5, "GPT-6 Sol" → Sol. */
	const shortModelLabel = $derived.by(() => {
		const name = activeModel ? stripDateSuffix(formatModelName(activeModel)) : stripDateSuffix(activeModelId ?? "");
		if (!name) return sessionLoading ? "Loading…" : "Select model";
		const words = (/\s/.test(name) ? name.split(/\s+/) : name.split("-")).filter((word) => !/^claude$/i.test(word));
		const index = words.findIndex((word, i) => /^[a-z]+$/i.test(word) && /^\d+(\.\d+)?$/.test(words[i + 1] ?? ""));
		const word = words[index];
		if (word) return `${word.charAt(0).toUpperCase()}${words[index + 1]}`;
		const last = words.at(-1) ?? name;
		return last.length <= 4 ? last : last.slice(0, 3);
	});

	const visibleAgents = $derived(needsAccount ? [] : getVisibleAgents());
	const activeAgent = $derived(needsAccount ? undefined : getActiveAgent() ?? visibleAgents[0]);
	// Regular OpenCode Plan sessions lock the agent; Side Threads use session rules.
	const planLocked = $derived(
		selectedTraits?.composerModeControl === "agent" &&
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
			void rpc("SwitchAgent", { sessionId, agentId: agent.id }).catch(undoAgent);
		}
	}

	function driverLabel(id: ProviderDriverKind | undefined): string {
		if (!id) return "Loading…";
		return getProviderPresentation(id)?.label ?? id.charAt(0).toUpperCase() + id.slice(1);
	}

	function instanceForDriver(driver: ProviderDriverKind): InstanceOption | undefined {
		return instances.find((instance) => instance.driver === driver && instance.isDefault);
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

	// The desktop panel hangs left from the trigger's right edge. A thin composer near the window's
	// left edge would push it offscreen, so slide it right to the floating menus' 8px collision padding.
	function keepOnscreen(panel: HTMLElement) {
		const overflow = 8 - panel.getBoundingClientRect().left;
		if (overflow > 0) panel.style.translate = `${overflow}px 0`;
	}

	function closePicker() {
		const opener = phone ? composerPickerState.request?.opener : undefined;
		composerPickerState.request = null;
		(opener?.isConnected ? opener : pickerTriggerEl?.isConnected ? pickerTriggerEl : triggerEl)?.focus({ preventScroll: true });
	}

	function handleInstanceSelect(instance: InstanceOption, e?: MouseEvent) {
		e?.stopPropagation();
		if (isInstanceDisabled(instance)) return;
		view = "root";
		if (instance.id === selectedId && discoveryState.hasInstanceChoice) return;
		selectInstance(instance.id);
		searchQuery = "";
	}

	function handleHarnessSelect(driver: ProviderDriverKind) {
		if (locked || harnesses.find((harness) => harness.value === driver)?.locked) return;
		const instance = instanceForDriver(driver);
		if (instance) handleInstanceSelect(instance);
	}

	function handleAccountSelect(id: string) {
		const card = accountCards.find((card) => card.value === id);
		if (!card || card.locked) return;
		if (locked) {
			if (hasAccountUsage && sessionState.currentId) {
				closePicker();
				void accounts.beginSwitch(sessionState.currentId, id, selectedLogoInstanceId);
				presentedRequest = accounts.handoff.kind === "previewing" ? accounts.handoff.requestId : undefined;
			}
			return;
		}
		const instance = instances.find((instance) => instance.id === id);
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
			void rpc("SetDefaultModel", {
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
		const sessionId = sessionState.currentId;
		if (sessionId) {
			void reloadProviderSession(sessionId).catch(() => undefined);
		}
		showToast("Reloading skills…", { duration: 1500 });
		closePicker();
	}

	$effect(() => {
		const request = composerPickerState.request;
		if (!request) return;
		untrack(() => {
			if (!locked && selectedTraits?.catalogSource === "server")
				viewDraftModels(getDraftProject(), selectedId, true);
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
			// An open session's current card is disabled. Focus its section instead: focusing
			// another card would select it (bits-ui selection follows focus) and start a switch.
			const selectedCard = panel?.querySelector<HTMLElement>('[data-testid="picker-account-options"] [aria-checked="true"]:not(:disabled)')
				?? panel?.querySelector<HTMLElement>('[data-testid="picker-account-section"]');
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
	<!-- The id names the whole visible picker: the sheet on phones, the card on desktop. -->
	<SheetChrome active={sheet} id="model-picker" data-testid="model-picker" maxHeight="85dvh" bottomPadding={30} safeAreaMode="max" bodyClass="flex flex-col">
	<Surface
		variant={sheet ? "bare" : "card"}
		{@attach !sheet && keepOnscreen}
		radius="none"
		elevation={sheet ? "none" : "menu-lg"}
		id={sheet ? undefined : "model-picker"}
		data-testid={sheet ? undefined : "model-picker"}
		data-phone={sheet ? "true" : undefined}
		role={sheet ? undefined : "dialog"}
		aria-labelledby={sheet ? undefined : titleId}
		class="model-dropdown flex flex-col overflow-hidden font-sans {sheet
			? 'w-full min-h-0 px-[16px]'
			: 'absolute bottom-[calc(100%+8px)] right-0 w-[404px] max-w-[90vw] max-h-[min(70vh,480px)] rounded-[12px] px-[12px] pt-[9px] pb-[4px] z-[var(--z-popover)]'}"
	>
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
				{#if harnesses.length > 1 || harnesses.some((harness) => harness.unavailableReason) || (harnesses.length > 0 && !harnesses.some((harness) => harness.value === selectedDriver))}
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
							value={selectedDriver ?? ""}
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
									instanceId={option.value === selectedDriver ? selectedLogoInstanceId : instanceForDriver(option.value)?.id}
									size={14}
									surface="surface"
								/>
								{option.label}
								{#if option.locked}<Icon name="lock" size={10} />{/if}
							{/snippet}
						</OptionRow>
						{#each harnesses.filter((harness) => harness.unavailableReason) as harness (harness.value)}
							<p data-testid={`picker-harness-${harness.value}-unavailable`} class="mt-[6px] text-[11px] text-text-muted">{harness.label} unavailable · {harness.unavailableReason}</p>
							{@const auth = getProviderPresentation(harness.value)?.auth}
							{#if auth && harness.authRequired}
								<Button variant="ghost-accent" size="sm" data-testid={`picker-harness-${harness.value}-login`} onclick={() => { closePicker(); openCursorLogin(); }}>{cursorAuth.current && cursorAuth.current.source !== "environment" ? auth.login : auth.manage}</Button>
							{/if}
						{/each}
					</section>
				{/if}
				{#if accountCards.length > 1}
					<section data-testid="picker-account-section" tabindex="-1" aria-label={accountLabel} class="pb-[4px] outline-none">
						<div class="mt-[9px] mb-[5px] flex justify-between text-[10px] uppercase tracking-[0.07em] text-text-dimmer">
							<span>{accountLabel}</span>
							<span data-testid="picker-account-section-caption">{hasAccountUsage ? "5-hour use" : "status"}</span>
						</div>
						<OptionRow
							options={accountCards}
							value={selectedLogoInstanceId ?? ""}
							onChange={handleAccountSelect}
							onReselect={(id) => { if (!locked) selectInstance(id); }}
							label={accountLabel}
							lockedReason={hasAccountUsage ? "" : "Harness is fixed for this session"}
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
						{#if locked && hasAccountUsage}
							<div data-testid="picker-account-note" class="mt-[8px] border-t border-border-subtle pt-[6px] text-[10.5px] text-text-muted">You'll see what carries over before anything changes.</div>
						{/if}
					</section>
				{/if}
				{#if needsAccount}
					<div class="flex items-center justify-between gap-2 border-b border-border-subtle py-2 text-xs text-text-muted">
						<span>No {driverLabel(selectedDriver)} accounts yet.</span>
						<Button variant="ghost-accent" size="content" data-testid="picker-add-account-btn" onclick={() => { closePicker(); openSettings("server", "instances"); }}>Add account</Button>
					</div>
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
						{#if contextSegments.length > 1}
							<SegmentedControl
								bind:value={() => parameterContext?.value ?? selectedContext?.value ?? "", (value) => parameterContext ? selectParameter(parameterContext.id, value) : contextWindow.select(contextOptions.find((option) => option.value === value) ?? null)}
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
				{#if parameters ? parameterEffort : effortSegments.length > 0 || (sessionState.currentId && effort.current)}
					<div data-testid="picker-row-effort" aria-disabled={effortSegments.length === 0 || undefined} tabindex="-1" class="flex min-h-[46px] items-center gap-2.5 border-b border-border-subtle px-1 py-2.5 last:border-b-0">
						<span class="w-16 shrink-0 text-[11.5px] text-text-muted">Effort</span>
						{#if effortSegments.length > (parameters ? 1 : 0)}
							<SegmentedControl
								bind:value={() => parameterEffort?.value ?? effort.current ?? "", (value) => parameterEffort ? selectParameter(parameterEffort.id, value) : effort.select(value)}
								options={effortSegments}
								variant={effortSegments.length > 5 || effortSegments.some(({ label }) => label.length > 5) ? "picker-context" : "picker"}
								label="Effort"
							/>
						{:else}
							<span class="min-w-0 flex-1 text-[13px] text-text">{parameterEffort?.label ?? effort.current}</span>
						{/if}
					</div>
				{/if}
				{#each parameterToggles as row (row.id)}
					<div data-testid="picker-row-{row.kind}" tabindex="-1" class="flex min-h-[46px] items-center gap-2.5 border-b border-border-subtle px-1 py-2.5 last:border-b-0">
						<span class="w-16 shrink-0 text-[11.5px] text-text-muted">{row.kind === "thinking" ? "Thinking" : "Fast"}</span>
						{#if row.options.length > 1}
							<SegmentedControl
								bind:value={() => row.value, (value) => selectParameter(row.id, value)}
								options={row.options}
								variant="picker"
								label={row.kind === "thinking" ? "Thinking" : "Fast"}
							/>
						{:else}
							<span class="min-w-0 flex-1 text-[13px] text-text">{row.label}</span>
						{/if}
					</div>
				{/each}
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
						class="min-w-0 flex-1 text-[13px] text-text font-sans placeholder:text-text-dimmer"
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
				<div data-testid="model-picker-list" class="py-1.5" aria-busy={draftModelLoading}>
					{#if locked}
						<div class="my-1.5 flex items-start gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-[11px] leading-[1.4] text-text-dimmer">
							<Icon name="lock" size={12} class="shrink-0" />
							<span>Harness fixed at creation — showing <b class="font-semibold text-text-secondary">{selectedLabel}</b> only. Model switching within it is allowed.</span>
						</div>
					{/if}
					{#if draftModelLoading}
						<div class="model-empty px-1 py-4 text-center text-base text-text-dimmer">Loading models…</div>
					{:else if filteredGroups.length === 0}
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
	</SheetChrome>
{/snippet}

<div
	id="model-display"
	class="relative inline-flex min-w-0 items-center {variant === 'words' ? 'gap-[5px]' : phone ? 'gap-[8px]' : 'shrink-0 gap-[2px]'}"
	use:dismiss={{ onDismiss: closePicker, enabled: pickerOpen && !phone }}
>
	{#if needsAccount}
		<Button variant="ghost-accent" size="content" class="shrink-0 gap-1 px-1.5 py-1 text-[11.5px]" data-testid="add-claude-account-btn" onclick={() => { closePicker(); openSettings("server", "instances"); }}><Icon name="plus" size={12} />Add account</Button>
	{/if}
	{#if variant === "words"}
		<Button
			bind:element={triggerEl}
			variant="ghost"
			size="content"
			tone="muted"
			hoverFill="none"
			data-testid="composer-word-harness"
			class="shrink-0 mr-[6px]"
			ariaLabel={`Account: ${wordAccountName}. Open account options`}
			aria-haspopup="dialog"
			aria-expanded={pickerOpen}
			aria-controls={pickerOpen ? "model-picker" : undefined}
			onclick={(event) => togglePicker(event, "account")}
		>
			{#if selectedDriver}<HarnessLogo driver={selectedDriver} instanceId={selectedLogoInstanceId} size={12} surface="page" />{/if}
		</Button>
		{#if hasAccountWord}
			<Button
				variant="ghost"
				size="content"
				tone="muted"
				hoverFill="none"
				data-testid="composer-word-account"
				class="shrink-0 text-[11.5px] font-normal font-sans"
				ariaLabel={`Account: ${wordAccountName}. Open account options`}
				aria-haspopup="dialog"
				aria-expanded={pickerOpen}
				aria-controls={pickerOpen ? "model-picker" : undefined}
				onclick={(event) => togglePicker(event, "account")}
			><span class="border-b border-dotted border-border-chip">{wordAccountName}{switchingTo ? "…" : ""}</span></Button>
			<span aria-hidden="true" class="text-border-chip">·</span>
		{/if}
		<Button
			variant="ghost"
			size="content"
			tone="muted"
			hoverFill="none"
			data-testid="composer-word-model"
			data-instance-id={selectedId}
			data-shown-harness={selectedDriver ?? ""}
			data-shown-provider={activeProviderId ?? ""}
			data-shown-model={activeModelId ?? ""}
			data-shown-effort={effort.current ?? ""}
			data-shown-context-window={selectedContext?.value ?? ""}
			data-shown-permission-mode={discoveryState.permissionMode}
			disabled={sessionLoading}
			class="shrink-0 text-[11.5px] font-normal font-sans"
			title="Switch model"
			ariaLabel={`Model: ${displayName}. Open model options`}
			aria-haspopup="dialog"
			aria-expanded={pickerOpen}
			aria-controls={pickerOpen ? "model-picker" : undefined}
			onclick={(event) => togglePicker(event, "model")}
		>
			<span class="border-b border-dotted border-border-chip">{phone ? shortModelLabel : displayName}</span>
		</Button>
		{#if showContextWord}
			<span aria-hidden="true" class="text-border-chip">·</span>
			<Button
				variant="ghost"
				size="content"
				tone="muted"
				hoverFill="none"
				data-testid="composer-word-context"
				class="shrink-0 text-[11.5px] font-normal font-sans"
				ariaLabel={`Context window: ${contextLabel}. Open harness and model options`}
				aria-haspopup="dialog"
				aria-expanded={pickerOpen}
				aria-controls={pickerOpen ? "model-picker" : undefined}
				onclick={(event) => togglePicker(event, "model")}
			>
				<span class="border-b border-dotted border-border-chip">{contextLabel}</span>
			</Button>
		{/if}
		{#if effort.options.length > 0 || (sessionState.currentId && effort.current)}
			<span aria-hidden="true" class="text-border-chip">·</span>
		{/if}
	{:else if !combinedTrigger}
		<Button
			bind:element={triggerEl}
			variant="ghost"
			size="content"
			tone="inherit"
			hoverFill="none"
			data-testid="composer-harness-trigger"
			data-instance-id={selectedLogoInstanceId}
			class="h-[26px] shrink-0 gap-[5px] rounded-[7px] bg-bg-alt px-[6px] text-[11.5px] font-normal font-sans text-text whitespace-nowrap hover:bg-text/7"
			ariaLabel={`Harness: ${driverLabel(selectedDriver)}, account: ${wordAccountName}${switchingTo ? ", switching" : ""}. Open harness options`}
			aria-haspopup="dialog"
			aria-expanded={pickerOpen}
			aria-controls={pickerOpen ? "model-picker" : undefined}
			onclick={(event) => togglePicker(event, "harness")}
		>
			{#if selectedDriver}<HarnessLogo driver={selectedDriver} instanceId={selectedLogoInstanceId} size={13} surface="box" />{/if}
			{#if sessionViewState.composerTier === "wide"}
				<span data-testid="composer-harness-label">{driverLabel(selectedDriver)}</span>
				{#if wordAccountName !== driverLabel(selectedDriver)}
					<span aria-hidden="true" class="text-text-dimmer">·</span>
					<span data-testid="composer-harness-account">{wordAccountName}{switchingTo ? "…" : ""}</span>
				{/if}
			{/if}
			<Icon name="chevron-down" size={10} class="text-text-dimmer" />
		</Button>
		<span data-testid="composer-control-divider" aria-hidden="true" class="mx-[4px] h-[14px] w-px shrink-0 bg-border"></span>
		<Button
			variant="ghost"
			size="content"
			tone="inherit"
			hoverFill="none"
			data-testid="model-picker-trigger"
			data-instance-id={selectedId}
			data-shown-harness={selectedDriver ?? ""}
			data-shown-provider={activeProviderId ?? ""}
			data-shown-model={activeModelId ?? ""}
			data-shown-effort={effort.current ?? ""}
			data-shown-context-window={selectedContext?.value ?? ""}
			data-shown-permission-mode={discoveryState.permissionMode}
			disabled={sessionLoading}
			class="model-btn h-[26px] shrink-0 gap-[5px] rounded-[7px] px-[6px] text-[11.5px] font-normal font-sans text-text-secondary whitespace-nowrap hover:bg-text/7 {hasModel ? '' : 'opacity-50'}"
			title="Switch model"
			ariaLabel={`Model: ${displayName}${contextLabel ? `, context ${contextLabel}` : ""}. Open model options`}
			aria-haspopup="dialog"
			aria-expanded={pickerOpen}
			aria-controls={pickerOpen ? "model-picker" : undefined}
			onclick={(event) => togglePicker(event, "model")}
		>
			<span class="model-label">{displayName}</span>
			{#if contextLabel}<span aria-hidden="true" class="text-text-dimmer">·</span><span data-testid="picker-selected-context">{contextLabel}</span>{/if}
			<span data-testid="model-chip-chevron" class="inline-flex shrink-0 text-text-dimmer"><Icon name="chevron-down" size={10} /></span>
		</Button>
	{:else}
		<!-- Phone and thin composers keep one logo and short model tag. -->
		<Button
			bind:element={triggerEl}
			variant="ghost"
			size="content"
			tone="inherit"
			hoverFill="none"
			data-testid="model-picker-trigger"
			data-instance-id={selectedId}
			data-shown-harness={selectedDriver ?? ""}
			data-shown-provider={activeProviderId ?? ""}
			data-shown-model={activeModelId ?? ""}
			data-shown-effort={effort.current ?? ""}
			data-shown-context-window={selectedContext?.value ?? ""}
			data-shown-permission-mode={discoveryState.permissionMode}
			disabled={sessionLoading}
			class="model-btn min-w-0 h-[26px] text-[11.5px] font-normal text-text-secondary font-sans hover:bg-text/7 gap-[5px] px-[6px] rounded-[7px] {hasModel ? '' : 'opacity-50'}"
			title="Switch model"
			ariaLabel={`Harness and model: ${selectedLabel}, ${displayName}${contextLabel ? `, context ${contextLabel}` : ""}`}
			aria-haspopup="dialog"
			aria-expanded={pickerOpen}
			aria-controls={pickerOpen ? "model-picker" : undefined}
			onclick={(event) => togglePicker(event, "model")}
		>
			{#if selectedDriver}<HarnessLogo driver={selectedDriver} instanceId={selectedLogoInstanceId} size={13} surface="box" />{/if}
			<span class="model-label text-[11.5px] font-normal whitespace-nowrap">{shortModelLabel}</span>
		</Button>
	{/if}

	{#if variant === "icons" && phone && phoneControls}
		<!-- Keep the effort owner mounted so Ctrl+T also works with the sheet closed. -->
		<ModelVariant bind:this={variantRef} onOpen={closePicker} variant="row">
			{#snippet children(effortRow)}
				{#snippet rows()}
					<Button
						variant="ghost" size="content" tone="inherit" hoverFill="none" layout="flow"
						class="flex min-h-[50px] w-full items-center gap-[10px] rounded-none border-b border-border-subtle text-left text-[12.5px] font-normal font-sans text-text hover:bg-text/7"
						data-testid="composer-harness-trigger"
						data-instance-id={selectedLogoInstanceId}
						ariaLabel={`Harness: ${driverLabel(selectedDriver)}, account: ${wordAccountName}. Open harness options`}
						aria-haspopup="dialog"
						onclick={(event) => togglePicker(event, "harness")}
					>
						<span data-part="label" class="w-[64px] shrink-0 text-[11px] text-text-muted">Harness</span>
						<span data-part="value" class="flex min-w-0 flex-1 items-center gap-[7px] font-semibold">{#if selectedDriver}<HarnessLogo driver={selectedDriver} instanceId={selectedLogoInstanceId} size={16} surface="surface" />{/if}<span class="min-w-0 truncate">{driverLabel(selectedDriver)}{wordAccountName !== driverLabel(selectedDriver) ? ` · ${wordAccountName}` : ""}{switchingTo ? "…" : ""}</span></span>
						<span data-part="chevron" class="inline-flex shrink-0 text-text-dimmer"><Icon name="chevron-right" size={10} /></span>
					</Button>
					<Button
						variant="ghost" size="content" tone="inherit" hoverFill="none" layout="flow"
						class="flex min-h-[50px] w-full items-center gap-[10px] rounded-none border-b border-border-subtle text-left text-[12.5px] font-normal font-sans text-text hover:bg-text/7"
						data-testid="composer-more-model"
						ariaLabel={`Model: ${displayName}. Open model options`}
						aria-haspopup="dialog"
						onclick={(event) => togglePicker(event, "model")}
					>
						<span data-part="label" class="w-[64px] shrink-0 text-[11px] text-text-muted">Model</span>
						<span data-part="value" class="flex min-w-0 flex-1 flex-wrap items-center gap-[7px] font-semibold"><span>{displayName}</span>{#if contextLabel || contextPercent > 0}<small class="text-[10.5px] font-normal {contextWarning ? 'text-warning' : 'text-text-muted'}">{contextLabel}{contextLabel && contextPercent > 0 ? " · " : ""}{contextPercent > 0 ? `${Math.round(contextPercent)}% used` : ""}</small>{/if}</span>
						<span data-part="chevron" class="inline-flex shrink-0 text-text-dimmer"><Icon name="chevron-right" size={10} /></span>
					</Button>
					{@render effortRow()}
				{/snippet}
				{@render phoneControls(rows)}
			{/snippet}
		</ModelVariant>
	{:else}
		<ModelVariant bind:this={variantRef} onOpen={closePicker} variant={variant === "icons" && !phone ? "control" : variant} wordLabel={parameters ? parameterEffortWord : undefined} />
	{/if}
	{#if variant === "words" && selectedTraits?.composerModeControl === "agent"}
		<span aria-hidden="true" class="text-border-chip">·</span>
		<Button
			variant="ghost"
			size="content"
			tone="muted"
			hoverFill="none"
			data-testid="composer-word-agent"
			class="shrink-0 text-[11.5px] font-normal font-sans"
			ariaLabel={`Agent: ${activeAgent ? agentLabel(activeAgent) : "Default"}. Open agent options`}
			aria-haspopup="dialog"
			aria-expanded={pickerOpen}
			aria-controls={pickerOpen ? "model-picker" : undefined}
			onclick={(event) => togglePicker(event, "agent")}
		><span class="border-b border-dotted border-border-chip">{activeAgent ? agentLabel(activeAgent).toLowerCase() : "default"}</span></Button>
	{/if}

	{#if pickerOpen}
		{#if phone}
			<Dialog
				open={pickerOpen}
				onclose={closePicker}
				placement="sheet"
				labelledBy={titleId}
				returnFocus={() => composerPickerState.request?.opener ?? pickerTriggerEl ?? triggerEl ?? null}
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
