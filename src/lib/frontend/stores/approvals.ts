// The approvals subscription (ni8.9): the project's pending permissions and
// questions, folded into the permissions store, with an alert for each one the
// browser had not seen pending before.

import { Effect, Fiber, Stream } from "effect";
import type { RuntimeFiber } from "effect/Fiber";
import { getRuntime, runTransportEffect } from "../transport/runtime.js";
import { WsRpcClients } from "../transport/shared-client.js";
import { supervise } from "../transport/supervise.js";
import {
	applyApprovalEnvelope,
	clearAllPermissions,
	isApprovalPending,
} from "./permissions.svelte.js";
import { triggerNotifications } from "./ws-notifications.js";

// An approval answered within this window (a rule auto-approved it, or another
// tab answered first) never alerts. The cross-tab receipt makes it fire once.
const ALERT_GRACE_MS = 1_000;

let attachGeneration = 0;
let approvalsFiber: RuntimeFiber<void, unknown> | null = null;
let attachedProject: string | null = null;

async function stopApprovals(): Promise<void> {
	const fiber = approvalsFiber;
	approvalsFiber = null;
	if (fiber) await runTransportEffect(Fiber.interrupt(fiber));
}

export function attachApprovals(project: string): void {
	const generation = ++attachGeneration;
	// Another project's sequences mean nothing here.
	if (attachedProject !== project) clearAllPermissions();
	attachedProject = project;
	void stopApprovals().then(async () => {
		const runtime = await getRuntime();
		if (generation !== attachGeneration) return;
		const fiber = runtime.runFork(
			Effect.flatMap(WsRpcClients, (clients) =>
				Effect.flatMap(clients.forProject(project), ({ subscriptions }) =>
					Stream.runForEach(
						supervise(subscriptions.approvals(), () => {}),
						(change) =>
							Effect.sync(() => {
								if (generation !== attachGeneration) return;
								for (const approval of applyApprovalEnvelope(change)) {
									const id =
										approval._tag === "permission"
											? approval.requestId
											: approval.toolId;
									setTimeout(() => {
										if (
											generation === attachGeneration &&
											isApprovalPending(id)
										)
											void triggerNotifications(approval);
									}, ALERT_GRACE_MS);
								}
							}),
					),
				),
			),
		);
		if (generation === attachGeneration) approvalsFiber = fiber;
		else runtime.runFork(Fiber.interrupt(fiber));
	});
}

export function detachApprovals(): void {
	attachGeneration++;
	void stopApprovals();
	attachedProject = null;
	clearAllPermissions();
}
