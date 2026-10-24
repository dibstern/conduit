<script lang="ts">
	import type { Snippet } from "svelte";
	import type { SessionInfo } from "../../types.js";
	import { isSessionSnoozed, sessionAttention } from "../../stores/session.svelte.js";
	import { formatSnoozeTime, formatTimeAgo } from "../../utils/format.js";
	import { dismissToast, uiState } from "../../stores/ui.svelte.js";
	import SessionStatusGlyph from "../ui/SessionStatusGlyph.svelte";
	import MenuCloseItem from "../ui/MenuCloseItem.svelte";
	import ProjectMark from "../ui/ProjectMark.svelte";
	import SheetNotice from "../ui/SheetNotice.svelte";
	import SessionCommandItems from "./SessionCommandItems.svelte";
	import type { SessionCommand, SessionCommandEntry } from "./session-commands.js";

	let { commands, onselect, header, views, now = Date.now() }: {
		commands: readonly SessionCommandEntry[];
		onselect: (run: SessionCommand["run"]) => void;
		header: {
			session: SessionInfo;
			projectLabel?: string | undefined;
			projectAccent?: number | undefined;
			branch?: string | undefined;
		};
		views?: Snippet;
		now?: number;
	} = $props();
	const toastHost = Symbol("session-sheet");
	const attention = $derived(sessionAttention(header.session));
	const blocking = $derived(attention === "needs-approval" || attention === "needs-reply" || attention === "error");
	const settled = $derived(!blocking && header.session.pinnedAt == null && header.session.settledAt != null);
	const snoozed = $derived(!blocking && !settled && header.session.pinnedAt == null && isSessionSnoozed(header.session, now));
	const activity = $derived.by(() => {
		const { pinnedAt, settledAt, snoozedUntil, updatedAt } = header.session;
		if (pinnedAt == null && settledAt != null) return `settled ${formatTimeAgo(settledAt, new Date(now))}`;
		if (pinnedAt == null && isSessionSnoozed(header.session, now))
			return snoozedUntil == null ? "snoozed" : `until ${formatSnoozeTime(snoozedUntil, now)}`;
		return formatTimeAgo(updatedAt, new Date(now));
	});
	$effect(() => {
		uiState.sheetToastHost = toastHost;
		return () => { if (uiState.sheetToastHost === toastHost) uiState.sheetToastHost = null; };
	});
</script>

<div class="px-[16px]" data-session-sheet-body>
	<div data-testid="session-sheet-header" class="grid grid-cols-[22px_minmax(0,1fr)_32px] items-start gap-[10px] px-[2px] pt-[3px] font-sans">
		<span class="mt-[3px]"><SessionStatusGlyph size={18} {attention} {settled} {snoozed} /></span>
		<div class="min-w-0">
			<div class="line-clamp-2 break-words text-[17px] font-semibold leading-[1.3] tracking-[-0.01em] text-text">{header.session.title || "New Session"}</div>
			<div class="mt-[4px] flex items-center gap-[7px] whitespace-nowrap text-[13px] text-text-muted">
				{#if header.projectLabel}<span class="inline-flex max-w-1/2 shrink-0 items-center gap-[7px]"><ProjectMark size={8} accent={header.projectAccent ?? 1} /><span class="truncate">{header.projectLabel}</span></span>{/if}
				{#if header.branch}<code data-testid="session-sheet-branch" class="min-w-0 max-w-full truncate rounded-[6px] bg-chip px-[6px] py-[1px] font-mono text-[11.5px] leading-[normal] text-text-secondary">{header.branch}</code>{/if}
				<span data-testid="session-sheet-activity" class="shrink-0">{activity}</span>
			</div>
		</div>
		<MenuCloseItem label="Close session sheet" data-testid="session-sheet-close" />
	</div>
	{#if views}<div data-hold-menu-dim class="mt-[18px]">{@render views()}</div>{/if}
	<SessionCommandItems {commands} {onselect} session={header.session} {now} presentation="sheet" />
	{#if uiState.sheetToastHost === toastHost && uiState.toasts.length > 0}
		<div class="sticky bottom-0 z-[var(--z-raised)] bg-bg-surface pb-[4px]">
			{#each [...uiState.toasts].reverse() as toast (toast.id)}
				<SheetNotice
					message={toast.title}
					body={toast.body}
					emphasis={toast.emphasis}
					variant={toast.variant}
					actions={toast.actions.map((action) => ({ label: action.label, run: () => { try { action.run?.(); } finally { dismissToast(toast.id); } } }))}
				/>
			{/each}
		</div>
	{/if}
</div>
