<!-- Swaps its text with the "Drip" motion: old letters fall away while new ones drop in and squash. -->
<script lang="ts">
	import { untrack } from "svelte";
	import { MediaQuery } from "svelte/reactivity";

	let { text }: { text: string } = $props();

	let box: HTMLSpanElement;
	let current: HTMLSpanElement | undefined;
	const reduced = new MediaQuery("(prefers-reduced-motion: reduce)");
	const rand = (min: number, max: number) => min + Math.random() * (max - min);

	// Each letter takes its own stop on the success-to-accent gradient, so letters can move independently.
	function spell(word: string): HTMLSpanElement {
		const layer = document.createElement("span");
		layer.className = "layer";
		const letters = [...word];
		for (const [i, letter] of letters.entries()) {
			const span = document.createElement("span");
			span.className = "letter";
			span.textContent = letter;
			span.style.color = `color-mix(in oklab, var(--color-success), var(--color-accent) ${Math.round((100 * i) / Math.max(1, letters.length - 1))}%)`;
			layer.append(span);
		}
		return layer;
	}

	$effect(() => {
		const next = spell(text);
		const leaving = current;
		current = next;
		box.append(next);
		if (!leaving || untrack(() => reduced.current)) {
			leaving?.remove();
			return;
		}
		// The leaving word goes absolute so the box takes the new word's width straight away.
		leaving.classList.add("leaving");
		const out = [...leaving.children].map((letter) => {
			const delay = rand(0, 200);
			letter.animate(
				[{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(16px) scaleY(1.3)" }],
				{ duration: 380, delay, fill: "forwards", easing: "cubic-bezier(.55, 0, 1, .45)" },
			);
			return delay + 380;
		});
		for (const [i, letter] of [...next.children].entries()) {
			letter.animate(
				[
					{ opacity: 0, transform: "translateY(-18px) scaleY(1.3)" },
					{ opacity: 1, transform: "translateY(1px) scale(1.12, .82)", offset: 0.55, easing: "ease-out" },
					{ opacity: 1, transform: "none" },
				],
				{ duration: 520, delay: 160 + i * 28 + rand(0, 70), fill: "both", easing: "cubic-bezier(.5, 0, .8, .6)" },
			);
		}
		setTimeout(() => leaving.remove(), Math.max(0, ...out) + 50);
	});
</script>

<span class="drip" bind:this={box} aria-hidden="true"></span>

<style>
	.drip { position: relative; display: inline-block; line-height: 1.4em; }
	.drip :global(.layer) { white-space: pre; }
	.drip :global(.layer.leaving) { position: absolute; left: 50%; top: 0; translate: -50% 0; }
	.drip :global(.letter) { display: inline-block; white-space: pre; }
</style>
