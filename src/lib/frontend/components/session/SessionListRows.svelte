<script lang="ts">
	import type { SessionInfo } from "../../types.js";
	import { effectiveWorkingDirectory } from "../../../session/session-workspace.js";
	import { projectState } from "../../stores/project.svelte.js";
	import type { SessionProjection } from "../../stores/session.svelte.js";
	import { isSessionSnoozed, isSessionWoken, sessionState } from "../../stores/session.svelte.js";
	import { selection } from "../../stores/selection.svelte.js";
	import { getSessionHref } from "../../stores/router.svelte.js";
	import { getBrowserClientId } from "../../stores/client-identity.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import { toastFailure } from "../../transport/rpc-errors.js";
	import { touch } from "../../utils/attention.js";
	import { setSessionStatusFilter, type SessionStatusFilter } from "../../stores/session-scope.js";
	import { setSettledShelfOpen, setSnoozedShelfOpen, uiState } from "../../stores/ui.svelte.js";
	import { formatSnoozeTime, formatTimeAgo } from "../../utils/format.js";
	import { toggleSessionRead } from "../../utils/session-read.js";
	import { openSnoozePicker } from "../../stores/snooze-picker.svelte.js";
	import { sessionCommandActions } from "./session-commands.js";
	import SessionItem from "./SessionItem.svelte";
	import SessionPager from "./SessionPager.svelte";
	import Button from "../ui/Button.svelte";
	import TextButton from "../ui/TextButton.svelte";
	import Icon from "../ui/Icon.svelte";
	import SortableList from "../ui/SortableList.svelte";
	import ProjectSquare from "./ProjectSquare.svelte";
	import { projectAccent } from "./session-list-project.js";
	import {
		projectTreeState,
		setProjectOrder,
		toggleProjectCollapsed,
		toggleProjectShowingAll,
		type ProjectTreeNode,
	} from "../../stores/project-tree.svelte.js";

	let { arrangement, fullArrangement, tree, reorderable, isEmpty, emptyMessage, statusFilter, searching, filteredLength, snoozedShelfOpen, settledShelfOpen, pagerPending, unavailableProjectLabels, selectMode, selectedSessionIds, menuOpenId, renamingSessionId, getProjectLabel, getProjectAccent, oncontextmenu, ontoggleselection, onrenamestart, onrenameend }: {
		arrangement: SessionProjection;
		fullArrangement: SessionProjection;
		/** The project tree, when the list is grouped by project. */
		tree: ProjectTreeNode[] | null;
		/** The tree shows every project, so a drag can save the whole order. */
		reorderable: boolean;
		isEmpty: boolean;
		emptyMessage: string;
		statusFilter: SessionStatusFilter | null;
		searching: boolean;
		filteredLength: number;
		snoozedShelfOpen: boolean;
		settledShelfOpen: boolean;
		pagerPending: boolean;
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
	/** Manual order drags projects by a handle in the header's left padding. */
	const sortable = $derived(reorderable && projectTreeState.sort === "manual");
	let heldSessionId = $state<string | null>(null);
	let sentinelEl: HTMLElement | undefined = $state();
	// Until the user scrolls, paging is background fill (a list kept short by a
	// collapsed shelf pages to the end on load) and nobody is waiting for it.
	let scrolled = $state(false);

	function handleSwitchSession(session: SessionInfo) {
		touch(session, "sidebar-pick");
		const projectSlug = session.projectSlug;
		if (projectSlug && isSessionWoken(session, sessionState.now)) {
			rpc("UnsnoozeSession", { sessionId: session.id, originId: getBrowserClientId() })
				.catch(toastFailure("Couldn't clear the wake"));
		}
		if (session.id !== sessionState.currentId) selection.open(session.id);
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
	     per-row commands each land in their own ticket, and copies would mean one
	     edit each with any divergence between them invisible. -->
	{#snippet sessionRow(s: SessionInfo, underProject = false)}
		{@const settled = s.pinnedAt == null && s.settledAt != null}
		{@const snoozed = !settled && s.pinnedAt == null && isSessionSnoozed(s, sessionState.now)}
		{@const primary = projectState.projects.find((project) => project.slug === s.projectSlug)?.folders[0]}
		<SessionItem
			session={s}
			pinned={s.pinnedAt != null}
			{settled}
			{snoozed}
			settledAt={settled ? formatTimeAgo(s.settledAt) : undefined}
			snoozedUntilText={snoozed ? formatSnoozeTime(s.snoozedUntil ?? null, sessionState.now) : undefined}
			now={sessionState.now}
			href={getSessionHref(s.id)}
			projectLabel={underProject ? undefined : getProjectLabel(s)}
			projectAccent={getProjectAccent(s)}
			branch={primary && effectiveWorkingDirectory(primary, s.workspace) !== primary ? s.git?.branch : undefined}
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
			onsettle={(_id, next) => { void sessionCommandActions.settle(s, next); }}
			onmarkread={(_id) => { void toggleSessionRead(s); }}
			onpin={(_id, next) => { void sessionCommandActions.pin(s, next); }}
			onsnooze={() => openSnoozePicker(s, "center")}
			onunsnooze={() => { void sessionCommandActions.unsnooze(s); }}
			oncommitsnooze={() => sessionCommandActions.commitTomorrow(s)}
			onrenamestart={() => onrenamestart(s.id)}
			{onrenameend}
		/>
	{/snippet}

	<!-- A project's header: collapse toggle, then a new draft in that project. -->
	{#snippet projectHeader(node: ProjectTreeNode)}
		<div class="session-group-label group flex min-w-0 flex-1 items-center" data-testid="project-tree-header" data-project={node.slug}>
			<Button
				variant="ghost"
				size="content"
				layout="flow"
				tone="inherit"
				hoverFill="none"
				class="flex min-w-0 flex-1 items-center gap-[7px] min-h-[44px] md:min-h-[30px] {sortable ? 'pl-0' : 'pl-[11px]'} pr-[7px] rounded-panel text-left text-text-secondary hover:text-text font-brand"
				data-testid="project-tree-toggle"
				aria-expanded={!node.collapsed}
				aria-controls="project-tree-rows-{node.slug}"
				onclick={() => { if (!searching && statusFilter === null) toggleProjectCollapsed(node.slug); }}
			>
				<Icon name={node.collapsed ? "chevron-right" : "chevron-down"} size={12} class="shrink-0 text-text-dimmer" />
				<ProjectSquare label={node.title} accent={projectAccent(node.slug)} />
				<span class="truncate text-base font-medium" data-testid="project-tree-title">{node.title}</span>
				<span class="ml-auto pl-2 text-xs tabular-nums text-text-dimmer md:group-hover:hidden md:group-focus-within:hidden">{node.sessions.length}</span>
			</Button>
			<Button
				variant="ghost"
				size="content"
				tone="muted"
				hoverFill="alt"
				iconOnly
				icon="plus"
				iconSize={14}
				class="shrink-0 justify-center min-h-[44px] min-w-[44px] md:min-h-[24px] md:min-w-[24px] rounded-md md:hidden md:group-hover:inline-flex md:group-focus-within:inline-flex"
				title="New session in {node.title}"
				ariaLabel="New session in {node.title}"
				data-testid="project-tree-new-session"
				disabled={!node.available}
				onclick={() => selection.openDraft(node.slug)}
			/>
		</div>
	{/snippet}

	{#snippet projectRows(node: ProjectTreeNode)}
		<div id="project-tree-rows-{node.slug}" class="pl-[17px] pb-1" data-testid="project-tree-rows">
			{#each node.shown as s (s.id)}{@render sessionRow(s, true)}{/each}
			{#if node.empty && !node.collapsed}
				<div class="py-1 pl-[36px] text-xs text-text-dimmer font-brand" data-testid="project-tree-empty">No sessions</div>
			{/if}
			{#if node.more}
				<TextButton
					tone="dimmer"
					class="min-h-[44px] md:min-h-0 py-1 pl-[36px] text-xs font-brand"
					data-testid="project-tree-more"
					onclick={() => toggleProjectShowingAll(node.slug)}
				>{node.more === "more" ? "Show more" : "Show less"}</TextButton>
			{/if}
		</div>
	{/snippet}

	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div id="session-list-scroller" class="flex-1 overflow-y-auto px-2 py-0.5" role="region" aria-label="Sessions" tabindex="0" onscroll={(event) => { heldSessionId = null; scrolled = event.currentTarget.scrollTop > 0; }}>
		{#if isEmpty && !sessionState.settled}
			<!-- First load: session-shaped rows breathe in a top-to-bottom wave. -->
			<div class="flex flex-col gap-px pt-1" aria-hidden="true" data-testid="session-list-skeleton">
				{#each [[78, 52], [64, 40], [86, 58], [58, 34], [72, 48], [66, 55], [80, 38], [60, 46]] as [title, context], i}
					<div class="session-skeleton-row grid grid-cols-[20px_minmax(0,1fr)_auto] grid-rows-2 items-center gap-x-[9px] gap-y-[7px] rounded-panel px-2 py-[9px]" style:--i={i}>
						<div class="row-span-2 size-[14px] justify-self-center rounded-full bg-border-subtle"></div>
						<div class="h-[9px] rounded bg-border-subtle" style:width="{title}%"></div>
						<div class="row-span-2 h-[7px] w-[22px] rounded bg-border-subtle"></div>
						<div class="h-[7px] rounded bg-border-subtle opacity-70" style:width="{context}%"></div>
					</div>
				{/each}
			</div>
		{:else if isEmpty && !tree?.length}
			<div class="session-empty py-6 px-3.5 text-center text-xs text-text-dimmer font-brand" data-testid={statusFilter !== null && (!searching || filteredLength > 0) ? "session-filter-empty" : undefined}>
				{emptyMessage}
				{#if statusFilter !== null && (!searching || filteredLength > 0)}
					<div class="mt-2"><Button variant="ghost" size="content" tone="accent" class="min-h-[44px] md:min-h-8 px-3" data-testid="session-filter-clear" onclick={() => setSessionStatusFilter(null)}>Clear filter</Button></div>
				{/if}
			</div>
		{:else}
			{#if arrangement.pinned.length > 0}
				<div class="session-group-label flex items-center uppercase pt-1.5 pb-0.5 px-3 text-xs font-semibold text-text-dimmer tracking-[0.3px] font-brand"><span>Pinned</span>{" "}<span class="ml-auto font-medium">{fullArrangement.pinned.length}</span></div>
				{#each arrangement.pinned as s (s.id)}{@render sessionRow(s)}{/each}
			{/if}
			{#if tree && sortable}
				<SortableList
					variant="tree"
					items={tree}
					key={(node) => node.slug}
					label={(node) => node.title}
					ariaLabel="Projects"
					onreorder={(next) => setProjectOrder(next.map((node) => node.slug))}
					row={projectHeader}
					details={projectRows}
				/>
			{:else if tree}
				{#each tree as node (node.slug)}{@render projectHeader(node)}{@render projectRows(node)}{/each}
			{:else}
				{#each arrangement.sections as section (section.key)}
					<div class="session-group-label flex items-center uppercase pt-1.5 pb-0.5 px-3 text-xs font-semibold text-text-dimmer tracking-[0.3px] font-brand">
						<span>{section.label}</span>{" "}<span class="ml-auto font-medium">{fullArrangement.sections.find((group) => group.key === section.key)?.sessions.length ?? section.sessions.length}</span>
					</div>
					{#each section.sessions as s (s.id)}
						{@render sessionRow(s)}
					{/each}
				{/each}
			{/if}
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
						<span class="uppercase">Snoozed</span>{" "}<span class="ml-auto font-medium">{fullArrangement.snoozed.length}</span>
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
		<SessionPager {sentinelEl} hasMore={pagerPending} />

		{#if pagerPending && (searching || scrolled)}
			<div
				class="px-3.5 py-2 text-center text-xs text-text-dimmer font-brand"
				data-testid="session-list-loading-more"
			>
				<span class="inline-flex items-center gap-2"><span class="loading-dots" aria-hidden="true"><span></span><span></span><span></span></span>Loading</span>
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

<style>
	/* A wave down the list reads as rows arriving; staggered by --i per row. */
	.session-skeleton-row {
		animation: session-skeleton-wave 1.8s ease-in-out infinite;
		animation-delay: calc(var(--i) * 110ms);
	}
	@keyframes session-skeleton-wave {
		0%, 100% { opacity: 0.35; transform: translateX(0); }
		40% { opacity: 1; transform: translateX(2px); }
	}
	@media (prefers-reduced-motion: reduce) {
		.session-skeleton-row { animation: none; }
	}
</style>
