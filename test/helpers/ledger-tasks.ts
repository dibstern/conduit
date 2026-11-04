import type { SessionActivity } from "../../src/lib/domain/daemon/Services/session-activity.js";
import type { BackgroundTaskTransition } from "../../src/lib/session/background-liveness.js";

/**
 * Publishes what the Run Ledger's arm would after folding this Claude transition: a snapshot's
 * tasks as the live view (kind and class as the decider names them, 8.2), an end as none.
 */
export const publishLedgerTasks = (
	background: SessionActivity["background"],
	transition: BackgroundTaskTransition,
	at = Date.now(),
): boolean => {
	const tasks = transition.kind === "snapshot" ? transition.tasks : [];
	const snapshot = tasks.map(({ id, type, ...display }) => ({
		key: { taskId: id },
		taskType: type,
		ambient: false,
		...display,
	}));
	return background.publish(
		transition.sessionId,
		tasks.length === 0
			? { tag: "none" }
			: {
					tag: "live",
					label: `${transition.sessionId}-runner:1`,
					tasks: snapshot.map(({ key, taskType, description, ambient }) => ({
						key,
						taskType,
						description,
						ambient,
						kind:
							{
								local_bash: "shell",
								local_agent: "subagent",
								local_workflow: "workflow",
							}[taskType] ?? taskType,
						class: taskType === "monitor" ? "monitoring" : "work",
					})),
				},
		{ tasks: snapshot, at },
	);
};
