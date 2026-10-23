<script lang="ts">
	import type { Snippet } from "svelte";
	import type { HTMLAttributes } from "svelte/elements";

	let {
		leading,
		field,
		controls,
		send,
		splitFooter = false,
		singleRow = false,
		class: className,
		...rest
	}: {
		leading: Snippet;
		field: Snippet;
		controls: Snippet;
		send: Snippet;
		splitFooter?: boolean | undefined;
		singleRow?: boolean | undefined;
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
			let footerStart = 0;
			let footerEnd = 0;
			if (element.hasAttribute("data-phone-icons")) {
				const leading = element.querySelector<HTMLElement>('[data-slot="leading"]');
				const send = element.querySelector<HTMLElement>('[data-slot="send"]');
				const model = element.querySelector<HTMLElement>(".model-btn");
				const effort = element.querySelector<HTMLElement>('[data-testid="variant-badge"]');
				const permission = element.querySelector<HTMLElement>('[data-testid="permission-mode-badge"]');
				const checkout = element.querySelector<HTMLElement>(".git-pill.compact");
				if (leading && send && model) {
					const effortWidth = effort?.getBoundingClientRect().width ?? 0;
					const fixedWidth = effortWidth + (permission?.getBoundingClientRect().width ?? 0);
					const available = element.clientWidth - leading.offsetWidth - send.offsetWidth - Number.parseFloat(getComputedStyle(send).marginLeft) - 2 * Number.parseFloat(getComputedStyle(element).columnGap);
					// These budgets never include space recovered by hiding a label.
					// Otherwise checkout collapsing would make the model name reappear.
					const checkoutWidth = checkout ? 90 : 0;
					const fit = available >= fixedWidth + checkoutWidth + 58 ? "labels"
						: available >= fixedWidth + checkoutWidth + 44 ? "model-logo"
						: checkout && available >= fixedWidth + 88 ? "checkout-icon" : "checkout-hidden";
					element.dataset["footerFit"] = fit;
					element.style.setProperty("--composer-model-minimum", `${44 + effortWidth}px`);
					const composer = element.closest<HTMLElement>("#input-area");
					if (fit === "checkout-hidden" && element.parentElement && composer && composer.clientWidth < 393) {
						const shortage = Math.min(14, Math.max(0, fixedWidth + 44 - available));
						const frame = getComputedStyle(element.parentElement);
						footerStart = Math.min(shortage, Math.max(0, Number.parseFloat(frame.paddingInlineStart) - 4));
						footerEnd = Math.min(shortage - footerStart, Math.max(0, Number.parseFloat(frame.paddingInlineEnd) - 4));
					}
				}
			} else {
				delete element.dataset["footerFit"];
				element.style.removeProperty("--composer-model-minimum");
			}
			for (const [property, loan] of [["--composer-footer-start", footerStart], ["--composer-footer-end", footerEnd]] as const) {
				if (loan > 0) element.style.setProperty(property, `${loan}px`);
				else element.style.removeProperty(property);
			}
			if (footerStart + footerEnd > 0) element.dataset["footerGutter"] = "borrowed";
			else delete element.dataset["footerGutter"];

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

			// Auto layout decides at the collapsed width; a split footer always
			// gives the field the full width. Both writes happen before paint.
			element.dataset["rows"] = splitFooter ? "2" : "1";
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
			element.dataset["rows"] = splitFooter || (!singleRow && probe.scrollHeight > lineHeight + 1) ? "2" : "1";

			// A placeholder longer than even the full-width field must grow too.
			// The field can use this inherited minimum height with an absolute editor.
			if (!textarea.value && textarea.placeholder) {
				probe.style.width = `${Math.max(0, textarea.clientWidth - horizontalPadding)}px`;
				probe.style.whiteSpace = "pre-wrap";
				element.style.setProperty("--composer-placeholder-height", `${probe.getBoundingClientRect().height + verticalPadding}px`);
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

<div {...rest} bind:this={root} class="composer-layout {className ?? ''}" class:split-footer={splitFooter} data-rows={splitFooter ? "2" : "1"}>
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

	[data-rows="1"] {
		align-items: center;
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

	.split-footer[data-rows="2"] {
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		column-gap: 2px;
		row-gap: 0;
	}

	.split-footer > [data-slot="controls"] {
		margin-left: 0;
		width: 100%;
	}

	.split-footer > [data-slot="send"] {
		margin-left: 6px;
		justify-content: flex-end;
		gap: 2px;
	}

	/* Reserve the hit areas in layout so adjacent phone controls cannot steal taps. */
	.split-footer[data-phone-icons] { column-gap: 1px; }
	[data-phone-icons] > [data-slot="leading"],
	[data-phone-icons] > [data-slot="controls"],
	[data-phone-icons] > [data-slot="send"] { min-height: 44px; display: flex; align-items: center; }
	[data-phone-icons] > [data-slot="leading"] { min-width: 44px; margin-inline-start: calc(-1 * var(--composer-footer-start, 0px)); }
	[data-footer-gutter="borrowed"] > [data-slot="leading"] { justify-content: center; }
	[data-phone-icons] > [data-slot="send"] { min-width: 44px; margin-inline-end: calc(-1 * var(--composer-footer-end, 0px)); }
	[data-phone-icons] :global(#input-bottom-right),
	[data-phone-icons] :global(#model-display) { gap: 0; }
	[data-phone-icons] :global(#model-display) { flex: 0 1 auto; min-width: var(--composer-model-minimum, 44px); }
	[data-phone-icons] :global(.model-btn),
	[data-phone-icons] :global([data-testid="variant-badge"]),
	[data-phone-icons] :global([data-testid="permission-mode-badge"]),
	[data-phone-icons] :global([data-testid="composer-checkout"]) {
		min-width: 44px;
		padding-inline: 4px;
		justify-content: center;
	}
	[data-phone-icons] :global(.model-btn) { gap: 0; }
	[data-phone-icons] :global(.git-pill.compact) { min-width: 44px; }
	[data-phone-icons] :global(button::before) { display: block; }
	[data-phone-icons]:not([data-footer-fit="labels"]) :global(.model-btn) { width: 44px; flex: none; }
	[data-phone-icons]:not([data-footer-fit="labels"]) :global(.model-label),
	[data-phone-icons]:not([data-footer-fit="labels"]) :global([data-testid="model-chip-chevron"]),
	[data-phone-icons]:not([data-footer-fit="labels"]) :global([data-testid="picker-selected-context"]) { display: none; }
	[data-footer-fit="checkout-icon"] { --composer-checkout-width: 44px; }
	[data-footer-fit="checkout-hidden"] :global(.git-pill.compact) { display: none; }

	/* Centre the font's x-height on the icons, rather than its line box.
	   Geist and Geist Mono have different baseline-to-x-height offsets. */
	.split-footer :global(.model-label),
	.split-footer :global([data-testid="composer-effort-label"]) {
		translate: 0 -0.8px;
	}

	.split-footer :global([data-testid="picker-selected-context"]),
	.split-footer :global([data-testid="composer-checkout"] [data-part="project"]),
	.split-footer :global([data-testid="composer-checkout"] [data-part="branch"]),
	.split-footer :global([data-testid="composer-checkout"] span[aria-hidden="true"]:not(:has(svg))) {
		translate: 0 -0.6px;
	}
	/* An empty controls slot leaves the grid, so send sits beside the field. */
	.composer-layout:has(> [data-slot="controls"]:empty) {
		grid-template-columns: auto minmax(0, 1fr) auto;
	}
	[data-slot="controls"]:empty {
		display: none;
	}

	[data-slot="field"] :global(textarea:placeholder-shown) {
		min-height: var(--composer-placeholder-height, 0px);
	}
</style>
