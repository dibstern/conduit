import type * as Pele from "pele/lazy";

let pele: Promise<typeof Pele> | undefined;

/** The only place pele is downloaded. A failed download is forgotten, so the next call tries again. */
export function loadPele(): Promise<typeof Pele> {
	return (pele ??= import("pele/lazy").catch((error: unknown) => {
		pele = undefined;
		throw error;
	}));
}
