import type { MathResolver, Mounted } from "pele/lazy";

/** Caches a download as a promise. A failed one is forgotten, so the next call tries again. */
function cached<T>(download: () => Promise<T>): () => Promise<T> {
	let pending: Promise<T> | undefined;
	return () =>
		(pending ??= download().catch((error: unknown) => {
			pending = undefined;
			throw error;
		}));
}

/** The only place pele is downloaded. */
export const loadPele = cached(() => import("pele/lazy"));

/** The only place KaTeX is downloaded; only diagrams whose source contains $$ ask for it. */
export const loadMath = cached(async (): Promise<MathResolver> => {
	const [{ default: katex }] = await Promise.all([
		import("katex"),
		import("katex/dist/katex.min.css"),
	]);
	// Lays the maths out as pele's label box does: a flex box at the label's font size.
	// Measuring starts KaTeX's font downloads; pele redraws once fonts still loading after a drawing arrive.
	const probe = document.createElement("div");
	probe.ariaHidden = "true";
	probe.style.cssText =
		"position:absolute;left:0;top:0;visibility:hidden;display:flex;line-height:normal;white-space:nowrap";
	document.body.append(probe);
	return (tex, size) => {
		try {
			// Display mode, as mermaid typesets $$: limits sit above and below a summation.
			probe.innerHTML = katex.renderToString(tex, {
				throwOnError: true,
				displayMode: true,
			});
		} catch {
			// This expression stays as its source; the rest of the diagram still renders.
			return null;
		}
		// The display wrapper only adds block margins; the label box centres the maths itself.
		const maths = probe.querySelector(".katex");
		if (!maths) return null;
		probe.replaceChildren(maths);
		probe.style.fontSize = `${size}px`;
		const { width, height } = maths.getBoundingClientRect();
		return { html: maths.outerHTML, width, height };
	};
});

let wake = (): void => {};
let retried = new Promise<void>((resolve) => (wake = resolve));

/** Wakes every diagram waiting in nextRetry(); each tries its download once more. */
export function retry(): void {
	wake();
	retried = new Promise((resolve) => (wake = resolve));
}

/** Settles at the next retry(). Only failed diagrams wait on it, so drawn ones are never remounted. */
export function nextRetry(): Promise<void> {
	return retried;
}

/** Resets a zoomed drawing. False at its fit, so the caller's Escape can close the viewer instead. */
export function resetIfZoomed(zoom: Mounted["zoom"]): boolean {
	if (!zoom || zoom.scale === zoom.fit) return false;
	zoom.reset();
	return true;
}
