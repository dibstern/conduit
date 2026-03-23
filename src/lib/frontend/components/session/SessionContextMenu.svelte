<!-- ─── SessionContextMenu ──────────────────────────────────────────────────── -->
<!-- Dropdown menu for session actions: Rename, Copy Resume Command, Delete. -->
<!-- Positioned relative to the anchor element (the "..." button). -->

<script lang="ts">
	import type { SessionInfo } from "../../types.js";
	import { copyToClipboard } from "../../utils/clipboard.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import Icon from "../shared/Icon.svelte";

	// ─── Props ──────────────────────────────────────────────────────────────────

	let {
		session,
		anchor,
		onrename,
		ondelete,
		oncopyresume,
		onfork,
		onclose,
	}: {
		session: SessionInfo;
		anchor: HTMLElement;
		onrename: (id: string) => void;
		ondelete: (id: string, title: string) => void;
		oncopyresume: (id: string) => void;
		onfork: (id: string) => void;
		onclose: () => void;
	} = $props();

	// ─── Local state ────────────────────────────────────────────────────────────

	let menuEl: HTMLDivElement | undefined = $state(undefined);

	// ─── Positioning ─────────────────────────────────────────────────────────────

	const menuStyle = $derived.by(() => {
		if (!anchor) return "";
		const rect = anchor.getBoundingClientRect();
		// Position below the anchor, aligned to the right
		return `top: ${rect.bottom + 4}px; left: ${rect.right}px; transform: translateX(-100%);`;
	});

	// ─── Handlers ───────────────────────────────────────────────────────────────

	function handleRename(e: MouseEvent) {
		e.stopPropagation();
		// Action first, then close — onclose unmounts this component
		onrename(session.id);
		onclose();
	}

	async function handleCopyResume(e: MouseEvent) {
		e.stopPropagation();
		const cmd = `opencode --session ${session.id}`;
		const ok = await copyToClipboard(cmd);
		if (ok) {
			showToast("Copied resume command");
		} else {
			showToast("Failed to copy \u2014 clipboard unavailable", { variant: "warn" });
		}
		oncopyresume(session.id);
		onclose();
	}

	function handleDelete(e: MouseEvent) {
		e.stopPropagation();
		// Action first, then close — onclose unmounts this component
		ondelete(session.id, session.title || "New Session");
		onclose();
	}

	function handleBackdropClick(e: MouseEvent) {
		if (e.target === e.currentTarget) {
			onclose();
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === "Escape") {
			onclose();
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- Invisible backdrop to catch clicks outside -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="fixed inset-0 z-[200]"
	onclick={handleBackdropClick}
>
	<!-- Menu dropdown -->
	<div
		bind:this={menuEl}
		class="session-ctx-menu fixed z-[201] min-w-[180px] bg-bg-alt border border-border rounded-lg py-1 shadow-[0_4px_16px_rgba(var(--shadow-rgb),0.3)]"
		style={menuStyle}
		onclick={(e) => e.stopPropagation()}
	>
		<!-- Rename -->
		<button
		class="session-ctx-item flex items-center gap-2 w-full py-2 px-3 border-none bg-transparent text-text-secondary text-base font-mono cursor-pointer text-left transition-colors duration-100 hover:bg-[rgba(var(--overlay-rgb),0.04)] hover:text-text"
		onclick={handleRename}
		>
			<Icon name="pencil" size={14} />
			<span>Rename</span>
		</button>

		<!-- Fork -->
		<button
		class="session-ctx-item flex items-center gap-2 w-full py-2 px-3 border-none bg-transparent text-text-secondary text-base font-mono cursor-pointer text-left transition-colors duration-100 hover:bg-[rgba(var(--overlay-rgb),0.04)] hover:text-text"
		onclick={(e) => {
				e.stopPropagation();
				onfork(session.id);
				onclose();
			}}
		>
			<Icon name="git-fork" size={14} />
			<span>Fork</span>
		</button>

		<!-- Copy resume command -->
		<button
		class="session-ctx-item flex items-center gap-2 w-full py-2 px-3 border-none bg-transparent text-text-secondary text-base font-mono cursor-pointer text-left transition-colors duration-100 hover:bg-[rgba(var(--overlay-rgb),0.04)] hover:text-text"
		onclick={handleCopyResume}
		>
			<Icon name="copy" size={14} />
			<span>Copy resume command</span>
		</button>

		<!-- Delete -->
		<button
			class="session-ctx-item session-ctx-delete flex items-center gap-2 w-full py-2 px-3 border-none bg-transparent text-base font-mono cursor-pointer text-left transition-colors duration-100 text-error hover:bg-error/10 hover:text-error"
			onclick={handleDelete}
		>
			<Icon name="trash-2" size={14} />
			<span>Delete</span>
		</button>
	</div>
</div>
