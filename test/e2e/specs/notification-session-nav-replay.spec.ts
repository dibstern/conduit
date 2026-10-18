// Notification → Session Navigation (Replay E2E)
// Real relay alert delivery and notification clicks over the typed RPC mock.
//
// Proves the complete path:
//   SSE event → relay event pipeline → alert on SubscribeAlerts →
//   frontend receives it → SW message → selection.open → ViewSession RPC.
//
// Uses the `chat-simple` recording with `injectSSEEvents()` to inject
// events that trigger notification broadcasts for unwatched sessions.

import type { OpenCodeRecording } from "../fixtures/recorded/types.js";
import { createSession } from "../helpers/e2e-harness.js";
import { loadOpenCodeRecording } from "../helpers/recorded-loader.js";
import { expect, gotoRelay, test } from "../helpers/replay-fixture.js";
import { mockWsRpc } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

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
	for (const project of ["e2e-replay", "another-project"]) {
		test(`a service worker notification for ${project} opens its session without URL navigation`, async ({
			page,
			harness,
		}, testInfo) => {
			const parent = "notification-parent";
			const target = "notification-target";
			const rpc = await mockWsRpc(page, {
				stubs: {
					AttachProject: (payload) => ({
						projectSlug:
							"projectSlug" in payload
								? (payload.projectSlug ?? "e2e-replay")
								: "e2e-replay",
						sessionSlug: "sessionId" in payload ? "e2e-replay" : null,
					}),
					ResolveSession: () => ({ projectSlug: project }),
					ViewSession: ({ sessionId }) => ({
						ok: true,
						draft: `Shown ${sessionId}`,
					}),
				},
			});
			await mockRelayWebSocket(page, {
				initMessages: [
					{
						type: "project_list",
						projects: ["e2e-replay", "another-project"].map((slug) => ({
							slug,
							title: slug,
							folders: [`/tmp/${slug}`],
						})),
						current: "e2e-replay",
					},
					{
						type: "shell_snapshot",
						roots: true,
						sessions: [
							{
								id: parent,
								title: "Parent",
								status: "idle",
								updatedAt: Date.now(),
							},
						],
					},
				],
				responses: new Map(),
			});
			await page.goto(`${harness.relayBaseUrl}/s/${parent}`);
			await expect(page.locator("#input")).toHaveValue(`Shown ${parent}`);
			const documentNavigations: string[] = [];
			page.on("request", (request) => {
				if (request.resourceType() === "document")
					documentNavigations.push(request.url());
			});
			await page.evaluate(
				({ sessionId, slug }) => {
					navigator.serviceWorker.dispatchEvent(
						new MessageEvent("message", {
							data: {
								type: "navigate_to_session",
								sessionId,
								slug,
								url: "/?notification-url-must-not-be-used",
							},
						}),
					);
				},
				{ sessionId: target, slug: project },
			);
			await expect(page).toHaveURL(`${harness.relayBaseUrl}/s/${target}`);
			await expect(page.locator("#input")).toHaveValue(`Shown ${target}`);
			const viewed = rpc
				.getRequests()
				.filter(
					(request) =>
						request.tag === "ViewSession" &&
						request.payload["sessionId"] === target,
				);
			expect(viewed).toHaveLength(1);
			expect(documentNavigations).toEqual([]);
			await page.goBack();
			await expect(page).toHaveURL(`${harness.relayBaseUrl}/s/${parent}`);
			await testInfo.attach("notification-back-to-parent", {
				body: await page.screenshot(),
				contentType: "image/png",
			});
		});
	}

	test("an in-project browser notification click opens the notified session", async ({
		page,
		harness,
	}, testInfo) => {
		await page.addInitScript(() => {
			class TestNotification {
				static permission = "granted";
				onclick: (() => void) | null = null;
				constructor() {
					document.documentElement.dataset["notificationCreated"] = "true";
					window.addEventListener("click-test-notification", () =>
						this.onclick?.(),
					);
				}
				close() {}
			}
			Object.defineProperty(window, "Notification", {
				value: TestNotification,
			});
			Object.defineProperty(navigator.serviceWorker, "getRegistration", {
				value: () => Promise.resolve(undefined),
			});
		});
		const rpc = await mockWsRpc(page, {
			stubs: {
				ViewSession: ({ sessionId }) => ({
					ok: true,
					draft: `Shown ${sessionId}`,
				}),
			},
		});
		await mockRelayWebSocket(page, {
			initMessages: [
				{
					type: "project_list",
					projects: [
						{
							slug: "e2e-replay",
							title: "e2e-replay",
							folders: ["/tmp/e2e-replay"],
						},
					],
					current: "e2e-replay",
				},
				{
					type: "shell_snapshot",
					roots: true,
					sessions: ["notification-parent", "notification-target"].map(
						(id) => ({ id, title: id, status: "idle", updatedAt: Date.now() }),
					),
				},
			],
			responses: new Map(),
		});
		await page.goto(`${harness.relayBaseUrl}/s/notification-parent`);
		await expect(page.locator("#input")).toHaveValue(
			"Shown notification-parent",
		);
		await expect.poll(() => rpc.hasStream("SubscribeAlerts")).toBe(true);
		rpc.sendAlert({
			_tag: "alert",
			kind: "done",
			alertId: "browser-click",
			sessionId: "notification-target",
		});
		await expect(page.locator("html")).toHaveAttribute(
			"data-notification-created",
			"true",
		);
		await page.evaluate(() =>
			window.dispatchEvent(new Event("click-test-notification")),
		);
		await expect(page).toHaveURL(
			`${harness.relayBaseUrl}/s/notification-target`,
		);
		await expect(page.locator("#input")).toHaveValue(
			"Shown notification-target",
		);
		await rpc.waitForRequest(
			(request) =>
				request.tag === "ViewSession" &&
				request.payload["sessionId"] === "notification-target",
		);
		await testInfo.attach("browser-notification-target", {
			body: await page.screenshot(),
			contentType: "image/png",
		});
	});

	test("an alert fires for unwatched session error", async ({
		page,
		relayUrl,
		mockServer,
		harness,
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
		const TARGET = await createSession(harness.relayPort, "opencode");
		expect(page.url()).not.toContain(`/s/${TARGET}`);
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
		// SW posts navigate_to_session → frontend listener → selection.open()
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
