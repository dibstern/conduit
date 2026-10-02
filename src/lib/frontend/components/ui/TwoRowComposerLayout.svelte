<script lang="ts">
	import type { Snippet } from "svelte";
	import type { HTMLAttributes } from "svelte/elements";

	let {
		leading,
		field,
		controls,
		send,
		class: className,
		...rest
	}: {
		leading: Snippet;
		field: Snippet;
		controls: Snippet;
		send: Snippet;
		class?: string | undefined;
	} & Omit<HTMLAttributes<HTMLDivElement>, "children" | "class"> = $props();

	let root: HTMLDivElement | undefined = $state();

	$effect(() => {
		if (!root) return;
		const element = root;
		const slots = element.querySelectorAll<HTMLElement>(":scope > [data-slot]");
		const probe = document.createElement("div");
		probe.setAttribute("aria-hidden", "true");
		probe.style.cssText = "position:absolute;top:0;left:0;visibility:hidden;pointer-events:none;overflow:hidden;box-sizing:content-box;padding:0;border:0;height:auto;min-height:0;";
		element.append(probe);
		let queued = false;
		let disposed = false;
		const valueHooks = new Map<HTMLTextAreaElement, PropertyDescriptor | undefined>();

		function schedule() {
			if (queued || disposed) return;
			queued = true;
			queueMicrotask(() => {
				queued = false;
				if (!disposed) measure();
			});
		}

		function measure() {
			const textarea = element.querySelector<HTMLTextAreaElement>('[data-slot="field"] textarea');
			if (!textarea || !element.clientWidth) return;

			// Bound drafts can change without an input event or a DOM mutation.
			// Observe this instance's native value setter, and restore it on teardown.
			if (!valueHooks.has(textarea)) {
				const own = Object.getOwnPropertyDescriptor(textarea, "value");
				const descriptor = own ?? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
				if (descriptor?.get && descriptor.set) {
					valueHooks.set(textarea, own);
					Object.defineProperty(textarea, "value", {
						configurable: true,
						get: () => descriptor.get?.call(textarea),
						set: (value: string) => {
							descriptor.set?.call(textarea, value);
							schedule();
						},
					});
				}
			}

			// Always decide at the collapsed width. Both DOM writes happen before
			// paint, so a draft that fits at full width cannot toggle the layout back.
			element.dataset["rows"] = "1";
			const style = getComputedStyle(textarea);
			probe.style.font = style.font;
			probe.style.fontFeatureSettings = style.fontFeatureSettings;
			probe.style.fontVariationSettings = style.fontVariationSettings;
			probe.style.fontKerning = style.fontKerning;
			probe.style.lineHeight = style.lineHeight;
			probe.style.letterSpacing = style.letterSpacing;
			probe.style.wordSpacing = style.wordSpacing;
			probe.style.tabSize = style.tabSize;
			probe.style.textIndent = style.textIndent;
			probe.style.textTransform = style.textTransform;
			probe.style.direction = style.direction;
			probe.style.lineBreak = style.lineBreak;
			probe.style.wordBreak = style.wordBreak;
			probe.style.overflowWrap = style.overflowWrap;
			const horizontalPadding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
			const verticalPadding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
			probe.style.width = `${Math.max(0, textarea.clientWidth - horizontalPadding)}px`;
			// Placeholder and draft alike: let the probe wrap and count lines.
			// Comparing widths instead misses sub-pixel overflow, because
			// scrollWidth rounds (79.2px of text reads as fitting in 79px) while
			// the textarea still wraps it.
			probe.style.whiteSpace = "pre-wrap";
			probe.textContent = "\u200b";
			const lineHeight = probe.scrollHeight;
			probe.textContent = textarea.value ? `${textarea.value}\u200b` : textarea.placeholder;
			element.dataset["rows"] = probe.scrollHeight > lineHeight + 1 ? "2" : "1";

			// A placeholder longer than even the full-width field must grow too.
			// The field can use this inherited minimum height with an absolute editor.
			if (!textarea.value && textarea.placeholder) {
				probe.style.width = `${Math.max(0, textarea.clientWidth - horizontalPadding)}px`;
				probe.style.whiteSpace = "pre-wrap";
				element.style.setProperty("--composer-placeholder-height", `${probe.scrollHeight + verticalPadding}px`);
			} else {
				element.style.removeProperty("--composer-placeholder-height");
			}
		}

		const mutations = new MutationObserver(schedule);
		const resize = new ResizeObserver(schedule);
		resize.observe(element);
		for (const slot of slots) {
			mutations.observe(slot, { subtree: true, childList: true, characterData: true, attributes: true });
			resize.observe(slot);
		}
		element.addEventListener("input", schedule);
		element.addEventListener("change", schedule);
		document.fonts.addEventListener("loadingdone", schedule);
		measure();

		return () => {
			disposed = true;
			mutations.disconnect();
			resize.disconnect();
			element.removeEventListener("input", schedule);
			element.removeEventListener("change", schedule);
			document.fonts.removeEventListener("loadingdone", schedule);
			for (const [textarea, descriptor] of valueHooks) {
				if (descriptor) Object.defineProperty(textarea, "value", descriptor);
				else Reflect.deleteProperty(textarea, "value");
			}
			probe.remove();
		};
	});
</script>

<div {...rest} bind:this={root} class="composer-layout {className ?? ''}" data-rows="1">
	<div data-slot="leading">{@render leading()}</div>
	<div data-slot="field">{@render field()}</div>
	<div data-slot="controls">{@render controls()}</div>
	<div data-slot="send">{@render send()}</div>
</div>

<style>
	.composer-layout {
		position: relative;
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto auto;
		align-items: end;
		gap: 4px;
		min-width: 0;
	}

	[data-slot] {
		min-width: 0;
	}

	[data-slot="field"] {
		min-height: var(--composer-placeholder-height, 0px);
	}

	[data-slot="send"] {
		display: flex;
		align-items: center;
		gap: 4px;
	}

	[data-rows="2"] {
		grid-template-columns: auto minmax(0, 1fr) auto;
	}

	[data-rows="2"] > [data-slot="field"] {
		grid-column: 1 / -1;
		grid-row: 1;
	}

	[data-rows="2"] > [data-slot="leading"] {
		grid-column: 1;
		grid-row: 2;
	}

	[data-rows="2"] > [data-slot="controls"] {
		grid-column: 2;
		grid-row: 2;
		max-width: 100%;
		margin-left: auto;
	}

	[data-rows="2"] > [data-slot="send"] {
		grid-column: 3;
		grid-row: 2;
	}

	[data-slot="field"] :global(textarea:placeholder-shown) {
		min-height: var(--composer-placeholder-height, 0px);
	}
</style>
