<!-- ─── ProjectContextMenu ──────────────────────────────────────────────────── -->
<!-- Dropdown menu for project actions: Rename, Remove (delete). -->
<!-- Positioned relative to the anchor element (the "..." button). -->

<script lang="ts">
	import type { ProjectInfo } from "../../types.js";
	import Icon from "../shared/Icon.svelte";

	// ─── Props ──────────────────────────────────────────────────────────────────

	let {
		project,
		anchor,
		onrename,
		ondelete,
		onclose,
	}: {
		project: ProjectInfo;
		anchor: HTMLElement;
		onrename: (slug: string) => void;
		ondelete: (slug: string, title: string) => void;
		onclose: () => void;
	} = $props();

	// ─── Positioning ─────────────────────────────────────────────────────────────

	const menuStyle = $derived.by(() => {
		if (!anchor) return "";
		const rect = anchor.getBoundingClientRect();
		return `top: ${rect.bottom + 4}px; left: ${rect.right}px; transform: translateX(-100%);`;
	});

	// ─── Handlers ───────────────────────────────────────────────────────────────

	function handleRename(e: MouseEvent) {
		e.stopPropagation();
		onrename(project.slug);
		onclose();
	}

	function handleDelete(e: MouseEvent) {
		e.stopPropagation();
		ondelete(project.slug, project.title);
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
<div class="fixed inset-0 z-[200]" onclick={handleBackdropClick}>
	<!-- Menu dropdown -->
	<div
		class="fixed z-[201] min-w-[160px] bg-bg-alt border border-border rounded-lg py-1 shadow-[0_4px_16px_rgba(var(--shadow-rgb),0.3)]"
		style={menuStyle}
		onclick={(e) => e.stopPropagation()}
	>
		<!-- Rename -->
		<button
			class="flex items-center gap-2 w-full py-2 px-3 border-none bg-transparent text-text-secondary text-[13px] font-mono cursor-pointer text-left transition-colors duration-100 hover:bg-[rgba(var(--overlay-rgb),0.04)] hover:text-text"
			onclick={handleRename}
		>
			<Icon name="pencil" size={14} />
			<span>Rename</span>
		</button>

		<!-- Remove -->
		<button
			class="flex items-center gap-2 w-full py-2 px-3 border-none bg-transparent text-[13px] font-mono cursor-pointer text-left transition-colors duration-100 text-error hover:bg-error/10 hover:text-error"
			onclick={handleDelete}
		>
			<Icon name="trash-2" size={14} />
			<span>Remove</span>
		</button>
	</div>
</div>
