import { confirm, uiState } from "../../stores/ui.svelte.js";
import {
	type DeleteSessionRpcInput,
	getWorktreeCleanupSettingRpc,
	rpc,
} from "../../transport/ws-rpc-client.js";

let pending = false;

/** Single and bulk deletion use the same inspection and worktree choice. */
export async function confirmSessionDeletion(
	targets: readonly DeleteSessionRpcInput[],
	text: string,
	returnFocus?: () => HTMLElement | null,
): Promise<readonly DeleteSessionRpcInput[] | null> {
	if (pending) return null;
	pending = true;
	try {
		const [inspections, removeOnDelete] = await Promise.all([
			Promise.all(
				targets.map((target) => rpc("InspectSessionWorktrees", target)),
			),
			getWorktreeCleanupSettingRpc().then(
				(setting) => setting.onDelete,
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
