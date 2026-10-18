<!--
  TerminalKeyRow — the touch presentation of the terminal keys: four flick
  keys, an arrow pad and a keyboard toggle under the terminal body.

  It sits in the panel's normal layout. On a phone the chat layout already
  fits the app to the visual viewport while the terminal shows, so the row
  rides directly above the software keyboard, and at the bottom of the screen
  when the keyboard is hidden, with no viewport tracking of its own.
-->
<script lang="ts">
	import type { TerminalKeyAction } from "../../../contracts/terminal-keys.js";
	import { projectState } from "../../stores/project-state.svelte.js";
	import {
		isTerminalModifier,
		TERMINAL_KEY_LABELS,
		type TerminalKeys,
	} from "../../utils/terminal-keys.svelte.js";
	import ArrowPad from "../ui/ArrowPad.svelte";
	import Button from "../ui/Button.svelte";
	import FlickKey from "../ui/FlickKey.svelte";

	let { keys }: { keys: TerminalKeys } = $props();

	const row = $derived(projectState.terminalKeys.row);

	const slot = (action: TerminalKeyAction) => ({
		...TERMINAL_KEY_LABELS[action],
		...(isTerminalModifier(action) && { state: keys.modifiers[action] }),
	});
</script>

<!-- With the keyboard down the row is the screen's bottom edge, so it clears
     the home indicator; with it up, it sits on the keyboard. -->
<div
	class="term-key-row flex shrink-0 gap-[6px] border-t border-border bg-bg px-2 pt-2
		{keys.keyboard ? 'pb-[7px]' : 'pb-[calc(7px+env(safe-area-inset-bottom,0px))]'}"
	role="toolbar"
	aria-label="Terminal keys"
>
	{#each row.keys as { tap, up }, index (index)}
		<FlickKey
			tap={slot(tap)}
			up={up === "nothing" ? undefined : slot(up)}
			hints={row.hints}
			onpress={(which) => keys.press(which === "tap" ? tap : up)}
		/>
	{/each}
	<ArrowPad class="flex-[1.5]" onarrow={(arrow, repeated) => keys.press(arrow, repeated)} />
	<Button
		variant="ghost"
		size="content"
		tone="secondary"
		hoverFill="none"
		icon={keys.keyboard ? "keyboard-off" : "keyboard"}
		iconSize={21}
		iconOnly
		ariaLabel="Keyboard"
		aria-pressed={keys.keyboard}
		class="h-[46px] w-[40px] shrink-0 rounded-[12px]"
		onmousedown={(event: MouseEvent) => event.preventDefault()}
		onclick={() => keys.press("keyboard")}
	/>
</div>
