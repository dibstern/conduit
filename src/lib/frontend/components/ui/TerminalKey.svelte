<!--
  TerminalKey — one on-screen key in the desktop terminal bar.

  Fires on press rather than on click, like a physical key, and never takes
  focus: the terminal keeps it, so typing straight afterwards still reaches
  the shell. A keyboard-activated click (detail 0) also fires, so the key
  stays usable without a pointer. `repeat` adds hold-to-repeat through the
  shared repeat timer; repeats call `onpress(true)`.

  `state` marks a modifier: waiting is the accent tint, locked adds a ring.
  Screen readers hear it as a tri-state toggle: off, mixed (waiting), pressed.
-->
<script lang="ts">
	import type { Snippet } from "svelte";
	import { createRepeatTimer } from "./repeat-timer.js";

	let {
		label,
		state,
		glyph = false,
		repeat = false,
		onpress,
		children,
	}: {
		/** Accessible name and tooltip, e.g. "Escape". */
		label: string;
		state?: "off" | "waiting" | "locked";
		/** A single symbol (⌃, an arrow): narrower padding, larger type. */
		glyph?: boolean;
		repeat?: boolean;
		onpress: (repeated: boolean) => void;
		children: Snippet;
	} = $props();

	const timer = createRepeatTimer();
	const pressed = { off: false, waiting: "mixed", locked: true } as const;

	function handlePointerDown(event: PointerEvent) {
		if (event.button !== 0) return;
		onpress(false);
		if (!repeat) return;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		timer.start(() => onpress(true));
	}

	$effect(() => timer.stop);
</script>

<button
	type="button"
	title={label}
	aria-label={label}
	aria-pressed={state && pressed[state]}
	class="relative inline-flex h-[26px] items-center justify-center gap-[5px] rounded-full font-sans font-medium transition-[background,color,box-shadow] duration-100
		{glyph ? 'min-w-[26px] px-[6px] text-[14.5px]' : 'min-w-[28px] px-[8px] text-[12.5px]'}
		{state === 'waiting' || state === 'locked'
		? 'bg-accent/[18%] text-accent'
		: 'text-text-secondary hover:bg-hover hover:text-text'}
		{state === 'locked' ? 'shadow-[inset_0_0_0_1.5px_var(--color-accent)]' : ''}"
	onmousedown={(event) => event.preventDefault()}
	onpointerdown={handlePointerDown}
	onpointerup={timer.stop}
	onpointercancel={timer.stop}
	onlostpointercapture={timer.stop}
	onclick={(event) => {
		if (event.detail === 0) onpress(false);
	}}
>
	{@render children()}
</button>
