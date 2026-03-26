// ─── Notification → Session Navigation (Replay E2E) ─────────────────────────
// Full-pipeline test: real relay + MockOpenCodeServer (no WS mock).
//
// Proves the complete path:
//   SSE event → relay event pipeline → notification_event WS broadcast →
//   frontend receives it → SW message → switchToSession → view_session WS.
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

test.use({ recording: "chat-simple" });

test.describe("Notification → session navigation (replay)", () => {
	test("notification_event fires for unwatched session error", async ({
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

		// Wait for relay SSE connection to stabilize and initial session
		// data to be loaded into the frontend.
		await page.waitForTimeout(500);

		// Inject a session.error for an unwatched session.
		// session.error is translated by the event translator into an
		// { type: "error", ... } relay message, which is notification-worthy.
		// Since no browser client is viewing this session, the pipeline
		// drops the message and broadcasts a notification_event instead.
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

		// Wait for notification_event to arrive via WS.
		await expect
			.poll(
				() => {
					return receivedFrames.some((f) => {
						try {
							const msg = JSON.parse(f);
							return (
								msg.type === "notification_event" && msg.sessionId === TARGET
							);
						} catch {
							return false;
						}
					});
				},
				{
					timeout: 5000,
					message: "notification_event with target sessionId not received",
				},
			)
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

		// Wait for view_session to be sent via WS.
		await expect
			.poll(
				() => {
					return sentFrames.some((f) => {
						try {
							const msg = JSON.parse(f);
							return msg.type === "view_session" && msg.sessionId === TARGET;
						} catch {
							return false;
						}
					});
				},
				{
					timeout: 5000,
					message: "view_session not sent for target session",
				},
			)
			.toBe(true);

		// Verify URL updated to include /s/<target-session-id>
		await expect(page).toHaveURL(new RegExp(`/s/${TARGET}`));
	});

	test("no notification_event when session HAS viewers", async ({
		page,
		relayUrl,
		mockServer,
	}) => {
		const receivedFrames: string[] = [];
		page.on("websocket", (ws) => {
			ws.on("framereceived", (frame) => {
				if (typeof frame.payload === "string")
					receivedFrames.push(frame.payload);
			});
		});

		await gotoRelay(page, relayUrl);
		await page.waitForTimeout(500);

		// The browser IS currently viewing this session (the target session
		// from the chat-simple recording).
		const recording = loadOpenCodeRecording("chat-simple");
		const watchedSession = findTargetSessionId(recording);
		expect(watchedSession).toBeTruthy();
		// biome-ignore lint/style/noNonNullAssertion: guarded by expect above
		const watchedId = watchedSession!;

		// Clear any frames accumulated during init so we only check new ones.
		const frameCountBefore = receivedFrames.length;

		// Inject a session.error for the session the browser IS viewing.
		// Because there ARE viewers, the pipeline should send the error
		// directly to the session (not broadcast notification_event).
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

		// Wait a reasonable time for any WS messages to arrive.
		await page.waitForTimeout(1500);

		// Filter frames received AFTER injection for notification_event
		// targeting the watched session. There should be none.
		const newFrames = receivedFrames.slice(frameCountBefore);
		const notifEvents = newFrames.filter((f) => {
			try {
				const msg = JSON.parse(f);
				return msg.type === "notification_event" && msg.sessionId === watchedId;
			} catch {
				return false;
			}
		});
		expect(notifEvents).toHaveLength(0);
	});
});
