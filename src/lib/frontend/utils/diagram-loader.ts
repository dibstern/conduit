import type * as Pele from "pele/lazy";

let pele: Promise<typeof Pele> | undefined;

/** The only place pele is downloaded. A failed download is forgotten, so the next call tries again. */
export function loadPele(): Promise<typeof Pele> {
	return (pele ??= import("pele/lazy").catch((error: unknown) => {
		pele = undefined;
		throw error;
	}));
}

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
