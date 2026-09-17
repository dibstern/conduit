<!-- ─── ProjectContextMenu ──────────────────────────────────────────────────── -->
<!-- Dropdown menu for project actions: Rename, Remove (delete). -->
<!-- Positioned relative to the anchor element (the "..." button). -->

<script lang="ts">
	import type { ProjectInfo } from "../../types.js";
	import Button from "../ui/Button.svelte";
	import Surface from "../ui/Surface.svelte";

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
		onrename?: (slug: string) => void;
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
		onrename?.(project.slug);
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
<div class="fixed inset-0 z-[var(--z-popover)]" onclick={handleBackdropClick}>
	<!-- Menu dropdown -->
	<Surface
		variant="raised"
		radius="md"
		elevation="panel"
		class="fixed z-[var(--z-popover-raised)] min-w-[160px] py-1 flex flex-col"
		style={menuStyle}
		onclick={(e: MouseEvent) => e.stopPropagation()}
	>
		<!-- Rename -->
		{#if onrename}
		<!-- The menu is a flex column so Button's inline-flex cannot add a descender gap. -->
		<Button
			variant="ghost"
			size="content"
			align="start"
			tone="secondary"
			hoverFill="overlay"
			icon="pencil"
			iconSize={14}
			class="gap-2 w-full py-2 px-3 text-[13px] font-mono text-left duration-100"
			onclick={handleRename}
		>
			<span>Rename</span>
		</Button>
		{/if}

		<!-- Remove -->
		<!-- No error/10 hover-fill member exists; none leaves that exact wash to the class. -->
		<Button
			variant="ghost"
			size="content"
			align="start"
			tone="error"
			hoverFill="none"
			icon="trash-2"
			iconSize={14}
			class="gap-2 w-full py-2 px-3 text-[13px] font-mono text-left duration-100 hover:bg-error/10 hover:text-error"
			onclick={handleDelete}
		>
			<span>Remove</span>
		</Button>
	</Surface>
</div>
