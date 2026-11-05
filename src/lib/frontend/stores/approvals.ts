// The approvals subscription (ni8.9): every project's pending permissions and
// questions, folded into the permissions store. A tab follows them for its
// lifetime, whatever project it shows (82tn.13). The ding for a new ask comes
// from the daemon's alert feed, which covers every project (82tn.12).

import { Effect, Fiber, Stream } from "effect";
import { getRuntime, runTransportEffect } from "../transport/runtime.js";
import { WsRpcClients } from "../transport/shared-client.js";
import { supervise } from "../transport/supervise.js";
import {
	applyApprovalEnvelope,
	clearAllPermissions,
} from "./permissions.svelte.js";

/** Follow every project's asks until the returned stop is called. */
export function followApprovals(): () => void {
	let live = true;
	let fiber: Fiber.Fiber<void, unknown> | null = null;
	void getRuntime().then((runtime) => {
		if (!live) return;
		fiber = runtime.runFork(
			Effect.flatMap(WsRpcClients, (clients) =>
				Effect.flatMap(clients.forProject(""), ({ subscriptions }) =>
					Stream.runForEach(
						supervise(subscriptions.approvals(), () => {}),
						(change) => Effect.sync(() => applyApprovalEnvelope(change)),
					),
				),
			),
		);
	});
	return () => {
		live = false;
		if (fiber) void runTransportEffect(Fiber.interrupt(fiber));
		clearAllPermissions();
	};
}
