<script lang="ts">
	import type { SessionInfo } from "../../types.js";
	import { isSessionSnoozed, sessionAttention } from "../../stores/session.svelte.js";
	import { formatSnoozeTime, formatTimeAgo } from "../../utils/format.js";
	import { onDestroy, untrack } from "svelte";
	import Icon from "../ui/Icon.svelte";
	import Menu from "../ui/Menu.svelte";
	import ProjectSquare from "./ProjectSquare.svelte";
	import { ATTENTION_DISPLAY } from "./SessionItem.svelte";
	import SessionVerbItems from "./SessionVerbItems.svelte";
	import { getSessionVerbs, type SessionVerb, type SessionVerbHost } from "./session-verbs.js";

	let {
		session,
		anchor,
		projectLabel,
		projectAccent = 1,
		branch,
		presentation = "menu",
		host,
		now = Date.now(),
		onclose,
		extras = [],
	}: {
		session: SessionInfo;
		anchor: HTMLElement;
		projectLabel?: string | undefined;
		projectAccent?: number;
		branch?: string | undefined;
		presentation?: "menu" | "sheet";
		host: SessionVerbHost;
		now?: number;
		onclose: () => void;
		/** Non-session actions appended after a divider, drawn as verb rows. */
		extras?: readonly SessionVerb[];
	} = $props();
	// Captured once: dialogs opened from a verb call focusTarget after this menu
	// unmounts, when its props may already be gone.
	const opener = untrack(() => anchor);
	const targetId = untrack(() => session.id);

	let open = $state(true);
	let selected = false;
	let focusScheduled = false;
	const status = $derived(ATTENTION_DISPLAY[sessionAttention(session)]);
	const activity = $derived(
		session.pinnedAt == null && session.settledAt != null
			? formatTimeAgo(session.settledAt)
			: session.pinnedAt == null && isSessionSnoozed(session, now)
				? formatSnoozeTime(session.snoozedUntil ?? null, now)
				: formatTimeAgo(session.updatedAt),
	);
	const verbs = $derived([
		...getSessionVerbs(session, now, host, presentation === "sheet" ? "sheet" : "center"),
		...(extras.length > 0 ? [{ divider: true } as const, ...extras] : []),
	]);
	function focusTarget(): HTMLElement | null {
		const row = [...opener.ownerDocument.querySelectorAll<HTMLElement>("#session-list .session-item[data-session-id]")].find((item) => item.dataset["sessionId"] === targetId);
		return (opener.matches(".session-more-btn") ? row?.querySelector<HTMLElement>(".session-more-btn") : null) ?? (opener.isConnected ? opener : row) ?? null;
	}
	function returnFocus() {
		if (focusScheduled) return;
		focusScheduled = true;
		setTimeout(() => {
			const target = focusTarget();
			if (target?.matches(".session-more-btn")) target.closest<HTMLElement>(".session-item")?.focus();
			target?.focus();
		}, 100);
	}
	onDestroy(() => {
		if (!selected) returnFocus();
	});

	function select(action: SessionVerb["run"]) {
		selected = true;
		action(focusTarget);
		onclose();
	}
</script>

{#snippet header(sheet: boolean)}
	{#if sheet}
		<div data-testid="session-sheet-header" class="flex items-start gap-3 border-b border-border px-4 pb-3 font-brand">
			{#if status.icon}<span class="mt-0.5 grid size-[20px] shrink-0 place-items-center {status.colour}" aria-hidden="true"><Icon name={status.icon} size={14} /></span>{/if}
			<div class="min-w-0 flex-1">
				<div class="line-clamp-2 break-words text-[15px] font-semibold leading-snug text-text">{session.title || "New Session"}</div>
				<div class="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-text-secondary">
					{#if projectLabel}<span class="inline-flex items-center gap-1 text-text-secondary"><ProjectSquare label={projectLabel} accent={projectAccent} />{projectLabel}</span>{/if}
					{#if branch}<span class="rounded border border-border bg-bg px-1.5 py-0.5 font-mono text-text-secondary">{branch}</span>{/if}
					<span>{activity}</span>
				</div>
			</div>
		</div>
	{:else}
		<div data-testid="session-ctx-header" class="border-b border-border px-3 py-2 font-brand">
			<div class="line-clamp-2 whitespace-normal break-words text-sm font-semibold text-text">{session.title || "New Session"}</div>
			{#if projectLabel || branch}<div class="mt-1 flex gap-2 text-xs text-text-dimmer">{#if projectLabel}<span>{projectLabel}</span>{/if}{#if branch}<span>{branch}</span>{/if}</div>{/if}
		</div>
	{/if}
{/snippet}

	<Menu
		bind:open
		presentation={presentation === "sheet" ? "sheet" : "popover"}
		onopenchange={(nextOpen) => {
			if (!nextOpen) {
				onclose();
			}
		}}
		onCloseAutoFocus={(event) => {
			if (selected) { event.preventDefault(); return; }
			event.preventDefault();
			returnFocus();
		}}
		customAnchor={anchor}
		ariaLabel="Session actions"
		side="bottom"
		align="end"
		class="min-w-[180px]"
		data-testid={presentation === "sheet" ? "session-action-sheet" : "session-ctx-menu"}
	>
		{#snippet trigger()}{/snippet}
		{@render header(presentation === "sheet")}
		<SessionVerbItems {verbs} {presentation} onselect={select} />
	</Menu>
