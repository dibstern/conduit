<!-- ─── SessionItem ─────────────────────────────────────────────────────────── -->
<!-- Single session entry in the sidebar list. Shows title, time, message count, -->
<!-- processing indicator, three-dot menu, and supports inline rename. -->

<script lang="ts">
	import type { SessionInfo } from "../../types.js";
	import { chatState } from "../../stores/chat.svelte.js";
	import { sessionState } from "../../stores/session.svelte.js";
	import { formatTimeAgo, truncateTitle } from "../../utils/format.js";
	import Icon from "../shared/Icon.svelte";

	// ─── Props ──────────────────────────────────────────────────────────────────

	let {
		session,
		href = "",
		active = false,
		renaming: renamingProp = false,
		cleanupMode = false,
		selected = false,
		onswitchsession,
		ontoggleselection,
		oncontextmenu: oncontextmenuProp,
		onrename,
		onrenameend,
	}: {
		session: SessionInfo;
		href?: string;
		active?: boolean;
		renaming?: boolean;
		cleanupMode?: boolean;
		selected?: boolean;
		onswitchsession?: (id: string) => void;
		ontoggleselection?: (id: string) => void;
		oncontextmenu?: (session: SessionInfo, anchor: HTMLElement) => void;
		onrename?: (id: string, title: string) => void;
		onrenameend?: () => void;
	} = $props();

	// ─── Local state ────────────────────────────────────────────────────────────

	let localRenaming = $state(false);
	let renameValue = $state("");
	let moreBtnEl: HTMLButtonElement | undefined = $state(undefined);

	// Combined rename state: local (double-click) OR external (context menu)
	const isRenaming = $derived(localRenaming || renamingProp);

	// Initialize rename value when context menu triggers rename mode.
	// Only reads renamingProp (no circular write to localRenaming).
	$effect(() => {
		if (renamingProp) {
			renameValue = session.title || "New Session";
		}
	});

	// ─── Derived ────────────────────────────────────────────────────────────────

	const displayTitle = $derived(truncateTitle(session.title || "New Session"));
	const timeAgo = $derived(formatTimeAgo(session.updatedAt));

	const metaText = $derived.by(() => {
		const parts: string[] = [];
		if (timeAgo) parts.push(timeAgo);
		if (session.messageCount !== undefined && session.messageCount > 0) {
			parts.push(
				`${session.messageCount} msg${session.messageCount === 1 ? "" : "s"}`,
			);
		}
		return parts.join(" \u00B7 ");
	});

	// Processing state: server flag OR local chat processing for active session
	const isProcessing = $derived(
		session.processing ||
			(session.id === sessionState.currentId && chatState.processing),
	);

	const itemClass = $derived(
		"session-item group flex items-center gap-1 py-1.5 px-2.5 rounded-md cursor-pointer relative text-[13px] transition-colors duration-100" +
			(active
				? " active bg-bg-surface text-text"
				: " text-text-secondary hover:bg-sidebar-hover hover:text-text"),
	);

	// ─── Handlers ───────────────────────────────────────────────────────────────

	function handleClick(e: MouseEvent) {
		e.preventDefault();
		if (!isRenaming) {
			onswitchsession?.(session.id);
		}
	}

	function handleMoreClick(e: MouseEvent) {
		e.preventDefault();
		e.stopPropagation();
		if (moreBtnEl) {
			oncontextmenuProp?.(session, moreBtnEl);
		}
	}

	function handleSelectionToggle(e: MouseEvent) {
		e.preventDefault();
		e.stopPropagation();
		ontoggleselection?.(session.id);
	}

	function startRename() {
		localRenaming = true;
		renameValue = session.title || "New Session";
	}

	function handleDblClick(e: MouseEvent) {
		if (cleanupMode) return;
		e.preventDefault();
		e.stopPropagation();
		startRename();
	}

	function commitRename() {
		const newTitle = renameValue.trim();
		localRenaming = false;
		onrenameend?.();
		if (newTitle && newTitle !== session.title) {
			onrename?.(session.id, newTitle);
		}
	}

	function cancelRename() {
		localRenaming = false;
		onrenameend?.();
	}

	function handleRenameKeydown(e: KeyboardEvent) {
		if (e.key === "Enter") {
			e.preventDefault();
			commitRename();
		} else if (e.key === "Escape") {
			e.preventDefault();
			cancelRename();
		}
	}

	function handleRenameBlur() {
		commitRename();
	}

	function handleRenameClick(e: MouseEvent) {
		e.preventDefault();
		e.stopPropagation();
	}

	// ─── Actions ────────────────────────────────────────────────────────────────

	function focusOnMount(node: HTMLElement) {
		node.focus();
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<a
	href={href || undefined}
	class="{itemClass} no-underline"
	style={active ? "box-shadow: inset 3px 0 0 var(--color-brand-a), inset 3px 0 12px rgba(255,45,123,0.1);" : ""}
	data-session-id={session.id}
	onclick={handleClick}
>
	<!-- Selection circle (cleanup mode) -->
	{#if cleanupMode}
		<button
			type="button"
			class="shrink-0 w-6 h-6 border-none rounded p-0 bg-transparent cursor-pointer flex items-center justify-center transition-colors duration-100 {active ? (selected ? 'text-brand-a' : 'text-text-muted') : (selected ? 'text-accent' : 'text-text-dimmer')}"
			onclick={handleSelectionToggle}
		>
			<Icon name={selected ? "circle-check" : "circle"} size={16} />
		</button>
	{/if}

	<!-- Processing indicator (pulsing dot) -->
	{#if isProcessing}
		<span
			class="session-processing-dot w-[7px] h-[7px] rounded-full shrink-0 animate-pulse-dot {active ? 'bg-brand-a' : 'bg-accent'}"
		></span>
	{/if}

	<!-- Title -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<span
		class="session-item-title flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
		style="font-family: var(--font-brand);"
		ondblclick={handleDblClick}
	>
		{#if isRenaming}
			<input
				type="text"
				class="session-rename-input w-full bg-input-bg border border-accent rounded py-px px-1 text-xs text-text outline-none"
				style="font-family: var(--font-brand);"
				bind:value={renameValue}
				onkeydown={handleRenameKeydown}
				onblur={handleRenameBlur}
				onclick={handleRenameClick}
				use:focusOnMount
			/>
		{:else}
			<span class="session-title-inner inline-block pr-[3em]">{displayTitle}</span>
		{/if}
	</span>

	<!-- Fork indicator -->
	{#if session.parentID}
		<span
			class="ml-1 text-[10px] text-text-dimmer shrink-0"
			title="Forked session"
		>
			<Icon name="git-fork" size={11} class="inline-block align-[-1px]" />
		</span>
	{/if}

	<!-- Meta (time ago + message count) -->
	{#if metaText && !isRenaming}
		<span
			class="session-item-meta shrink-0 text-[11px] text-text-dimmer whitespace-nowrap"
			style="font-family: var(--font-brand);"
		>
			{metaText}
		</span>
	{/if}

	<!-- Three-dot more button -->
	{#if !isRenaming && !cleanupMode}
		<button
			bind:this={moreBtnEl}
			class="session-more-btn shrink-0 w-5 h-5 border-none rounded p-0 bg-transparent cursor-pointer flex items-center justify-center transition-[opacity,color] duration-100
			{active
				? 'text-text-muted group-hover:text-text-secondary hover:text-text hover:bg-bg-alt'
				: 'text-text-dimmer/50 group-hover:text-text-dimmer hover:text-text hover:bg-bg-alt'}"
			title="More options"
			onclick={handleMoreClick}
		>
			<Icon name="ellipsis" size={13} />
		</button>
	{/if}
</a>
