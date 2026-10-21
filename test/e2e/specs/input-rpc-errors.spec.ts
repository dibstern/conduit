import type { Page, TestInfo } from "@playwright/test";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { build } from "vite";
import { AccountUnroutable } from "../../../src/lib/contracts/limit-recovery.js";
import { WsRpcError } from "../../../src/lib/contracts/ws-rpc.js";
import type { StubTable } from "../../helpers/stub-ws-rpc.js";
import { initMessages } from "../fixtures/mockup-state.js";
import { expect, test } from "../helpers/replay-fixture.js";
import { mockWsRpc } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

// Failures must keep the action, reveal only a server-supplied reason, and
// leave the composer usable for retry.
async function openChat(page: Page, baseUrl: string, stubs: StubTable) {
	const rpc = await mockWsRpc(page, { stubs });
	const relay = await mockRelayWebSocket(page, {
		initMessages,
		responses: new Map(),
		initDelay: 0,
		messageDelay: 0,
	});
	await page.goto(`${baseUrl}/s/sess-mockup-001`);
	await expect(page.locator("#input")).toBeVisible();
	await expect(page.locator(".connect-overlay")).not.toBeVisible();
	return { rpc, relay };
}

async function attachScreen(page: Page, testInfo: TestInfo) {
	const path = testInfo.outputPath("rpc-failure.png");
	await page.screenshot({ path });
	await testInfo.attach("rpc-failure", { path, contentType: "image/png" });
}

for (const scenario of ["account", "generic", "empty", "socket"] as const) {
	test(`composer submit ${scenario} failure shows the available reason`, async ({
		page,
		harness,
	}, testInfo) => {
		const { rpc } = await openChat(page, harness.relayBaseUrl, {
			"input.submit": () => {
				if (scenario === "account")
					throw new AccountUnroutable({ ref: { _tag: "Id", id: "retired" } });
				if (scenario === "socket") return new Promise<never>(() => {});
				throw new WsRpcError({
					message:
						scenario === "generic" ? "This session cannot accept input." : "",
				});
			},
		});
		await page.locator("#input").fill("Try this message");
		await page.locator("#input").press("Enter");
		await rpc.waitForRequest(({ tag }) => tag === "input.submit");
		if (scenario === "socket") rpc.closeSockets();
		const toast = page
			.getByRole("alert")
			.filter({ hasText: "Failed to send message" });
		await expect(toast).toContainText("Failed to send message");
		if (scenario === "account")
			await expect(toast).toContainText(
				'Cannot route account reference "retired".',
			);
		else if (scenario === "generic")
			await expect(toast).toContainText("This session cannot accept input.");
		else await expect(toast).toHaveText("Failed to send message");
		await expect(page.locator("#input")).toBeEnabled();
		await attachScreen(page, testInfo);
	});
}

test("composer stop shows the server refusal and permits retry", async ({
	page,
	harness,
}, testInfo) => {
	const { relay, rpc } = await openChat(page, harness.relayBaseUrl, {
		CancelSession: () => {
			throw new WsRpcError({ message: "The provider refused to stop." });
		},
	});
	relay.sendMessage({ type: "status", status: "processing" });
	await page.locator("#stop").click();
	await rpc.waitForRequest(({ tag }) => tag === "CancelSession");
	const toast = page.getByRole("alert");
	await expect(toast).toContainText("Failed to stop session");
	await expect(toast).toContainText("The provider refused to stop.");
	await expect(page.locator("#stop")).toBeEnabled();
	await attachScreen(page, testInfo);
});

test("background task stop shows the server refusal and keeps the task", async ({
	page,
	harness,
}, testInfo) => {
	const { rpc } = await openChat(page, harness.relayBaseUrl, {
		StopBackgroundTask: () => {
			throw new WsRpcError({ message: "The task cannot be stopped yet." });
		},
	});
	rpc.setDaemonList("SubscribeInstances", {
		instances: [
			{
				id: "claude",
				name: "Claude",
				driver: "claude",
				isDefault: true,
				port: 0,
				managed: false,
				status: "healthy",
				restartCount: 0,
				createdAt: 1,
				capabilities: {
					supportsMultiFolder: true,
					supportsWorktree: true,
					supportsTaskStop: true,
				},
			},
		],
	});
	rpc.upsertShellRow({
		id: "sess-mockup-001",
		projectSlug: "myapp",
		accountId: "claude",
		title: "Background task refusal",
		status: "idle",
		updatedAt: Date.now(),
		backgroundTasks: [
			{
				id: "refused-task",
				type: "local_bash",
				description: "Watch tests",
				firstSeenAt: Date.now(),
			},
		],
	});
	await page.getByRole("button", { name: /^\d+ background tasks?$/ }).click();
	await page.getByTestId("background-task-stop").click();
	const toast = page.getByRole("alert");
	await expect(toast).toContainText("Failed to stop background task");
	await expect(toast).toContainText("The task cannot be stopped yet.");
	await expect(page.getByTestId("background-task-description")).toHaveText(
		"Watch tests",
	);
	await attachScreen(page, testInfo);
});

for (const ending of [
	"stop tasks",
	"tasks finish",
	"navigate",
	"timeout",
	"unsupported driver",
] as const) {
	test(`turn stop background-tasks follow-up: ${ending}`, async ({
		page,
		harness,
	}, testInfo) => {
		const { rpc } = await openChat(page, harness.relayBaseUrl, {
			CancelSession: () => ({ ok: true }),
			StopBackgroundTask: () => ({ ok: true }),
		});
		const sessionId = "sess-mockup-001";
		rpc.setDaemonList("SubscribeInstances", {
			instances: [
				{
					id: "stop-account",
					name: "Stop account",
					driver: ending === "unsupported driver" ? "opencode" : "claude",
					isDefault: true,
					port: 0,
					managed: false,
					status: "healthy",
					restartCount: 0,
					createdAt: 1,
				},
			],
		});
		const tasks = ["watch-tests", "watch-build"].map((id) => ({
			id,
			type: "local_bash",
			description: id,
			firstSeenAt: Date.now(),
		}));
		const row = {
			id: sessionId,
			projectSlug: "myapp",
			accountId: "stop-account",
			title: "Stop follow-up",
			status: "busy",
			updatedAt: Date.now(),
			backgroundTasks: tasks,
		};
		rpc.upsertShellRow(row);
		await expect(
			page.getByRole("button", { name: "2 background tasks", exact: true }),
		).toBeVisible();
		await page.locator("#stop").click();
		const cancel = await rpc.waitForRequest(
			({ tag }) => tag === "CancelSession",
		);
		expect(cancel.payload).toEqual({
			_tag: "CancelSession",
			sessionId,
			commandId: expect.any(String),
		});
		const offer = page
			.getByTestId("toast")
			.filter({ hasText: "Turn stopped." });
		if (ending === "unsupported driver") {
			// A later wire round trip ensures the stop reply was processed.
			rpc.upsertShellRow({ ...row, status: "idle" });
			await expect(page.locator("#stop")).toBeHidden();
			await expect(offer).toHaveCount(0);
		} else {
			await expect(offer).toContainText("Turn stopped. 2 tasks still running");
			await expect(
				offer.getByRole("button", { name: "Stop them" }),
			).toBeVisible();
			// Cancel alone must not hide working while the server still says busy.
			await expect(page.locator("#stop")).toBeVisible();
			rpc.upsertShellRow({ ...row, status: "idle" });
			await expect(page.locator("#stop")).toBeHidden();
			if (ending === "stop tasks") {
				await offer.getByRole("button", { name: "Stop them" }).click();
				await rpc.waitForRequest(
					({ tag, payload }) =>
						tag === "StopBackgroundTask" && payload["taskId"] === "watch-tests",
				);
				expect(
					rpc
						.getRequests()
						.filter(({ tag }) => tag === "StopBackgroundTask")
						.map(({ payload }) => payload),
				).toEqual([
					{ _tag: "StopBackgroundTask", sessionId, taskId: "watch-build" },
					{ _tag: "StopBackgroundTask", sessionId, taskId: "watch-tests" },
				]);
				// Requests alone do not remove tasks; the server owns their rows.
				await expect(
					page.getByRole("button", {
						name: "2 background tasks",
						exact: true,
					}),
				).toBeVisible();
				rpc.upsertShellRow({ ...row, status: "idle", backgroundTasks: [] });
			} else if (ending === "tasks finish") {
				rpc.upsertShellRow({
					...row,
					status: "idle",
					backgroundTasks: tasks.slice(0, 1),
				});
				await expect(offer).toContainText("Turn stopped. 1 task still running");
				rpc.upsertShellRow({ ...row, status: "idle", backgroundTasks: [] });
			} else if (ending === "navigate") {
				rpc.upsertShellRow({
					...row,
					id: "another-session",
					title: "Another session",
					status: "idle",
					backgroundTasks: [],
				});
				await page
					.getByRole("link", { name: /Another session/ })
					.getByText("Another session", { exact: true })
					.click();
				await expect(page).toHaveURL(/\/s\/another-session$/);
			}
			await expect(offer).toHaveCount(0, {
				timeout: ending === "timeout" ? 8_000 : 3_000,
			});
		}
		if (ending !== "stop tasks")
			expect(
				rpc.getRequests().filter(({ tag }) => tag === "StopBackgroundTask"),
			).toEqual([]);
		const path = testInfo.outputPath("stop-background-tasks.png");
		await page.screenshot({ path });
		await testInfo.attach("stop-background-tasks", {
			path,
			contentType: "image/png",
		});
	});
}

test.describe("rewind confirmation", () => {
	let browserCode: string;
	test.beforeAll(async () => {
		// Compile the real component's store graph outside the browser-action budget.
		test.setTimeout(120_000);
		const output = await build({
			configFile: false,
			logLevel: "error",
			plugins: [svelte()],
			resolve: { conditions: ["browser"] },
			build: {
				write: false,
				minify: false,
				lib: {
					entry: new URL(
						"../helpers/input-rpc-error-browser.ts",
						import.meta.url,
					).pathname,
					formats: ["es"],
				},
			},
		});
		if (!("output" in output) && !Array.isArray(output))
			throw new Error("Expected browser bundle");
		const chunk = (Array.isArray(output) ? output[0] : output)?.output.find(
			(item) => item.type === "chunk" && item.isEntry,
		);
		if (chunk?.type !== "chunk") throw new Error("Missing browser entry");
		browserCode = chunk.code;
	});

	test("shows the server refusal", async ({ page }, testInfo) => {
		const rpc = await mockWsRpc(page, {
			stubs: {
				RewindSession: () => {
					throw new WsRpcError({ message: "That message cannot be rewound." });
				},
			},
		});
		await page.route("http://rpc.test/", (route) =>
			route.fulfill({
				contentType: "text/html",
				body: "<!doctype html>",
			}),
		);
		await page.goto("http://rpc.test/");
		await page.addScriptTag({ type: "module", content: browserCode });
		await page.getByRole("button", { name: "Rewind", exact: true }).click();
		await rpc.waitForRequest(({ tag }) => tag === "RewindSession");
		const toast = page.getByTestId("toast");
		await expect(toast).toContainText("Could not rewind the conversation.");
		await expect(toast).toContainText("That message cannot be rewound.");
		await attachScreen(page, testInfo);
	});
});

for (const action of ["remove", "resume"] as const) {
	test(`queue ${action} shows the server refusal and keeps the input`, async ({
		page,
		harness,
	}, testInfo) => {
		const refuse = () => {
			throw new WsRpcError({ message: "The queue is locked." });
		};
		const { relay } = await openChat(page, harness.relayBaseUrl, {
			"input.cancel": refuse,
			"input.sendNow": refuse,
		});
		relay.sendMessage({
			type: "mock_pending_input",
			sessionId: "sess-mockup-001",
			inputId: "held-input",
			text: "Held message",
		});
		relay.sendMessage({
			type: "mock_inbox",
			sessionId: "sess-mockup-001",
			paused: true,
		});
		await page.getByTestId(`pending-input-${action}`).click();
		const toast = page.getByRole("alert");
		await expect(toast).toContainText("Could not update the queue");
		await expect(toast).toContainText("The queue is locked.");
		await expect(page.getByTestId("pending-input-text")).toHaveText(
			"Held message",
		);
		await attachScreen(page, testInfo);
	});
}

test("undo rewind shows the server refusal and leaves undo available", async ({
	page,
	harness,
}, testInfo) => {
	const { rpc } = await openChat(page, harness.relayBaseUrl, {
		UndoRewind: () => {
			throw new WsRpcError({ message: "The rewind point expired." });
		},
	});
	rpc.sendChunk(
		"SubscribeSessionDetail",
		[
			{
				_tag: "upsert",
				item: { _tag: "rewind", messageId: "rewound-message" },
				sequence: 1,
			},
		],
		"sess-mockup-001",
	);
	await page.getByTestId("undo-rewind").click();
	const toast = page
		.getByTestId("toast")
		.filter({ hasText: "Could not undo the rewind." });
	await expect(toast).toContainText("Could not undo the rewind.");
	await expect(toast).toContainText("The rewind point expired.");
	await expect(page.getByTestId("undo-rewind")).toBeEnabled();
	await attachScreen(page, testInfo);
});

for (const withReason of [true, false]) {
	test(`tool details refusal ${withReason ? "shows the server reason" : "uses the fallback"} and permits retry`, async ({
		page,
		harness,
	}, testInfo) => {
		const { relay } = await openChat(page, harness.relayBaseUrl, {
			GetToolDetails: () => {
				throw new WsRpcError({
					message: withReason ? "Tool details are unavailable." : "",
				});
			},
		});
		relay.sendMessage({
			type: "mock_transcript_snapshot",
			id: "sess-mockup-001",
			history: {
				messages: [
					{
						id: "assistant-with-tool",
						role: "assistant",
						parts: [
							{
								id: "preview-part",
								type: "tool",
								callID: "preview-tool",
								tool: "Bash",
								state: {
									status: "completed",
									input: { _tag: "whole", value: { command: "echo preview" } },
									output: {
										_tag: "preview",
										text: "Preview output",
										fullBytes: 999,
									},
								},
							},
						],
					},
				],
			},
		});
		const tool = page.locator('.tool-item[data-tool-id="preview-tool"]');
		if (!(await tool.isVisible()))
			await page.locator(".turn-activity-toggle").last().click();
		await tool.locator("button").first().click();
		const detail = tool.locator(".tool-full-detail");
		await expect(detail).toContainText(
			withReason
				? "Tool details are unavailable."
				: "Couldn't load the full output.",
		);
		await expect(detail.getByRole("button", { name: "Retry" })).toBeEnabled();
		await attachScreen(page, testInfo);
	});
}
