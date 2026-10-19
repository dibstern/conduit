<!--
  SortableList — a bordered list whose rows the user reorders by mouse drag,
  touch drag or keyboard, through a ⋮⋮ handle at the start of each row.

  The handle is a real button. Space or Enter picks the row up, the arrow keys
  move it, Space or Enter drops it and Escape puts it back; every step is
  announced through a live region. A pointer drag (mouse or touch) lifts the row
  under the pointer and swaps it past a neighbour once it crosses that
  neighbour's midpoint.

  The list keeps a draft order while a row is lifted and calls `onreorder` once,
  on drop, only when the order changed. The caller owns `items` and should
  update it synchronously in `onreorder`, so the dropped order never flickers
  back. The caller renders each row's content through the `row` snippet.
-->
<script lang="ts" generics="T">
	import { flushSync, type Snippet, tick } from "svelte";
	import { flip } from "svelte/animate";
	import { MediaQuery } from "svelte/reactivity";

	let {
		items,
		key,
		label,
		onreorder,
		row,
		details,
		variant = "rows",
		ariaLabel,
		disabled = false,
		class: className = "",
	}: {
		items: readonly T[];
		/** A stable, unique key per item. */
		key: (item: T) => string;
		/** The item's name in announcements and the handle's accessible name. */
		label: (item: T) => string;
		/** The new order, called on drop only when it differs from `items`. */
		onreorder: (next: T[]) => void;
		/** The row's content, after the handle. */
		row: Snippet<[item: T, index: number]>;
		/** Cards and trees keep the handle beside their heading, with details underneath. */
		details?: Snippet<[item: T, index: number]>;
		/** Trees are borderless: a group heading over its own rows. */
		variant?: "rows" | "cards" | "tree";
		/** Names the list for assistive tech. */
		ariaLabel: string;
		disabled?: boolean | undefined;
		/** Layout only (margin, width). */
		class?: string | undefined;
	} = $props();

	const id = $props.id();
	const reducedMotion = new MediaQuery("(prefers-reduced-motion: reduce)");

	let listEl = $state<HTMLUListElement>();
	/** The order shown while a row is lifted; null at rest. */
	let draft = $state<T[] | null>(null);
	let lifted = $state<{ key: string; by: "pointer" | "keyboard" } | null>(null);
	/** The pointer drag's anchor; `originY` moves with each swap so the row stays under the pointer. */
	let drag: { pointerId: number; originY: number } | null = null;
	let offset = $state(0);
	let announcement = $state("");

	const shown = $derived(draft ?? items);

	function position(order: readonly T[], k: string): number {
		return order.findIndex((item) => key(item) === k);
	}

	function lift(item: T, by: "pointer" | "keyboard") {
		draft = [...items];
		lifted = { key: key(item), by };
		offset = 0;
		announcement = `Picked up ${label(item)}, position ${position(items, key(item)) + 1} of ${items.length}.${by === "keyboard" ? " Use the arrow keys to move it, space to drop it, escape to cancel." : ""}`;
	}

	function move(from: number, to: number) {
		if (!draft || to < 0 || to >= draft.length) return;
		const next = [...draft];
		const [item] = next.splice(from, 1);
		if (item === undefined) return;
		next.splice(to, 0, item);
		draft = next;
	}

	function drop() {
		if (!draft || !lifted) return;
		const next = draft;
		const k = lifted.key;
		const item = next[position(next, k)];
		draft = null;
		lifted = null;
		drag = null;
		offset = 0;
		if (item === undefined) return;
		announcement = `Dropped ${label(item)} at position ${position(next, k) + 1} of ${next.length}.`;
		if (next.some((candidate, index) => key(candidate) !== key(items[index] as T))) onreorder(next);
	}

	function cancel() {
		if (!lifted) return;
		const k = lifted.key;
		draft = null;
		lifted = null;
		drag = null;
		offset = 0;
		const item = items[position(items, k)];
		if (item !== undefined) announcement = `Reorder cancelled. ${label(item)} is back at position ${position(items, k) + 1} of ${items.length}.`;
	}

	async function focusHandle(index: number) {
		await tick();
		listEl?.children[index]?.querySelector<HTMLButtonElement>("[data-sortable-handle]")?.focus();
	}

	function onkeydown(event: KeyboardEvent, item: T) {
		if (disabled) return;
		const k = key(item);
		const step = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
		if (variant === "cards" && !lifted && step !== 0) {
			event.preventDefault();
			const from = position(items, k);
			const to = from + step;
			if (to < 0 || to >= items.length) return;
			lift(item, "keyboard");
			move(from, to);
			drop();
			void focusHandle(to);
			return;
		}
		if (event.key === " " || event.key === "Enter") {
			event.preventDefault();
			if (lifted?.key === k) drop();
			else if (!lifted) lift(item, "keyboard");
			return;
		}
		if (lifted?.key !== k || lifted.by !== "keyboard" || !draft) return;
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			const index = position(items, k);
			cancel();
			void focusHandle(index);
			return;
		}
		if (step === 0) return;
		event.preventDefault();
		const from = position(draft, k);
		const to = from + step;
		if (to < 0 || to >= draft.length) return;
		move(from, to);
		announcement = `${label(item)} moved to position ${to + 1} of ${draft.length}.`;
		void focusHandle(to);
	}

	// Leaving the list with a row still lifted by keyboard drops it where it is.
	function onfocusout() {
		setTimeout(() => {
			if (lifted?.by === "keyboard" && !listEl?.contains(document.activeElement)) drop();
		});
	}

	function onpointerdown(event: PointerEvent, item: T) {
		if (disabled || lifted || event.button !== 0) return;
		event.preventDefault();
		// Capture on the list, not the handle: a swap moves the row's nodes, and
		// moving a node releases its capture, so the drop would never arrive and
		// the list would stay lifted.
		listEl?.setPointerCapture(event.pointerId);
		drag = { pointerId: event.pointerId, originY: event.clientY };
		lift(item, "pointer");
	}

	function onpointermove(event: PointerEvent) {
		if (!drag || event.pointerId !== drag.pointerId || !draft || !lifted || !listEl) return;
		// One event can pass several rows (a fast flick, or tall cards), so keep
		// stepping until the lifted row's centre sits between its neighbours.
		for (let step = 0; step < draft.length; step++) {
			offset = event.clientY - drag.originY;
			const rows = [...listEl.children] as HTMLElement[];
			const index = position(draft, lifted.key);
			const self = rows[index];
			if (!self) return;
			// Layout offsets ignore transforms, so a row mid-animation still measures where it will land.
			const centre = self.offsetTop + self.offsetHeight / 2 + offset;
			const below = rows[index + 1];
			const above = rows[index - 1];
			if (below && centre > below.offsetTop + below.offsetHeight / 2) {
				drag.originY += below.offsetTop + below.offsetHeight - self.offsetTop - self.offsetHeight;
				move(index, index + 1);
			} else if (above && centre < above.offsetTop + above.offsetHeight / 2) {
				drag.originY += above.offsetTop - self.offsetTop;
				move(index, index - 1);
			} else return;
			// Render the move so the next pass measures the new layout.
			flushSync();
		}
		offset = event.clientY - drag.originY;
	}

	function onpointerend(event: PointerEvent, commit: boolean) {
		if (!drag || event.pointerId !== drag.pointerId) return;
		if (commit) drop();
		else cancel();
	}
</script>

<ul
	bind:this={listEl}
	aria-label={ariaLabel}
	class="relative flex flex-col {variant === 'cards' ? 'gap-[8px]' : variant === 'rows' ? 'gap-[6px]' : ''} {className}"
	{onfocusout}
	{onpointermove}
	onpointerup={(event) => onpointerend(event, true)}
	onpointercancel={(event) => onpointerend(event, false)}
>
	{#each shown as item, index (key(item))}
		{@const isLifted = lifted?.key === key(item)}
		<li
			animate:flip={{ duration: reducedMotion.current || (isLifted && lifted?.by === "pointer") ? 0 : 150 }}
			data-testid="sortable-row"
			data-lifted={isLifted || undefined}
			class="{variant === 'tree' ? 'rounded-panel' : 'min-h-[30px] border bg-bg text-[11.5px] text-text-secondary'} {variant === 'cards' ? 'rounded-[12px] px-[11px] py-[9px]' : variant === 'rows' ? 'rounded-[7px] p-[6px]' : ''} {isLifted ? 'relative z-10 shadow-modal' : ''} {isLifted ? (variant === 'tree' ? 'bg-bg-surface' : 'border-border') : variant === 'cards' ? 'border-border' : variant === 'rows' ? 'border-border-subtle' : ''}"
			style:transform={isLifted && lifted?.by === "pointer" ? `translateY(${offset}px)` : undefined}
		>
			<div class="flex min-w-0 items-center {variant === 'cards' ? 'gap-[7px]' : variant === 'rows' ? 'gap-[8px]' : ''}">
			<button
				type="button"
				data-sortable-handle
				data-testid="sortable-handle"
				aria-label="Reorder {label(item)}"
				aria-describedby="{id}-instructions"
				aria-pressed={isLifted}
				{disabled}
				class="-my-[2px] shrink-0 cursor-grab touch-none select-none rounded-[4px] px-[2px] leading-none text-text-dimmer hover:text-text-secondary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-text disabled:cursor-default disabled:opacity-50 {variant === 'tree' ? 'min-h-[44px] md:min-h-[28px] w-[24px] md:w-[11px]' : ''} {isLifted ? 'cursor-grabbing text-text-secondary' : ''}"
				onkeydown={(event) => onkeydown(event, item)}
				onpointerdown={(event) => onpointerdown(event, item)}
				><span aria-hidden="true">{variant === "cards" ? "⠿" : "⋮⋮"}</span></button>
			{@render row(item, index)}
			</div>
			{#if details}{@render details(item, index)}{/if}
		</li>
	{/each}
</ul>
<p id="{id}-instructions" hidden>Press space or enter to pick up. Use the arrow keys to move, space or enter to drop, and escape to cancel.</p>
<p class="sr-only" aria-live="assertive" aria-atomic="true" data-testid="sortable-announcement">{announcement}</p>
