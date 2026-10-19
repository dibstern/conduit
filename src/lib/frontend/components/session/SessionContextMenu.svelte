<script lang="ts">
	import type { SessionInfo } from "../../types.js";
	import { onDestroy, untrack } from "svelte";
	import Menu from "../ui/Menu.svelte";
	import SessionCommandItems from "./SessionCommandItems.svelte";
	import SessionSheetBody from "./SessionSheetBody.svelte";
	import SessionSheetFooter from "./SessionSheetFooter.svelte";
	import { getSessionCommands, type SessionCommand, type SessionCommandHost } from "./session-commands.js";

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
		host: SessionCommandHost;
		now?: number;
		onclose: () => void;
		/** Non-session actions: desktop rows or the phone sheet footer. */
		extras?: readonly Omit<SessionCommand, "section">[];
	} = $props();
	// Captured once: dialogs opened from a command call focusTarget after this menu
	// unmounts, when its props may already be gone.
	const opener = untrack(() => anchor);
	const targetId = untrack(() => session.id);

	let open = $state(true);
	let selected = false;
	let focusScheduled = false;
	const commands = $derived([
		...getSessionCommands(session, now, host, presentation === "sheet" ? "sheet" : "center"),
		...extras.map((item) => ({ ...item, section: "extras" as const })),
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

	function select(action: SessionCommand["run"]) {
		selected = true;
		action(focusTarget);
		onclose();
	}
</script>

	<Menu
		bind:open
		presentation={presentation === "sheet" ? "sheet" : "popover"}
		appearance="final"
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
		footer={presentation === "sheet" && extras.length > 0 ? sheetFooter : undefined}
		sheetBottomPadding={extras.length > 0 ? 12 : 22}
	>
		{#snippet trigger()}{/snippet}
		{#if presentation === "sheet"}
			<SessionSheetBody {commands} {now} header={{ session, projectLabel, projectAccent, branch }} onselect={select} />
		{:else}
			<div data-testid="session-ctx-header" class="border-b border-border px-3 py-2 font-sans">
				<div class="line-clamp-2 whitespace-normal break-words text-sm font-semibold text-text">{session.title || "New Session"}</div>
				{#if projectLabel || branch}<div class="mt-1 flex gap-2 text-xs text-text-dimmer">{#if projectLabel}<span>{projectLabel}</span>{/if}{#if branch}<span>{branch}</span>{/if}</div>{/if}
			</div>
			<SessionCommandItems {commands} onselect={select} />
		{/if}
	</Menu>

{#snippet sheetFooter()}
	<SessionSheetFooter {extras} onselect={select} />
{/snippet}
