// Notification → Session Navigation (Replay E2E)
// Full-pipeline test: real relay + MockOpenCodeServer (no WS mock).
//
// Proves the complete path:
//   SSE event → relay event pipeline → alert on SubscribeAlerts →
//   frontend receives it → SW message → switchToSession → ViewSession RPC.
//
// Uses the `chat-simple` recording with `injectSSEEvents()` to inject
// events that trigger notification broadcasts for unwatched sessions.

import type { OpenCodeRecording } from "../fixtures/recorded/types.js";
import { loadOpenCodeRecording } from "../helpers/recorded-loader.js";
import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";

/** Extract the session ID used in prompt_async calls from a recording. */
function findTargetSessionId(recording: OpenCodeRecording): string | undefined {
	for (const ix of recording.interactions) {
		if (ix.kind === "rest" && ix.method === "POST") {
			const match = /\/session\/([^/]+)\/prompt_async/.exec(ix.path);
			if (match?.[1]) return match[1];
		}
	}
	return undefined;
}

/** True when a received RPC frame carries an error alert for `sessionId`. */
function isErrorAlertFor(frame: string, sessionId: string): boolean {
	try {
		const msg = JSON.parse(frame);
		return (
			msg._tag === "Chunk" &&
			Array.isArray(msg.values) &&
			msg.values.some(
				(value: { _tag?: string; kind?: string; sessionId?: string }) =>
					value._tag === "alert" &&
					value.kind === "error" &&
					value.sessionId === sessionId,
			)
		);
	} catch {
		return false;
	}
}

test.use({ recording: "chat-simple" });

test.describe("Notification → session navigation (replay)", () => {
	test("an alert fires for unwatched session error", async ({
		page,
		relayUrl,
		mockServer,
	}) => {
		// Capture all WS frames (received and sent) before navigating.
		const receivedFrames: string[] = [];
		const sentFrames: string[] = [];
		page.on("websocket", (ws) => {
			ws.on("framereceived", (frame) => {
				if (typeof frame.payload === "string")
					receivedFrames.push(frame.payload);
			});
			ws.on("framesent", (frame) => {
				if (typeof frame.payload === "string") sentFrames.push(frame.payload);
			});
		});

		await gotoRelay(page, relayUrl);

		// Wait for initial session data to render before injecting the event.
		await expect(
			page.locator("#session-list [data-session-id]").first(),
		).toBeVisible();
		await expect
			.poll(() =>
				mockServer.diagnostics.some(({ event }) => event === "sse_connect"),
			)
			.toBe(true);

		// Inject a session.error for an unwatched session.
		// session.error is translated by the event translator into a failed
		// { type: "done", error, ... } relay message, which is notification-worthy.
		// Since no browser client is viewing this session, the pipeline
		// drops the message and publishes an alert instead.
		const TARGET = "ses_notification_target";
		mockServer.injectSSEEvents([
			{
				type: "session.error",
				properties: {
					sessionID: TARGET,
					error: {
						name: "TestError",
						data: { message: "Simulated error for E2E test" },
					},
				},
			},
		]);

		// Wait for the alert to arrive on the SubscribeAlerts stream.
		await expect
			.poll(() => receivedFrames.some((f) => isErrorAlertFor(f, TARGET)), {
				timeout: 5000,
				message: "alert with target sessionId not received",
			})
			.toBe(true);

		// Simulate SW notification click → navigate_to_session.
		// In a real flow: push notification click → SW notificationclick →
		// SW posts navigate_to_session → frontend listener → switchToSession()
		await page.evaluate(
			({ sessionId, slug }) => {
				if ("serviceWorker" in navigator) {
					const event = new MessageEvent("message", {
						data: { type: "navigate_to_session", sessionId, slug },
					});
					navigator.serviceWorker.dispatchEvent(event);
				}
			},
			{ sessionId: TARGET, slug: "e2e-replay" },
		);

		// Wait for ViewSession to be sent over the RPC WebSocket.
		await expect
			.poll(
				() => {
					return sentFrames.some((f) => {
						try {
							const msg = JSON.parse(f);
							return (
								msg._tag === "Request" &&
								msg.tag === "ViewSession" &&
								msg.payload?.sessionId === TARGET
							);
						} catch {
							return false;
						}
					});
				},
				{
					timeout: 5000,
					message: "ViewSession RPC not sent for target session",
				},
			)
			.toBe(true);

		// Verify URL updated to include /s/<target-session-id>
		await expect(page).toHaveURL(new RegExp(`/s/${TARGET}`));
	});

	test("no alert when session HAS viewers", async ({
		page,
		relayUrl,
		mockServer,
	}) => {
		const receivedFrames: string[] = [];
		const sentFrames: string[] = [];
		page.on("websocket", (ws) => {
			ws.on("framereceived", (frame) => {
				if (typeof frame.payload === "string")
					receivedFrames.push(frame.payload);
			});
			ws.on("framesent", (frame) => {
				if (typeof frame.payload === "string") sentFrames.push(frame.payload);
			});
		});
		const parse = (frame: string): Record<string, unknown> => {
			try {
				return JSON.parse(frame);
			} catch {
				return {};
			}
		};

		await gotoRelay(page, relayUrl);
		await expect(
			page.locator("#session-list [data-session-id]").first(),
		).toBeVisible();
		await expect
			.poll(() =>
				mockServer.diagnostics.some(({ event }) => event === "sse_connect"),
			)
			.toBe(true);

		// The browser IS currently viewing this session (the target session
		// from the chat-simple recording).
		const recording = loadOpenCodeRecording("chat-simple");
		const watchedSession = findTargetSessionId(recording);
		expect(watchedSession).toBeTruthy();
		if (!watchedSession) throw new Error("expected watched session");
		const watchedId = watchedSession;

		// The tab views the session through ViewSession (197cbb7c retired
		// session_switched). Its success reply proves the relay registered the
		// viewer before the error arrives.
		await expect
			.poll(() => {
				const requestIds = sentFrames
					.map(parse)
					.filter(
						(msg) =>
							msg["tag"] === "ViewSession" &&
							(msg["payload"] as { sessionId?: unknown } | undefined)
								?.sessionId === watchedId,
					)
					.map((msg) => msg["id"]);
				return receivedFrames
					.map(parse)
					.some(
						(msg) =>
							msg["_tag"] === "Exit" &&
							requestIds.includes(msg["requestId"]) &&
							(msg["exit"] as { _tag?: unknown } | undefined)?._tag ===
								"Success",
					);
			})
			.toBe(true);

		// Clear any frames accumulated during init so we only check new ones.
		const frameCountBefore = receivedFrames.length;

		// Inject a session.error for the session the browser IS viewing.
		// Because there ARE viewers, the pipeline should send the error
		// directly to the session (not publish an alert).
		mockServer.injectSSEEvents([
			{
				type: "session.error",
				properties: {
					sessionID: watchedId,
					error: {
						name: "TestError",
						data: { message: "Error on watched session" },
					},
				},
			},
		]);

		// No notification for the watched session may arrive during this window.
		await page.waitForTimeout(1500);

		// Filter frames received AFTER injection for an error alert targeting
		// the watched session. There should be none.
		const newFrames = receivedFrames.slice(frameCountBefore);
		expect(newFrames.filter((f) => isErrorAlertFor(f, watchedId))).toEqual([]);
	});
});
