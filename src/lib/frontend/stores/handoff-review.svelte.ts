import type {
	HandoffSummary,
	SessionResume,
} from "../../contracts/limit-recovery.js";
import { openSettings } from "../components/layout/chrome-actions.js";
import { getContinuationHandoffRpc } from "../transport/ws-rpc-client.js";
import type { SessionInfo } from "../types.js";
import { limitWindowName } from "../utils/continuation.js";
import { getBrowserClientId } from "./client-identity.js";
import { getInstanceById } from "./instance.svelte.js";
import { getCurrentSlug } from "./router.svelte.js";
import { showToast } from "./ui.svelte.js";

/** The read-only "What carried over?" review on screen, if any. `summary` is null when nothing has been handed over yet. */
export const handoffReview = $state<{
	review: { to: string; summary: HandoffSummary | null } | null;
}>({ review: null });

/** Opens the read-only summary of what a switch carried over, from the transcript divider or the auto-switch toast. */
export async function reviewHandoff(
	projectSlug: string,
	sessionId: string,
	resume: SessionResume,
): Promise<void> {
	try {
		const response = await getContinuationHandoffRpc({
			projectSlug,
			sessionId,
			instanceId: resume.instanceId,
			at: resume.at,
			originId: getBrowserClientId(),
		});
		handoffReview.review = {
			to: resume.instanceId,
			summary: response.handoff,
		};
	} catch {
		showToast("Couldn't load what carried over", { variant: "error" });
	}
}

/**
 * Says so when the server moved a session to another account on its own: a
 * toast for each auto-switch resume the row gained since `previous`. A first
 * sighting (cold start) is history, not news, so it stays quiet.
 */
export function followSessionResumes(
	row: SessionInfo,
	previous: SessionInfo | undefined,
): void {
	const projectSlug = getCurrentSlug();
	if (!previous || !projectSlug) return;
	const name = (id: string) => getInstanceById(id)?.name ?? id;
	for (const resume of (row.resumes ?? []).slice(
		previous.resumes?.length ?? 0,
	)) {
		if (resume.reason !== "auto-switch") continue;
		const { from } = resume;
		const limit = [row.limitRecovery, previous.limitRecovery].find(
			(recovery) => recovery && recovery.instanceId === from,
		);
		showToast({
			title: `Switched to ${name(resume.instanceId)}`,
			...(from === undefined
				? {}
				: {
						body: `${name(from)} reached its ${limitWindowName(limit?.rateLimitType)}.`,
					}),
			actions: [
				{
					kind: "primary",
					label: "What carried over?",
					run: () => void reviewHandoff(projectSlug, row.id, resume),
				},
				{
					kind: "dismiss",
					label: "Settings",
					run: () => openSettings("instances"),
				},
			],
		});
	}
}
