import type { SessionActivity } from "../../src/lib/domain/daemon/Services/session-activity.js";
import type { BackgroundTaskTransition } from "../../src/lib/provider/claude/claude-event-translator.js";
import {
	type ActivityOf,
	deriveSessionActivity,
} from "../../src/lib/session/session-activity-view.js";

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

/** Publishes what the arm would for a session whose user turn is running: an active input Run. */
export const publishRun = (
	background: SessionActivity["background"],
	sessionId: string,
): boolean =>
	background.publish(sessionId, { tag: "none" }, undefined, {
		active: {
			runId: `${sessionId}-run`,
			inputs: [],
			origin: "input",
			tag: "Running",
		},
	});

/**
 * What SessionActivity answers (82tn.32.30) when `running` sessions have an active Run and each
 * `background` session has live tasks of that class: rows and roll-ups read this, never row status.
 */
export const activityFrom =
	({
		running = [],
		background = {},
	}: {
		readonly running?: readonly string[];
		readonly background?: Readonly<Record<string, "work" | "monitoring">>;
	}): ActivityOf =>
	(sessionId, prompts) => {
		const cls = background[sessionId];
		return deriveSessionActivity({
			...(running.includes(sessionId) ? { run: { origin: "input" } } : {}),
			tasks: cls
				? {
						tag: "live",
						label: `${sessionId}-runner:1`,
						tasks: [
							{
								key: { taskId: `${sessionId}-task` },
								taskType: "local_bash",
								description: "task",
								ambient: false,
								kind: "shell",
								class: cls,
							},
						],
					}
				: { tag: "none" },
			servers: [],
			prompts,
		});
	};
