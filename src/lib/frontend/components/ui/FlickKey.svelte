<!--
  FlickKey — a touch key with two actions: tap sends the big label, a flick
  up sends the small corner one.

  Past FLICK_PX upward a bubble shows the corner action; letting go sends it,
  and sliding back down cancels to the tap. The key captures its pointer, so a
  drag stays on the key it started on, and never takes focus: the terminal
  keeps it, and with it the software keyboard. The corner label is its own
  button, so it can be reached without a gesture, and a tap on it sends the
  corner action too.

  `state` marks a slot that is a modifier, as on the desktop TerminalKey:
  waiting is the accent tint, locked adds a ring. The tap slot's shows on the
  key, the flick slot's on the corner label.
-->
<script lang="ts">
	import Icon from "./Icon.svelte";

	type Slot = {
		/** The label on the key: a glyph or a short word. */
		text: string;
		/** The name it's announced by, e.g. "Escape". */
		name: string;
		/** Shown instead of `text` on the key face and in the bubble. */
		icon?: string;
		state?: "off" | "waiting" | "locked";
	};

	let {
		tap,
		up,
		hints = true,
		preserveFocus = true,
		onpress,
	}: {
		tap: Slot;
		up?: Slot | undefined;
		hints?: boolean;
		/** Terminal keys keep the input focused; preview keys can take focus. */
		preserveFocus?: boolean;
		onpress: (slot: "tap" | "up") => void;
	} = $props();

	const FLICK_PX = 18;
	const pressed = { off: false, waiting: "mixed", locked: true } as const;

	let gesture = $state<{
		pointerId: number;
		startY: number;
		onCorner: boolean;
		flicking: boolean;
	} | null>(null);

	const held = (slot: Slot) =>
		slot.state === "waiting" || slot.state === "locked";

	function handlePointerDown(event: PointerEvent) {
		if (event.button !== 0) return;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		gesture = {
			pointerId: event.pointerId,
			startY: event.clientY,
			onCorner: (event.target as Element).closest("[data-corner]") !== null,
			flicking: false,
		};
	}

	function handlePointerMove(event: PointerEvent) {
		if (gesture?.pointerId !== event.pointerId) return;
		gesture.flicking = gesture.startY - event.clientY > FLICK_PX;
	}

	function handlePointerUp(event: PointerEvent) {
		if (gesture?.pointerId !== event.pointerId) return;
		const slot = gesture.flicking || gesture.onCorner ? "up" : "tap";
		gesture = null;
		if (slot === "tap" || up) onpress(slot);
	}
</script>

<!-- The buttons carry the semantics; the wrapper only tracks the gesture.
     The face sits low so a narrow key's corner label clears it. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="flick-key relative h-[46px] min-w-0 flex-1 touch-none select-none"
	onmousedown={(event) => { if (preserveFocus) event.preventDefault(); }}
	onpointerdown={handlePointerDown}
	onpointermove={handlePointerMove}
	onpointerup={handlePointerUp}
	onpointercancel={() => (gesture = null)}
	onlostpointercapture={() => (gesture = null)}
>
	<button
		type="button"
		aria-label={up ? `${tap.name}, flick up for ${up.name}` : tap.name}
		aria-pressed={tap.state && pressed[tap.state]}
		class="absolute inset-0 grid place-items-center rounded-[12px] pt-[11px] font-sans font-medium transition-[background,color,box-shadow] duration-100
			{tap.text.length === 1 ? 'text-[19px]' : 'text-[16px]'}
			{gesture?.flicking && up
			? 'bg-accent/[14%] text-text'
			: held(tap)
				? 'bg-accent/[18%] text-accent'
				: gesture
					? 'bg-text/[14%] text-text'
					: 'bg-chip text-text'}
			{tap.state === 'locked' ? 'shadow-[inset_0_0_0_1.5px_var(--color-accent)]' : ''}"
		onclick={(event) => {
			if (event.detail === 0) onpress("tap");
		}}
	>
		{#if tap.icon}<Icon name={tap.icon} size={19} />{:else}{tap.text}{/if}
	</button>
	{#if up && hints}
	<button
		type="button"
		data-corner
		aria-label={up.name}
		aria-pressed={up.state && pressed[up.state]}
		class="absolute top-[3px] right-[4px] rounded-[4px] px-[3px] font-mono text-[11.5px] leading-[1.4] transition-[background,color,box-shadow] duration-100
			{gesture?.flicking
			? 'bg-accent text-bg'
			: held(up)
				? 'bg-accent/[18%] text-accent'
				: 'text-text-secondary'}
			{up.state === 'locked' ? 'shadow-[inset_0_0_0_1px_var(--color-accent)]' : ''}"
		onclick={(event) => {
			if (event.detail === 0) onpress("up");
		}}
	>
		{up.text}
	</button>
	{/if}
	{#if gesture?.flicking && up}
		<span
			class="flick-bubble pointer-events-none absolute bottom-[calc(100%+8px)] z-10 min-w-[64px] rounded-[14px] border border-border bg-popover-bg px-3 pt-2 pb-[7px] text-center shadow-dropdown"
			aria-hidden="true"
		>
			<b class="flex justify-center text-[24px] leading-[1.1] font-semibold text-accent">
				{#if up.icon}<Icon name={up.icon} size={24} />{:else}{up.text}{/if}
			</b>
			<small class="mt-[3px] block text-[11px] font-medium text-text-muted">{up.name}</small>
		</span>
	{/if}
</div>

<style>
	.flick-bubble {
		left: 50%;
		translate: -50% 0;
	}
	/* The first key sits at the screen edge, where a centred bubble would clip. */
	.flick-key:first-child .flick-bubble {
		left: 0;
		translate: none;
	}
</style>
