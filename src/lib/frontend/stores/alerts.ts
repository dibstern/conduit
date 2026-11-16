// Every project's in-app alerts, read through the attached project's
// SubscribeAlerts stream: a session finished or failed while this tab was
// looking elsewhere, or asks for an approval or an answer. Push covers
// subscribed browsers (triggerNotifications stands down for them); this is the
// ding for every other one. Live-only, so a reconnect never re-fires an alert.

import { Effect, Fiber, Stream } from "effect";
import { notificationContent } from "../../notification-content.js";
import type { PermissionId } from "../../shared-types.js";
import { getRuntime, runTransportEffect } from "../transport/runtime.js";
import { WsRpcClients } from "../transport/shared-client.js";
import { supervise } from "../transport/supervise.js";
import type { Alert } from "../transport/ws-rpc.js";
import type { BrowserMessage } from "../types.js";
import { findSession } from "./session.svelte.js";
import { showToast } from "./ui.svelte.js";
import { triggerNotifications } from "./ws-notifications.js";

export const applyAlert = (alert: Alert): void => {
	if (alert.kind === "warning") {
		if (alert.message) showToast(alert.message, { variant: "warn" });
		return;
	}
	if (alert.kind === "permission" || alert.kind === "question") {
		const sessionId = alert.sessionId ?? "";
		void triggerNotifications(
			alert.kind === "permission"
				? {
						_tag: "permission",
						sessionId,
						requestId: alert.alertId as PermissionId,
						toolName: alert.message ?? "",
						toolInput: {},
					}
				: { _tag: "question", sessionId, toolId: alert.alertId, questions: [] },
		);
		return;
	}
	const failed = alert.kind === "error";
	const syntheticMsg: BrowserMessage = {
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
		showToast({
			title: content.title,
			...(content.body ? { body: content.body } : {}),
			variant: "warn",
		});
};

/** Follow every project's alerts until the returned stop is called. */
export function followAlerts(): () => void {
	let live = true;
	let fiber: Fiber.Fiber<void, never> | null = null;
	void getRuntime().then((runtime) => {
		if (!live) return;
		fiber = runtime.runFork(
			Effect.flatMap(WsRpcClients, (clients) =>
				Effect.flatMap(clients.forProject(""), ({ subscriptions }) =>
					Stream.runForEach(
						supervise(
							Stream.suspend(() => subscriptions.alerts()),
							() => undefined,
						),
						(envelope) =>
							Effect.sync(() => {
								if (envelope._tag === "alert") applyAlert(envelope);
							}),
					),
				),
			),
		);
	});
	return () => {
		live = false;
		if (fiber)
			void runTransportEffect(Fiber.interrupt(fiber)).catch(() => undefined);
	};
}
