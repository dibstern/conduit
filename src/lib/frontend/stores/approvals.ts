// The approvals subscription (ni8.9): the project's pending permissions and
// questions, folded into the permissions store. The ding for a new ask comes
// from the daemon's alert feed, which covers every project (82tn.12).

import { Effect, Fiber, Stream } from "effect";
import { getRuntime, runTransportEffect } from "../transport/runtime.js";
import { WsRpcClients } from "../transport/shared-client.js";
import { supervise } from "../transport/supervise.js";
import {
	applyApprovalEnvelope,
	clearAllPermissions,
} from "./permissions.svelte.js";

let attachGeneration = 0;
let approvalsFiber: Fiber.Fiber<void, unknown> | null = null;
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
								if (generation === attachGeneration)
									applyApprovalEnvelope(change);
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
