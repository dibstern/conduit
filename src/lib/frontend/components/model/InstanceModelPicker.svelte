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
	import ModelSelectionPanel from "./ModelSelectionPanel.svelte";
	import { composerModelSelectionTarget as target } from "./composer-model-selection-target.svelte.js";
	import { createModelSelectionState, modelContextLabel } from "./model-selection.svelte.js";
	import OptionRow from "../ui/OptionRow.svelte";
	import AccountDot from "../ui/AccountDot.svelte";
	import QuotaMeter from "../ui/QuotaMeter.svelte";
	// biome-ignore lint/style/useImportType: ModelVariant is used as a value for bind:this
	import ModelVariant from "./ModelVariant.svelte";
	import { dismiss } from "../../actions/use-dismiss.svelte.js";
	import { effort } from "../../stores/composer-settings.svelte.js";
	import {
		applyDefaultModelSet,
		refreshCatalogs,
		chooseAgent,
		chooseDefaultModel,
		discoveryState,
		formatAgentLabel,
		getActiveAgent,
		getVisibleAgents,
		formatModelName,
		type InstanceOption,
		viewDraftModels,
	} from "../../stores/discovery.svelte.js";
	import { currentChat } from "../../stores/chat.svelte.js";
	import { composerPreferences, isContextWarning } from "../../stores/composer-preferences.svelte.js";
	import { composerPickerState, openPicker, type PickerSection } from "../../stores/composer-picker.svelte.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import { getClaudeAccounts, type AccountAvailability } from "../../stores/claude-accounts.svelte.js";
	import { getDriverTraits, instanceStatusColor } from "../../stores/instance.svelte.js";
	import { usageState } from "../../stores/usage.svelte.js";
	import { getProviderPresentation } from "../../utils/provider-presentation.js";
	import { cursorAuth, openCursorLogin, refreshCursorAuth } from "../../stores/cursor-auth.svelte.js";
	import { usageResetTime } from "../../utils/continuation.js";
	import { getDraftProject } from "../../stores/project.svelte.js";
	import { getCurrentSlug } from "../../stores/router.svelte.js";
	import { findSession, reloadProviderSession, sessionState } from "../../stores/session.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import { openSettings } from "../layout/chrome-actions.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import type { AgentInfo, Immutable, InstanceStatus, ModelInfo } from "../../types.js";
	import Surface from "../ui/Surface.svelte";

	let { variant = "icons", phoneControls, phoneMode }: {
		variant?: "icons" | "words" | undefined;
		phoneControls?: Snippet<[rows: Snippet, trigger: Snippet<[{ props: Record<string, unknown>; attention?: boolean }]>]> | undefined;
		phoneMode?: Snippet | undefined;
	} = $props();

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

	// Prefix for the per-provider heading ids that each group's
	// `aria-labelledby` points at. One base id per component instance, suffixed
	// with the provider id, because the picker can mount more than once.
	const groupHeadingId = $props.id();
	const titleId = `${groupHeadingId}-title`;
	const title = $derived(
		view === "root" ? "Harness & model" : view === "agent" ? "Agent" : "Model",
	);

	const instances = $derived(target.accounts);

	/** The server's effective account for the active session. */
	const boundInstanceId = $derived(
		sessionState.currentId ? findSession(sessionState.currentId)?.accountId ?? undefined : undefined,
	);
	const locked = $derived(sessionState.currentId !== null);
	const sessionLoading = $derived(target.loading);
	const selectedId = $derived(target.pick.account);
	const selectedInstance = $derived(
		instances.find((i) => i.id === selectedId) ?? null,
	);
	const selectedDriver = $derived(target.pick.driver);
	const selectedTraits = $derived(getDriverTraits(selectedDriver));
	const canSwitchAccounts = $derived(selectedTraits?.usageHarness === "claude" || selectedTraits?.usageHarness === "codex");
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
	const accounts = $derived(getClaudeAccounts(accountProjectSlug, selectedTraits?.usageHarness === "codex" ? "codex" : "claude"));
	const switchingTo = $derived(canSwitchAccounts && accounts.handoff.kind !== "idle" && accounts.handoff.sessionId === sessionState.currentId ? accounts.switchingTo : null);
	const wordAccountName = $derived(selectedInstance ? accounts.nameOf(switchingTo ?? selectedLogoInstanceId, selectedInstance.label) : selectedLabel);
	let presentedRequest = $state<number | undefined>();
	const handoff = $derived(accounts.pendingHandoff?.requestId === presentedRequest ? accounts.pendingHandoff : undefined);
	type AccountCard = { value: string; label: string; locked: boolean } & (
		| { kind: "usage"; availability: AccountAvailability }
		| { kind: "status"; status: InstanceStatus }
	);
	const accountCards = $derived.by<AccountCard[]>(() => {
		if (canSwitchAccounts) {
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
	const hasAccountWord = $derived(!phone);

	const selection = createModelSelectionState(() => target);
	const activeModelId = $derived(selection.activeModelId);
	const activeProviderId = $derived(selection.activeProviderId);
	const activeModel = $derived(selection.activeModel);
	const parameters = $derived(selection.parameters);
	const defaultCombination = $derived(selection.defaultCombination);
	const parameterContext = $derived(selection.parameterContext);
	const parameterEffortWord = $derived(selection.parameterEffortWord);
	const contextOptions = $derived(selection.contextOptions);
	const selectedContext = $derived(selection.selectedContext);
	const displayName = $derived(selection.displayName);
	const contextLabel = $derived(sessionLoading ? "" : parameterContext?.label ?? selectedContext?.label ??
		(sessionState.currentId && contextOptions.length ? "Default" : modelContextLabel(activeModel)));
	// Phones show the context word only when it differs from the default.
	const showContextWord = $derived(!!contextLabel && (!phone || (parameterContext
		? parameterContext.value !== defaultCombination?.values[parameterContext.id]
		: selectedContext !== null && !selectedContext.isDefault)));
	const contextPercent = $derived(currentChat().contextPercent);
	const contextWarning = $derived(isContextWarning(contextPercent, composerPreferences.contextWarning));
	$effect(() => {
		// Refetch once each turn ends.
		const endedGeneration = currentChat().endedGeneration;
		const projectSlug = getCurrentSlug();
		const sessionId = sessionState.currentId;
		if (endedGeneration < 0 || !projectSlug || !sessionId) return;

		untrack(() => { void refreshCatalogs(); });
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

	function isDefaultModel(model: Immutable<ModelInfo>): boolean {
		return (
			model.id === discoveryState.defaultModelId &&
			model.provider === discoveryState.defaultProviderId
		);
	}

	function isInstanceDisabled(instance: InstanceOption): boolean {
		return locked && instance.id !== boundInstanceId;
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
		target.selectAccount(instance.id);
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
			if (canSwitchAccounts && sessionState.currentId) {
				closePicker();
				void accounts.beginSwitch(sessionState.currentId, id, selectedLogoInstanceId);
				presentedRequest = accounts.handoff.kind === "previewing" ? accounts.handoff.requestId : undefined;
			}
			return;
		}
		const instance = instances.find((instance) => instance.id === id);
		if (instance) handleInstanceSelect(instance);
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

	// The root focuses the row of the subview just left, so Back returns where it came from.
	// Plain variables: the focus effect also reruns when bound elements change, without a view change.
	let shownView: typeof view = "root";
	let leftView: "model" | "agent" | undefined;
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
			shownView = "root";
			leftView = undefined;
			view = request.section === "model" || request.section === "agent"
				? request.section
				: "root";
		});
	});

	$effect(() => {
		if (!pickerOpen) return;
		if (view !== shownView) {
			leftView = shownView === "root" ? undefined : shownView;
			shownView = view;
		}
		const section = leftView ?? composerPickerState.request?.section;
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
		variant={sheet ? "bare" : "popover"}
		{@attach !sheet && keepOnscreen}
		radius="none"
		elevation={sheet ? "none" : "popover"}
		id={sheet ? undefined : "model-picker"}
		data-testid={sheet ? undefined : "model-picker"}
		data-phone={sheet ? "true" : undefined}
		role={sheet ? undefined : "dialog"}
		aria-labelledby={sheet ? undefined : titleId}
		class="model-dropdown flex flex-col overflow-hidden font-sans {sheet
			? 'w-full min-h-0 px-[6px]'
			: 'absolute bottom-[calc(100%+8px)] right-0 w-[404px] max-w-[90vw] max-h-[min(70vh,480px)] rounded-[16px] p-[6px] z-[var(--z-popover)]'}"
	>
		<ModelSelectionPanel
			{target} {titleId} {title} {contextLabel} {selectedLabel} {groupHeadingId}
			storedEffortLabel={sessionState.currentId ? target.pick.effort : null}
			bind:view bind:searchQuery bind:searchEl bind:backEl
			filterModel={favoritesOnly ? isDefaultModel : undefined}
		>
			{#snippet subtitle()}
			{#if view === "root"}
				<span data-testid="picker-subtitle" class="ml-auto text-[12px] text-text-muted">{locked ? "this session" : "new session"}</span>
			{/if}
			{/snippet}
			{#snippet accountControls()}
				{#if harnesses.length > 1 || harnesses.some((harness) => harness.unavailableReason) || (harnesses.length > 0 && !harnesses.some((harness) => harness.value === selectedDriver))}
					<section data-testid="picker-harness-section" aria-label="Harness" class="pb-[6px]">
						<div class="flex items-center justify-between px-[10px] pt-[8px] pb-[6px] text-[12px] font-medium text-text-muted">
							<span>Harness</span>
							{#if locked}
								<span data-testid="picker-harness-caption" class="inline-flex items-center gap-[4px]">
									<Icon name="lock" size={12} /> fixed for this session
								</span>
							{/if}
						</div>
						<OptionRow
							variant="joined"
							options={harnesses}
							value={selectedDriver ?? ""}
							onChange={handleHarnessSelect}
							label="Harness"
							lockedReason="Harness is fixed for this session"
							itemWidth={104}
							testId="picker-harness-options"
							itemTestId={(driver) => `picker-harness-${driver}`}
							class="mx-[4px]"
						>
							{#snippet item(option)}
								<HarnessLogo
									driver={option.value}
									instanceId={option.value === selectedDriver ? selectedLogoInstanceId : instanceForDriver(option.value)?.id}
									size={18}
									surface="surface"
								/>
								{option.label}
								{#if option.locked}<Icon name="lock" size={10} />{/if}
							{/snippet}
						</OptionRow>
						{#each harnesses.filter((harness) => harness.unavailableReason) as harness (harness.value)}
							<p data-testid={`picker-harness-${harness.value}-unavailable`} class="mt-[6px] px-[10px] text-[12px] text-text-muted">{harness.label} unavailable · {harness.unavailableReason}</p>
							{@const auth = getProviderPresentation(harness.value)?.auth}
							{#if auth && harness.authRequired}
								<Button variant="ghost-accent" size="sm" data-testid={`picker-harness-${harness.value}-login`} onclick={() => { closePicker(); openCursorLogin(); }}>{cursorAuth.current && cursorAuth.current.source !== "environment" ? auth.login : auth.manage}</Button>
							{/if}
						{/each}
					</section>
				{/if}
				{#if accountCards.length > 1}
					<section data-testid="picker-account-section" tabindex="-1" aria-label={accountLabel} class="pb-[6px] outline-none">
						<div class="flex items-center justify-between px-[10px] pt-[8px] pb-[6px] text-[12px] font-medium text-text-muted">
							<span>{accountLabel}</span>
							<span data-testid="picker-account-section-caption">{selectedTraits?.usageHarness === "claude" ? "5-hour use" : canSwitchAccounts ? "usage" : "status"}</span>
						</div>
						<OptionRow
							variant="cards"
							options={accountCards}
							value={selectedLogoInstanceId ?? ""}
							onChange={handleAccountSelect}
							onActivate={locked ? undefined : target.selectAccount}
							label={accountLabel}
							lockedReason={canSwitchAccounts ? "" : "Harness is fixed for this session"}
							itemWidth={108}
							testId="picker-account-options"
							itemTestId={(id) => `picker-account-${id}`}
							class="mx-[4px] gap-[6px] pt-[2px] pb-[6px]"
						>
							{#snippet item(option, selected)}
								{@const card = accountCards.find((card) => card.value === option.value)}
								{#if card}
									{@const availability = card.kind === "usage" ? card.availability : undefined}
									<span
										class="picker-account-card"
										data-option-card
										data-limited={availability?.kind === "limited" ? "true" : undefined}
										data-locked={card.kind === "status" && locked && !selected ? "true" : undefined}
									>
										<span class="flex min-w-0 items-center gap-[6px]">
											<AccountDot instanceId={card.value} size={7} />
											<span data-testid="picker-account-name" class="min-w-0 truncate">{card.label}</span>
										</span>
										{#if card.kind === "status"}
											<span data-testid="picker-account-caption" class="flex items-center gap-[6px] text-[10.5px] font-normal text-text-muted">
												<span data-testid="picker-instance-status-dot" class="size-[7px] shrink-0 rounded-full {instanceStatusColor(card.status)}" aria-hidden="true"></span>
												{card.status}
											</span>
										{:else if availability?.kind === "limited"}
											{@const reset = usageResetTime(availability.resetsAt)}
											<span data-testid="picker-account-caption" class="text-[10.5px] font-normal text-error">limit{reset ? ` · resets ${reset}` : ""}</span>
										{:else if availability?.kind === "selectable" && availability.usagePct !== null}
											<QuotaMeter
												used={availability.usagePct}
												warnAt={usageState.limits.warnAt}
												caption={`${Math.round(availability.usagePct)}%`}
												variant="usage"
												trackWidth={26}
												gap={6}
												trackTestId="picker-account-meter"
												captionTestId="picker-account-usage"
											/>
										{:else}
											<span class="flex flex-wrap items-center gap-[6px] text-[10.5px] font-normal text-text-muted">
												{#if card.kind === "usage" && availability?.kind === "selectable"}<small data-testid="picker-account-usage" class="font-mono text-[10.5px]">—</small>{/if}
												<span data-testid="picker-account-caption">usage unknown</span>
											</span>
										{/if}
									</span>
								{/if}
							{/snippet}
						</OptionRow>
						{#if locked && canSwitchAccounts}
							<div data-testid="picker-account-note" class="mx-[4px] mt-[8px] border-t border-border-subtle pt-[6px] text-[10.5px] text-text-muted">You'll see what carries over before anything changes.</div>
						{/if}
					</section>
				{/if}
				{#if needsAccount}
					<div class="flex items-center justify-between gap-2 border-b border-border-subtle py-2 text-xs text-text-muted">
						<span>No {driverLabel(selectedDriver)} accounts yet.</span>
						<Button variant="ghost-accent" size="content" data-testid="picker-add-account-btn" onclick={() => { closePicker(); openSettings("server", "instances"); }}>Add account</Button>
					</div>
				{/if}
				{#if accountCards.length > 1}
					<div aria-hidden="true" class="mx-[8px] my-[4px] h-px bg-border-chip opacity-70"></div>
				{/if}

			{/snippet}
			{#snippet contextUsage()}
						{#if contextPercent > 0}
							<span data-testid="picker-context-usage" data-warning={contextWarning ? "true" : undefined} class="shrink-0 text-[11px] {contextWarning ? 'text-status-amber' : 'text-text-muted'}">{Math.round(contextPercent)}% used</span>
						{/if}
			{/snippet}
			{#snippet rootExtras()}
				{#if planLocked}
					<div data-testid="picker-row-agent" data-locked="plan" class="flex min-h-[36px] items-center gap-[10px] px-[10px] py-[6px] text-[13.5px] max-md:min-h-[50px]">
						<Icon name="user" size={16} class="shrink-0 text-text-muted" />
						<span class="flex-1">Agent</span>
						<span class="min-w-0 truncate text-text-secondary">Plan</span>
						<span class="shrink-0 text-[11px] text-text-dimmer">Set by approvals</span>
					</div>
				{:else if visibleAgents.length > 1}
					<Button
						variant="picker-row"
						size="content"
						layout="flow"
						data-testid="picker-row-agent"
						onclick={() => { view = "agent"; }}
					>
						<Icon name="user" size={16} class="shrink-0 text-text-muted" />
						<span class="flex-1">Agent</span>
						<span class="min-w-0 truncate text-text-secondary">{activeAgent ? agentLabel(activeAgent) : "Default"}</span>
						<Icon name="chevron-right" size={13} class="shrink-0 text-text-muted" />
					</Button>
				{:else if activeAgent}
					<div data-testid="picker-row-agent" class="flex min-h-[36px] items-center gap-[10px] px-[10px] py-[6px] text-[13.5px] max-md:min-h-[50px]">
						<Icon name="user" size={16} class="shrink-0 text-text-muted" />
						<span class="flex-1">Agent</span>
						<span class="min-w-0 truncate text-text-secondary">{agentLabel(activeAgent)}</span>
					</div>
				{/if}

			{/snippet}
			{#snippet extraView()}
				{#each visibleAgents as agent (agent.id)}
					{@const selected = agent.id === activeAgent?.id}
					<Button
						variant="picker-row"
						size="content"
						layout="flow"
						aria-pressed={selected}
						data-testid="picker-agent-{agent.id}"
						onclick={() => handleAgentSelect(agent)}
					>
						<Icon name="user" size={16} class="shrink-0 text-text-muted" />
						<span class="min-w-0 flex-1">
							<span class="block">{agentLabel(agent)}</span>
							{#if agent.description}<span class="block text-[12px] text-text-muted">{agent.description}</span>{/if}
						</span>
						{#if selected}<Icon name="check" size={16} class="text-accent" />{/if}
					</Button>
				{/each}

			{/snippet}
			{#snippet modelToolbar()}
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
			{/snippet}
			{#snippet modelNotice()}
					{#if locked}
						<div class="mx-[4px] my-1.5 flex items-start gap-2 rounded-[10px] bg-chip px-[10px] py-2 text-[12px] leading-[1.4] text-text-muted">
							<Icon name="lock" size={12} class="shrink-0" />
							<span>Harness fixed at creation — showing <b class="font-semibold text-text-secondary">{selectedLabel}</b> only. Model switching within it is allowed.</span>
						</div>
					{/if}

			{/snippet}
			{#snippet modelLabelSuffix(model: Immutable<ModelInfo>)}
{#if isDefaultModel(model)}<span class="ml-1 text-xs font-normal text-text-muted">(default)</span>{/if}
			{/snippet}
			{#snippet modelAction(model: Immutable<ModelInfo>)}
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
			{/snippet}
			{#snippet modelFooter()}
					<div class="mx-[4px] mt-1 border-t border-border pt-1">
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
			{/snippet}
		</ModelSelectionPanel>
	</Surface>
	</SheetChrome>
{/snippet}

{#snippet modelTrigger({ props, attention = false }: { props: Record<string, unknown>; attention?: boolean })}
	{#snippet summary()}
		{#if selectedDriver}<HarnessLogo driver={selectedDriver} instanceId={selectedLogoInstanceId} size={variant === "words" ? 15 : 18} surface="box" />{/if}
		<span class="model-label min-w-0 truncate">{displayName}</span>
		{#if phone && attention}<span data-testid="composer-more-attention" class="size-[6px] shrink-0 rounded-full bg-status-ask" aria-hidden="true"></span>{/if}
		{#if contextLabel}<span data-testid="picker-selected-context" class="shrink-0 {variant === 'words' ? '' : 'font-mono text-[11.5px] text-text-muted'}">{contextLabel}</span>{/if}
		{#if variant === "words"}
			{@const effortWord = parameters ? parameterEffortWord : effort.current}
			{#if effortWord}<span aria-hidden="true">·</span><span class="shrink-0">{effortWord}</span>{/if}
			<span aria-hidden="true">·</span>{@render phoneMode?.()}
		{/if}
		<span data-testid="model-chip-chevron" class="inline-flex shrink-0 {variant === 'words' ? 'text-text-dimmer' : 'text-text-muted'}"><Icon name="chevron-down" size={12} /></span>
	{/snippet}
	<Button
		{...props}
		bind:element={triggerEl}
		variant={variant === "words" ? "composer-summary" : "composer-model"}
		size={variant === "words" ? "content" : "composer-chip"}
		align="start"
		touchTarget
		data-testid={variant === "words" ? "composer-words-sheet-trigger" : "model-picker-trigger"}
		data-instance-id={selectedId}
		data-shown-harness={selectedDriver ?? ""}
		data-shown-provider={activeProviderId ?? ""}
		data-shown-model={activeModelId ?? ""}
		data-shown-effort={effort.current ?? ""}
		data-shown-context-window={selectedContext?.value ?? ""}
		data-shown-permission-mode={discoveryState.permissionMode}
		disabled={sessionLoading}
		class="model-btn max-w-full {phone && variant === 'words' ? 'w-full' : ''}"
		title="Switch model"
		ariaLabel={`${phone ? "Composer options" : "Harness and model"}: ${displayName}${contextLabel ? `, context ${contextLabel}` : ""}, ${wordAccountName}`}
		aria-haspopup="dialog"
		aria-expanded={phone ? props["aria-expanded"] === "true" || props["aria-expanded"] === true : pickerOpen}
		onclick={(event) => {
			if (phone && phoneControls) { if (typeof props["onclick"] === "function") props["onclick"](event); }
			else togglePicker(event);
		}}
	>
		{#if variant === "words"}
			<span data-part="summary" class="inline-flex min-w-0 items-center gap-[5px] rounded-[6px] group-focus-visible/composer-summary:outline-2 group-focus-visible/composer-summary:outline-offset-[3px] group-focus-visible/composer-summary:outline-text">{@render summary()}</span>
		{:else}
			{@render summary()}
		{/if}
		{#if variant === "words" && contextPercent > 0}<span data-testid="composer-word-context-usage" data-warning={contextWarning ? "true" : undefined} class="ml-auto shrink-0 pl-[8px]" class:text-status-ask={contextWarning}>{Math.round(contextPercent)}%</span>{/if}
	</Button>
{/snippet}

<div
	id="model-display"
	class="relative inline-flex min-w-0 items-center gap-[5px] {phone && variant === 'words' ? 'w-full' : 'flex-[0_1_auto]'}"
	use:dismiss={{ onDismiss: closePicker, enabled: pickerOpen && !phone }}
>
	{#if needsAccount}
		<Button variant="ghost-accent" size="content" class="shrink-0 gap-1 px-1.5 py-1 text-[11.5px]" data-testid="add-claude-account-btn" onclick={() => { closePicker(); openSettings("server", "instances"); }}><Icon name="plus" size={12} />Add account</Button>
	{/if}
	{#if variant === "words" && !phone}
		<Button
			bind:element={triggerEl}
			variant="composer-word"
			size="content"
			data-testid="composer-word-harness"
			class="shrink-0 mr-[6px]"
			ariaLabel={`Account: ${wordAccountName}. Open account options`}
			aria-haspopup="dialog"
			aria-expanded={pickerOpen}
			aria-controls={pickerOpen ? "model-picker" : undefined}
			onclick={(event) => togglePicker(event, "account")}
		>
			{#if selectedDriver}<HarnessLogo driver={selectedDriver} instanceId={selectedLogoInstanceId} size={15} surface="page" />{/if}
		</Button>
		{#if hasAccountWord}
			<Button
				variant="composer-word"
				size="content"
				data-testid="composer-word-account"
				class="min-w-[16px] text-[12px]"
				ariaLabel={`Account: ${wordAccountName}. Open account options`}
				aria-haspopup="dialog"
				aria-expanded={pickerOpen}
				aria-controls={pickerOpen ? "model-picker" : undefined}
				onclick={(event) => togglePicker(event, "account")}
			><span class="block min-w-0 truncate">{wordAccountName}{switchingTo ? "…" : ""}</span></Button>
			<span aria-hidden="true" class="text-text-dimmer">·</span>
		{/if}
		<Button
			variant="composer-word"
			size="content"
			data-testid="composer-word-model"
			data-instance-id={selectedId}
			data-shown-harness={selectedDriver ?? ""}
			data-shown-provider={activeProviderId ?? ""}
			data-shown-model={activeModelId ?? ""}
			data-shown-effort={effort.current ?? ""}
			data-shown-context-window={selectedContext?.value ?? ""}
			data-shown-permission-mode={discoveryState.permissionMode}
			disabled={sessionLoading}
			class="min-w-[16px] text-[12px]"
			title="Switch model"
			ariaLabel={`Model: ${displayName}. Open model options`}
			aria-haspopup="dialog"
			aria-expanded={pickerOpen}
			aria-controls={pickerOpen ? "model-picker" : undefined}
			onclick={(event) => togglePicker(event, "model")}
		>
			<span class="block min-w-0 truncate">{displayName}</span>
		</Button>
		{#if showContextWord}
			<span aria-hidden="true" class="text-text-dimmer">·</span>
			<Button
				variant="composer-word"
				size="content"
				data-testid="composer-word-context"
				class="shrink-0"
				ariaLabel={`Context window: ${contextLabel}. Open harness and model options`}
				aria-haspopup="dialog"
				aria-expanded={pickerOpen}
				aria-controls={pickerOpen ? "model-picker" : undefined}
				onclick={(event) => togglePicker(event, "model")}
			>
				<span>{contextLabel}</span>
			</Button>
		{/if}
		{#if effort.options.length > 0 || (sessionState.currentId && effort.current)}
			<span aria-hidden="true" class="text-text-dimmer">·</span>
		{/if}
	{:else if !phone || !phoneControls}
		{@render modelTrigger({ props: {} })}
	{/if}

	{#if phone && phoneControls}
		<!-- Keep the effort owner mounted so Ctrl+T also works with the sheet closed. -->
		<ModelVariant bind:this={variantRef} onOpen={closePicker} variant="row" wordLabel={parameters ? parameterEffortWord : undefined}>
			{#snippet children(effortRow)}
				{#snippet rows()}
					<Button
						variant="composer-row" size="content"
						data-testid="composer-harness-trigger"
						data-instance-id={selectedLogoInstanceId}
						ariaLabel={`Harness: ${driverLabel(selectedDriver)}, account: ${wordAccountName}. Open harness options`}
						aria-haspopup="dialog"
						onclick={(event) => togglePicker(event, "harness")}
					>
						<span data-part="label" class="w-[64px] shrink-0 text-[11px] text-text-muted">Harness</span>
						<span data-part="value" class="flex min-w-0 flex-1 items-center gap-[7px] font-semibold">{#if selectedDriver}<HarnessLogo driver={selectedDriver} instanceId={selectedLogoInstanceId} size={18} surface="surface" />{/if}<span class="min-w-0 truncate">{driverLabel(selectedDriver)}</span></span>
						<span data-part="chevron" class="inline-flex shrink-0 text-text-dimmer"><Icon name="chevron-right" size={10} /></span>
					</Button>
					<Button variant="composer-row" size="content" data-testid="composer-more-account" ariaLabel={`Account: ${wordAccountName}. Open account options`} onclick={(event) => togglePicker(event, "account")}>
						<span data-part="label" class="w-[64px] shrink-0 text-[11px] text-text-muted">Account</span>
						<span data-part="value" class="min-w-0 flex-1 truncate font-semibold">{wordAccountName}</span>
						<span data-part="chevron" class="inline-flex shrink-0 text-text-dimmer"><Icon name="chevron-right" size={10} /></span>
					</Button>
					<Button
						variant="composer-row" size="content"
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
				{@render phoneControls(rows, modelTrigger)}
			{/snippet}
		</ModelVariant>
	{:else}
		<ModelVariant bind:this={variantRef} onOpen={closePicker} variant={variant === "icons" ? "control" : variant} wordLabel={parameters ? parameterEffortWord : undefined} />
	{/if}
	{#if variant === "words" && !phone && selectedTraits?.composerModeControl === "agent"}
		<span aria-hidden="true" class="text-text-dimmer">·</span>
		<Button
			variant="composer-word"
			size="content"
			data-testid="composer-word-agent"
			class="shrink-0"
			ariaLabel={`Agent: ${activeAgent ? agentLabel(activeAgent) : "Default"}. Open agent options`}
			aria-haspopup="dialog"
			aria-expanded={pickerOpen}
			aria-controls={pickerOpen ? "model-picker" : undefined}
			onclick={(event) => togglePicker(event, "agent")}
		><span>{activeAgent ? agentLabel(activeAgent).toLowerCase() : "default"}</span></Button>
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
