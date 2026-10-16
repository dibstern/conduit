import { confirm, uiState } from "../../stores/ui.svelte.js";
import { rpc } from "../../transport/ws-rpc-client.js";

let pending = false;

/** Single and bulk deletion use the same inspection and worktree choice. */
export async function confirmSessionDeletion(
	targets: readonly Omit<Parameters<typeof rpc<"DeleteSession">>[1], "_tag">[],
	text: string,
	returnFocus?: () => HTMLElement | null,
): Promise<
	readonly Omit<Parameters<typeof rpc<"DeleteSession">>[1], "_tag">[] | null
> {
	if (pending) return null;
	pending = true;
	try {
		const [inspections, removeOnDelete] = await Promise.all([
			Promise.all(
				targets.map((target) => rpc("InspectSessionWorktrees", target)),
			),
			rpc("GetWorktreeCleanupSetting", {}).then(
				({ worktreeCleanup }) => worktreeCleanup.onDelete,
				() => false,
			),
		]);
		const worktrees = inspections.flatMap((inspection) => inspection.worktrees);
		// Another action may have opened a dialog while inspection was in flight.
		if (uiState.confirmDialog) return null;
		// Removal still keeps worktrees in use or with uncommitted changes.
		let removeWorktrees =
			!removeOnDelete &&
			inspections
				.filter((inspection) => inspection.worktrees.length > 0)
				.every((inspection) => inspection.removeWorktrees);
		const confirmed = await confirm(
			text,
			"Delete",
			returnFocus,
			!removeOnDelete && worktrees.length > 0
				? {
						worktrees,
						removeWorktrees,
						onchange: (remove) => {
							removeWorktrees = remove;
						},
					}
				: undefined,
		);
		if (!confirmed) return null;
		return targets.map((target, index) => ({
			...target,
			...(inspections[index]?.worktrees.length ? { removeWorktrees } : {}),
		}));
	} finally {
		pending = false;
	}
}
