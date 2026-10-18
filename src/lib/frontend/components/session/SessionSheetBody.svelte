<script lang="ts">
	import { untrack, type Snippet } from "svelte";
	import type { SessionInfo } from "../../types.js";
	import { isSessionSnoozed, sessionAttention } from "../../stores/session.svelte.js";
	import { formatSnoozeTime, formatTimeAgo } from "../../utils/format.js";
	import { describeAutoSettle } from "../../utils/auto-settle.js";
	import { rpc } from "../../transport/ws-rpc-client.js";
	import { dismissToast, showToast, uiState } from "../../stores/ui.svelte.js";
	import DitherGlyph from "../ui/DitherGlyph.svelte";
	import Icon from "../ui/Icon.svelte";
	import HoldMenuTile from "../ui/HoldMenuTile.svelte";
	import LabelledGridGroup from "../ui/LabelledGridGroup.svelte";
	import MenuCloseItem from "../ui/MenuCloseItem.svelte";
	import ProjectMark from "../ui/ProjectMark.svelte";
	import SheetNotice from "../ui/SheetNotice.svelte";
	import SwitchRow from "../ui/SwitchRow.svelte";
	import Tile from "../ui/Tile.svelte";
	import { ATTENTION_DISPLAY } from "./SessionItem.svelte";
	import { sessionCommandActions, type SessionCommand, type SessionCommandEntry } from "./session-commands.js";

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
	const triage = $derived(commands.filter((item) => item.section === "triage" && item.checked === undefined));
	let outlook = $state<Awaited<ReturnType<typeof rpc<"GetSessionAutoSettleOutlook">>>>();
	let saving = $state(false);
	// Bumped by every read, write and session change: only the latest request's reply lands.
	let request = 0;
	// The id, not `header`: shell updates during a save must not restart the read.
	const autoSettleSessionId = $derived(header.session.id);
	const checked = $derived(outlook ? outlook.kind !== "off" : header.session.autoSettleDisabled !== true);
	$effect(() => {
		const sessionId = autoSettleSessionId;
		const read = ++request;
		outlook = undefined;
		saving = false;
		void untrack(() => rpc("GetSessionAutoSettleOutlook", { sessionId })).then(
			(reply) => { if (read === request) outlook = reply; },
			() => {},
		);
		return () => { ++request; };
	});
	async function toggleAutoSettle() {
		if (saving) return;
		const write = ++request;
		saving = true;
		const reply = await sessionCommandActions.autoSettle(header.session, checked);
		if (write !== request) return;
		if (reply) outlook = reply;
		saving = false;
	}
	const session = $derived(commands.filter((item) => item.section === "manage" || item.section === "danger"));
	const toastHost = Symbol("session-sheet");
	const status = $derived(ATTENTION_DISPLAY[sessionAttention(header.session)]);
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

{#snippet tile(item: SessionCommandEntry)}
	{#if item.options && !item.disabledReason}
		<HoldMenuTile
			data-testid={item.testId}
			aria-label={item.label}
			label={item.shortLabel ?? item.label}
			icon={item.icon}
			subLine={item.detail ?? undefined}
			tag={item.detail ? undefined : "hold"}
			title={item.options.title}
			hint={item.options.hint}
			items={item.options.items.map((option) => ({ ...option, action: () => onselect(option.run) }))}
		/>
	{:else}
		<Tile
			data-testid={item.testId}
			aria-label={item.label}
			label={item.shortLabel ?? item.label}
			icon={item.icon}
			subLine={item.detail ?? undefined}
			variant={item.danger ? "danger" : item.emphasis ?? "default"}
			disabledReason={item.disabledReason}
			ondisabledselect={() => { if (item.disabledReason) showToast(item.disabledReason, { variant: "pinned" }); }}
			onselect={() => onselect(item.run)}
		/>
	{/if}
{/snippet}

<div class="px-[16px]" data-session-sheet-body>
	<div data-testid="session-sheet-header" class="grid grid-cols-[22px_minmax(0,1fr)_32px] items-start gap-[10px] px-[2px] pt-[3px] font-sans">
		<span class="mt-[3px] grid size-[18px] place-items-center {status.colour}" aria-hidden="true">{#if "dither" in status.glyph}<DitherGlyph state={status.glyph.dither} />{:else}<Icon name={status.glyph.icon} size={18} />{/if}</span>
		<div class="min-w-0">
			<div class="line-clamp-2 break-words text-[17px] font-semibold leading-[1.3] tracking-[-0.01em] text-text">{header.session.title || "New Session"}</div>
			<div class="mt-[4px] flex items-center gap-[7px] whitespace-nowrap text-[13px] text-text-muted">
				{#if header.projectLabel}<span class="inline-flex max-w-1/2 shrink-0 items-center gap-[7px]"><ProjectMark size={8} accent={header.projectAccent ?? 1} /><span class="truncate">{header.projectLabel}</span></span>{/if}
				{#if header.branch}<code data-testid="session-sheet-branch" class="min-w-0 max-w-full truncate rounded-[6px] bg-chip px-[6px] py-[1px] font-mono text-[10.58px] text-text-secondary">{header.branch}</code>{/if}
				<span data-testid="session-sheet-activity" class="shrink-0">{activity}</span>
			</div>
		</div>
		<MenuCloseItem label="Close session sheet" data-testid="session-sheet-close" />
	</div>
	{#if views}<div data-hold-menu-dim class="mt-[18px]">{@render views()}</div>{/if}
	<LabelledGridGroup label="Triage" columns={triage.length > 4 ? 5 : 4}>
		{#each triage as item (item.testId)}{@render tile(item)}{/each}
	</LabelledGridGroup>
	<SwitchRow data-testid="session-ctx-auto-settle" aria-label="Auto-settle when idle" label="Auto-settle" {checked} {saving} controlled showState={outlook !== undefined} description={outlook && describeAutoSettle(outlook, now)} oncheckedchange={() => void toggleAutoSettle()} />
	<LabelledGridGroup label="Session" columns={session.length > 4 ? 5 : 4}>
		{#each session as item (item.testId)}{@render tile(item)}{/each}
	</LabelledGridGroup>
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
