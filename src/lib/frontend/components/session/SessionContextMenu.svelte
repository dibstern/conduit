<script lang="ts">
	import type { SessionInfo } from "../../types.js";
	import { isSessionSnoozed, sessionAttention } from "../../stores/session.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import { copyToClipboard } from "../../utils/clipboard.js";
	import { formatSnoozeTime, formatTimeAgo } from "../../utils/format.js";
	import { getSessionActionState } from "../../utils/swipe.js";
	import Icon from "../ui/Icon.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuItem from "../ui/MenuItem.svelte";
	import MenuSeparator from "../ui/MenuSeparator.svelte";
	import Modal from "../ui/Modal.svelte";
	import ProjectSquare from "./ProjectSquare.svelte";
	import { ATTENTION_DISPLAY } from "./SessionItem.svelte";
	import SheetActionItem from "./SheetActionItem.svelte";

	let {
		session,
		anchor,
		projectLabel,
		projectAccent = 1,
		branch,
		presentation = "menu",
		onrename,
		onsettle,
		onautosettle,
		onpin,
		onmarkread,
		onsnooze,
		onunsnooze,
		now = Date.now(),
		ondelete,
		oncopyresume,
		onfork,
		onclose,
		markOnly = false,
	}: {
		session: SessionInfo;
		anchor: HTMLElement;
		projectLabel?: string | undefined;
		projectAccent?: number;
		branch?: string | undefined;
		presentation?: "menu" | "sheet";
		onrename: (id: string) => void;
		onsettle: (id: string, next: boolean) => void;
		onautosettle: (id: string, disabled: boolean) => void;
		onpin: (id: string, next: boolean) => void;
		onmarkread?: (id: string) => void;
		onsnooze: (id: string) => void;
		onunsnooze: (id: string) => void;
		now?: number;
		ondelete: (id: string, title: string) => void;
		oncopyresume: (id: string) => void;
		onfork: (id: string) => void;
		onclose: () => void;
		markOnly?: boolean;
	} = $props();

	let open = $state(true);
	let selected = false;
	const actions = $derived(getSessionActionState(session, now));
	const status = $derived(ATTENTION_DISPLAY[sessionAttention(session)]);
	const activity = $derived(
		session.pinnedAt == null && session.settledAt != null
			? formatTimeAgo(session.settledAt)
			: session.pinnedAt == null && isSessionSnoozed(session, now)
				? formatSnoozeTime(session.snoozedUntil ?? null, now)
				: formatTimeAgo(session.updatedAt),
	);
	const ActionItem = $derived(presentation === "sheet" ? SheetActionItem : MenuItem);
	type Verb = {
		testId: string;
		label: string;
		icon?: "undo" | "check" | "moon" | "star-off" | "star" | "circle" | "circle-dot" | "pencil" | "git-fork" | "copy";
		hint?: string;
		disabledReason?: string | null;
		checked?: boolean;
		indent?: boolean;
		danger?: boolean;
		run: () => void;
	};
	type Action = Verb | { divider: true };
	const verbs = $derived.by(() => {
		const items: Action[] = [];
		if (!markOnly) {
			items.push(
				{ testId: session.settledAt != null ? "session-ctx-unsettle" : "session-ctx-settle", label: session.settledAt != null ? "Un-settle" : "Settle", icon: session.settledAt != null ? "undo" : "check", hint: "s", disabledReason: actions.settleDisabledReason, run: () => onsettle(session.id, !actions.settled) },
				{ testId: "session-ctx-auto-settle", label: "Auto-settle when idle", checked: session.autoSettleDisabled !== true, indent: true, run: () => onautosettle(session.id, session.autoSettleDisabled !== true) },
			);
			if (actions.snoozeVisible) {
				items.push({ testId: "session-ctx-snooze", label: actions.snoozed ? "Change snooze…" : "Snooze…", icon: "moon", hint: "z", disabledReason: actions.snoozeDisabledReason, run: () => onsnooze(session.id) });
				if (actions.snoozed) items.push({ testId: "session-ctx-unsnooze", label: "Unsnooze", icon: "undo", hint: "z", run: () => onunsnooze(session.id) });
			}
			items.push({ testId: session.pinnedAt != null ? "session-ctx-unpin" : "session-ctx-pin", label: session.pinnedAt != null ? "Unpin" : "Pin to top", icon: session.pinnedAt != null ? "star-off" : "star", hint: "p", run: () => onpin(session.id, !actions.pinned) });
		}
		if (onmarkread && !actions.settled && !actions.snoozed) items.push({ testId: session.unread ? "session-ctx-mark-read" : "session-ctx-mark-unread", label: session.unread ? "Mark read" : "Mark unread", icon: session.unread ? "circle" : "circle-dot", hint: "u · ⌘⇧U", run: () => onmarkread(session.id) });
		if (!markOnly) items.push(
			{ divider: true },
			{ testId: "session-ctx-rename", label: "Rename", icon: "pencil", hint: "r", run: () => onrename(session.id) },
			{ testId: "session-ctx-fork", label: "Fork", icon: "git-fork", run: () => onfork(session.id) },
			{ testId: "session-ctx-copy-resume", label: "Copy resume command", icon: "copy", run: () => { void handleCopyResume(); } },
			{ divider: true },
			{ testId: "session-ctx-delete", label: "Delete", danger: true, run: () => ondelete(session.id, session.title || "New Session") },
		);
		return items;
	});

	function select(action: () => void) {
		selected = true;
		action();
		if (presentation === "sheet") onclose();
	}

	async function handleCopyResume() {
		const ok = await copyToClipboard(`opencode --session ${session.id}`);
		if (ok) showToast("Copied resume command");
		else showToast("Failed to copy — clipboard unavailable", { variant: "error" });
		oncopyresume(session.id);
	}
</script>

{#snippet header(sheet: boolean)}
	{#if sheet}
		<div data-testid="session-sheet-header" class="flex items-start gap-3 border-b border-border px-4 pb-3 font-brand">
			{#if status.icon}<span class="mt-0.5 grid size-[20px] shrink-0 place-items-center {status.colour}" aria-hidden="true"><Icon name={status.icon} size={14} /></span>{/if}
			<div class="min-w-0 flex-1">
				<div class="line-clamp-2 break-words text-[15px] font-semibold leading-snug text-text">{session.title || "New Session"}</div>
				<div class="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-text-dimmer">
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

{#snippet verbContent(item: Verb)}
	{#if item.icon}<Icon name={item.icon} size={13} />{:else if item.checked !== undefined}<span class="w-[13px] shrink-0" aria-hidden="true">{#if item.checked}<Icon name="check" size={13} />{/if}</span>{/if}
	<span>{item.label}</span>
	{#if item.hint}<span class="ml-auto text-xs text-text-muted">{item.hint}</span>{/if}
	{#if item.disabledReason}<span class="ml-auto text-xs text-text-dimmer">{item.disabledReason}</span>{/if}
{/snippet}

{#snippet actionList()}
	{#each verbs as item, index (index)}
		{#if "divider" in item}
			{#if presentation === "sheet"}<div role="separator" class="my-1 h-px bg-border"></div>{:else}<MenuSeparator />{/if}
		{:else}
			{#if item.danger}
			<ActionItem
				data-testid={item.testId}
				class={presentation === "sheet" ? item.indent ? "pl-9" : "" : "min-h-[44px] md:min-h-0"}
				variant="danger"
				disabled={item.disabledReason != null}
				{...(item.checked === undefined ? {} : { "aria-checked": item.checked })}
				onselect={() => select(item.run)}
			>
				{@render verbContent(item)}
			</ActionItem>
			{:else}
			<ActionItem
				data-testid={item.testId}
				class={presentation === "sheet" ? item.indent ? "pl-9" : "" : "min-h-[44px] md:min-h-0"}
				variant="default"
				disabled={item.disabledReason != null}
				{...(item.checked === undefined ? {} : { "aria-checked": item.checked })}
				onselect={() => select(item.run)}
			>
				{@render verbContent(item)}
			</ActionItem>
			{/if}
		{/if}
	{/each}
{/snippet}

{#if presentation === "sheet"}
	<Modal open={true} {onclose} ariaLabel="Session actions" placement="sheet" flush returnFocus={() => selected ? null : anchor} showClose={false}>
		<div data-testid="session-action-sheet">
			{@render header(true)}
			{@render actionList()}
		</div>
	</Modal>
{:else}
	<Menu
		bind:open
		onopenchange={(nextOpen) => {
			if (!nextOpen) {
				if (!selected && anchor.isConnected) anchor.focus();
				onclose();
			}
		}}
		customAnchor={anchor}
		ariaLabel="Session actions"
		side="bottom"
		align="end"
		class="min-w-[180px]"
		data-testid="session-ctx-menu"
	>
		{#snippet trigger()}{/snippet}
		{@render header(false)}
		{@render actionList()}
	</Menu>
{/if}
