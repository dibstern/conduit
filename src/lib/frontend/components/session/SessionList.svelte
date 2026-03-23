<!-- ─── SessionList ─────────────────────────────────────────────────────────── -->
<!-- Sidebar session list with search, date grouping, and new session button. -->
<!-- Reads from sessionState store and renders SessionItem components. -->

<script lang="ts">
	import type { DateGroups, SessionInfo } from "../../types.js";
	import {
		sessionState,
		getFilteredSessions,
		getDateGroups,
		setSearchQuery,
		setCurrentSession,
		switchToSession,
		sendNewSession,
		sessionCreation,
	} from "../../stores/session.svelte.js";
	import { getSessionHref } from "../../stores/router.svelte.js";
	import { wsSend } from "../../stores/ws.svelte.js";
	import { closeMobileSidebar, confirm, toggleHideSubagentSessions, uiState } from "../../stores/ui.svelte.js";
	import SessionItem from "./SessionItem.svelte";
	import SessionContextMenu from "./SessionContextMenu.svelte";
	import Icon from "../shared/Icon.svelte";
	import BlockGrid from "../shared/BlockGrid.svelte";

	// ─── Local state ────────────────────────────────────────────────────────────

	let searchVisible = $state(false);
	let localSearchValue = $state("");
	let debounceTimer: ReturnType<typeof setTimeout> | undefined = $state(
		undefined,
	);

	// Context menu state
	let ctxMenuSession = $state<SessionInfo | null>(null);
	let ctxMenuAnchor = $state<HTMLElement | null>(null);

	// Rename state — set by context menu to trigger inline rename on a SessionItem
	let renamingSessionId = $state<string | null>(null);

	// Cleanup mode state
	let cleanupMode = $state(false);
	let selectedForDeletion = $state<Set<string>>(new Set());

	// ─── Derived ────────────────────────────────────────────────────────────────

	const filtered = $derived(getFilteredSessions());
	const groups: DateGroups = $derived(getDateGroups());
	const isEmpty = $derived(filtered.length === 0);

	const emptyMessage = $derived(
		sessionState.searchQuery ? "No matching sessions" : "No sessions yet",
	);

	const selectionCount = $derived(selectedForDeletion.size);
	const allSelected = $derived(
		filtered.length > 0 && filtered.every((s) => selectedForDeletion.has(s.id)),
	);

	const hasToday = $derived(groups.today.length > 0);
	const hasYesterday = $derived(groups.yesterday.length > 0);
	const hasOlder = $derived(groups.older.length > 0);

	// Prune stale selections when the session list changes externally
	$effect(() => {
		if (!cleanupMode) return;
		const validIds = new Set(filtered.map((s) => s.id));
		const pruned = new Set([...selectedForDeletion].filter((id) => validIds.has(id)));
		if (pruned.size !== selectedForDeletion.size) {
			selectedForDeletion = pruned;
		}
	});

	// Exit cleanup mode when session list becomes empty
	$effect(() => {
		if (cleanupMode && isEmpty) {
			cleanupMode = false;
			selectedForDeletion = new Set();
		}
	});

	// Re-send search when subagent toggle changes during active search
	$effect(() => {
		const _hide = uiState.hideSubagentSessions; // track dependency
		if (localSearchValue.trim()) {
			if (debounceTimer !== undefined) clearTimeout(debounceTimer);
			wsSend({
				type: "search_sessions",
				query: localSearchValue,
				...(_hide && { roots: true }),
			});
		}
	});

	// ─── Handlers ───────────────────────────────────────────────────────────────

	function handleNewSession() {
		if (!sendNewSession(wsSend)) return;
		closeMobileSidebar();
	}

	function closeSearch() {
		searchVisible = false;
		localSearchValue = "";
		setSearchQuery("");
		sessionState.searchResults = null;
	}

	function handleToggleSearch() {
		searchVisible = !searchVisible;
		if (!searchVisible) {
			closeSearch();
		}
	}

	function handleSearchInput(e: Event) {
		const input = e.target as HTMLInputElement;
		localSearchValue = input.value;

		// Apply local filter immediately
		setSearchQuery(localSearchValue);

		// Debounce remote search
		if (debounceTimer !== undefined) clearTimeout(debounceTimer);
		if (localSearchValue.trim()) {
			debounceTimer = setTimeout(() => {
				wsSend({
					type: "search_sessions",
					query: localSearchValue,
					...(uiState.hideSubagentSessions && { roots: true }),
				});
			}, 300);
		}
	}

	function handleSearchKeydown(e: KeyboardEvent) {
		if (e.key === "Escape") {
			e.preventDefault();
			searchVisible = false;
			localSearchValue = "";
			setSearchQuery("");
		}
	}

	function handleSwitchSession(id: string) {
		if (id !== sessionState.currentId) {
			switchToSession(id, wsSend);
		}
		closeMobileSidebar();
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

	function handleRenameEnd() {
		renamingSessionId = null;
	}

	async function handleCtxDelete(id: string, title: string) {
		const confirmed = await confirm(
			`Delete "${title}"? This session and its history will be permanently removed.`,
			"Delete",
		);
		if (confirmed) {
			wsSend({ type: "delete_session", sessionId: id });
		}
	}

	function handleCtxCopyResume(_id: string) {
		// Copy is handled inside the context menu component
	}

	function handleCtxFork(id: string) {
		wsSend({ type: "fork_session", sessionId: id });
	}

	function resetCleanupMode() {
		cleanupMode = false;
		selectedForDeletion = new Set();
	}

	function handleEnterCleanup() {
		cleanupMode = true;
		selectedForDeletion = new Set();
		if (searchVisible) {
			closeSearch();
		}
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
			selectedForDeletion = new Set(filtered.map((s) => s.id));
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
			for (const id of selectedForDeletion) {
				wsSend({ type: "delete_session", sessionId: id });
			}
			resetCleanupMode();
		}
	}

	function handleRename(id: string, title: string) {
		wsSend({ type: "rename_session", sessionId: id, title });
	}

	// ─── Actions ────────────────────────────────────────────────────────────────

	function focusOnMount(node: HTMLElement) {
		node.focus();
	}
</script>

<div id="session-list" class="flex-1 flex flex-col overflow-hidden">
	<!-- Session list header — cleanup mode (fixed, outside scroll) -->
	{#if cleanupMode}
		<div class="shrink-0 px-2 pb-1 bg-bg-surface">
			<div class="session-list-header flex items-center justify-between px-2 py-1">
				<button
					type="button"
					title={allSelected ? "Deselect all sessions" : "Select all sessions"}
				class="flex items-center gap-1.5 border-none bg-transparent text-sm font-semibold text-text-dimmer cursor-pointer p-0 hover:text-text transition-colors duration-100 font-brand"
				onclick={handleToggleSelectAll}
				>
					<Icon name={allSelected ? "circle-check" : "circle"} size={14} />
					<span>{allSelected ? "Deselect all" : "Select all"}</span>
				</button>
				<button
					type="button"
					title="Exit cleanup mode"
				class="border-none bg-transparent text-sm font-semibold text-text-dimmer cursor-pointer p-0 hover:text-text transition-colors duration-100 font-brand"
				onclick={handleExitCleanup}
				>
					Cancel
				</button>
			</div>
			<div class="px-2">
				<button
					type="button"
					disabled={selectionCount === 0}
				class="w-full py-1.5 px-4 rounded-lg text-xs font-medium border cursor-pointer transition-colors duration-100 font-brand {selectionCount > 0 ? 'bg-error/10 text-error border-error/20 hover:bg-error/20' : 'bg-transparent text-text-dimmer border-border-subtle cursor-default'}"
				onclick={handleBulkDelete}
				>
					{selectionCount > 0
						? `Delete ${selectionCount === 1 ? "1 session" : `${selectionCount} sessions`}`
						: "Select sessions to delete"}
				</button>
			</div>
		</div>
	{:else}
		<div class="shrink-0 px-2">
			<div class="session-list-header flex items-center justify-between px-2 py-1">
				<span class="text-sm font-semibold uppercase tracking-[0.5px] text-text-dimmer font-brand">Sessions</span>
				<div class="session-list-header-actions flex items-center gap-0.5">
					<button
						type="button"
						title="New session"
					onclick={handleNewSession}
					disabled={sessionCreation.value.phase === "creating"}
					class="flex items-center justify-center w-6 h-6 border-none rounded-md bg-transparent text-text-dimmer cursor-pointer disabled:cursor-default transition-[background,color] duration-100 p-0 hover:bg-[rgba(var(--overlay-rgb),0.04)] hover:text-text"
					>
						{#if sessionCreation.value.phase === "creating"}
							<BlockGrid cols={5} mode="fast" blockSize={1.5} gap={0.5} class="shrink-0" />
						{:else}
							<Icon name="plus" size={14} />
						{/if}
					</button>
					<button
						id="search-session-btn"
						type="button"
						title="Search sessions"
					class="flex items-center justify-center w-6 h-6 border-none rounded-md bg-transparent text-text-dimmer cursor-pointer transition-[background,color] duration-100 p-0 hover:bg-[rgba(var(--overlay-rgb),0.04)] hover:text-text"
					onclick={handleToggleSearch}
					>
						<Icon name="search" size={14} />
					</button>
				<button
					type="button"
					data-testid="subagent-toggle"
					title={uiState.hideSubagentSessions ? "Show subagent sessions" : "Hide subagent sessions"}
					class="flex items-center justify-center w-6 h-6 border-none rounded-md bg-transparent cursor-pointer transition-[background,color] duration-100 p-0 hover:bg-[rgba(var(--overlay-rgb),0.04)] hover:text-text {uiState.hideSubagentSessions ? 'text-text-dimmer' : 'text-accent'}"
					onclick={toggleHideSubagentSessions}
					>
						<Icon name="git-fork" size={14} />
					</button>
					<button
						type="button"
						title="Cleanup sessions"
					class="flex items-center justify-center w-6 h-6 border-none rounded-md bg-transparent text-text-dimmer cursor-pointer transition-[background,color] duration-100 p-0 hover:bg-[rgba(var(--overlay-rgb),0.04)] hover:text-text"
					onclick={handleEnterCleanup}
					>
						<Icon name="trash-2" size={14} />
					</button>
				</div>
			</div>
		</div>
	{/if}

	{#if searchVisible}
		<div class="shrink-0 px-2.5 py-1 pb-1.5">
			<input
				id="session-search-input"
				type="text"
				placeholder="Search sessions..."
				autocomplete="off"
				spellcheck="false"
			class="w-full bg-input-bg border border-border rounded-lg py-1.5 px-2.5 text-xs text-text outline-none focus:border-accent placeholder:text-text-dimmer font-brand"
				value={localSearchValue}
				oninput={handleSearchInput}
				onkeydown={handleSearchKeydown}
				use:focusOnMount
			/>
		</div>
	{/if}

	<!-- Scrollable session list content -->
	<div class="flex-1 overflow-y-auto px-2 py-0.5">
		{#if isEmpty}
			<div class="session-empty py-6 px-3.5 text-center text-xs text-text-dimmer font-brand">
				{emptyMessage}
			</div>
		{:else}
			{#if hasToday}
			<div class="session-group-label pt-1.5 pb-0.5 px-3 text-xs font-semibold text-text-dimmer tracking-[0.3px] font-brand">
				Today
			</div>
			{#each groups.today as s (s.id)}
				<SessionItem
					session={s}
					href={getSessionHref(s.id) ?? ""}
					active={s.id === sessionState.currentId}
					renaming={s.id === renamingSessionId}
					{cleanupMode}
					selected={selectedForDeletion.has(s.id)}
					onswitchsession={handleSwitchSession}
					ontoggleselection={handleToggleSelection}
					oncontextmenu={handleContextMenu}
					onrename={handleRename}
					onrenameend={handleRenameEnd}
				/>
			{/each}
			{/if}

			{#if hasYesterday}
			<div class="session-group-label pt-1.5 pb-0.5 px-3 text-xs font-semibold text-text-dimmer tracking-[0.3px] font-brand">
				Yesterday
			</div>
			{#each groups.yesterday as s (s.id)}
				<SessionItem
					session={s}
					href={getSessionHref(s.id) ?? ""}
					active={s.id === sessionState.currentId}
					renaming={s.id === renamingSessionId}
					{cleanupMode}
					selected={selectedForDeletion.has(s.id)}
					onswitchsession={handleSwitchSession}
					ontoggleselection={handleToggleSelection}
					oncontextmenu={handleContextMenu}
					onrename={handleRename}
					onrenameend={handleRenameEnd}
				/>
			{/each}
			{/if}

			{#if hasOlder}
			<div class="session-group-label pt-1.5 pb-0.5 px-3 text-xs font-semibold text-text-dimmer tracking-[0.3px] font-brand">
				Older
			</div>
			{#each groups.older as s (s.id)}
				<SessionItem
					session={s}
					href={getSessionHref(s.id) ?? ""}
					active={s.id === sessionState.currentId}
					renaming={s.id === renamingSessionId}
					{cleanupMode}
					selected={selectedForDeletion.has(s.id)}
					onswitchsession={handleSwitchSession}
					ontoggleselection={handleToggleSelection}
					oncontextmenu={handleContextMenu}
					onrename={handleRename}
					onrenameend={handleRenameEnd}
				/>
			{/each}
			{/if}
		{/if}
	</div>
</div>

<!-- Session context menu (rendered outside the scrollable area for proper z-index) -->
{#if !cleanupMode && ctxMenuSession && ctxMenuAnchor}
	<SessionContextMenu
		session={ctxMenuSession}
		anchor={ctxMenuAnchor}
		onrename={handleCtxRename}
		ondelete={handleCtxDelete}
		oncopyresume={handleCtxCopyResume}
		onfork={handleCtxFork}
		onclose={handleCloseContextMenu}
	/>
{/if}
