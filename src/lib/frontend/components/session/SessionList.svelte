<!-- Sidebar session list with scope and search, status grouping, and new session button. -->
<!-- Reads from sessionState store and renders SessionItem components. -->

<script lang="ts">
	import { tick, untrack } from "svelte";
	import type { SessionInfo } from "../../types.js";
	import {
		sessionState,
		projectSessionList,
		sessionMatchesStatus,
		isSessionSnoozed,
		setSearchQuery,
	} from "../../stores/session.svelte.js";
	import { currentSearchQuery, refreshSessionList, sessionList } from "../../stores/session-list.svelte.js";
	import {
		getSessionGrouping,
		getSessionScope,
		getSessionStatusFilter,
		setSessionScope,
	} from "../../stores/session-scope.js";
	import {
		getCurrentSlug,
		routerState,
	} from "../../stores/router.svelte.js";
	import { projectState } from "../../stores/project.svelte.js";
	import { getBrowserClientId } from "../../stores/client-identity.js";
	import {
		deleteSessionRpc,
	} from "../../transport/ws-rpc-client.js";
	import {
		confirm,
		dismissToast,
		showToast,
		uiState,
	} from "../../stores/ui.svelte.js";
	import { getSessionActionState } from "../../utils/swipe.js";
	import SessionContextMenu from "./SessionContextMenu.svelte";
	import { getSessionVerbs, isForeignSession, runSessionVerbShortcut, type SessionVerbHost } from "./session-verbs.js";
	import SnoozeSheet from "./SnoozeSheet.svelte";
	import ShortcutSheet from "./ShortcutSheet.svelte";
	import Banners from "../overlays/Banners.svelte";
	import SessionListHeader from "./SessionListHeader.svelte";
	import SessionListFilters from "./SessionListFilters.svelte";
	import SessionListRows from "./SessionListRows.svelte";
	import SessionListBulkBar from "./SessionListBulkBar.svelte";
	import { runBulkChange, runBulkSnooze } from "./session-list-bulk-actions.js";
	import { getProjectAccent, getProjectLabel, projectDisplayName } from "./session-list-project.js";

	let { onaddproject }: { onaddproject?: (() => void) | undefined } = $props();

	let localSearchValue = $state("");
	let debounceTimer: ReturnType<typeof setTimeout> | undefined = $state(
		undefined,
	);

	// Context menu state
	let ctxMenuSession = $state<SessionInfo | null>(null);
	let ctxMenuAnchor = $state<HTMLElement | null>(null);
	let ctxMenuPresentation = $state<"menu" | "sheet">("menu");
	let snoozePlacement = $state<"center" | "sheet">("center");
	let snoozeSheetNow = $state(0);
	let shortcutSheetOpen = $state(false);
	let shortcutReturnFocus: HTMLElement | null = null;
	let focusedRowId = $state<string | null>(null);
	let focusedRowIndex = $state(0);

	// Rename state — set by context menu to trigger inline rename on a SessionItem
	let renamingSessionId = $state<string | null>(null);

	// Select mode includes both settle and the former cleanup/delete flow.
	// Two modes putting checkboxes on the same rows would be two ways to do one thing.
	const selectMode = $derived(uiState.selectMode);
	let selectedSessionIds = $state<Set<string>>(new Set());
	let bulkPending = $state(false);
	let bulkSnoozeOpen = $state(false);

	const filtered = $derived(sessionList.groups.flatMap((group) => group.rows));
	let feedStale = $state(false);
	$effect(() => {
		const staleSince = sessionList.staleSince;
		feedStale = false;
		if (staleSince === null) return;
		const remaining = Math.max(0, staleSince + 3_000 - Date.now());
		const timer = setTimeout(() => { feedStale = true; }, remaining);
		return () => clearTimeout(timer);
	});
	const statusFilter = $derived(getSessionStatusFilter());
	const grouping = $derived(getSessionGrouping());
	const matching = $derived(filtered.filter((session) => statusFilter === null || sessionMatchesStatus(session, statusFilter)));
	const arrangement = $derived(projectSessionList(
		filtered,
		{ status: statusFilter, grouping },
		sessionState.now,
		(session) => {
			const slug = session.projectSlug ?? getCurrentSlug() ?? "";
			return { key: slug, label: projectDisplayName(slug) };
		},
	));
	// Chips count only live rows: settled and snoozed sets grow without bound.
	const live = $derived(filtered.filter((session) => session.settledAt == null && !isSessionSnoozed(session, sessionState.now)));

	const isEmpty = $derived(matching.length === 0);
	const searching = $derived(sessionState.searchQuery.trim().length > 0);
	const settledShelfOpen = $derived(searching || uiState.settledShelfOpen);
	const snoozedShelfOpen = $derived(searching || uiState.snoozedShelfOpen);
	const visibleRowIds = $derived([
		...arrangement.pinned.map((session) => session.id),
		...arrangement.sections.flatMap((section) => section.sessions.map((session) => session.id)),
		...(snoozedShelfOpen ? arrangement.snoozed.map((session) => session.id) : []),
		...(settledShelfOpen ? arrangement.settled.map((session) => session.id) : []),
	]);
	const selectCandidates = $derived.by(() => {
		const shown = new Set(visibleRowIds);
		return matching.filter((session) => shown.has(session.id) && !isForeignSession(session));
	});

	const scope = $derived(getSessionScope());
	const emptyMessage = $derived.by(() => {
		if (searching && filtered.length === 0) return "No matching sessions";
		if (statusFilter !== null) {
			const label = statusFilter === "needs-you" ? "needs you" : statusFilter;
			return `Nothing ${label}${scope === null ? "" : ` in ${projectDisplayName(scope)}`}`;
		}
		if (scope !== null) return `No sessions in ${projectDisplayName(scope)}`;
		return "No sessions yet";
	});

	// A trailing "+" whenever another page exists, so the number is always "at
	// least this many" and never claims to be the size of the whole match set.
	// Counting the full set is exactly what this list must never do.
	const searchSummary = $derived.by(() => {
		const query = currentSearchQuery();
		if (query === null) return null;
		if (query.hasMore) return `${filtered.length}+ matches`;
		return filtered.length === 1 ? "1 match" : `${filtered.length} matches`;
	});

	const pagerLoading = $derived(
		currentSearchQuery() === null
			? sessionState.daemonLoading
			: (currentSearchQuery()?.loading ?? false),
	);

	const selectionCount = $derived(selectedSessionIds.size);
	const selectedSessions = $derived(selectCandidates.filter((session) => selectedSessionIds.has(session.id)));
	const settleEligible = $derived(selectedSessions.filter((session) => {
		const actions = getSessionActionState(session, sessionState.now);
		return !actions.settled && !actions.settleDisabledReason;
	}));
	const snoozeEligible = $derived(selectedSessions.filter((session) => {
		const actions = getSessionActionState(session, sessionState.now);
		return actions.snoozeVisible && !actions.snoozeDisabledReason;
	}));
	const unpinSelected = $derived(selectedSessions.length > 0 && selectedSessions.every((session) => getSessionActionState(session, sessionState.now).pinned));
	const pinEligible = $derived(selectedSessions.filter((session) => getSessionActionState(session, sessionState.now).pinned === unpinSelected));
	const allSelected = $derived(
		selectCandidates.length > 0 &&
			selectCandidates.every((s) => selectedSessionIds.has(s.id)),
	);

	const unavailableProjectLabels = $derived(
		sessionState.daemonUnavailableProjects.map(projectDisplayName),
	);

	// Prune stale selections when the session list changes externally
	$effect(() => {
		if (!selectMode) return;
		const validIds = new Set(selectCandidates.map((s) => s.id));
		const pruned = new Set([...selectedSessionIds].filter((id) => validIds.has(id)));
		if (pruned.size !== selectedSessionIds.size) {
			selectedSessionIds = pruned;
		}
	});

	// The server scopes its page, so a new scope needs a fresh first page, and a
	// live search its matches re-fetched. The initial scope is already loaded by
	// ChatLayout on connect, hence skipping the first run.
	let loadedScope = untrack(() => scope);
	$effect(() => {
		if (scope === loadedScope) return;
		loadedScope = scope;
		void refreshSessionList();
		const query = untrack(() => localSearchValue);
		if (query.trim()) requestRemoteSearch(query);
	});

	// Exit select mode when the shown list becomes empty.
	$effect(() => {
		if (selectMode && visibleRowIds.length === 0 && !pagerLoading) {
			resetSelectMode();
		}
	});

	// Keyed rows may be moved or destroyed while focused. Restore by identity,
	// or take the row that replaced its old position when it leaves the list.
	$effect(() => {
		const ids = visibleRowIds;
		const id = focusedRowId;
		if (!id) return;
		void tick().then(() => {
			if (focusedRowId !== id) return;
			const rows = Array.from(document.querySelectorAll<HTMLAnchorElement>("#session-list .session-item[data-session-id]"));
			if (rows.length === 0) {
				focusedRowId = null;
				document.getElementById("session-list-scroller")?.focus();
				return;
			}
			// Only recover focus the list itself dropped; never pull it from elsewhere.
			const current = document.activeElement;
			if (current && current !== document.body && !rows.includes(current as HTMLAnchorElement)) return;
			const nextIndex = Math.min(focusedRowIndex, rows.length - 1);
			const row = rows.find((element) => element.dataset["sessionId"] === id) ?? rows[nextIndex];
			if (!row) return;
			focusedRowId = row.dataset["sessionId"] ?? null;
			focusedRowIndex = rows.indexOf(row);
			if (document.activeElement !== row) row.focus();
		});
		void ids;
	});

	// Searches every project the daemon knows about, not just this one, and pages
	// the matches. The store drops responses for a superseded query, so the
	// debounce does not need to re-check what was typed since.
	function requestRemoteSearch(query: string) {
		sessionList.search(query);
	}

	function clearSearch() {
		if (debounceTimer !== undefined) clearTimeout(debounceTimer);
		localSearchValue = "";
		setSearchQuery("");
		sessionList.search("");
	}

	function handleSearchInput(text: string) {
		localSearchValue = text;

		// Apply local filter immediately
		setSearchQuery(localSearchValue);

		// Debounce remote search
		if (debounceTimer !== undefined) clearTimeout(debounceTimer);
		if (localSearchValue.trim()) {
			debounceTimer = setTimeout(() => {
				requestRemoteSearch(localSearchValue);
			}, 300);
		}
	}

	function handleContextMenu(session: SessionInfo, anchor: HTMLElement, trigger?: "touch") {
		// Open context menu for this session
		ctxMenuSession = session;
		ctxMenuAnchor = anchor;
		ctxMenuPresentation = trigger === "touch" ? "sheet" : "menu";
	}

	function handleCloseContextMenu() {
		ctxMenuSession = null;
		ctxMenuAnchor = null;
	}

	function handleCtxRename(id: string) {
		// Set reactive state — SessionItem with matching id enters rename mode
		renamingSessionId = id;
	}

	function sessionVerbHost(getSession: () => SessionInfo | null): SessionVerbHost {
		return {
			rename: () => { const session = getSession(); if (session) handleCtxRename(session.id); },
			select: () => { const session = getSession(); if (session) handleEnterSelect(session.id); },
		};
	}

	function handleRenameEnd() {
		renamingSessionId = null;
	}

	function handleRowFocus(event: FocusEvent) {
		const target = event.target;
		if (!(target instanceof HTMLAnchorElement) || !target.matches("#session-list .session-item")) {
			focusedRowId = null;
			return;
		}
		focusedRowId = target.dataset["sessionId"] ?? null;
		focusedRowIndex = Array.from(document.querySelectorAll("#session-list .session-item")).indexOf(target);
	}

	function isEditable(target: EventTarget | null): boolean {
		return target instanceof HTMLElement &&
			(target.closest("input, textarea, select, [contenteditable]") !== null || target.isContentEditable);
	}

	function handleListKeydown(event: KeyboardEvent) {
		if (selectMode) {
			if (event.key === "Escape" && event.target instanceof Element && event.target.closest("#session-list")) {
				event.preventDefault();
				resetSelectMode();
			}
			return;
		}
		if (event.defaultPrevented || event.repeat || event.altKey) return;
		if (isEditable(event.target) || document.querySelector('[role="dialog"], [role="menu"]') || renamingSessionId) return;
		if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "z") {
			const toast = [...uiState.toasts].reverse().find((item) => item.action);
			if (toast?.action) {
				event.preventDefault();
				toast.action.run();
				dismissToast(toast.id);
			}
			return;
		}
		if (event.metaKey || event.ctrlKey || (event.shiftKey && event.key !== "?")) return;
		if (event.key === "?") {
			event.preventDefault();
			shortcutReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
			shortcutSheetOpen = true;
			return;
		}
		if (/^[0-9]$/.test(event.key)) {
			const index = Number(event.key) - 1;
			if (event.key === "0" || projectState.projects[index]) {
				event.preventDefault();
				setSessionScope(event.key === "0" ? null : projectState.projects[index]?.slug ?? null);
			}
			return;
		}
		const rows = Array.from(document.querySelectorAll<HTMLAnchorElement>("#session-list .session-item[data-session-id]"));
		if (event.key === "j" || event.key === "k") {
			if (rows.length === 0) return;
			const current = rows.indexOf(document.activeElement as HTMLAnchorElement);
			const active = rows.findIndex((row) => row.dataset["sessionId"] === sessionState.currentId);
			let next: number;
			if (current < 0) next = active < 0 ? 0 : active;
			else next = Math.max(0, Math.min(rows.length - 1, current + (event.key === "j" ? 1 : -1)));
			event.preventDefault();
			rows[next]?.focus();
			rows[next]?.scrollIntoView({ block: "nearest" });
			return;
		}
		const row = document.activeElement;
		if (!(row instanceof HTMLAnchorElement) || !row.matches("#session-list .session-item")) return;
		const session = filtered.find((item) => item.id === row.dataset["sessionId"]);
		if (!session) return;
		runSessionVerbShortcut(event, getSessionVerbs(session, sessionState.now, sessionVerbHost(() => session), "center"));
	}

	function closeShortcutSheet() {
		shortcutSheetOpen = false;
		const target = shortcutReturnFocus;
		shortcutReturnFocus = null;
		void tick().then(() => target?.focus());
	}

	function resetSelectMode() {
		uiState.selectMode = false;
		selectedSessionIds = new Set();
	}

	function handleEnterSelect(id?: string) {
		selectedSessionIds = id ? new Set([id]) : new Set();
		uiState.selectMode = true;
	}

	function handleToggleSelection(id: string) {
		const next = new Set(selectedSessionIds);
		if (next.has(id)) {
			next.delete(id);
		} else {
			next.add(id);
		}
		selectedSessionIds = next;
	}

	function handleToggleSelectAll() {
		if (allSelected) {
			selectedSessionIds = new Set();
		} else {
			selectedSessionIds = new Set(selectCandidates.map((s) => s.id));
		}
	}

	async function handleBulkChange(kind: "settle" | "pin") {
		const eligible = kind === "settle" ? settleEligible : pinEligible;
		if (bulkPending || eligible.length === 0) return;
		bulkPending = true;
		await runBulkChange(kind, { eligible, selectedCount: selectedSessions.length, oncomplete: () => {
			bulkPending = false;
			resetSelectMode();
		} }, unpinSelected);
	}

	function handleOpenBulkSnooze() {
		if (bulkPending || snoozeEligible.length === 0) return;
		snoozePlacement = window.matchMedia("(hover: hover) and (pointer: fine)").matches ? "center" : "sheet";
		snoozeSheetNow = Date.now();
		bulkSnoozeOpen = true;
	}

	async function handleBulkSnooze(until: number | null) {
		if (bulkPending || snoozeEligible.length === 0) return;
		bulkPending = true;
		await runBulkSnooze({ eligible: snoozeEligible, selectedCount: selectedSessions.length, oncomplete: () => {
			bulkPending = false;
			resetSelectMode();
		} }, until, snoozeSheetNow);
	}

	async function handleBulkDelete() {
		if (bulkPending || selectionCount === 0) return;
		bulkPending = true;
		const count = selectionCount;
		const label = count === 1 ? "1 session" : `${count} sessions`;
		const confirmed = await confirm(
			`Delete ${label}? These sessions and their history will be permanently removed.`,
			"Delete",
		);
		if (confirmed) {
			// Snapshot the rows, then clear selection so the UI responds at once.
			// The list is cross-project, so each row deletes in its own project.
			const targets = selectedSessions.map((session) => ({ projectSlug: session.projectSlug ?? getCurrentSlug() ?? "", sessionId: session.id }));
			resetSelectMode();
			const results = await Promise.allSettled(
				targets.map((target) => deleteSessionRpc({ ...target, originId: getBrowserClientId() })),
			);
			const failed = results.filter((r) => r.status === "rejected").length;
			if (failed > 0) {
				showToast(
					failed === 1
						? "Couldn't delete 1 session"
						: `Couldn't delete ${failed} sessions`,
					{ variant: "warn" },
				);
			}
		}
		bulkPending = false;
	}

</script>

<!-- A click anywhere forgets the focused row; focusin re-records it if the click landed on one. -->
<svelte:window onkeydown={handleListKeydown} onfocusin={handleRowFocus} onpointerdown={() => { focusedRowId = null; }} />

<div id="session-list" class="flex-1 flex flex-col overflow-hidden">
	{#if routerState.sessionNotFound}
		<Banners
			banners={[{ id: "session-not-found", variant: "warning", icon: "alert-triangle", text: "Session not found. That session no longer exists.", dismissible: true }]}
			showHealthWarning={false}
			ondismiss={() => { routerState.sessionNotFound = false; }}
		/>
	{/if}
	<SessionListHeader {selectMode} {selectionCount} {allSelected} onselectall={handleToggleSelectAll} ondone={resetSelectMode} onenterselect={() => handleEnterSelect()} />
	<SessionListFilters {localSearchValue} {live} {searchSummary} onsearchinput={handleSearchInput} onclearsearch={clearSearch} {onaddproject} />
	{#if feedStale}
		<div class="px-3.5 py-1 text-xs text-text-dimmer font-brand" data-testid="session-list-stale">May be out of date</div>
	{/if}
	<SessionListRows {arrangement} {isEmpty} {emptyMessage} {statusFilter} {searching} filteredLength={filtered.length} {snoozedShelfOpen} {settledShelfOpen} {pagerLoading} {unavailableProjectLabels} {selectMode} {selectedSessionIds} menuOpenId={ctxMenuSession?.id} {renamingSessionId} {getProjectLabel} {getProjectAccent} oncontextmenu={handleContextMenu} ontoggleselection={handleToggleSelection} onrenameend={handleRenameEnd} />
	{#if selectMode}
		<SessionListBulkBar settleCount={settleEligible.length} snoozeCount={snoozeEligible.length} pinCount={pinEligible.length} {selectionCount} {unpinSelected} {bulkPending} onsettle={() => { void handleBulkChange("settle"); }} onsnooze={handleOpenBulkSnooze} onpin={() => { void handleBulkChange("pin"); }} ondelete={handleBulkDelete} />
	{/if}
</div>

<!-- Session context menu (rendered outside the scrollable area for proper z-index) -->
{#if !selectMode && ctxMenuSession && ctxMenuAnchor}
	<SessionContextMenu
		session={ctxMenuSession}
		anchor={ctxMenuAnchor}
		projectLabel={getProjectLabel(ctxMenuSession)}
		projectAccent={getProjectAccent(ctxMenuSession)}
		branch={ctxMenuSession.git?.branch}
		presentation={ctxMenuPresentation}
		now={sessionState.now}
		host={sessionVerbHost(() => ctxMenuSession)}
		onclose={handleCloseContextMenu}
	/>
{/if}

<ShortcutSheet open={shortcutSheetOpen} onclose={closeShortcutSheet} />

{#if bulkSnoozeOpen}
	<SnoozeSheet
		open={true}
		placement={snoozePlacement}
		sessionTitle={`${snoozeEligible.length} ${snoozeEligible.length === 1 ? "session" : "sessions"}`}
		now={snoozeSheetNow}
		onclose={() => { bulkSnoozeOpen = false; }}
		onsnooze={(until) => { void handleBulkSnooze(until); }}
	/>
{/if}
