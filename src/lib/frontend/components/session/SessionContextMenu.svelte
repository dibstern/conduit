<!-- ─── SessionContextMenu ──────────────────────────────────────────────────── -->
<!-- Session actions: Rename, Fork, Copy Resume Command, Delete.              -->
<!--                                                                         -->
<!-- Anchored to the "..." button SessionList already owns. The `anchor` prop -->
<!-- lets the row keep its trigger while ui/Menu owns the menu.               -->
<!--                                                                         -->
<!-- The consumer mounts this only while the menu should be open, so `open`   -->
<!-- starts true and `onclose` unmounts us. That is also why the empty        -->
<!-- trigger snippet is safe: bits-ui has no trigger element to return focus  -->
<!-- to on close, but by then this component no longer exists.                -->
<!--                                                                         -->
<!-- What this replaced (conduit-test-de3.35.4): a fixed full-screen backdrop -->
<!-- for outside clicks, manual getBoundingClientRect positioning with no     -->
<!-- collision handling, a window-level Escape listener, and four <button>s   -->
<!-- with no role="menu", no role="menuitem" and no arrow-key navigation.     -->

<script lang="ts">
	import type { SessionInfo } from "../../types.js";
	import { getSessionActionState } from "../../utils/swipe.js";
	import { copyToClipboard } from "../../utils/clipboard.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import Icon from "../ui/Icon.svelte";
	import Menu from "../ui/Menu.svelte";
	import MenuItem from "../ui/MenuItem.svelte";
	import MenuSeparator from "../ui/MenuSeparator.svelte";

	// ─── Props ──────────────────────────────────────────────────────────────────

	let {
		session,
		anchor,
		projectLabel,
		branch,
		onrename,
		onsettle,
		onautosettle,
		onpin,
		onsnooze,
		onunsnooze,
		now = Date.now(),
		ondelete,
		oncopyresume,
		onfork,
		onclose,
	}: {
		session: SessionInfo;
		anchor: HTMLElement;
		projectLabel?: string | undefined;
		branch?: string | undefined;
		onrename: (id: string) => void;
		onsettle: (id: string, next: boolean) => void;
		onautosettle: (id: string, disabled: boolean) => void;
		onpin: (id: string, next: boolean) => void;
		onsnooze: (id: string) => void;
		onunsnooze: (id: string) => void;
		now?: number;
		ondelete: (id: string, title: string) => void;
		oncopyresume: (id: string) => void;
		onfork: (id: string) => void;
		onclose: () => void;
	} = $props();

	let open = $state(true);
	let selected = false;
	const actions = $derived(getSessionActionState(session, now));

	function select(action: () => void) {
		selected = true;
		action();
	}

	// ─── Handlers ───────────────────────────────────────────────────────────────

	async function handleCopyResume() {
		const ok = await copyToClipboard(`opencode --session ${session.id}`);
		if (ok) {
			showToast("Copied resume command");
		} else {
			showToast("Failed to copy — clipboard unavailable", {
				variant: "error",
			});
		}
		oncopyresume(session.id);
	}
</script>

<Menu
	bind:open
	onopenchange={(nextOpen) => {
		if (!nextOpen) {
			// Before onclose(): the parent drops the anchor, and the row hides its
			// verbs once neither the menu nor focus holds them open.
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
	<!-- Intentionally empty: the anchor is an element the consumer owns, so
	     there is nothing for us to render. `customAnchor` does the pointing. -->
	{#snippet trigger()}{/snippet}
	<div data-testid="session-ctx-header" class="px-3 py-2 border-b border-border font-brand">
		<div class="line-clamp-2 whitespace-normal break-words text-sm font-semibold text-text">{session.title || "New Session"}</div>
		{#if projectLabel || branch}
			<div class="mt-1 flex gap-2 text-xs text-text-dimmer">
				{#if projectLabel}<span>{projectLabel}</span>{/if}
				{#if branch}<span>{branch}</span>{/if}
			</div>
		{/if}
	</div>

	<MenuItem
		data-testid={session.settledAt != null ? "session-ctx-unsettle" : "session-ctx-settle"}
		disabled={actions.settleDisabledReason != null}
		onselect={() => select(() => onsettle(session.id, !actions.settled))}
	>
		<Icon name={session.settledAt != null ? "undo" : "check"} size={13} />
		<span>{session.settledAt != null ? "Un-settle" : "Settle"}</span>
		{#if actions.settleDisabledReason}
			<span class="ml-auto text-xs text-text-dimmer">{actions.settleDisabledReason}</span>
		{/if}
	</MenuItem>
	<MenuItem
		data-testid="session-ctx-auto-settle"
		aria-checked={session.autoSettleDisabled !== true}
		onselect={() => select(() => onautosettle(session.id, session.autoSettleDisabled !== true))}
	>
		<span class="w-[13px] shrink-0" aria-hidden="true">
			{#if session.autoSettleDisabled !== true}<Icon name="check" size={13} />{/if}
		</span>
		<span>Auto-settle when idle</span>
	</MenuItem>
	<MenuItem
		data-testid={session.pinnedAt != null ? "session-ctx-unpin" : "session-ctx-pin"}
		onselect={() => select(() => onpin(session.id, !actions.pinned))}
	>
		<Icon name={session.pinnedAt != null ? "star-off" : "star"} size={13} />
		<span>{session.pinnedAt != null ? "Unpin" : "Pin to top"}</span>
	</MenuItem>
	{#if actions.snoozeVisible}
		<MenuItem
			data-testid="session-ctx-snooze"
			disabled={actions.snoozeDisabledReason != null}
			onselect={() => select(() => onsnooze(session.id))}
		>
			<Icon name="moon" size={13} />
			<span>{actions.snoozed ? "Change snooze…" : "Snooze…"}</span>
			{#if actions.snoozeDisabledReason}
				<span class="ml-auto text-xs text-text-dimmer">{actions.snoozeDisabledReason}</span>
			{/if}
		</MenuItem>
		{#if actions.snoozed}
			<MenuItem data-testid="session-ctx-unsnooze" onselect={() => select(() => onunsnooze(session.id))}>
				<Icon name="undo" size={13} />
				<span>Unsnooze</span>
			</MenuItem>
		{/if}
	{/if}
	<MenuSeparator />

	<MenuItem
		data-testid="session-ctx-rename"
		onselect={() => select(() => onrename(session.id))}
	>
		<Icon name="pencil" size={13} />
		<span>Rename</span>
	</MenuItem>

	<MenuItem data-testid="session-ctx-fork" onselect={() => select(() => onfork(session.id))}>
		<Icon name="git-fork" size={13} />
		<span>Fork</span>
	</MenuItem>

	<MenuItem data-testid="session-ctx-copy-resume" onselect={() => select(() => { void handleCopyResume(); })}>
		<Icon name="copy" size={13} />
		<span>Copy resume command</span>
	</MenuItem>

	<MenuItem
		variant="danger"
		data-testid="session-ctx-delete"
		onselect={() => select(() => ondelete(session.id, session.title || "New Session"))}
	>
		<span>Delete</span>
	</MenuItem>
</Menu>
