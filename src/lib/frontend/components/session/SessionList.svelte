<!-- ─── SessionList ─────────────────────────────────────────────────────────── -->
<!-- Sidebar session list with scope and search, status grouping, and new session button. -->
<!-- Reads from sessionState store and renders SessionItem components. -->

<script lang="ts">
	import { untrack } from "svelte";
	import type { AttentionGroups, SessionInfo } from "../../types.js";
	import {
		sessionState,
		getFilteredSessions,
		getAttentionGroups,
		setSearchQuery,
		setCurrentSession,
		switchToSession,
		sendNewSession,
		sessionCreation,
		clearSessionSearch,
		loadDaemonSessions,
		searchSessions,
	} from "../../stores/session.svelte.js";
	import { getSessionScope } from "../../stores/session-scope.js";
	import {
		getCurrentSlug,
		getSessionHref,
		routerState,
	} from "../../stores/router.svelte.js";
	import { projectState } from "../../stores/project.svelte.js";
	import { getBrowserClientId } from "../../stores/client-identity.js";
	import {
		deleteSessionRpc,
		forkSessionRpc,
		renameSessionRpc,
		setSessionSettledRpc,
		setSessionPinnedRpc,
	} from "../../transport/ws-rpc-client.js";
	import {
		confirm,
		showToast,
		uiState,
		setSettledShelfOpen,
	} from "../../stores/ui.svelte.js";
	import { formatTimeAgo } from "../../utils/format.js";
	import SessionItem from "./SessionItem.svelte";
	import SessionPager from "./SessionPager.svelte";
	import SessionContextMenu from "./SessionContextMenu.svelte";
	import Icon from "../ui/Icon.svelte";
	import BlockGrid from "../ui/BlockGrid.svelte";
	import Button from "../ui/Button.svelte";
	import TextButton from "../ui/TextButton.svelte";
	import SessionSearchField from "./SessionSearchField.svelte";
	import Banners from "../overlays/Banners.svelte";

	let { onaddproject }: { onaddproject?: (() => void) | undefined } = $props();

	// The box only; ui/Button `toolbar` owns the colours and the hover fill.
	// `size="content"` emits no geometry precisely so a call site can supply
	// its own without a `!` override (see Button.svelte::ButtonSize).
	const TOOLBAR_ICON_BOX = "h-6 w-6 rounded-md";

	// ─── Local state ────────────────────────────────────────────────────────────

	let localSearchValue = $state("");
	let debounceTimer: ReturnType<typeof setTimeout> | undefined = $state(
		undefined,
	);

	// Context menu state
	let ctxMenuSession = $state<SessionInfo | null>(null);
	let ctxMenuAnchor = $state<HTMLElement | null>(null);

	// Rename state — set by context menu to trigger inline rename on a SessionItem
	let renamingSessionId = $state<string | null>(null);

	// Paging sentinel, observed by SessionPager.
	let sentinelEl: HTMLElement | undefined = $state();

	// Cleanup mode state
	let cleanupMode = $state(false);
	let selectedForDeletion = $state<Set<string>>(new Set());

	// ─── Derived ────────────────────────────────────────────────────────────────

	const filtered = $derived(getFilteredSessions());
	const cleanupCandidates = $derived(
		filtered.filter((session) => !isForeignSession(session)),
	);
	const groups: AttentionGroups = $derived(getAttentionGroups());
	const isEmpty = $derived(filtered.length === 0);
	const searching = $derived(sessionState.searchQuery.trim().length > 0);
	const settledShelfOpen = $derived(searching || uiState.settledShelfOpen);

	const scope = $derived(getSessionScope());
	const emptyMessage = $derived.by(() => {
		if (sessionState.searchQuery) return "No matching sessions";
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

	const selectionCount = $derived(selectedForDeletion.size);
	const allSelected = $derived(
		cleanupCandidates.length > 0 &&
			cleanupCandidates.every((s) => selectedForDeletion.has(s.id)),
	);

	const unavailableProjectLabels = $derived(
		sessionState.daemonUnavailableProjects.map(projectDisplayName),
	);

	// Rendered in this order, and an empty one is left out entirely: a heading
	// over nothing costs a line of a phone's list and says nothing.
	const sections = $derived([
		{ label: "Pinned", sessions: groups.pinned },
		{ label: "Needs you", sessions: groups.needsYou },
		{ label: "Running", sessions: groups.running },
		{ label: "Done, unread", sessions: groups.doneUnread },
		{ label: "Idle", sessions: groups.idle },
	]);

	// Prune stale selections when the session list changes externally
	$effect(() => {
		if (!cleanupMode) return;
		const validIds = new Set(cleanupCandidates.map((s) => s.id));
		const pruned = new Set([...selectedForDeletion].filter((id) => validIds.has(id)));
		if (pruned.size !== selectedForDeletion.size) {
			selectedForDeletion = pruned;
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

	// Exit cleanup mode when session list becomes empty
	$effect(() => {
		if (cleanupMode && isEmpty) {
			cleanupMode = false;
			selectedForDeletion = new Set();
		}
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
	function isForeignSession(session: SessionInfo): boolean {
		return (
			session.projectSlug != null && session.projectSlug !== getCurrentSlug()
		);
	}

	function getRowHref(session: SessionInfo): string {
		return getSessionHref(session.id);
	}

	// Named on every row once a second project exists, including the rows of the
	// project you are already in: in a merged list an unlabelled row would mean
	// "work out which project this is yourself", and you cannot. With a single
	// project it is pure noise and is absent entirely.
	//
	// Resolved from the live project list rather than stamped onto the session at
	// fetch time, so renaming a project relabels its rows without the list being
	// re-fetched. Falls back to the slug because the project list arrives over
	// the socket and the sidebar renders before it does.
	function getProjectLabel(session: SessionInfo): string | undefined {
		if (projectState.projects.length <= 1) return undefined;
		const slug = session.projectSlug ?? getCurrentSlug();
		return slug ? projectDisplayName(slug) : undefined;
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

	function handleSwitchSession(id: string, projectSlug?: string) {
		if (id !== sessionState.currentId) {
			switchToSession(id, projectSlug);
		}
	}

	function handleContextMenu(session: SessionInfo, anchor: HTMLElement) {
		// Open context menu for this session
		ctxMenuSession = session;
		ctxMenuAnchor = anchor;
	}

	function handleCloseContextMenu() {
		ctxMenuSession = null;
		ctxMenuAnchor = null;
	}

	function handleCtxRename(id: string) {
		// Set reactive state — SessionItem with matching id enters rename mode
		renamingSessionId = id;
	}

	async function handleCtxSettle(session: SessionInfo, settled: boolean) {
		const projectSlug = session.projectSlug ?? getCurrentSlug();
		if (!projectSlug || isForeignSession(session)) return;
		const input = { projectSlug, sessionId: session.id, originId: getBrowserClientId() };
		try {
			await setSessionSettledRpc({ ...input, settled });
			if (settled) {
				showToast(`Moved “${session.title || "New Session"}” to Settled`, {
					duration: 5000,
					action: {
						label: "Undo",
						run: () => {
							void setSessionSettledRpc({ ...input, settled: false }).catch(() => {
								showToast("Couldn't undo", { variant: "error" });
							});
						},
					},
				});
			}
		} catch {
			showToast("Couldn't settle session", { variant: "error" });
		}
	}

	async function handleCtxPin(session: SessionInfo, pinned: boolean) {
		const projectSlug = session.projectSlug ?? getCurrentSlug();
		if (!projectSlug || isForeignSession(session)) return;
		const input = { projectSlug, sessionId: session.id, originId: getBrowserClientId() };
		try {
			await setSessionPinnedRpc({ ...input, pinned });
			if (pinned) {
				showToast(`Pinned “${session.title || "New Session"}” to the top`, {
					duration: 5000,
					action: {
						label: "Undo",
						run: () => {
							void setSessionPinnedRpc({ ...input, pinned: false }).catch(() => {
								showToast("Couldn't undo", { variant: "error" });
							});
						},
					},
				});
			}
		} catch {
			showToast("Couldn't pin session", { variant: "error" });
		}
	}

	function handleRenameEnd() {
		renamingSessionId = null;
	}

	async function handleCtxDelete(id: string, title: string) {
		const confirmed = await confirm(
			`Delete "${title}"? This session and its history will be permanently removed.`,
			"Delete",
		);
		if (confirmed) {
			const projectSlug = getCurrentSlug();
			if (!projectSlug) return;
			// Surface failures: a rejected delete used to vanish into an
			// unhandled rejection, leaving the row in place with no feedback.
			deleteSessionRpc({
				projectSlug,
				sessionId: id,
				originId: getBrowserClientId(),
			}).catch(() => {
				showToast(`Couldn't delete "${title}"`, { variant: "warn" });
			});
		}
	}

	function handleCtxCopyResume(_id: string) {
		// Copy is handled inside the context menu component
	}

	function handleCtxFork(id: string) {
		const projectSlug = getCurrentSlug();
		if (!projectSlug) return;
		void forkSessionRpc({
			projectSlug,
			sessionId: id,
			originId: getBrowserClientId(),
		}).then((response) => {
			if (!sessionState.currentId) switchToSession(response.sessionId, response.projectSlug);
		}).catch(() => showToast("Failed to fork session", { variant: "error" }));
	}

	function resetCleanupMode() {
		cleanupMode = false;
		selectedForDeletion = new Set();
	}

	function handleEnterCleanup() {
		cleanupMode = true;
		selectedForDeletion = new Set();
		if (localSearchValue) clearSearch();
	}

	function handleExitCleanup() {
		resetCleanupMode();
	}

	function handleToggleSelection(id: string) {
		const next = new Set(selectedForDeletion);
		if (next.has(id)) {
			next.delete(id);
		} else {
			next.add(id);
		}
		selectedForDeletion = next;
	}

	function handleToggleSelectAll() {
		if (allSelected) {
			selectedForDeletion = new Set();
		} else {
			selectedForDeletion = new Set(cleanupCandidates.map((s) => s.id));
		}
	}

	async function handleBulkDelete() {
		const count = selectionCount;
		const label = count === 1 ? "1 session" : `${count} sessions`;
		const confirmed = await confirm(
			`Delete ${label}? These sessions and their history will be permanently removed.`,
			"Delete",
		);
		if (confirmed) {
			const projectSlug = getCurrentSlug();
			if (!projectSlug) return;
			// Snapshot the ids, then clear selection so the UI responds at once.
			const ids = [...selectedForDeletion];
			resetCleanupMode();
			const results = await Promise.allSettled(
				ids.map((id) =>
					deleteSessionRpc({
						projectSlug,
						sessionId: id,
						originId: getBrowserClientId(),
					}),
				),
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
	}

	function handleRename(id: string, title: string) {
		const projectSlug = getCurrentSlug();
		if (!projectSlug) return;
		void renameSessionRpc({ projectSlug, sessionId: id, title });
	}
</script>

<div id="session-list" class="flex-1 flex flex-col overflow-hidden">
	{#if routerState.sessionNotFound}
		<Banners
			banners={[{ id: "session-not-found", variant: "warning", icon: "alert-triangle", text: "Session not found. That session no longer exists.", dismissible: true }]}
			showHealthWarning={false}
			ondismiss={() => { routerState.sessionNotFound = false; }}
		/>
	{/if}
	<!-- Session list header — cleanup mode (fixed, outside scroll) -->
	{#if cleanupMode}
		<div class="shrink-0 px-2 pb-1 bg-bg-surface">
			<div class="session-list-header flex items-center justify-between px-2 py-1">
				<TextButton
					type="button"
					title={allSelected ? "Deselect all sessions" : "Select all sessions"}
				tone="dimmer" class="flex items-center gap-1.5 text-sm font-semibold transition-colors duration-100 font-brand"
				onclick={handleToggleSelectAll}
				>
					<Icon name={allSelected ? "circle-check" : "circle"} size={14} />
					<span>{allSelected ? "Deselect all" : "Select all"}</span>
				</TextButton>
				<TextButton
					type="button"
					title="Exit cleanup mode"
				tone="dimmer" class="text-sm font-semibold transition-colors duration-100 font-brand"
				onclick={handleExitCleanup}
				>
					Cancel
				</TextButton>
			</div>
			<div class="px-2">
				<!--
					The parent stays a plain block on purpose. A raw button element is
					`inline-block` by default, so this control already sits on a line box
					and already carries the descender gap below it; BASE's `inline-flex`
					is inline-level too, so nothing moves. (Contrast file/FileTreeNode,
					where the as-found class list said `flex` -- block-level -- and the
					swap DID need a `flex flex-col` wrapper.) Making this parent a flex
					column would close a gap that is currently there, which is a diff.
					`disabledStyle="undimmed"` because the as-found disabled state does
					not dim: it only swaps the colour set through the expression below.
				-->
				<Button
					variant="ghost"
					size="content"
					tone="inherit"
					hoverFill="none"
					disabledStyle="undimmed"
					disabled={selectionCount === 0}
					class="w-full py-1.5 px-4 rounded-lg text-xs font-medium border duration-100 font-brand {selectionCount >
					0
						? 'bg-error/10 text-error border-error/20 hover:bg-error/20'
						: 'bg-transparent text-text-dimmer border-border-subtle cursor-default'}"
					onclick={handleBulkDelete}
				>
					{selectionCount > 0
						? `Delete ${selectionCount === 1 ? "1 session" : `${selectionCount} sessions`}`
						: "Select sessions to delete"}
				</Button>
			</div>
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
						icon="trash-2"
						title="Cleanup sessions"
						ariaLabel="Cleanup sessions"
						onclick={handleEnterCleanup}
					/>
				</div>
			</div>
		</div>
	{/if}

	{#if !cleanupMode}
		<div id="session-search" class="shrink-0 px-2.5 py-1 pb-1.5">
			<SessionSearchField
				value={localSearchValue}
				oninput={handleSearchInput}
				onescape={clearSearch}
				{onaddproject}
			/>
		</div>
	{/if}

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
	     in cleanup mode and would leave the idref dangling. -->
	<!-- One row, rendered by every section. It is a snippet rather than a copy
	     per section because the row is about to grow: the shelves and the
	     per-row verbs each land in their own ticket, and copies would mean one
	     edit each with any divergence between them invisible. -->
	{#snippet sessionRow(s: SessionInfo)}
		{@const settled = s.pinnedAt == null && s.settledAt != null}
		{#if isForeignSession(s)}
			<!-- Rename, the context menu and cleanup selection all
			     RPC the relay this socket is attached to, so handing them a session
			     owned by another project would act on the wrong relay. Withholding
			     the handlers is what makes the row inert instead of wrong, and it
			     keeps those actions on the owning relay. -->
			<SessionItem
				session={s}
				pinned={s.pinnedAt != null}
				{settled}
				settledAt={settled ? formatTimeAgo(s.settledAt) : undefined}
				href={getRowHref(s)}
				projectLabel={getProjectLabel(s)}
				onswitchsession={(id) => handleSwitchSession(id, s.projectSlug)}
			/>
		{:else}
			<SessionItem
				session={s}
				pinned={s.pinnedAt != null}
				{settled}
				settledAt={settled ? formatTimeAgo(s.settledAt) : undefined}
				href={getRowHref(s)}
				projectLabel={getProjectLabel(s)}
				active={s.id === sessionState.currentId}
				renaming={s.id === renamingSessionId}
				{cleanupMode}
				selected={selectedForDeletion.has(s.id)}
				onswitchsession={(id) => handleSwitchSession(id, s.projectSlug)}
				ontoggleselection={handleToggleSelection}
				oncontextmenu={handleContextMenu}
				onrename={handleRename}
				onrenameend={handleRenameEnd}
			/>
		{/if}
	{/snippet}

	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div id="session-list-scroller" class="flex-1 overflow-y-auto px-2 py-0.5" role="region" aria-label="Sessions" tabindex="0">
		{#if isEmpty}
			<div class="session-empty py-6 px-3.5 text-center text-xs text-text-dimmer font-brand">
				{emptyMessage}
			</div>
		{:else}
			{#each sections as section (section.label)}
				{#if section.sessions.length > 0}
					<div class="session-group-label pt-1.5 pb-0.5 px-3 text-xs font-semibold text-text-dimmer tracking-[0.3px] font-brand">
						{section.label}
					</div>
					{#each section.sessions as s (s.id)}
						{@render sessionRow(s)}
					{/each}
				{/if}
			{/each}
			{#if groups.settled.length > 0}
				<TextButton
					tone="dimmer"
					class="session-group-label flex items-center gap-1 pt-1.5 pb-0.5 px-3 text-xs font-semibold tracking-[0.3px] font-brand"
					data-testid="settled-shelf-toggle"
					aria-expanded={settledShelfOpen}
					aria-controls="settled-shelf-rows"
					onclick={() => { if (!searching) setSettledShelfOpen(!uiState.settledShelfOpen); }}
				>
					<Icon name={settledShelfOpen ? "chevron-down" : "chevron-right"} size={12} />
					Settled
				</TextButton>
				<div id="settled-shelf-rows">
					{#if settledShelfOpen}
						{#each groups.settled as s (s.id)}
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
</div>

<!-- Session context menu (rendered outside the scrollable area for proper z-index) -->
{#if !cleanupMode && ctxMenuSession && ctxMenuAnchor}
	<SessionContextMenu
		session={ctxMenuSession}
		anchor={ctxMenuAnchor}
		onrename={handleCtxRename}
		onsettle={(_id, next) => { if (ctxMenuSession) void handleCtxSettle(ctxMenuSession, next); }}
		onpin={(_id, next) => { if (ctxMenuSession) void handleCtxPin(ctxMenuSession, next); }}
		ondelete={handleCtxDelete}
		oncopyresume={handleCtxCopyResume}
		onfork={handleCtxFork}
		onclose={handleCloseContextMenu}
	/>
{/if}
