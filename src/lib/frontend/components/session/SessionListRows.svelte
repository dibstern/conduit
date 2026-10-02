<script lang="ts">
	import type { SessionInfo } from "../../types.js";
	import type { SessionProjection } from "../../stores/session.svelte.js";
	import { isSessionSnoozed, isSessionWoken, sessionState, switchToSession } from "../../stores/session.svelte.js";
	import { getCurrentSlug, getSessionHref } from "../../stores/router.svelte.js";
	import { getBrowserClientId } from "../../stores/client-identity.js";
	import { unsnoozeSessionRpc } from "../../transport/ws-rpc-client.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import { touch } from "../../utils/attention.js";
	import { setSessionStatusFilter, type SessionStatusFilter } from "../../stores/session-scope.js";
	import { setSettledShelfOpen, setSnoozedShelfOpen, uiState } from "../../stores/ui.svelte.js";
	import { formatSnoozeTime, formatTimeAgo } from "../../utils/format.js";
	import { toggleSessionRead } from "../../utils/session-read.js";
	import { openSnoozePicker } from "../../stores/snooze-picker.svelte.js";
	import { sessionVerbActions } from "./session-verbs.js";
	import SessionItem from "./SessionItem.svelte";
	import SessionPager from "./SessionPager.svelte";
	import Button from "../ui/Button.svelte";
	import TextButton from "../ui/TextButton.svelte";
	import Icon from "../ui/Icon.svelte";

	let { arrangement, isEmpty, emptyMessage, statusFilter, searching, filteredLength, snoozedShelfOpen, settledShelfOpen, pagerLoading, unavailableProjectLabels, selectMode, selectedSessionIds, menuOpenId, renamingSessionId, getProjectLabel, getProjectAccent, oncontextmenu, ontoggleselection, onrenamestart, onrenameend }: {
		arrangement: SessionProjection;
		isEmpty: boolean;
		emptyMessage: string;
		statusFilter: SessionStatusFilter | null;
		searching: boolean;
		filteredLength: number;
		snoozedShelfOpen: boolean;
		settledShelfOpen: boolean;
		pagerLoading: boolean;
		unavailableProjectLabels: string[];
		selectMode: boolean;
		selectedSessionIds: Set<string>;
		menuOpenId: string | undefined;
		renamingSessionId: string | null;
		getProjectLabel: (session: SessionInfo) => string | undefined;
		getProjectAccent: (session: SessionInfo) => number;
		oncontextmenu: (session: SessionInfo, anchor: HTMLElement, trigger?: "touch") => void;
		ontoggleselection: (id: string) => void;
		onrenamestart: (id: string) => void;
		onrenameend: () => void;
	} = $props();
	let heldSessionId = $state<string | null>(null);
	let sentinelEl: HTMLElement | undefined = $state();

	function handleSwitchSession(session: SessionInfo) {
		touch(session, "sidebar-pick");
		const projectSlug = session.projectSlug ?? getCurrentSlug();
		if (projectSlug && isSessionWoken(session, sessionState.now)) {
			unsnoozeSessionRpc({ projectSlug, sessionId: session.id, originId: getBrowserClientId() })
				.catch(() => showToast("Couldn't clear the wake", { variant: "error" }));
		}
		if (session.id !== sessionState.currentId) switchToSession(session.id, session.projectSlug);
	}
</script>

	<!-- Scrollable session list content -->
	<!-- The region scrolls and has no tabbable descendant, so it must be focusable or a
	     keyboard-only user cannot scroll it at all (axe scrollable-region-focusable);
	     Svelte's non-interactive-tabindex heuristic does not model that case.
	     Labelled by string rather than by the "Sessions" heading, which does not exist
	     in select mode and would leave the idref dangling. -->
	<!-- One row, rendered by every section. It is a snippet rather than a copy
	     per section because the row is about to grow: the shelves and the
	     per-row verbs each land in their own ticket, and copies would mean one
	     edit each with any divergence between them invisible. -->
	{#snippet sessionRow(s: SessionInfo)}
		{@const settled = s.pinnedAt == null && s.settledAt != null}
		{@const snoozed = !settled && s.pinnedAt == null && isSessionSnoozed(s, sessionState.now)}
		<SessionItem
			session={s}
			pinned={s.pinnedAt != null}
			{settled}
			{snoozed}
			settledAt={settled ? formatTimeAgo(s.settledAt) : undefined}
			snoozedUntilText={snoozed ? formatSnoozeTime(s.snoozedUntil ?? null, sessionState.now) : undefined}
			now={sessionState.now}
			href={getSessionHref(s.id)}
			projectLabel={getProjectLabel(s)}
			projectAccent={getProjectAccent(s)}
			branch={s.git?.branch}
			active={s.id === sessionState.currentId}
			renaming={s.id === renamingSessionId}
			{selectMode}
			selected={selectedSessionIds.has(s.id)}
			heldSessionId={heldSessionId}
			menuOpen={menuOpenId === s.id}
			onholdchange={(id) => { heldSessionId = id; }}
			onswitchsession={() => handleSwitchSession(s)}
			{ontoggleselection}
			{oncontextmenu}
			onsettle={(_id, next) => { void sessionVerbActions.settle(s, next); }}
			onmarkread={(_id) => { void toggleSessionRead(s); }}
			onpin={(_id, next) => { void sessionVerbActions.pin(s, next); }}
			onsnooze={() => openSnoozePicker(s, "center")}
			onunsnooze={() => { void sessionVerbActions.unsnooze(s); }}
			oncommitsnooze={() => sessionVerbActions.commitTomorrow(s)}
			onrenamestart={() => onrenamestart(s.id)}
			{onrenameend}
		/>
	{/snippet}

	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div id="session-list-scroller" class="flex-1 overflow-y-auto px-2 py-0.5" role="region" aria-label="Sessions" tabindex="0" onscroll={() => { heldSessionId = null; }}>
		{#if isEmpty}
			<div class="session-empty py-6 px-3.5 text-center text-xs text-text-dimmer font-brand" data-testid={statusFilter !== null && (!searching || filteredLength > 0) ? "session-filter-empty" : undefined}>
				{emptyMessage}
				{#if statusFilter !== null && (!searching || filteredLength > 0)}
					<div class="mt-2"><Button variant="ghost" size="content" tone="accent" class="min-h-[44px] md:min-h-8 px-3" data-testid="session-filter-clear" onclick={() => setSessionStatusFilter(null)}>Clear filter</Button></div>
				{/if}
			</div>
		{:else}
			{#if arrangement.pinned.length > 0}
				<div class="session-group-label flex items-center uppercase pt-1.5 pb-0.5 px-3 text-xs font-semibold text-text-dimmer tracking-[0.3px] font-brand"><span>Pinned</span>{" "}<span class="ml-auto font-medium">{arrangement.pinned.length}</span></div>
				{#each arrangement.pinned as s (s.id)}{@render sessionRow(s)}{/each}
			{/if}
			{#each arrangement.sections as section (section.key)}
					<div class="session-group-label flex items-center uppercase pt-1.5 pb-0.5 px-3 text-xs font-semibold text-text-dimmer tracking-[0.3px] font-brand">
						<span>{section.label}</span>{" "}<span class="ml-auto font-medium">{section.sessions.length}</span>
					</div>
					{#each section.sessions as s (s.id)}
						{@render sessionRow(s)}
					{/each}
			{/each}
			{#if arrangement.snoozed.length > 0}
				<TextButton
					tone="dimmer"
					class="session-group-label flex items-center gap-1 min-h-[44px] md:min-h-0 pt-1.5 pb-0.5 px-3 text-xs font-semibold tracking-[0.3px] font-brand"
					data-testid="snoozed-shelf-toggle"
					aria-expanded={snoozedShelfOpen}
					aria-controls="snoozed-shelf-rows"
					onclick={() => { if (!searching) setSnoozedShelfOpen(!uiState.snoozedShelfOpen); }}
				>
					<Icon name={snoozedShelfOpen ? "chevron-down" : "chevron-right"} size={12} />
						<span class="uppercase">Snoozed</span>{" "}<span class="ml-auto font-medium">{arrangement.snoozed.length}</span>
				</TextButton>
				<div id="snoozed-shelf-rows">
					{#if snoozedShelfOpen}
						{#each arrangement.snoozed as s (s.id)}
							{@render sessionRow(s)}
						{/each}
					{/if}
				</div>
			{/if}
			{#if arrangement.settled.length > 0}
				<TextButton
					tone="dimmer"
					class="session-group-label flex items-center gap-1 min-h-[44px] md:min-h-0 pt-1.5 pb-0.5 px-3 text-xs font-semibold tracking-[0.3px] font-brand"
					data-testid="settled-shelf-toggle"
					aria-expanded={settledShelfOpen}
					aria-controls="settled-shelf-rows"
					onclick={() => { if (!searching) setSettledShelfOpen(!uiState.settledShelfOpen); }}
				>
					<Icon name={settledShelfOpen ? "chevron-down" : "chevron-right"} size={12} />
						<!-- No count: settled sessions grow without bound and load in pages,
						     so any number here would undercount. -->
						<span class="uppercase">Settled</span>
				</TextButton>
				<div id="settled-shelf-rows">
					{#if settledShelfOpen}
						{#each arrangement.settled as s (s.id)}
							{@render sessionRow(s)}
						{/each}
					{/if}
				</div>
			{/if}
		{/if}

		<!-- Paging sentinel. Inside the scroll region so the observer's root
		     intersection is the list's own viewport, and after the rows so it is
		     only reached at the bottom. -->
		<div id="session-list-sentinel" class="h-px" bind:this={sentinelEl}></div>
		<SessionPager {sentinelEl} />

		{#if pagerLoading}
			<div
				class="px-3.5 py-2 text-center text-xs text-text-dimmer font-brand"
				data-testid="session-list-loading-more"
			>
				Loading…
			</div>
		{/if}

		<!-- Outside the isEmpty branch on purpose. A project that cannot be read
		     is most misleading when it leaves the list empty, which is exactly
		     when the empty message would otherwise claim there is nothing to
		     show. Naming the projects is safe where counting sessions is not:
		     the registry is a bounded set. -->
		{#if unavailableProjectLabels.length > 0}
			<div
				class="session-unavailable px-3.5 py-3 text-xs leading-snug text-text-dimmer font-brand"
				data-testid="session-list-unavailable"
			>
				Sessions missing from {unavailableProjectLabels.join(", ")}
			</div>
		{/if}
	</div>
