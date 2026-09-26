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
		onrename,
		onsettle,
		onpin,
		ondelete,
		oncopyresume,
		onfork,
		onclose,
	}: {
		session: SessionInfo;
		anchor: HTMLElement;
		onrename: (id: string) => void;
		onsettle: (id: string, next: boolean) => void;
		onpin: (id: string, next: boolean) => void;
		ondelete: (id: string, title: string) => void;
		oncopyresume: (id: string) => void;
		onfork: (id: string) => void;
		onclose: () => void;
	} = $props();

	let open = $state(true);

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
		if (!nextOpen) onclose();
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

	<MenuItem
		data-testid={session.settledAt != null ? "session-ctx-unsettle" : "session-ctx-settle"}
		disabled={session.pinnedAt != null}
		onselect={() => onsettle(session.id, session.settledAt == null)}
	>
		<Icon name={session.settledAt != null ? "undo" : "check"} size={13} />
		<span>{session.settledAt != null ? "Un-settle" : "Settle"}</span>
		{#if session.pinnedAt != null}
			<span class="ml-auto text-xs text-text-dimmer">Unpin to settle</span>
		{/if}
	</MenuItem>
	<MenuItem
		data-testid={session.pinnedAt != null ? "session-ctx-unpin" : "session-ctx-pin"}
		onselect={() => onpin(session.id, session.pinnedAt == null)}
	>
		<Icon name={session.pinnedAt != null ? "star-off" : "star"} size={13} />
		<span>{session.pinnedAt != null ? "Unpin" : "Pin to top"}</span>
	</MenuItem>
	<MenuSeparator />

	<MenuItem
		data-testid="session-ctx-rename"
		onselect={() => onrename(session.id)}
	>
		<Icon name="pencil" size={13} />
		<span>Rename</span>
	</MenuItem>

	<MenuItem data-testid="session-ctx-fork" onselect={() => onfork(session.id)}>
		<Icon name="git-fork" size={13} />
		<span>Fork</span>
	</MenuItem>

	<MenuItem data-testid="session-ctx-copy-resume" onselect={handleCopyResume}>
		<Icon name="copy" size={13} />
		<span>Copy resume command</span>
	</MenuItem>

	<MenuItem
		variant="danger"
		data-testid="session-ctx-delete"
		onselect={() => ondelete(session.id, session.title || "New Session")}
	>
		<span>Delete</span>
	</MenuItem>
</Menu>
