<!--
  ArrowPad — a touch pad that sends arrows.

  Dragging sends one arrow per STEP_PX in the drag's dominant direction.
  Holding still after a step repeats that direction on the shared repeat
  timer, as a held key would. A tap that never stepped sends the arrow of the
  side it landed on. Like the flick keys it captures its pointer and never
  takes focus, so the terminal keeps the software keyboard.

  Each side's chevron is its own button, so the arrows can be reached without
  a gesture; pointer input goes through the pad's geometry instead.
-->
<script lang="ts">
	import Icon from "./Icon.svelte";
	import { createRepeatTimer } from "./repeat-timer.js";

	type Arrow = "left" | "up" | "down" | "right";

	let {
		onarrow,
		class: className = "",
	}: {
		/** `repeated` is true for the timer's repeats, not for drag steps. */
		onarrow: (arrow: Arrow, repeated: boolean) => void;
		class?: string;
	} = $props();

	const STEP_PX = 14;
	const SIDES: readonly (readonly [Arrow, string, string])[] = [
		["left", "Left arrow", "top-1/2 left-[6px] -translate-y-1/2"],
		["up", "Up arrow", "top-[2px] left-1/2 -translate-x-1/2"],
		["down", "Down arrow", "bottom-[2px] left-1/2 -translate-x-1/2"],
		["right", "Right arrow", "top-1/2 right-[6px] -translate-y-1/2"],
	];

	const repeat = createRepeatTimer();
	$effect(() => repeat.stop);
	let gesture = $state<{
		pointerId: number;
		/** Where the next step is measured from. */
		x: number;
		y: number;
		/** The last direction stepped; null until the drag first steps. */
		arrow: Arrow | null;
	} | null>(null);

	/** The dominant direction of a displacement. */
	const direction = (dx: number, dy: number): Arrow =>
		Math.abs(dx) >= Math.abs(dy)
			? dx < 0
				? "left"
				: "right"
			: dy < 0
				? "up"
				: "down";

	function end() {
		repeat.stop();
		gesture = null;
	}

	function handlePointerDown(event: PointerEvent) {
		if (event.button !== 0) return;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		gesture = {
			pointerId: event.pointerId,
			x: event.clientX,
			y: event.clientY,
			arrow: null,
		};
	}

	function handlePointerMove(event: PointerEvent) {
		if (gesture?.pointerId !== event.pointerId) return;
		const dx = event.clientX - gesture.x;
		const dy = event.clientY - gesture.y;
		const horizontal = Math.abs(dx) >= Math.abs(dy);
		const steps = Math.floor(Math.abs(horizontal ? dx : dy) / STEP_PX);
		if (steps === 0) return;
		const arrow = direction(dx, dy);
		// Advance along the dominant axis only by whole steps, and drop the
		// other axis's drift, so a wobbly line still steps evenly.
		if (horizontal) {
			gesture.x += Math.sign(dx) * steps * STEP_PX;
			gesture.y = event.clientY;
		} else {
			gesture.y += Math.sign(dy) * steps * STEP_PX;
			gesture.x = event.clientX;
		}
		gesture.arrow = arrow;
		for (let step = 0; step < steps; step++) onarrow(arrow, false);
		// Each step restarts the delay, so repeating begins only once the
		// finger stops stepping.
		repeat.start(() => onarrow(arrow, true));
	}

	function handlePointerUp(event: PointerEvent) {
		if (gesture?.pointerId !== event.pointerId) return;
		const stepped = gesture.arrow !== null;
		end();
		if (stepped) return;
		const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
		// Measured against the half-size, so the wide pad's sides split on
		// its diagonals rather than at 45 degrees.
		onarrow(
			direction(
				(event.clientX - box.left - box.width / 2) / box.width,
				(event.clientY - box.top - box.height / 2) / box.height,
			),
			false,
		);
	}
</script>

<!-- The buttons carry the semantics; the wrapper only tracks the gesture. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
	class="arrow-pad relative h-[46px] min-w-0 touch-none rounded-[12px] select-none transition-[background] duration-100
		{gesture?.arrow ? 'bg-accent/[14%]' : gesture ? 'bg-text/[14%]' : 'bg-chip'} {className}"
	role="group"
	aria-label="Arrows"
	onmousedown={(event) => event.preventDefault()}
	onpointerdown={handlePointerDown}
	onpointermove={handlePointerMove}
	onpointerup={handlePointerUp}
	onpointercancel={end}
	onlostpointercapture={end}
>
	{#each SIDES as [arrow, label, position] (arrow)}
		<button
			type="button"
			aria-label={label}
			class="absolute grid place-items-center {position}
				{gesture?.arrow === arrow ? 'text-accent' : 'text-text-secondary'}"
			onclick={(event) => {
				if (event.detail === 0) onarrow(arrow, false);
			}}
		>
			<Icon name="chevron-{arrow}" size={15} />
		</button>
	{/each}
</div>
