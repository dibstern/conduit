// The attached project's in-app alerts, fed by its SubscribeAlerts stream: a
// session finished or failed while this tab was looking elsewhere. Push covers
// subscribed browsers (triggerNotifications stands down for them); this is the
// ding for every other one. Live-only, so a reconnect never re-fires an alert.

import { Effect, Fiber, Stream } from "effect";
import type { RuntimeFiber } from "effect/Fiber";
import { notificationContent } from "../../notification-content.js";
import { getRuntime, runTransportEffect } from "../transport/runtime.js";
import { WsRpcClients } from "../transport/shared-client.js";
import { supervise } from "../transport/supervise.js";
import type { Alert } from "../transport/ws-rpc.js";
import type { RelayMessage } from "../types.js";
import { findSession } from "./session.svelte.js";
import { showToast } from "./ui.svelte.js";
import { triggerNotifications } from "./ws-notifications.js";

export const applyAlert = (alert: Alert): void => {
	if (alert.kind === "warning") {
		if (alert.message) showToast(alert.message, { variant: "warn" });
		return;
	}
	const failed = alert.kind === "error";
	const syntheticMsg: RelayMessage = {
		type: "done",
		code: failed ? 1 : 0,
		alertId: alert.alertId,
		sessionId: alert.sessionId ?? "",
		...(failed ? { error: alert.message ?? "" } : {}),
	};

	// The server already suppresses subagent completions; this is
	// belt-and-suspenders.
	if (!failed && alert.sessionId && findSession(alert.sessionId)?.parentID)
		return;

	void triggerNotifications(syntheticMsg);

	// Toast errors only. Every "done" is synthesized from session.status idle,
	// which OpenCode can emit between tool rounds, so a toast for it would be
	// a spurious "Response complete" mid-turn.
	if (!failed) return;
	const content = notificationContent(syntheticMsg);
	if (content)
		showToast(content.title + (content.body ? ` — ${content.body}` : ""), {
			variant: "warn",
		});
};

let viewed: string | null = null;
let generation = 0;
let fiber: RuntimeFiber<void, never> | null = null;

/** Follow `project`'s alerts until the attached project moves; `null` stops. */
export function viewAlerts(project: string | null): void {
	if (viewed === project) return;
	viewed = project;
	const currentGeneration = ++generation;
	const old = fiber;
	fiber = null;
	void (old ? runTransportEffect(Fiber.interrupt(old)) : Promise.resolve())
		.catch(() => undefined)
		.then(async () => {
			if (currentGeneration !== generation || !project) return;
			const runtime = await getRuntime();
			if (currentGeneration !== generation) return;
			const next = runtime.runFork(
				Effect.flatMap(WsRpcClients, (clients) =>
					Effect.flatMap(clients.forProject(project), ({ subscriptions }) =>
						Stream.runForEach(
							supervise(
								Stream.suspend(() => subscriptions.alerts()),
								() => undefined,
							),
							(envelope) =>
								Effect.sync(() => {
									if (currentGeneration !== generation) return;
									if (envelope._tag === "alert") applyAlert(envelope);
								}),
						),
					),
				),
			);
			if (currentGeneration === generation) fiber = next;
			else runtime.runFork(Fiber.interrupt(next));
		});
}
