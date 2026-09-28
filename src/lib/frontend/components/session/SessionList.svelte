<!-- ─── SessionList ─────────────────────────────────────────────────────────── -->
<!-- Sidebar session list with scope and search, status grouping, and new session button. -->
<!-- Reads from sessionState store and renders SessionItem components. -->

<script lang="ts">
	import { tick, untrack } from "svelte";
	import type { SessionInfo } from "../../types.js";
	import {
		sessionState,
		getFilteredSessions,
		projectSessionList,
		sessionMatchesStatus,
		isSessionSnoozed,
		isSessionWoken,
		setSearchQuery,
		setCurrentSession,
		switchToSession,
		sendNewSession,
		sessionCreation,
		clearSessionSearch,
		loadDaemonSessions,
		searchSessions,
	} from "../../stores/session.svelte.js";
	import {
		getSessionGrouping,
		getSessionScope,
		getSessionStatusFilter,
		setSessionScope,
		setSessionGrouping,
		setSessionStatusFilter,
		type SessionStatusFilter,
	} from "../../stores/session-scope.js";
	import { sessionViewState } from "../../stores/session-view.svelte.js";
	import {
		getCurrentSlug,
		getSessionHref,
		routerState,
	} from "../../stores/router.svelte.js";
	import { projectState } from "../../stores/project.svelte.js";
	import { getBrowserClientId } from "../../stores/client-identity.js";
	import {
		deleteSessionRpc,
		setSessionSettledRpc,
		setSessionPinnedRpc,
		snoozeSessionRpc,
		unsnoozeSessionRpc,
	} from "../../transport/ws-rpc-client.js";
	import {
		confirm,
		dismissToast,
		showToast,
		uiState,
		setSettledShelfOpen,
		setSnoozedShelfOpen,
	} from "../../stores/ui.svelte.js";
	import { formatSnoozeTime, formatTimeAgo } from "../../utils/format.js";
	import { touch } from "../../utils/attention.js";
	import { toggleSessionRead } from "../../utils/session-read.js";
	import { getSessionActionState } from "../../utils/swipe.js";
	import SessionItem from "./SessionItem.svelte";
	import SessionPager from "./SessionPager.svelte";
	import SessionContextMenu from "./SessionContextMenu.svelte";
	import { getSessionVerbs, isForeignSession, sessionVerbActions } from "./session-verbs.js";
	import { openSnoozePicker } from "../../stores/snooze-picker.svelte.js";
	import SnoozeSheet from "./SnoozeSheet.svelte";
	import ShortcutSheet from "./ShortcutSheet.svelte";
	import Icon from "../ui/Icon.svelte";
	import BlockGrid from "../ui/BlockGrid.svelte";
	import Button from "../ui/Button.svelte";
	import TextButton from "../ui/TextButton.svelte";
	import SessionSearchField from "./SessionSearchField.svelte";
	import SessionGroupMenu from "./SessionGroupMenu.svelte";
	import Banners from "../overlays/Banners.svelte";

	let { onaddproject }: { onaddproject?: (() => void) | undefined } = $props();

	// The box only; ui/Button `toolbar` owns the colours and the hover fill.
	// `size="content"` emits no geometry precisely so a call site can supply
	// its own without a `!` override (see Button.svelte::ButtonSize).
	// Phone touch floors across the sidebar are literal px: the root font-size
	// is 12px, so rem utilities undershoot (min-h-11 is 33px, not 44px).
	const TOOLBAR_ICON_BOX = "h-6 w-6 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 rounded-md";

	// ─── Local state ────────────────────────────────────────────────────────────

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
	let heldSessionId = $state<string | null>(null);
	let shortcutSheetOpen = $state(false);
	let shortcutReturnFocus: HTMLElement | null = null;
	let focusedRowId = $state<string | null>(null);
	let focusedRowIndex = $state(0);

	// Rename state — set by context menu to trigger inline rename on a SessionItem
	let renamingSessionId = $state<string | null>(null);

	// Paging sentinel, observed by SessionPager.
	let sentinelEl: HTMLElement | undefined = $state();

	// Select mode includes both settle and the former cleanup/delete flow.
	// Two modes putting checkboxes on the same rows would be two ways to do one thing.
	const selectMode = $derived(uiState.selectMode);
	let selectedSessionIds = $state<Set<string>>(new Set());
	let bulkPending = $state(false);
	let bulkSnoozeOpen = $state(false);
	const selectVerbClass = "min-w-0 flex-1 min-h-[50px] flex-col gap-1 rounded-lg text-[11px] disabled:opacity-[0.35] disabled:cursor-default";

	// ─── Derived ────────────────────────────────────────────────────────────────

	const filtered = $derived(getFilteredSessions());
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
	const filterChips: { value: SessionStatusFilter; label: string }[] = [
		{ value: "needs-you", label: "Needs you" },
		{ value: "running", label: "Running" },
		{ value: "unread", label: "Unread" },
	];
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
		if (sessionState.searchResults === null) return null;
		if (sessionState.searchHasMore) return `${filtered.length}+ matches`;
		return filtered.length === 1 ? "1 match" : `${filtered.length} matches`;
	});

	const pagerLoading = $derived(
		sessionState.searchResults === null
			? sessionState.daemonLoading
			: sessionState.searchLoading,
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
		void loadDaemonSessions();
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

	// ─── Handlers ───────────────────────────────────────────────────────────────

	// Searches every project the daemon knows about, not just this one, and pages
	// the matches. The store drops responses for a superseded query, so the
	// debounce does not need to re-check what was typed since.
	function requestRemoteSearch(query: string) {
		void searchSessions(query, true);
	}

	// A session belonging to a project other than the one this socket is attached
	// to. Only the daemon's cold cross-project read sets projectSlug, so an
	// absent slug means "this relay's own session", which is why the current
	// project's rows come out local.
	function getRowHref(session: SessionInfo): string {
		return getSessionHref(session.id);
	}

	// Name every row's project so the square and title identify it in any scope.
	//
	// Resolved from the live project list rather than stamped onto the session at
	// fetch time, so renaming a project relabels its rows without the list being
	// re-fetched. Falls back to the slug because the project list arrives over
	// the socket and the sidebar renders before it does.
	function getProjectLabel(session: SessionInfo): string | undefined {
		const slug = session.projectSlug ?? getCurrentSlug();
		return slug ? projectDisplayName(slug) : undefined;
	}

	function getProjectAccent(session: SessionInfo): number {
		const slug = session.projectSlug ?? getCurrentSlug();
		const index = projectState.projects.findIndex((project) => project.slug === slug);
		return (Math.max(index, 0) % 6) + 1;
	}

	function projectDisplayName(slug: string): string {
		return (
			projectState.projects.find((project) => project.slug === slug)?.title ||
			slug
		);
	}

	function handleNewSession() {
		sendNewSession();
	}

	function clearSearch() {
		if (debounceTimer !== undefined) clearTimeout(debounceTimer);
		localSearchValue = "";
		setSearchQuery("");
		clearSessionSearch();
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

	// A user's pick clears the turn-end dot, so it is reported even when the
	// session is already open; switching alone writes no read state (ADR-0004,
	// Scope; conduit-test-hk9m.3, .4).
	function handleSwitchSession(session: SessionInfo) {
		touch(session, "sidebar-pick");
		// Opening a woken session is what clears its Woke badge; hovering or
		// clicking its open view does not (conduit-test-hk9m.9).
		const projectSlug = session.projectSlug ?? getCurrentSlug();
		if (projectSlug && isSessionWoken(session, sessionState.now)) {
			unsnoozeSessionRpc({
				projectSlug,
				sessionId: session.id,
				originId: getBrowserClientId(),
			}).catch(() => showToast("Couldn't clear the wake", { variant: "error" }));
		}
		if (session.id !== sessionState.currentId) {
			switchToSession(session.id, session.projectSlug);
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
		if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
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
			const next = current < 0 ? (active < 0 ? 0 : active) : Math.max(0, Math.min(rows.length - 1, current + (event.key === "j" ? 1 : -1)));
			event.preventDefault();
			rows[next]?.focus();
			rows[next]?.scrollIntoView({ block: "nearest" });
			return;
		}
		const row = document.activeElement;
		if (!(row instanceof HTMLAnchorElement) || !row.matches("#session-list .session-item")) return;
		const session = filtered.find((item) => item.id === row.dataset["sessionId"]);
		if (!session || isForeignSession(session)) return;
		const actions = getSessionActionState(session, sessionState.now);
		const verbs = getSessionVerbs(session, sessionState.now, { rename: () => { renamingSessionId = session.id; }, select: () => handleEnterSelect(session.id) }, "center");
		const runVerb = (testId: string) => { const verb = verbs.find((item) => "testId" in item && item.testId === testId); if (verb && "run" in verb) verb.run(); };
		switch (event.key) {
			case "s":
				event.preventDefault();
				if (actions.settleDisabledReason) showToast(actions.settleDisabledReason, { variant: "warn" });
				else runVerb(actions.settled ? "session-ctx-unsettle" : "session-ctx-settle");
				break;
			case "z":
				event.preventDefault();
				if (actions.snoozed) runVerb("session-ctx-unsnooze");
				else if (actions.snoozeVisible && !actions.snoozeDisabledReason) runVerb("session-ctx-snooze");
				break;
			case "p":
				event.preventDefault();
				runVerb(actions.pinned ? "session-ctx-unpin" : "session-ctx-pin");
				break;
			case "r":
				event.preventDefault();
				runVerb("session-ctx-rename");
				break;
		}
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

	async function handleBulkSettle() {
		if (bulkPending || settleEligible.length === 0) return;
		const skipped = selectedSessions.length - settleEligible.length;
		const input = settleEligible.map((session) => ({ projectSlug: session.projectSlug ?? getCurrentSlug() ?? "", sessionId: session.id, originId: getBrowserClientId() }));
		bulkPending = true;
		const results = await Promise.allSettled(input.map((session) => setSessionSettledRpc({ ...session, settled: true })));
		bulkPending = false;
		const settled = input.filter((_, index) => results[index]?.status === "fulfilled");
		resetSelectMode();
		const count = settled.length;
		const message = (count === input.length
			? `Settled ${count} ${count === 1 ? "session" : "sessions"}`
			: `Settled ${count} of ${input.length} ${input.length === 1 ? "session" : "sessions"}`) + (skipped ? `, ${skipped} skipped` : "");
		showToast(message, {
			duration: 5000,
			...(count > 0 ? { action: {
				label: "Undo",
				run: () => {
					void Promise.allSettled(settled.map((session) => setSessionSettledRpc({ ...session, settled: false }))).then((undoResults) => {
						if (undoResults.some((result) => result.status === "rejected")) showToast("Couldn't undo", { variant: "error" });
					});
				},
			} } : {}),
		});
	}

	async function handleBulkPin() {
		if (bulkPending || pinEligible.length === 0) return;
		const pinned = !unpinSelected;
		const skipped = selectedSessions.length - pinEligible.length;
		const input = pinEligible.map((session) => ({ projectSlug: session.projectSlug ?? getCurrentSlug() ?? "", sessionId: session.id, originId: getBrowserClientId() }));
		bulkPending = true;
		const results = await Promise.allSettled(input.map((session) => setSessionPinnedRpc({ ...session, pinned })));
		bulkPending = false;
		const changed = input.filter((_, index) => results[index]?.status === "fulfilled");
		resetSelectMode();
		const count = changed.length;
		const verb = pinned ? "Pinned" : "Unpinned";
		const message = (count === input.length
			? `${verb} ${count} ${count === 1 ? "session" : "sessions"}`
			: `${verb} ${count} of ${input.length} ${input.length === 1 ? "session" : "sessions"}`) + (skipped ? `, ${skipped} skipped` : "");
		showToast(message, {
			duration: 5000,
			...(count > 0 ? { action: {
				label: "Undo",
				run: () => {
					void Promise.allSettled(changed.map((session) => setSessionPinnedRpc({ ...session, pinned: !pinned }))).then((undoResults) => {
						if (undoResults.some((result) => result.status === "rejected")) showToast("Couldn't undo", { variant: "error" });
					});
				},
			} } : {}),
		});
	}

	function handleOpenBulkSnooze() {
		if (bulkPending || snoozeEligible.length === 0) return;
		snoozePlacement = window.matchMedia("(hover: hover) and (pointer: fine)").matches ? "center" : "sheet";
		snoozeSheetNow = Date.now();
		bulkSnoozeOpen = true;
	}

	async function handleBulkSnooze(until: number | null) {
		if (bulkPending || snoozeEligible.length === 0) return;
		const skipped = selectedSessions.length - snoozeEligible.length;
		const input = snoozeEligible.map((session) => ({
			projectSlug: session.projectSlug ?? getCurrentSlug() ?? "",
			sessionId: session.id,
			originId: getBrowserClientId(),
			wasSnoozed: isSessionSnoozed(session, snoozeSheetNow),
			previousUntil: session.snoozedUntil ?? null,
		}));
		bulkPending = true;
		const results = await Promise.allSettled(input.map((session) => snoozeSessionRpc({ projectSlug: session.projectSlug, sessionId: session.sessionId, originId: session.originId, until })));
		bulkPending = false;
		const changed = input.filter((_, index) => results[index]?.status === "fulfilled");
		resetSelectMode();
		const count = changed.length;
		const message = (count === input.length
			? `Snoozed ${count} ${count === 1 ? "session" : "sessions"}`
			: `Snoozed ${count} of ${input.length} ${input.length === 1 ? "session" : "sessions"}`)
			+ (count > 0 ? ` until ${until === null ? "something happens" : formatSnoozeTime(until, snoozeSheetNow)}` : "")
			+ (skipped ? `, ${skipped} skipped` : "");
		showToast(message, {
			duration: 5000,
			...(count > 0 ? { action: {
				label: "Undo",
				run: () => {
					void Promise.allSettled(changed.map((session) => session.wasSnoozed
						? snoozeSessionRpc({ projectSlug: session.projectSlug, sessionId: session.sessionId, originId: session.originId, until: session.previousUntil })
						: unsnoozeSessionRpc({ projectSlug: session.projectSlug, sessionId: session.sessionId, originId: session.originId }))).then((undoResults) => {
						if (undoResults.some((result) => result.status === "rejected")) showToast("Couldn't undo", { variant: "error" });
					});
				},
			} } : {}),
		});
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
	<!-- Select-mode header stays outside the scroller. -->
	{#if selectMode}
		<div class="session-list-header flex shrink-0 items-center gap-2 px-4 py-1 bg-bg-surface font-brand">
			<span class="min-w-0 flex-1 text-sm font-semibold">{selectionCount} selected</span>
			<TextButton type="button" title={allSelected ? "Select none" : "Select all"} tone="dimmer" class="min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 text-sm font-semibold" onclick={handleToggleSelectAll}>
				{allSelected ? "None" : "All"}
			</TextButton>
			<TextButton type="button" title="Done selecting" tone="dimmer" class="min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 text-sm font-semibold" onclick={resetSelectMode}>Done</TextButton>
		</div>
	{:else}
		<div class="shrink-0 px-2">
			<div class="session-list-header flex items-center justify-between px-2 py-1">
				<span class="text-sm font-semibold uppercase tracking-[0.5px] text-text-dimmer font-brand">Sessions</span>
				<div class="session-list-header-actions flex items-center gap-0.5">
					<!-- The one control here that is not `iconOnly`: its busy glyph is a
					     BlockGrid, the app-wide in-progress affordance. Button's `loading`
					     would swap it for a loader-circle, which appears nowhere else. -->
					<Button
						variant="toolbar"
						size="content"
						class={TOOLBAR_ICON_BOX}
						title="New session"
						ariaLabel="New session"
						onclick={handleNewSession}
						disabled={sessionCreation.value.phase === "creating"}
					>
						{#if sessionCreation.value.phase === "creating"}
							<BlockGrid cols={5} mode="fast" blockSize={1.5} gap={0.5} class="shrink-0" />
						{:else}
							<Icon name="plus" size={14} />
						{/if}
					</Button>
					<Button
						variant="toolbar"
						size="content"
						class={TOOLBAR_ICON_BOX}
						iconOnly
						iconSize={14}
						icon="circle-check"
						title="Select sessions"
						ariaLabel="Select sessions"
						onclick={() => handleEnterSelect()}
					/>
				</div>
			</div>
		</div>
	{/if}

	<div id="session-search" class="shrink-0 px-2.5 py-1 pb-1.5">
		<SessionSearchField
			value={localSearchValue}
			oninput={handleSearchInput}
			onescape={clearSearch}
			{onaddproject}
		/>
	</div>
	<div class="flex shrink-0 items-center gap-1 px-2.5 pb-1.5">
			<div class="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
				{#if grouping !== "status"}
					<Button
						variant="ghost"
						size="content"
						tone="default"
						class="shrink-0 gap-1.5 rounded-full border border-border bg-bg-alt px-2.5 text-xs font-brand {sessionViewState.compact ? 'min-h-[44px]' : 'min-h-8'}"
						data-testid="session-group-chip"
						onclick={() => setSessionGrouping("status")}
					>
						By {grouping} <span aria-hidden="true" class="text-text-dimmer">✕</span>
					</Button>
				{/if}
				{#each filterChips as chip (chip.value)}
					{@const active = statusFilter === chip.value}
					{@const count = live.filter((session) => sessionMatchesStatus(session, chip.value)).length}
					<Button
						variant="ghost"
						size="content"
						tone={chip.value === "needs-you" && count > 0 ? "accent" : active ? "default" : "secondary"}
						class="shrink-0 gap-1.5 rounded-full border px-2.5 text-xs font-brand {sessionViewState.compact ? 'min-h-[44px]' : 'min-h-8'} {chip.value === 'needs-you' && count > 0 ? 'border-accent/40 bg-accent/10' : active ? 'border-border bg-bg-alt' : 'border-border-subtle'}"
						aria-pressed={active}
						data-testid={`session-filter-chip-${chip.value}`}
						onclick={() => setSessionStatusFilter(active ? null : chip.value)}
					>
						{chip.label} <b class="font-semibold text-text">{count}</b>
						{#if active}<span aria-hidden="true" class="text-text-dimmer">✕</span>{/if}
					</Button>
				{/each}
			</div>
			{#if !sessionViewState.compact}<SessionGroupMenu />{/if}
	</div>
	{#if searchSummary}
		<!-- Outside the search-input block: the count belongs to the results, and
		     the input's visibility is local component state. -->
		<div
			class="flex shrink-0 items-center justify-between gap-2 px-3.5 pb-1.5 text-xs text-text-dimmer font-brand"
			data-testid="session-search-summary"
		>
			<span aria-live="polite">{searchSummary}</span>
			<TextButton onclick={clearSearch}>Clear</TextButton>
		</div>
	{/if}

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
		{#if isForeignSession(s)}
			<!-- Rename, most context-menu verbs and select-mode selection all
			     RPC the relay this socket is attached to, so handing them a session
			     owned by another project would act on the wrong relay. Withholding
			     the handlers is what makes the row inert instead of wrong. The menu
			     keeps only Mark read/unread (markOnly), which carries the row's
			     own projectSlug. -->
			<SessionItem
				session={s}
				pinned={s.pinnedAt != null}
				{settled}
				{snoozed}
				settledAt={settled ? formatTimeAgo(s.settledAt) : undefined}
				snoozedUntilText={snoozed ? formatSnoozeTime(s.snoozedUntil ?? null, sessionState.now) : undefined}
				now={sessionState.now}
				href={getRowHref(s)}
				projectLabel={getProjectLabel(s)}
				projectAccent={getProjectAccent(s)}
				branch={s.git?.branch}
				onswitchsession={() => handleSwitchSession(s)}
				oncontextmenu={handleContextMenu}
				menuOpen={ctxMenuSession?.id === s.id}
				onmarkread={() => { void toggleSessionRead(s); }}
				markOnly
			/>
		{:else}
			<SessionItem
				session={s}
				pinned={s.pinnedAt != null}
				{settled}
				{snoozed}
				settledAt={settled ? formatTimeAgo(s.settledAt) : undefined}
				snoozedUntilText={snoozed ? formatSnoozeTime(s.snoozedUntil ?? null, sessionState.now) : undefined}
				now={sessionState.now}
				href={getRowHref(s)}
				projectLabel={getProjectLabel(s)}
				projectAccent={getProjectAccent(s)}
				branch={s.git?.branch}
				active={s.id === sessionState.currentId}
				renaming={s.id === renamingSessionId}
				{selectMode}
				selected={selectedSessionIds.has(s.id)}
				heldSessionId={heldSessionId}
				menuOpen={ctxMenuSession?.id === s.id}
				onholdchange={(id) => { heldSessionId = id; }}
				onswitchsession={() => handleSwitchSession(s)}
				ontoggleselection={handleToggleSelection}
				oncontextmenu={handleContextMenu}
				onsettle={(_id, next) => { void sessionVerbActions.settle(s, next); }}
				onmarkread={(_id) => { void toggleSessionRead(s); }}
				onpin={(_id, next) => { void sessionVerbActions.pin(s, next); }}
				onsnooze={() => openSnoozePicker(s, "center")}
				onunsnooze={() => { void sessionVerbActions.unsnooze(s); }}
				oncommitsnooze={() => sessionVerbActions.commitTomorrow(s)}
				onrenameend={handleRenameEnd}
			/>
		{/if}
	{/snippet}

	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div id="session-list-scroller" class="flex-1 overflow-y-auto px-2 py-0.5" role="region" aria-label="Sessions" tabindex="0" onscroll={() => { heldSessionId = null; }}>
		{#if isEmpty}
			<div class="session-empty py-6 px-3.5 text-center text-xs text-text-dimmer font-brand" data-testid={statusFilter !== null && (!searching || filtered.length > 0) ? "session-filter-empty" : undefined}>
				{emptyMessage}
				{#if statusFilter !== null && (!searching || filtered.length > 0)}
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
	{#if selectMode}
		<div data-testid="select-bar" class="flex shrink-0 border-t border-border bg-bg-surface px-[6px] pt-2 pb-[calc(10px+env(safe-area-inset-bottom))] font-brand">
			<Button
				variant="ghost" size="content" tone="inherit" hoverFill="none" disabledStyle="none"
				disabled={settleEligible.length === 0 || bulkPending}
				data-testid="select-bar-settle"
				ariaLabel={`Settle ${settleEligible.length} ${settleEligible.length === 1 ? "session" : "sessions"}`}
				class={selectVerbClass}
				onclick={() => { void handleBulkSettle(); }}
			><Icon name="check" size={17} /> Settle</Button>
			<Button
				variant="ghost" size="content" tone="inherit" hoverFill="none" disabledStyle="none"
				disabled={snoozeEligible.length === 0 || bulkPending}
				data-testid="select-bar-snooze"
				ariaLabel={`Snooze ${snoozeEligible.length} ${snoozeEligible.length === 1 ? "session" : "sessions"}`}
				class={selectVerbClass}
				onclick={handleOpenBulkSnooze}
			><Icon name="moon" size={17} /> Snooze</Button>
			<Button
				variant="ghost" size="content" tone="inherit" hoverFill="none" disabledStyle="none"
				disabled={pinEligible.length === 0 || bulkPending}
				data-testid="select-bar-pin"
				ariaLabel={`${unpinSelected ? "Unpin" : "Pin"} ${pinEligible.length} ${pinEligible.length === 1 ? "session" : "sessions"}`}
				class={selectVerbClass}
				onclick={() => { void handleBulkPin(); }}
			><Icon name={unpinSelected ? "star-off" : "star"} size={17} /> {unpinSelected ? "Unpin" : "Pin"}</Button>
			<Button
				variant="ghost" size="content" tone="inherit" hoverFill="none" disabledStyle="none"
				disabled={selectionCount === 0 || bulkPending}
				data-testid="select-bar-delete"
				ariaLabel={`Delete ${selectionCount} ${selectionCount === 1 ? "session" : "sessions"}`}
				class="{selectVerbClass} text-error"
				onclick={handleBulkDelete}
			><Icon name="trash-2" size={17} /> Delete</Button>
		</div>
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
		host={{ rename: () => { if (ctxMenuSession) handleCtxRename(ctxMenuSession.id); }, select: () => { if (ctxMenuSession) handleEnterSelect(ctxMenuSession.id); } }}
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
