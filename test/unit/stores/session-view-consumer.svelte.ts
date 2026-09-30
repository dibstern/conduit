import { findSession } from "../../../src/lib/frontend/stores/session.svelte.js";

export function observeSessionTitle(
	id: string,
	observe: (title: string | undefined) => void,
): () => void {
	return $effect.root(() => {
		$effect(() => observe(findSession(id)?.title));
	});
}
