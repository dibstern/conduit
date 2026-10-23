<!--
  SessionBar — the session's top bar on phones and desktop (design bar 20).

  One component for both layouts. On phones the expanded form has a row of
  back, the segmented group and overflow, then a title row; at the bottom of the transcript
  it floats as an island outside the layout. Desktop keeps one row regardless
  of position: title on the left, identity grouped with the controls on the right.

  You collapse by scrolling to the bottom and expand by scrolling up or by
  pressing the chevron. There is deliberately no collapse button: hiding chrome
  is never urgent, getting it back is.

  Phone geometry lives in style.css as a grid keyed on `data-collapsed`, so the
  title moves between rows without being re-parented and the <h1> never unmounts.

  The desktop overflow and phone sheet share the session command list and
  global actions.
-->

<script lang="ts">
	import { tick, untrack } from "svelte";
	import { isProcessing } from "../../stores/chat.svelte.js";
	import { discoveryState, getAvailableInstances } from "../../stores/discovery.svelte.js";
	import { instanceState } from "../../stores/instance.svelte.js";
	import { dismissGoalMet, goalDetails, goalView, isGoalMetDismissed, sessionGoals, type GoalComposerAction } from "../../stores/goal.svelte.js";
	import { getDescendantSessionIds } from "../../stores/permissions.svelte.js";
	import { projectState } from "../../stores/project.svelte.js";
	import {
		getCurrentSlug,
	} from "../../stores/router.svelte.js";
	import {
		forceBarOpen,
		isBarCollapsed,
		sessionViewState,
	} from "../../stores/session-view.svelte.js";
	import { findSession, getAttentionSessions, sessionAttention, sessionState } from "../../stores/session.svelte.js";
	import { backToSessions } from "../../utils/session-read.js";
	import { formatSnoozeTime, formatTimeAgo } from "../../utils/format.js";
	import { getSessionBarState, getWokenSessionText } from "../../utils/session-lifecycle.js";
	import type { GoalDetails, GoalSummary } from "../../transport/ws-rpc.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import { failureLine } from "../../transport/rpc-errors.js";
	import type { Immutable, SessionInfo } from "../../types.js";
	import Badge from "../ui/Badge.svelte";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuItem from "../ui/MenuItem.svelte";
	import MenuRadioGroup from "../ui/MenuRadioGroup.svelte";
	import Tooltip from "../ui/Tooltip.svelte";
	import Surface from "../ui/Surface.svelte";
	import Popover from "../ui/Popover.svelte";
	import SessionRenameInput from "../session/SessionRenameInput.svelte";
	import SessionSkillsChip from "../session/SessionSkillsChip.svelte";
	import BackgroundTasksPanel from "../session/BackgroundTasksPanel.svelte";
	import BackgroundTasksRow from "../session/BackgroundTasksRow.svelte";
	import SideThreadsPanel, { waitingMarker } from "../session/SideThreadsPanel.svelte";
	import { appBanners } from "../overlays/Banners.svelte";
	import BannersRow from "../overlays/BannersRow.svelte";
	import { stopBackgroundTasks, tasksPanel } from "../session/background-tasks.svelte.js";
	import { openSideThreads, sideThreadsPanel } from "../session/side-threads.svelte.js";
	import { getPinCommand, getPrimaryCommand, getSessionCommands, globalKeyHint, runSessionCommandShortcut, sessionCommandActions, sessionCommandKeys, sessionCommandKeysHint, type SessionCommand } from "../session/session-commands.js";
	import { uiState, expandSidebar } from "../../stores/ui.svelte.js";
	import { connectionState } from "../../transport/connection-status.svelte.js";
	import { chromeMenuActions } from "./chrome-actions.js";
	import SessionSheetFooter from "../session/SessionSheetFooter.svelte";
	import SessionSheetBody from "../session/SessionSheetBody.svelte";
	import SessionCommandItems from "../session/SessionCommandItems.svelte";
	import AutoSettleRow from "../session/AutoSettleRow.svelte";
	import { getProjectAccent } from "../session/session-list-project.js";
	import ViewCard from "../ui/ViewCard.svelte";
	import { activeSessionView, sessionViews } from "./session-views.js";

	let {
		getGoalDetails = (input) => rpc("GetGoalDetails", input),
		generateGoalSummary = (input) => rpc("GenerateGoalSummary", input),
	}: {
		getGoalDetails?: ((input: { sessionId: string }) => Promise<GoalDetails>) | undefined;
		generateGoalSummary?: ((input: { sessionId: string }) => Promise<GoalSummary>) | undefined;
	} = $props();

	// "New Session" matches session/SessionItem.svelte, so an untitled session
	// reads the same in the bar as it does in the list it came from.
	const session = $derived(findSession(sessionState.currentId ?? ""));
	const title = $derived(session?.title || "New Session");
	const goalFacts = $derived(discoveryState.currentTraits?.supportsGoalState ? sessionGoals.get(sessionState.currentId ?? "") : undefined);
	const goal = $derived(goalView(
		goalFacts,
		isProcessing() ? "busy" : session?.status ?? "idle",
	));
	const detailsGoal = $derived(goalFacts?.goal ?? goalFacts?.endedGoal);
	let goalSubtitleEl: HTMLButtonElement | HTMLAnchorElement | undefined = $state();
	let goalFocusHandedOff = false;
	const backgroundTasks = $derived(session?.backgroundTasks ?? []);
	const goalShown = $derived(goal.phase !== null && goal.phase !== "cleared" && !isGoalMetDismissed(goalFacts));
	// The family push carries the whole tree; prefer the versioned row, as busySessionIds does.
	const sideThreads = $derived.by(() => {
		const rows = new Map(sessionState.familySessions.map((row) => [row.id, row]));
		for (const row of sessionState.sessions.values()) rows.set(row.id, row);
		const lastActive = (row: Immutable<SessionInfo>) => new Date(row.updatedAt ?? row.createdAt ?? 0).getTime();
		return [...rows.values()]
			.filter((row) => row.sideThread && row.parentID === sessionState.currentId)
			.sort((a, b) => lastActive(b) - lastActive(a));
	});
	const sideThreadsLabel = $derived(sideThreads.length === 1 ? "1 Side Thread" : `${sideThreads.length} Side Threads`);
	const sideThreadsWaiting = $derived(waitingMarker(sideThreads));

	// Close the pull-downs when the session changes or its tasks end.
	$effect(() => {
		void sessionState.currentId;
		return () => {
			tasksPanel.open = false;
			sideThreadsPanel.open = false;
		};
	});
	$effect(() => {
		if (backgroundTasks.length === 0) tasksPanel.open = false;
	});

	let details: GoalDetails | null = $state(null);
	let detailsLoading = $state(false);
	let detailsFailed = $state("");
	let historyOpen = $state(false);
	let summaryLoading = $state(false);
	let summaryFailed = $state(false);
	let detailsContext = "";
	let summaryOnOpen = false;
	let summaryEpoch = 0;
	let detailsProjectSlug: string | null | undefined;
	const summary = $derived.by(() => details?.summary);
	const summaryEnabled = $derived.by(() => details?.summaryEnabled !== false);
	const latestCheck = $derived.by(() => goalFacts?.ended === "met" && detailsGoal
		? { at: details?.metAt ?? goalFacts.endedAt ?? detailsGoal.setAt, reason: detailsGoal.lastReason ?? details?.checks.at(-1)?.reason }
		: details?.checks.at(-1));
	const newCheckCount = $derived.by(() => summary ? (details?.checks.filter((check) => check.at > summary.generatedAt).length ?? 0) : (details?.checks.length ?? 0));
	const stuck = $derived(goalFacts?.goal ? session?.goalStuck : undefined);

	$effect(() => {
		const projectSlug = getCurrentSlug();
		if (detailsProjectSlug !== undefined && projectSlug !== detailsProjectSlug) {
			goalDetails.open = false;
		}
		detailsProjectSlug = projectSlug;
	});

	$effect(() => {
		if (!detailsGoal || goal.phase === "cleared" || isGoalMetDismissed(goalFacts)) goalDetails.open = false;
	});

	$effect(() => {
		const sessionId = sessionState.currentId;
		const facts = goalFacts;
		const currentGoal = facts?.goal ?? facts?.endedGoal;
		const open = goalDetails.open;
		void session?.goalStuck;
		return untrack(() => {
			const context = open && sessionId && currentGoal ? `${sessionId}:${currentGoal.setAt}:${currentGoal.condition}` : "";
			if (context !== detailsContext) {
				detailsContext = context;
				summaryEpoch++;
				details = null;
				detailsFailed = "";
				detailsLoading = false;
				historyOpen = false;
				summaryLoading = false;
				summaryFailed = false;
				summaryOnOpen = Boolean(context);
			}
			if (!context || !sessionId) return;
			let cancelled = false;
			detailsLoading = true;
			detailsFailed = "";
			void getGoalDetails({ sessionId }).then((result) => {
				if (cancelled) return;
				// A details read started before generation may carry the older cache.
				const cached = details?.summary;
				details = cached && cached.generatedAt > (result.summary?.generatedAt ?? 0)
					? { ...result, summary: cached }
					: result;
				const generate = summaryOnOpen;
				summaryOnOpen = false;
				if (generate && result.summaryEnabled !== false && result.checks.length && (!result.summary || result.summary.stale)) void updateGoalSummary();
			}).catch((error) => {
				if (!cancelled) detailsFailed = failureLine(error, "Could not load check history.");
			}).finally(() => {
				if (!cancelled) detailsLoading = false;
			});
			return () => { cancelled = true; };
		});
	});

	async function updateGoalSummary() {
		const sessionId = sessionState.currentId;
		if (!sessionId || !details?.checks.length || !summaryEnabled || summaryLoading) return;
		const epoch = summaryEpoch;
		summaryLoading = true;
		summaryFailed = false;
		try {
			const result = await generateGoalSummary({ sessionId });
			if (epoch === summaryEpoch && details && result.generatedAt > (details.summary?.generatedAt ?? 0)) details = { ...details, summary: result };
		} catch {
			if (epoch === summaryEpoch) summaryFailed = true;
		} finally {
			if (epoch === summaryEpoch) summaryLoading = false;
		}
	}

	function goalDuration(milliseconds: number, short = false): string {
		const minutes = Math.max(1, Math.floor(milliseconds / 60_000));
		const hours = Math.floor(minutes / 60);
		const part = (value: number, unit: string) => short ? `${value} ${unit === "hour" ? "hr" : "min"}` : `${value} ${unit}${value === 1 ? "" : "s"}`;
		return hours ? `${part(hours, "hour")}${minutes % 60 ? ` ${part(minutes % 60, "minute")}` : ""}` : part(minutes, "minute");
	}

	function goalTokens(tokens: number): string {
		if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(2))}M`;
		if (tokens >= 1_000) return `${Number((tokens / 1_000).toFixed(1))}K`;
		return String(tokens);
	}

	function goalClock(at: number): string {
		return new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
	}

	function closeGoalDetails(returnFocus = false) {
		goalFocusHandedOff = !returnFocus;
		goalDetails.open = false;
		if (returnFocus && !sessionViewState.compact) goalSubtitleEl?.focus();
	}

	function handleGoalDetailsKeydown(event: KeyboardEvent) {
		if (event.key !== "Escape" || (!goalDetails.open && !tasksPanel.open && !sideThreadsPanel.open) || uiState.confirmDialog) return;
		if (goalDetails.open && sessionViewState.compact && !tasksPanel.open && !sideThreadsPanel.open) return;
		if (sideThreadsPanel.open && sessionViewState.compact) return;
		event.preventDefault();
		event.stopPropagation();
		if (sideThreadsPanel.open) {
			sideThreadsPanel.open = false;
			document.getElementById("side-threads-control")?.focus();
		} else if (tasksPanel.open) {
			if (sessionViewState.compact) forceBarOpen();
			tasksPanel.open = false;
			document.querySelector<HTMLElement>("[data-testid='background-tasks-toggle'], button[data-testid='background-tasks-row']")?.focus();
		} else closeGoalDetails(true);
	}

	function runGoalAction(action: GoalComposerAction["action"]) {
		const sessionId = sessionState.currentId;
		if (!sessionId || !detailsGoal) return;
		if (action === "edit" || action === "new") closeGoalDetails();
		window.dispatchEvent(new CustomEvent<GoalComposerAction>("composer:goal", {
			detail: { action, sessionId, condition: detailsGoal.condition },
		}));
	}
	const woke = $derived(session?.pinnedAt == null && getSessionBarState(session, sessionState.now)?.kind === "woke");
	const stateChip = $derived.by(() => {
		const chip = getSessionBarState(session, sessionState.now);
		if (sessionViewState.compact) return chip;
		if (session?.pinnedAt != null) return { kind: "pinned" as const, label: "Pinned", icon: "pin" };
		if (chip?.kind === "woke") return null;
		if (chip?.kind === "snoozed") return { ...chip, label: "Snoozed" };
		if (chip?.kind === "auto-settled") return { ...chip, label: "Settled", icon: "zap" };
		return chip;
	});
	const primaryCommand = $derived.by((): SessionCommand | undefined => {
		if (!session) return undefined;
		if (sessionViewState.compact) return getPrimaryCommand(session, sessionState.now);
		// The Pinned chip already carries the state; Unpin is a plain segment, as in the design.
		if (session.pinnedAt != null) return { ...getPinCommand(session), emphasis: undefined };
		if (stateChip?.kind === "snoozed") return {
			testId: "session-bar-snooze-time", section: "triage", icon: "moon",
			label: session.snoozedUntil == null ? "Until something happens" : `Until ${formatSnoozeTime(session.snoozedUntil, sessionState.now)}`,
			run: () => { stateMenuOpen = true; },
		};
		if (goal.phase === "checking") return undefined;
		if (goalFacts?.goal && goal.phase !== "paused") return { ...getPinCommand(session), emphasis: "primary" };
		if (woke) return undefined;
		return getPrimaryCommand(session, sessionState.now);
	});
	const goalButtonTone = $derived(goal.phase === "met" ? "goal-met" : stuck || (!sessionViewState.compact && goal.phase === "paused") ? "goal-paused" : "goal");
	const desktopGoalLabel = $derived(goal.phase === "met" ? "Goal met" : goal.phase === "paused" ? "Paused" : stuck ? "Stuck" : goal.phase === "checking" ? "Checking" : "Pursuing");
	const goalIcon = $derived(goal.phase === "met" ? "circle-check" : goal.phase === "paused" ? "pause" : stuck ? "circle-alert" : goal.phase === "checking" ? "loader-circle" : "target");
	const statusTitle = $derived(connectionState.statusText || "Connecting");
	const statusClass = $derived.by(() => {
		switch (connectionState.status) {
			case "connected": return "bg-success";
			case "processing": return "bg-success animate-[pulse-dot_1.2s_ease-in-out_infinite]";
			case "error": return "bg-error";
			default: return "bg-text-muted";
		}
	});

	const project = $derived(projectState.projects.find((p) => p.slug === getCurrentSlug()));
	const sessionInstanceId = $derived(session?.accountId);
	const sessionInstance = $derived(getAvailableInstances().find((instance) => instance.id === sessionInstanceId));
	const supportsTaskStop = $derived((
		sessionInstance?.capabilities?.supportsTaskStop
			?? instanceState.providerCapabilities[sessionInstance?.driver ?? ""]?.supportsTaskStop
	) === true);

	const attentionCount = $derived(
		getAttentionSessions(sessionState.currentId, getDescendantSessionIds).size,
	);

	const activeView = $derived(activeSessionView());
	const collapsed = $derived(isBarCollapsed() && activeView === "chat" && !goalDetails.open && !sideThreadsPanel.open && !tasksPanel.open);
	const viewBadgeCount = $derived(
		sessionViews.reduce((total, view) => total + (view.badge?.() ?? 0), 0),
	);
	// The island is phone-only, so its commands and the keyboard share one list.
	const commands = $derived(session
		? getSessionCommands(session, sessionState.now, { rename: async () => { forceBarOpen(); await tick(); renaming = true; } }, sessionViewState.compact ? "sheet" : "center")
		: []);
	const snoozeCommand = $derived(commands.find((item) => item.testId === "session-ctx-snooze"));
	const globalActions = $derived(chromeMenuActions());

	function handleSessionShortcut(event: KeyboardEvent) {
		if (event.defaultPrevented || goalDetails.open) return;
		const global = (event.metaKey || event.ctrlKey) && event.shiftKey;
		if (!global) {
			// Plain letters act on the open session only from the transcript.
			const target = event.target;
			if (!(target instanceof HTMLElement) || !target.closest("#messages") || target.isContentEditable || target.closest("input, textarea, select")) return;
		}
		runSessionCommandShortcut(event, commands);
	}

	let barEl: HTMLElement | null = $state(null);

	function showControls() {
		forceBarOpen();
		// Expanding unmounts the chevron that was just pressed, which would drop
		// focus to <body> — the change would read to a screen reader as the
		// control disappearing. Moving focus to the bar instead announces the
		// region by name, so it reads as a state change.
		barEl?.focus();
	}

	let overflowOpen = $state(false);
	let overflowOpener: HTMLElement | null = null;
	// A selected phone action may open a dialog or move focus itself.
	let overflowSelected = false;
	function selectOverflow(action: (returnFocus?: () => HTMLElement | null) => void) {
		if (sessionViewState.compact) overflowSelected = true;
		overflowOpen = false;
		action(() => overflowOpener?.isConnected ? overflowOpener : null);
	}
	let stateMenuOpen = $state(false);
	let statePickingTime = false;
	let renaming = $state(false);
	// The two layouts anchor their menus differently, so crossing the
	// breakpoint closes any open one rather than leaving it floating.
	$effect(() => {
		void sessionViewState.compact;
		void sessionState.currentId;
		stateMenuOpen = false;
		overflowOpen = false;
	});

</script>

<svelte:window onkeydown={handleSessionShortcut} onkeydowncapture={handleGoalDetailsKeydown} />

{#if goalDetails.open && detailsGoal}
	{#if !sessionViewState.compact}<Button variant="scrim-clear" size="content" tabindex={-1} ariaLabel="Close goal details" data-testid="goal-details-scrim" class="fixed inset-0 z-[var(--z-dropdown)]" onclick={() => closeGoalDetails(true)} />{/if}
{:else if tasksPanel.open && backgroundTasks.length > 0 && !sessionViewState.compact}
	<Button variant="scrim-clear" size="content" tabindex={-1} ariaLabel="Close background tasks" data-testid="background-tasks-scrim" class="fixed inset-0 z-[var(--z-dropdown)]" onclick={() => { tasksPanel.open = false; }} />
{:else if sideThreadsPanel.open && !sessionViewState.compact}
	<Button variant="scrim-clear" size="content" tabindex={-1} ariaLabel="Close Side Threads" data-testid="side-threads-scrim" class="fixed inset-0 z-[var(--z-dropdown)]" onclick={() => { sideThreadsPanel.open = false; }} />
{/if}

{#snippet viewCards()}
	<MenuRadioGroup value={activeView} aria-label="Views" class="grid grid-cols-4 gap-[8px]">
		{#each sessionViews as view (view.id)}
			<ViewCard value={view.id} preview={view.id} label={view.label} icon={view.icon} badge={view.badge?.()} disabled={view.disabled === true} data-testid={`overflow-view-${view.id}`} onselect={view.select} />
		{/each}
	</MenuRadioGroup>
{/snippet}

{#snippet overflowMenu()}
	<Menu
		bind:open={overflowOpen}
		onopenchange={(open) => { if (open) { overflowSelected = false; if (sessionViewState.compact) forceBarOpen(); } }}
		presentation={sessionViewState.compact ? "sheet" : "popover"}
		sheetEdge="top"
		portalTo={sessionViewState.compact ? "#session-bar" : undefined}
		appearance="final"
		class={sessionViewState.compact ? undefined : "w-[340px] max-w-[calc(100vw-16px)]"}
		ariaLabel="More actions"
		align="end"
		onCloseAutoFocus={(event) => {
			if (overflowSelected) { event.preventDefault(); return; }
			const opener = overflowOpener;
			if (opener?.isConnected) {
				event.preventDefault();
				// Yield to an item that moved focus on purpose: the Terminal view
				// focuses xterm once its lazily loaded tab mounts, which can land
				// either side of this restore. The phone sheet keeps focus while it
				// glides away.
				setTimeout(() => {
					requestAnimationFrame(() => {
						const active = document.activeElement;
						if (!overflowOpen && opener.isConnected && (active === document.body || active?.closest("[data-dropdown-menu-content]"))) opener.focus();
					});
				}, 0);
			}
		}}
		data-testid={sessionViewState.compact ? "session-bar-island-menu" : "session-bar-overflow-menu"}
		footer={overflowFooter}
	>
		{#snippet trigger({ props })}
			<Button
				{...props}
				id="session-bar-more"
				variant="menu-trigger"
				size={collapsed ? "touch-pill" : "phone-header-icon"}
				icon="ellipsis"
				iconSize={sessionViewState.compact ? 14 : 16}
				touchTarget="always"
				class="relative shrink-0"
				title="More actions"
				ariaLabel="More actions"
				aria-describedby={sessionViewState.compact && viewBadgeCount > 0 ? "session-bar-view-badge" : undefined}
				data-testid={sessionViewState.compact ? "session-bar-island-overflow" : "session-bar-overflow"}
				onpointerdowncapture={(event) => { overflowOpener = event.currentTarget as HTMLElement; }}
				onkeydowncapture={(event) => { overflowOpener = event.currentTarget as HTMLElement; }}
			>
				{#if sessionViewState.compact && viewBadgeCount > 0}
					<Badge variant="accent-solid" size="indicator" shape="pill" id="session-bar-view-badge" data-testid="session-bar-view-badge" class="pointer-events-none absolute right-0 top-0">{viewBadgeCount}<span class="sr-only"> unread view updates</span></Badge>
				{/if}
			</Button>
		{/snippet}

		{#if sessionViewState.compact}
			{#if session}
				<SessionSheetBody {commands} now={sessionState.now} header={{ session, projectLabel: project?.title ?? getCurrentSlug() ?? undefined, projectAccent: getProjectAccent(session), branch: session.git?.branch }} views={viewCards} onselect={selectOverflow} />
			{:else}
				<div class="px-[16px] pt-[8px]">{@render viewCards()}</div>
			{/if}
		{:else if session}
			<div class="px-[4px] pb-[6px]">
				<SessionCommandItems {commands} {session} now={sessionState.now} presentation="popover" settleShortcutTag={globalKeyHint(sessionCommandKeys.settle.global)} onselect={selectOverflow} />
			</div>
		{/if}
	</Menu>
{/snippet}

{#snippet overflowFooter()}
	<SessionSheetFooter extras={globalActions.map((action) => ({ ...action, testId: `overflow-${action.id}` }))} onselect={selectOverflow} />
{/snippet}

{#snippet goalContent()}
	{#if detailsGoal && goalFacts}
		<div class={sessionViewState.compact ? "pt-[2px]" : ""}>
			<Badge variant={goal.phase === "met" ? "success" : stuck ? "warning" : "goal"} shape="pill" size="session"><Icon name={goalIcon} size={12} class={goalIcon === "loader-circle" ? "motion-safe:animate-spin" : ""} />{desktopGoalLabel}</Badge>
			<h2 id="goal-details-title" data-testid="goal-details-condition" class="mt-[10px] mb-[4px] text-[15px] font-semibold leading-[1.35] tracking-[-0.01em]">{detailsGoal.condition}</h2>
			<p data-testid="goal-details-meta" class="m-0 font-mono text-[10.5px] text-text-dimmer">Set {goalClock(details?.setAt ?? detailsGoal.setAt)}{details?.judgeModel ? ` · ${details.judgeModel} judges` : ""}{#if details?.tokensSinceStart != null}<span data-testid="goal-details-tokens">{" · "}{goalTokens(details.tokensSinceStart)} tokens</span>{/if}</p>
		</div>
		<div class="my-[12px] border-t border-border-chip"></div>
		{#if stuck}
			<div data-testid="goal-details-stuck" class="mb-[12px] rounded-[12px] border border-warning/30 bg-warning/5 px-[12px] py-[10px]">
				<b class="text-[13.5px] font-semibold text-warning">{goal.phase === "paused" ? `Paused after ${goalDuration(stuck.lastAt - stuck.since)} stuck` : `Stuck for ${goalDuration(stuck.lastAt - stuck.since)}`}</b>
				<p class="mt-[3px] mb-0 text-[12.5px] leading-[1.45] text-text-secondary">{goal.phase === "paused" ? `Checks stopped after ${stuck.count} found the same blocker. Resume once it is fixed.` : `${stuck.count} checks in a row found the same blocker.`}</p>
			</div>
		{/if}
		<div data-testid="goal-details-summary" aria-live="polite" aria-atomic="true">
			{#if details?.checks.length}
				<div class="mb-[6px] flex flex-wrap items-baseline justify-between gap-x-[8px] gap-y-[4px]">
					<h3 class="m-0 text-[14px] font-semibold">{!summaryEnabled ? "Latest check" : goal.phase === "met" ? "How it ended" : "Where it stands"}</h3>
					<span data-testid="goal-details-summary-label" class="inline-flex items-center gap-[5px] font-mono text-[10.5px] text-text-dimmer">
						{#if !summaryEnabled}{latestCheck ? goalClock(latestCheck.at) : ""}
						{:else if summaryLoading}<Icon name="loader-circle" size={11} class="motion-safe:animate-spin" />{summary ? `Updating · ${newCheckCount} new checks` : `Summarising ${detailsGoal.iterations} checks`}
						{:else if summaryFailed}Couldn't summarise · <Button variant="ghost" size="content" tone="accent" touchTarget={sessionViewState.compact ? "always" : true} data-testid="goal-details-retry" onclick={updateGoalSummary}>Retry</Button>
						{:else if !summary || summary.stale}<Button variant="ghost" size="content" tone="accent" touchTarget={sessionViewState.compact ? "always" : true} data-testid="goal-details-update" onclick={updateGoalSummary}>{newCheckCount > 1 ? `${newCheckCount} new checks` : "New check"} · Update</Button>
						{:else if summary}Summary · {goalClock(summary.generatedAt)}{newCheckCount > 0 ? " · still current" : ""}{/if}
					</span>
				</div>
				{#if summaryEnabled && summaryLoading && !summary}
					<div data-testid="goal-details-summary-skeleton" aria-hidden="true" class="flex flex-col gap-[8px] py-[3px] motion-safe:animate-pulse"><div class="h-[11px] w-[96%] rounded-full bg-chip"></div><div class="h-[11px] w-[88%] rounded-full bg-chip"></div><div class="h-[11px] w-[58%] rounded-full bg-chip"></div></div>
				{:else}
					<p data-testid="goal-details-summary-body" class="m-0 whitespace-pre-wrap text-[13px] leading-[1.5] {summaryEnabled && summaryLoading ? 'text-text-dimmer' : 'text-text-secondary'}">{summaryEnabled && summary ? summary.text : latestCheck?.reason ?? detailsGoal.lastReason ?? ""}</p>
				{/if}
			{:else if detailsLoading && !details}<p class="m-0 text-text-muted">Loading goal details…</p>{/if}
		</div>
		{#if detailsFailed}<p role="status" class="mt-[8px] mb-0 text-error">{detailsFailed}</p>{/if}
		<div class="mt-[10px] flex items-center justify-between gap-[8px] text-[12px] text-text-dimmer">
			<span data-testid="goal-details-foot" class="inline-flex items-center gap-[5px]">
				{#if goal.phase === "checking"}<Icon name="loader-circle" size={12} class="motion-safe:animate-spin text-status-goal" /><span class="text-status-goal">Checking{details?.turnCount != null ? ` after turn ${details.turnCount}` : ""}</span>
				{:else}{detailsGoal.iterations} checks · {#if goal.phase === "paused"}paused {goalClock(latestCheck?.at ?? detailsGoal.setAt)}{:else if goal.phase === "met"}met {goalClock(details?.metAt ?? goalFacts.endedAt ?? detailsGoal.setAt)}{:else}{goalDuration(sessionState.now - (details?.setAt ?? detailsGoal.setAt), true)}{/if}{/if}
			</span>
			<Button variant="ghost" size="content" tone="accent" touchTarget={sessionViewState.compact ? "always" : true} aria-expanded={historyOpen} aria-controls="goal-details-history" data-testid="goal-details-history-toggle" onclick={() => { historyOpen = !historyOpen; }}>History {historyOpen ? "⌄" : "›"}</Button>
		</div>
		{#if historyOpen}
		<ol id="goal-details-history" data-testid="goal-details-history" class="mt-[10px] mb-0 flex list-none flex-col gap-[5px] p-0">
			{#if goal.phase === "checking"}
				<li data-testid="goal-details-check" class="desktop-goal-check"><Icon name="loader-circle" size={13} class="mt-[2px] motion-safe:animate-spin text-status-goal" /><span><b>Checking</b>{details?.turnCount != null ? ` · after turn ${details.turnCount}` : ""}</span><time class="text-text-dimmer">now</time></li>
			{:else if goalFacts.ended === "met"}
				<li data-testid="goal-details-check" class="desktop-goal-check"><Icon name="circle-check" size={13} class="text-success" /><span><b>Met</b>{detailsGoal.lastReason ? ` · ${detailsGoal.lastReason}` : ""}</span><time class="text-text-dimmer">{goalFacts.endedAt == null ? "" : goalClock(goalFacts.endedAt)}</time></li>
			{/if}
			{#each [...(details?.checks ?? [])].reverse() as check (check.iteration)}
				<li data-testid="goal-details-check" class="desktop-goal-check"><Icon name="circle-x" size={13} class="mt-px text-text-dimmer" /><span><b>Not yet</b>{check.reason ? ` · ${check.reason}` : ""}{#if check.turnIndex != null}<small class="text-[11px] text-text-dimmer" class:block={!sessionViewState.compact} class:whitespace-nowrap={sessionViewState.compact}>{sessionViewState.compact ? " · " : ""}After turn {check.turnIndex}</small>{/if}</span><time class="text-text-dimmer">{goalClock(check.at)}</time></li>
			{/each}
		{#if detailsLoading}
			<li role="status" class="goal-details-check"><span class="col-span-full text-text-muted">Loading checks…</span></li>
		{:else if detailsFailed}
			<li role="status" class="goal-details-check"><span class="col-span-full text-status-red">{detailsFailed}</span></li>
		{:else if !details?.checks.length && goal.phase !== "checking" && goal.phase !== "met"}
			<li class="goal-details-check"><span class="col-span-full">No checks yet. The first runs when Claude finishes a turn.</span></li>
		{/if}
		</ol>
		{/if}
	<div class="flex gap-[8px] mt-[16px] pb-[4px]">
		{#if goalFacts.goal}
			<Button variant={stuck || goal.phase === "paused" ? "primary" : "chip"} size={sessionViewState.compact ? "phone-card-action" : "card-action"} icon={goal.phase === "paused" ? "play" : "pause"} iconSize={13} touchTarget={sessionViewState.compact ? "always" : true} data-testid={goal.phase === "paused" ? "goal-details-resume" : "goal-details-pause"} onclick={() => runGoalAction(goal.phase === "paused" ? "resume" : "pause")}>{goal.phase === "paused" ? "Resume" : "Pause"}</Button>
			<Button variant="chip" size={sessionViewState.compact ? "phone-card-action" : "card-action"} tone="secondary" icon="pencil" iconSize={13} touchTarget={sessionViewState.compact ? "always" : true} data-testid="goal-details-edit" onclick={() => runGoalAction("edit")}>Edit</Button>
			<Button variant="danger-soft" size={sessionViewState.compact ? "phone-card-action" : "card-action"} tone="error" touchTarget={sessionViewState.compact ? "always" : true} class="ml-auto" data-testid="goal-details-clear" onclick={() => runGoalAction("clear")}>Clear goal</Button>
		{:else if goalFacts.ended === "met"}
			<Button variant="primary" size={sessionViewState.compact ? "phone-card-action" : "card-action"} touchTarget={sessionViewState.compact ? "always" : true} data-testid="goal-details-new" onclick={() => runGoalAction("new")}>Set a new goal</Button>
			<Button variant="chip" size={sessionViewState.compact ? "phone-card-action" : "card-action"} touchTarget={sessionViewState.compact ? "always" : true} class="ml-auto" data-testid="goal-details-dismiss" onclick={() => { if (goalFacts) dismissGoalMet(goalFacts); closeGoalDetails(); }}>Dismiss</Button>
		{/if}
	</div>
	{/if}
{/snippet}

{#snippet goalLine(props: Record<string, unknown> = {})}
	<Button variant="ghost" size={sessionViewState.compact ? "phone-subtitle" : "subtitle"} touchTarget={sessionViewState.compact ? "always" : false} layout="block" align="start" tone={goalButtonTone} hoverFill="none" bind:element={goalSubtitleEl} data-testid="session-goal-subtitle" aria-expanded={goalDetails.open} aria-controls="goal-details" title={goal.phase === "paused" ? `${goal.subtitle} · ${goalFacts?.pausedReason}` : goal.subtitle} class={sessionViewState.compact ? "" : "mt-[1px]"} onclick={() => { tasksPanel.open = false; sideThreadsPanel.open = false; goalDetails.open = !goalDetails.open; }} {...props}>
		<Icon name={goalIcon} size={12} class="shrink-0 {goalIcon === 'loader-circle' ? 'motion-safe:animate-spin' : ''}" />
		<b class="shrink-0 font-medium">{desktopGoalLabel}</b>{" "}<span class="min-w-0 truncate text-text-secondary">· {detailsGoal?.condition}</span>
	</Button>
{/snippet}

<!-- One border for the session controls. -->
{#snippet identityBlock()}
	<div id="session-bar-meta" class="flex min-w-0 items-center gap-2">
		<Surface variant="capsule" radius="none" class="session-bar-segments" data-testid="session-controls-pill">
			<SessionSkillsChip presentation={sessionViewState.compact ? "sheet" : "popover"} />
			{#if sideThreads.length > 0 && !session?.sideThread}
				<Button id="side-threads-control" variant="ghost" size={sessionViewState.compact ? "phone-capsule-segment" : "capsule-segment"} icon="messages-square" touchTarget={sessionViewState.compact ? "always" : true} class="shrink-0" ariaLabel={sideThreadsLabel} title={sideThreadsLabel} aria-expanded={sideThreadsPanel.open} aria-controls="side-threads-panel" data-testid="side-threads-control" onclick={() => openSideThreads(!sideThreadsPanel.open)}>
					{sideThreads.length}
					{#if !sessionViewState.compact}<span class="segment-word">{sideThreads.length === 1 ? "side thread" : "side threads"}</span>{/if}
					{#if sideThreadsWaiting}<span data-testid="side-threads-waiting" class="inline-flex {sideThreadsWaiting.colour}"><Icon name={sideThreadsWaiting.icon} size={11} /></span>{/if}
					{#if sideThreads.some((row) => sessionAttention(row) === "done-unread")}<span data-testid="side-threads-unread-dot" class="size-[7px] shrink-0 rounded-full bg-accent" aria-hidden="true"></span>{/if}
				</Button>
			{/if}
			{#if primaryCommand}
				<Tooltip side="bottom">
					{#snippet trigger({ props })}<Button
						{...props}
						id="session-bar-settle"
						variant={primaryCommand.emphasis === "primary" ? "capsule-primary" : "ghost"}
						size={sessionViewState.compact ? "phone-capsule-segment" : "capsule-segment"}
						icon={primaryCommand.icon ?? "check"}
						touchTarget={sessionViewState.compact ? "always" : true}
						class="shrink-0"
						disabled={primaryCommand.disabledReason != null}
						title={primaryCommand.disabledReason ?? undefined}
						ariaLabel={primaryCommand.disabledReason ? `${primaryCommand.label}: ${primaryCommand.disabledReason}` : primaryCommand.label}
						data-testid="session-bar-settle"
						data-emphasis={primaryCommand.emphasis}
						onclick={() => primaryCommand.run()}
					><span id="session-bar-settle-label">{primaryCommand.label}</span></Button>{/snippet}
					{#snippet children()}{primaryCommand.label}{#if primaryCommand.keys}<span class="shortcut-hint ml-2 text-text-muted" aria-hidden="true">{sessionCommandKeysHint(primaryCommand.keys)}</span>{/if}{/snippet}
				</Tooltip>
			{:else if woke && session && !sessionViewState.compact && !goalFacts?.goal}
				<span data-testid="session-bar-woke" class="inline-flex h-[24px] items-center gap-[5px] px-[10px] text-[12.5px] font-medium text-text-secondary"><Icon name="clock" size={13} />{getWokenSessionText(session)}</span>
			{/if}
		</Surface>
	</div>
{/snippet}

<div
	id="session-bar"
	data-testid="session-bar"
	data-collapsed={collapsed}
	data-compact={sessionViewState.compact}
	role="region"
	aria-label="Session controls"
	tabindex="-1"
	bind:this={barEl}
	class="relative shrink-0 {sessionViewState.compact ? 'bg-bg-surface' : 'bg-bg'} border-b border-border-subtle outline-none {goalDetails.open || tasksPanel.open || sideThreadsPanel.open ? 'z-[var(--z-sheet)]' : ''}"
>
	<!-- The labelled pill becomes a chevron and adjacent count in the island. -->
	{#if sessionViewState.compact || uiState.sidebarCollapsed}
	<Button
		id="session-bar-back"
		variant={collapsed ? "ghost" : "chip"}
		size={sessionViewState.compact ? collapsed ? "navigation-pill" : "phone-navigation" : "session-navigation"}
		touchTarget="always"
		icon="chevron-left"
		iconSize={sessionViewState.compact ? 14 : 16}
		class="shrink-0"
		data-testid="session-bar-back"
		onclick={sessionViewState.compact ? backToSessions : expandSidebar}
	>
		<span>Sessions</span>
		{#if attentionCount > 0}
			<Badge
				variant="ask-solid"
				size="navigation-count"
				shape="pill"
				data-testid="session-bar-attention"
			>
				{attentionCount}
			</Badge>
		{/if}
	</Button>
	{/if}

	{#if sessionViewState.compact}
		{@render identityBlock()}
	{/if}

	<!-- The session title, and the only string in the bar allowed to ellipse. It
	     is the page heading on a phone; the global header's <h1> is suppressed at
	     this width, so there is still exactly one — and there is still exactly
	     one across the collapse, because this is the same element in both
	     layouts.

	     Collapsed it drops a size: the row shares its width with the state
	     glyph and two 44px controls.

	     Session actions are available from the overflow in both layouts.
	     The collapsed row keeps its separate chevron for expanding the bar. -->
	{#if sessionViewState.compact || session}
	<div id="session-bar-title-row" class="flex min-w-0 flex-col justify-center">
	<div class="flex min-w-0 items-center {sessionViewState.compact ? 'gap-[3px]' : 'gap-1.5'}">
		<div class="min-w-0">
		<div class="flex min-w-0 items-center">
		<h1
			id="session-bar-title"
			data-testid="session-bar-title"
			class="min-w-0 truncate font-semibold leading-tight text-text"
			class:text-lg={!collapsed}
			class:text-base={collapsed}
		>
			{#if renaming && session}
				<SessionRenameInput {session} onend={() => { renaming = false; }} class="min-h-[44px] md:min-h-0" />
			{:else}<span class="block truncate">{title}</span>{/if}
		</h1>
		</div>
		{#if goalShown && !sessionViewState.compact}{@render goalLine()}{/if}
		<!-- Collapsed, the full banner strip is hidden (style.css); this line stands in. -->
		{#if collapsed}<BannersRow banners={appBanners()} onexpand={showControls} />{/if}
		</div>
		{#if session?.unread === true && !collapsed}
			<Menu appearance="final" ariaLabel="Unread session options" align="end" data-testid="session-bar-unread-menu">
				{#snippet trigger({ props })}
					<Button {...props} variant="ghost" size="phone-status" touchTarget="always" hoverFill="none" class="group shrink-0" ariaLabel="Unread — open options" data-testid="session-bar-unread-chip">
						<Badge variant="accent" shape="pill" size="session" interactive>
							<span class="size-[7px] shrink-0 rounded-full bg-accent" aria-hidden="true"></span>Unread
						</Badge>
					</Button>
				{/snippet}
				<MenuItem data-testid="session-bar-unread-mark-read" onselect={() => void sessionCommandActions.markRead(session)}>Mark read</MenuItem>
			</Menu>
		{/if}
		{#if stateChip && session && !collapsed}
			{#if stateChip.kind === "woke"}
				<Badge variant="quiet" shape="pill" size="sm" class="shrink-0" data-testid="session-bar-state-chip" data-state="woke" title={stateChip.label}>
					<Icon name={stateChip.icon} size={13} class="text-accent" />
					<span class="desktop-state-label">{stateChip.label}</span>
				</Badge>
			{:else}
				<Menu bind:open={stateMenuOpen} onopenchange={(open) => { if (open) statePickingTime = false; }} onCloseAutoFocus={(event) => { if (statePickingTime) event.preventDefault(); }} appearance="final" ariaLabel="Session state options" align="start" class={stateChip.kind === "snoozed" && !sessionViewState.compact ? "w-[340px] max-w-[calc(100vw-16px)]" : undefined} data-testid="session-bar-state-menu">
					{#snippet trigger({ props })}
						<Button {...props} variant="ghost" size="phone-status" touchTarget="always" class="shrink-0" ariaLabel={`${stateChip.label} — open options`} data-testid="session-bar-state-chip" data-state={stateChip.kind}>
							<Badge variant={stateChip.kind === "snoozed" ? "snoozed" : stateChip.kind === "pinned" ? "pinned" : "success"} shape="pill" size="session">
							<Icon name={stateChip.icon} size={13} class={sessionViewState.compact ? (stateChip.kind === "snoozed" ? "text-status-snoozed" : "text-success") : ""} />
								<span class="desktop-state-label">{stateChip.label}</span>
							</Badge>
						</Button>
					{/snippet}
					<div class="flex items-center gap-[7px] px-[10px] py-[8px] text-[13px] font-semibold text-text">
						{#if stateChip.kind === "snoozed"}
							<Icon name="moon" size={14} class="text-status-snoozed" />
							{session.snoozedUntil == null ? "Snoozed · no timer" : `Snoozed until ${formatSnoozeTime(session.snoozedUntil, sessionState.now)}`}
							{#if !sessionViewState.compact}
								<MenuItem variant="selected" closeOnSelect icon="undo" data-testid="session-bar-wake" class="ml-auto" onselect={() => void sessionCommandActions.unsnooze(session)}>Unsnooze</MenuItem>
							{/if}
						{:else if stateChip.kind === "pinned"}
							Pinned to top
						{:else}
							{stateChip.label} {formatTimeAgo(session.settledAt)}
						{/if}
						{#if stateChip.kind === "auto-settled"}
							<div class="mt-1 font-normal text-text-dimmer">Settled automatically after it sat idle</div>
						{/if}
					</div>
					{#if stateChip.kind === "snoozed"}
						{#if sessionViewState.compact}<MenuItem data-testid="session-bar-wake" onselect={() => void sessionCommandActions.unsnooze(session)}>
							<Icon name="undo" size={13} /><span>Wake now</span>
						</MenuItem>{:else}
							<div class="px-[10px] pt-[8px] pb-[6px] text-[12.5px] font-medium text-text-muted">Change time</div>
							{#each snoozeCommand?.options?.items ?? [] as option (option.id)}
								<MenuItem variant={option.selected ? "selected" : "default"} density="option" icon={option.icon ?? "clock"} disabled={snoozeCommand?.disabledReason != null} title={snoozeCommand?.disabledReason ?? undefined} aria-current={option.selected ? "true" : undefined} data-testid={`session-state-snooze-${option.id}`} detail={option.detail} onselect={() => { statePickingTime = option.id === "pick"; stateMenuOpen = false; option.run(() => document.querySelector<HTMLElement>("[data-testid='session-bar-state-chip']") ?? document.getElementById("session-bar-more")); }}>
									{option.label}
								</MenuItem>
							{/each}
						{/if}
					{:else if stateChip.kind === "pinned"}
						<MenuItem icon="pin-off" onselect={() => getPinCommand(session).run()}>Unpin</MenuItem>
					{:else}
						<MenuItem data-testid="session-bar-unsettle" onselect={() => void sessionCommandActions.settle(session, false)}>
							<Icon name="undo" size={13} /><span>Un-settle</span>
						</MenuItem>
					{/if}
					<AutoSettleRow {session} now={sessionState.now} testId="session-bar-auto-settle" />
				</Menu>
			{/if}
		{/if}
	</div>
	</div>
	{/if}

	{#if sessionViewState.compact && !collapsed && goalShown}
		<Popover bind:open={goalDetails.open} presentation="sheet" sheetEdge="top" modal initialFocus="content" labelledBy="goal-details-title" id="goal-details" data-testid="goal-details" portalTo="#session-bar" sheetBottomPadding={16} class="px-[20px] pt-[16px] whitespace-normal text-[12px]" sheetScrim={{ portalTo: goalSubtitleEl?.closest("#session-bar")?.parentElement ?? undefined, zIndex: "var(--z-dropdown)", testId: "goal-details-scrim" }}
			onopenchange={(open) => { if (open) { goalFocusHandedOff = false; tasksPanel.open = false; sideThreadsPanel.open = false; } }}
			onCloseAutoFocus={(event) => { if (goalFocusHandedOff) event.preventDefault(); goalFocusHandedOff = false; }}
		>
			{#snippet trigger({ props })}{@render goalLine(props)}{/snippet}
			{@render goalContent()}
		</Popover>
	{/if}

	{#if !sessionViewState.compact}{@render identityBlock()}{/if}

	{#if !sessionViewState.compact}
		<div id="session-bar-connection" class="flex shrink-0 items-center gap-[5px] pl-[8px] pr-[4px] font-mono text-[12px] leading-[normal] text-text-dimmer">
			<span id="status" class="status-dot mr-[3px] size-[7px] shrink-0 rounded-full {statusClass}" title={statusTitle} role="status"><span class="sr-only">{statusTitle}</span></span>
			<Icon name="laptop" size={14} />
			<span id="client-count-badge" class="font-mono tabular-nums">{uiState.clientCount}</span>
		</div>
	{/if}

	{#if sessionViewState.compact && collapsed}
		<!-- Ghost like the ⋯ beside it: the same visual size and a 44px hit target
		     fit inside the 46px island without a bordered box. -->
		<Button
			id="session-bar-chevron"
			variant="ghost"
			size="touch-icon"
			touchTarget="always"
			iconOnly
			icon="chevron-down"
			iconSize={14}
			class="shrink-0"
			title="Show the bar"
			ariaLabel="Show session controls"
			aria-expanded={false}
			aria-controls="session-bar"
			data-testid="session-bar-expand"
			onclick={showControls}
		/>
	{/if}

	{@render overflowMenu()}
	{#if backgroundTasks.length > 0 && !collapsed}
		<BackgroundTasksRow tasks={backgroundTasks} compact={sessionViewState.compact} onstop={supportsTaskStop ? (taskId) => { void stopBackgroundTasks(sessionState.currentId, taskId); } : undefined} onstopall={supportsTaskStop ? () => { void stopBackgroundTasks(sessionState.currentId); } : undefined} />
	{/if}

	{#if goalDetails.open && detailsGoal && goalFacts && !sessionViewState.compact}
		<Surface id="goal-details" data-testid="goal-details" variant="floating" radius="none" elevation="popover" role="region" aria-label="Goal details" class="z-[var(--z-popover)] whitespace-normal text-[12px] absolute top-full left-[20px] mt-[8px] max-h-[70dvh] w-[380px] max-w-[calc(100%-40px)] overflow-y-auto rounded-[16px] px-[16px] pt-[14px] pb-[12px]">
			{@render goalContent()}
		</Surface>
	{/if}

	{#if tasksPanel.open && backgroundTasks.length > 0}
		<BackgroundTasksPanel tasks={backgroundTasks} compact={sessionViewState.compact} onstop={supportsTaskStop ? (taskId) => { void stopBackgroundTasks(sessionState.currentId, taskId); } : undefined} onstopall={supportsTaskStop ? () => { void stopBackgroundTasks(sessionState.currentId); } : undefined} />
	{/if}

	{#if sideThreadsPanel.open}
		<SideThreadsPanel threads={sideThreads} compact={sessionViewState.compact} />
	{/if}

</div>

<style>
	#session-bar-meta > :global(.session-bar-segments) { flex-shrink: 1; }
	#session-bar-meta > :global(.session-bar-segments:not(:has(> *))) { display: none; }
	#session-bar-meta > :global(.session-bar-segments) > :global(* + *) { position: relative; }
	#session-bar-meta > :global(.session-bar-segments) > :global(* + *)::after { content: ""; position: absolute; left: 0; top: 6px; bottom: 6px; width: 1px; background: var(--color-border-chip); }
	#session-bar-meta > :global(.session-bar-segments) > :global(#session-bar-settle[data-emphasis="primary"])::after { display: none; }
	.desktop-goal-check { display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; gap: 8px; align-items: start; padding: 7px 10px; font-size: 12.5px; line-height: 1.4; color: var(--color-text-secondary); }
	.desktop-goal-check b { font-weight: 600; color: var(--color-text); }
	.desktop-goal-check time { font-family: var(--font-mono); font-size: 11px; }
	.goal-details-check {
		display: grid;
		grid-template-columns: 14px 32px minmax(0, 1fr);
		gap: 6px;
		align-items: start;
		font-size: 11.5px;
		line-height: 1.35;
		color: var(--color-text-secondary);
	}
</style>
