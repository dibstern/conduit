<!-- One project in the scope picker. Three ways to remove it, all through the -->
<!-- same confirm: the ✕ on hover, a left swipe on touch, or Delete/Backspace. -->
<!-- The pencil beside it, or F2, opens the project in the Edit dialog.        -->

<script lang="ts">
	import { onDestroy } from "svelte";
	import type { ProjectInfo } from "../../types.js";
	import { getSwipeStage, MOVEMENT_SLOP_PX } from "../../utils/swipe.js";
	import Button from "../ui/Button.svelte";
	import Icon from "../ui/Icon.svelte";
	import MenuRadioItem from "../ui/MenuRadioItem.svelte";

	let { project, onremove, onedit }: {
		project: ProjectInfo;
		onremove: (slug: string) => void;
		onedit: (project: ProjectInfo) => void;
	} = $props();

	// A touch release can still fire a click on the row; that click must not
	// also pick the project the user just swiped away.
	const CLICK_SUPPRESSION_MS = 450;

	let wrapper: HTMLDivElement | undefined = $state();
	let offset = $state(0);
	let dragging = $state(false);
	let pointer: { id: number; x: number; y: number } | null = null;
	let suppressTimer: ReturnType<typeof setTimeout> | undefined;

	const stage = $derived(getSwipeStage(offset, wrapper?.offsetWidth ?? 0));

	function startSwipe(event: PointerEvent) {
		if (event.pointerType !== "touch" || pointer) return;
		pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
	}

	function moveSwipe(event: PointerEvent) {
		if (event.pointerId !== pointer?.id) return;
		const dx = event.clientX - pointer.x;
		if (!dragging) {
			const dy = event.clientY - pointer.y;
			if (Math.max(Math.abs(dx), Math.abs(dy)) <= MOVEMENT_SLOP_PX) return;
			if (Math.abs(dy) > Math.abs(dx)) { pointer = null; return; }
			dragging = true;
		}
		offset = Math.min(dx, 0);
	}

	function endSwipe(event: PointerEvent) {
		if (event.pointerId !== pointer?.id) return;
		const remove = event.type === "pointerup" && dragging && stage !== "none";
		if (dragging) {
			clearTimeout(suppressTimer);
			suppressTimer = setTimeout(() => { suppressTimer = undefined; }, CLICK_SUPPRESSION_MS);
		}
		pointer = null;
		dragging = false;
		offset = 0;
		if (remove) onremove(project.slug);
	}

	// F2, not a letter: letters belong to the menu's typeahead.
	function handleKeydown(event: KeyboardEvent) {
		if (event.key === "F2") {
			event.preventDefault();
			onedit(project);
			return;
		}
		if (event.key !== "Delete" && event.key !== "Backspace") return;
		event.preventDefault();
		onremove(project.slug);
	}

	onDestroy(() => clearTimeout(suppressTimer));
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	bind:this={wrapper}
	class="relative overflow-hidden"
	onpointerdown={startSwipe}
	onpointermove={moveSwipe}
	onpointerup={endSwipe}
	onpointercancel={endSwipe}
	onclickcapture={(event) => {
		if (suppressTimer === undefined) return;
		event.preventDefault();
		event.stopPropagation();
	}}
>
	{#if offset < 0}
		<div
			aria-hidden="true"
			class="absolute inset-0 flex items-center justify-end gap-1 px-3 font-brand text-sm font-medium {stage === 'none' ? 'bg-error/15 text-error' : 'bg-error text-bg'}"
		>
			<Icon name="trash-2" size={14} />
			{stage === "none" ? "Remove" : "Release to remove"}
		</div>
	{/if}
	<MenuRadioItem
		value={project.slug}
		class="group min-h-[44px] md:min-h-0 {offset < 0 ? 'bg-bg-alt' : ''} {dragging ? '' : 'transition-transform duration-150 motion-reduce:transition-none'}"
		style="touch-action: pan-y; transform: translateX({offset}px);"
		aria-keyshortcuts="Delete F2"
		onkeydown={handleKeydown}
	>
		<!-- The token beside each name teaches the typed form by use. -->
		<span class="flex min-w-0 items-center justify-between gap-3">
			<span class="truncate">{project.title || project.slug}</span>
			<span class="flex shrink-0 items-center gap-[6px]">
			<span class="font-mono text-xs text-text-dimmer">project:{project.slug}</span>
			<!-- Same reveal as the ✕ on desktop; touch has no hover, so phones and
			     coarse pointers always show it, with a 44px hit area on phones. -->
			<Button
				variant="toolbar"
				size="content"
				iconOnly
				icon="pencil"
				iconSize={11}
				touchTarget
				class="h-[16px] w-[16px] shrink-0 rounded-full md:pointer-fine:invisible md:group-hover:visible md:group-data-highlighted:visible"
				title="Edit project (F2)"
				ariaLabel="Edit {project.title || project.slug}"
				aria-hidden="true"
				tabindex={-1}
				data-testid="session-scope-edit"
				onpointerdown={(event: PointerEvent) => event.stopPropagation()}
				onpointerup={(event: PointerEvent) => event.stopPropagation()}
				onclick={(event: MouseEvent) => {
					event.stopPropagation();
					onedit(project);
				}}
			/>
			<!-- Desktop holds its slot while hidden so nothing shifts on hover;
			     phones swipe instead. Pointer-only: keyboard users press Delete
			     on the row, so the button stays out of the focus order and the
			     a11y tree. Press events stop here or the row would select.
			     layout="flow": Button's default inline-flex would beat `hidden`. -->
			<Button
				variant="toolbar"
				size="content"
				iconOnly
				icon="x"
				iconSize={11}
				layout="flow"
				class="hidden h-[16px] w-[16px] shrink-0 items-center justify-center rounded-full md:flex md:invisible md:group-hover:visible md:group-data-highlighted:visible"
				title="Remove project"
				ariaLabel="Remove {project.title || project.slug}"
				aria-hidden="true"
				tabindex={-1}
				data-testid="session-scope-remove"
				onpointerdown={(event: PointerEvent) => event.stopPropagation()}
				onpointerup={(event: PointerEvent) => event.stopPropagation()}
				onclick={(event: MouseEvent) => {
					event.stopPropagation();
					onremove(project.slug);
				}}
			/>
			</span>
		</span>
	</MenuRadioItem>
</div>
