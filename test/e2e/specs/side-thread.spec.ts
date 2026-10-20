// Real relay and event store, with OpenCode REST/SSE replayed from the capture
// and Claude SDK turns replayed from committed traces.

import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import NodeWebSocket from "ws";
import { WsRpcError, WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { readNativeThread } from "../../helpers/native-thread.js";
import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

const parentPrompt =
	"Remember the word 'alpha'. Reply with only: ok, remembered.";
const question =
	"What word did I ask you to remember? Reply with only the word.";
const followUpPrompt = "Reply with only: ok, raised.";
const planRules = [
	{ permission: "edit", pattern: "*", action: "deny" },
	{ permission: "bash", pattern: "*", action: "ask" },
	{ permission: "task", pattern: "*", action: "deny" },
];
const askRules = [
	{ permission: "edit", pattern: "*", action: "ask" },
	{ permission: "bash", pattern: "*", action: "ask" },
	{ permission: "task", pattern: "*", action: "allow" },
];

async function rpc<A>(
	relayUrl: string,
	call: (
		client: RpcClient.FromGroup<typeof WsRpcGroup, unknown>,
	) => Effect.Effect<A, unknown>,
): Promise<A> {
	const url = new URL("/rpc", relayUrl);
	url.protocol = "ws:";
	const previousWebSocket = globalThis.WebSocket;
	globalThis.WebSocket =
		NodeWebSocket as unknown as typeof globalThis.WebSocket;
	try {
		return await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					return yield* call(yield* RpcClient.make(WsRpcGroup));
				}),
			).pipe(
				Effect.provide(RpcClient.layerProtocolSocket()),
				Effect.provide(Socket.layerWebSocket(url.toString())),
				Effect.provide(Socket.layerWebSocketConstructorGlobal),
				Effect.provide(RpcSerialization.layerJson),
			),
		);
	} finally {
		globalThis.WebSocket = previousWebSocket;
	}
}

function sessionEvents(dbPath: string, sessionId?: string) {
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		const rows = sessionId
			? db
					.prepare(
						"SELECT sequence, type, data FROM events WHERE session_id = ? ORDER BY sequence",
					)
					.all(sessionId)
			: db
					.prepare("SELECT sequence, type, data FROM events ORDER BY sequence")
					.all();
		return rows.map((row) => ({
			sequence: Number(row["sequence"]),
			type: String(row["type"]),
			payload: JSON.parse(String(row["data"])) as Record<string, unknown>,
		}));
	} finally {
		db.close();
	}
}

function transcript(dbPath: string, sessionId: string) {
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		return db
			.prepare(
				"SELECT id, role, text FROM messages WHERE session_id = ? ORDER BY created_at, id",
			)
			.all(sessionId);
	} finally {
		db.close();
	}
}

async function parentSettings(relayUrl: string, sessionId: string) {
	return rpc(relayUrl, (client) =>
		Effect.gen(function* () {
			const models = yield* client.GetModels({ sessionId });
			const agents = yield* client.GetAgents({ sessionId });
			return {
				model: models.active,
				permissionMode: models.permissionMode,
				agent: agents.activeAgentId,
			};
		}),
	);
}

test.describe("OpenCode Side Threads", () => {
	test.use({ recording: "side-thread" });
	test.describe.configure({ timeout: 90_000 });

	for (const command of ["btw", "side"]) {
		test(`$${command} asks in a saved hidden fork and leaves its parent untouched`, async ({
			page,
			relayUrl,
			harness,
			mockServer,
		}, testInfo) => {
			test.setTimeout(90_000);
			const app = new AppPage(page);
			const chat = new ChatPage(page);
			await app.goto(relayUrl);
			const parentId = new URL(page.url()).pathname.split("/").at(-1);
			if (!parentId) throw new Error("Parent session route is missing");

			await app.input.fill("$");
			for (const name of ["btw", "side"]) {
				const row = app.commandMenu
					.getByRole("option")
					.filter({ hasText: `$${name}` });
				await expect(row).toHaveCount(1);
				await expect(row.locator(".cmd-desc")).toHaveText(/\S/);
			}

			// A bare command opens the list, clears the composer and starts nothing.
			const eventsBeforeBare = sessionEvents(harness.eventsDbPath);
			await app.sendMessage(`$${command}`);
			await expect(page.getByTestId("side-threads-empty")).toHaveText(
				"No Side Threads yet. Type $btw and a question to ask one.",
			);
			await expect(app.input).toHaveValue("");
			await expect(page).toHaveURL(new RegExp(`/s/${parentId}(?:\\?|$)`));
			expect(sessionEvents(harness.eventsDbPath)).toEqual(eventsBeforeBare);
			expect(
				mockServer.requestBodies.some((request) =>
					request.path.endsWith("/fork"),
				),
			).toBe(false);
			await page.keyboard.press("Escape");
			await expect(page.getByTestId("side-threads-panel")).toHaveCount(0);

			await app.sendMessage(parentPrompt);
			await chat.waitForAssistantMessage();
			await expect
				.poll(() =>
					sessionEvents(harness.eventsDbPath, parentId).some(
						(event) => event.type === "turn.completed",
					),
				)
				.toBe(true);
			await chat.waitForStreamingComplete();
			const parentTranscript = transcript(harness.eventsDbPath, parentId);
			const parentTitle = await page
				.locator(
					`#session-list [data-session-id="${parentId}"] .session-title-inner`,
				)
				.innerText();
			const userBodies = chat.userMessages.locator(".whitespace-pre-wrap");
			const assistantBodies = chat.assistantMessages.locator(".md-content");
			const parentUserText = await userBodies.allTextContents();
			const parentAssistantText = await assistantBodies.allTextContents();

			// Choose non-default overrides, so clearing them cannot pass unnoticed.
			await rpc(relayUrl, (client) =>
				Effect.gen(function* () {
					const catalog = yield* client.GetModels({
						sessionId: parentId,
					});
					const alternate = catalog.providers
						.find((provider) => provider.id === "opencode")
						?.models.find((model) => model.id !== "big-pickle");
					if (!alternate)
						throw new Error("Recording needs a second OpenCode model");
					yield* client.SwitchModel({
						sessionId: parentId,
						providerId: "opencode",
						modelId: alternate.id,
					});
					yield* client.SwitchAgent({
						sessionId: parentId,
						agentId: "plan",
					});
					yield* client.SwitchPermissionMode({
						sessionId: parentId,
						mode: "full",
					});
				}),
			);
			const settingsBefore = await parentSettings(relayUrl, parentId);
			expect(settingsBefore.permissionMode).toBe("full");
			expect(settingsBefore.agent).toBe("plan");
			expect(settingsBefore.model?.model).not.toBe("big-pickle");
			// An ordinary OpenCode session has no Plan approval mode.
			const approvalPill = page.getByTestId("permission-mode-badge");
			await approvalPill.click();
			await expect(
				page.getByTestId("permission-mode-option-ask"),
			).toBeVisible();
			await expect(page.getByTestId("permission-mode-option-plan")).toHaveCount(
				0,
			);
			await page.keyboard.press("Escape");

			await app.sendMessage(`$${command} ${question}`);
			await expect(page).not.toHaveURL(new RegExp(`/s/${parentId}(?:\\?|$)`));
			const sideId = new URL(page.url()).pathname.split("/").at(-1);
			if (!sideId) throw new Error("Side Thread route is missing");
			await expect(
				chat.userMessages.filter({ hasText: question }),
			).toBeVisible();
			await expect(chat.assistantMessages.last()).toContainText(/alpha/i);
			await chat.waitForStreamingComplete();
			await expect(page.getByTestId("session-bar-title")).toHaveText(question);
			await expect(chat.subagentBackBar).toContainText("Side Thread of");
			await expect(chat.subagentBackBar).toContainText(parentTitle.trim());
			await expect(
				page.locator(`#session-list [data-session-id="${sideId}"]`),
			).toHaveCount(0);
			await expect(
				page.locator(`#session-list [data-session-id="${parentId}"]`),
			).toHaveCount(1);
			expect(await parentSettings(relayUrl, parentId)).toEqual(settingsBefore);
			const sideSettings = await rpc(relayUrl, (client) =>
				client.GetModels({
					sessionId: sideId,
				}),
			);
			expect(sideSettings.permissionMode).toBe("ask");

			const requestBodies = mockServer.requestBodies;
			expect(
				mockServer.diagnostics.some(
					(entry) =>
						entry.event === "request" &&
						entry.detail?.startsWith(`POST /session/${parentId}/fork`),
				),
			).toBe(true);
			const forkRequest = requestBodies.find(
				(request) =>
					request.method === "POST" &&
					request.path === `/session/${parentId}/fork`,
			);
			expect(JSON.parse(forkRequest?.body ?? "{}")).toEqual({});
			const titleUpdateIndex = requestBodies.findIndex(
				(request) =>
					request.method === "PATCH" && request.path === `/session/${sideId}`,
			);
			const promptIndex = requestBodies.findIndex(
				(request) =>
					request.method === "POST" &&
					request.path === `/session/${sideId}/prompt_async`,
			);
			expect(titleUpdateIndex).toBeGreaterThanOrEqual(0);
			expect(titleUpdateIndex).toBeLessThan(promptIndex);
			expect(
				JSON.parse(requestBodies[titleUpdateIndex]?.body ?? "null"),
			).toEqual({ title: question, permission: askRules });
			expect(
				JSON.parse(requestBodies[promptIndex]?.body ?? "null"),
			).not.toHaveProperty("agent");

			// The recording includes the real title update emitted by OpenCode.
			await expect
				.poll(() => {
					const events = sessionEvents(harness.eventsDbPath, sideId);
					const creation = events.find(
						(event) => event.type === "session.created",
					);
					return events.some(
						(event) =>
							event.type === "session.renamed" &&
							event.payload["title"] === question &&
							event.sequence > (creation?.sequence ?? Number.POSITIVE_INFINITY),
					);
				})
				.toBe(true);
			const sideEvents = sessionEvents(harness.eventsDbPath, sideId);
			const creations = sideEvents.filter(
				(event) => event.type === "session.created",
			);
			expect(creations).toHaveLength(1);
			expect(creations[0]?.payload).toMatchObject({
				parentId,
				title: question,
				sideThread: true,
				permissionMode: "ask",
			});
			const firstTurn = sideEvents.find((event) =>
				event.type.startsWith("turn."),
			);
			expect(firstTurn).toBeDefined();
			expect(creations[0]?.sequence).toBeLessThan(firstTurn?.sequence ?? 0);
			const eventsPath = testInfo.outputPath(
				`${command}-canonical-events.json`,
			);
			await writeFile(eventsPath, JSON.stringify(sideEvents, null, 2));
			await testInfo.attach(`${command}-canonical-events`, {
				path: eventsPath,
				contentType: "application/json",
			});

			await page.reload();
			await app.connectOverlay.waitFor({ state: "detached", timeout: 30_000 });
			await expect(
				chat.userMessages.filter({ hasText: question }),
			).toBeVisible();
			await expect(chat.assistantMessages.last()).toContainText(/alpha/i);
			await expect(page.getByTestId("session-bar-title")).toHaveText(question);
			await expect(chat.subagentBackBar).toBeVisible();
			await expect(
				page.locator(`#session-list [data-session-id="${sideId}"]`),
			).toHaveCount(0);

			await app.input.fill("$");
			for (const name of ["btw", "side"]) {
				await expect(
					app.commandMenu.getByRole("option").filter({ hasText: `$${name}` }),
				).toHaveCount(0);
			}
			const eventsBeforeNested = sessionEvents(harness.eventsDbPath);
			const nested = await rpc(relayUrl, (client) =>
				Effect.result(
					client.StartSideThread({
						sessionId: sideId,
						title: "Nested question",
						inputId: randomUUID(),
						text: "Nested question",
					}),
				),
			);
			expect(nested._tag).toBe("Failure");
			if (nested._tag !== "Failure")
				throw new Error("Nested Side Thread was created");
			expect(nested.failure).toBeInstanceOf(WsRpcError);
			if (!(nested.failure instanceof WsRpcError))
				throw new Error("Nested start failed outside the typed RPC contract");
			expect(nested.failure._tag).toBe("WsRpcError");
			expect(nested.failure.message).toBe(
				"Cannot start a Side Thread from a Side Thread",
			);
			expect(sessionEvents(harness.eventsDbPath)).toEqual(eventsBeforeNested);
			const nestedText = `$${command} Nested question`;
			await app.sendMessage(nestedText);
			await expect(
				page.getByText("Cannot start a Side Thread from a Side Thread", {
					exact: true,
				}),
			).toBeVisible();
			await expect(app.input).toHaveValue(nestedText);
			expect(sessionEvents(harness.eventsDbPath)).toEqual(eventsBeforeNested);
			await app.input.fill("");

			// Side Thread modes are session rules, so the agent stays selectable.
			// The harness control opens the picker root, where the agent row lives.
			const harnessPicker = page.locator(
				'[data-testid="composer-harness-trigger"]:visible, [data-testid="composer-word-harness"]:visible',
			);
			const agentRow = page.getByTestId("picker-row-agent");
			await harnessPicker.click();
			await expect(agentRow).not.toHaveAttribute("data-locked", "plan");
			await expect(agentRow).toContainText("Build");
			await agentRow.click();
			await page.getByTestId("picker-agent-plan").click();
			await expect(agentRow).toContainText("Plan");
			await expect
				.poll(() => parentSettings(relayUrl, sideId))
				.toMatchObject({ permissionMode: "ask", agent: "plan" });
			await agentRow.click();
			await page.getByTestId("picker-agent-build").click();
			await expect(agentRow).toContainText("Build");
			// Escape in an empty Side Thread composer goes back to the parent.
			await harnessPicker.click();
			await expect(page.getByTestId("model-picker")).toBeHidden();
			await expect(approvalPill).toContainText("Ask");
			await expect
				.poll(() => parentSettings(relayUrl, sideId))
				.toMatchObject({ permissionMode: "ask", agent: "build" });
			await app.sendMessage(followUpPrompt);
			await expect(chat.assistantMessages.last()).toContainText("ok, raised");
			await chat.waitForStreamingComplete();
			const sidePrompts = mockServer.requestBodies
				.filter(
					(request) =>
						request.method === "POST" &&
						request.path === `/session/${sideId}/prompt_async`,
				)
				.map((request) => JSON.parse(request.body ?? "null"));
			expect(sidePrompts).toHaveLength(2);
			expect(sidePrompts[1]?.agent).toBe("build");
			expect(sidePrompts[1]?.agent).not.toBe("plan");
			await approvalPill.click();
			const planOption = page.getByTestId("permission-mode-option-plan");
			await expect(planOption).toBeVisible();
			await expect(planOption).not.toContainText("Claude");
			await planOption.click();
			await expect(approvalPill).toContainText("Plan");
			const sidePatches = () =>
				mockServer.requestBodies
					.filter(
						(request) =>
							request.method === "PATCH" &&
							request.path === `/session/${sideId}`,
					)
					.map((request) => JSON.parse(request.body ?? "null"));
			await expect
				.poll(sidePatches)
				.toEqual([
					{ title: question, permission: askRules },
					{ permission: planRules },
				]);
			await harnessPicker.click();
			await expect(agentRow).not.toHaveAttribute("data-locked", "plan");
			await harnessPicker.click();
			await expect(page.getByTestId("model-picker")).toBeHidden();
			const sideScreenshot = testInfo.outputPath(
				`${command}-side-thread-after-reload.png`,
			);
			await page.screenshot({ path: sideScreenshot, fullPage: true });
			await testInfo.attach(`${command}-side-thread-after-reload`, {
				path: sideScreenshot,
				contentType: "image/png",
			});

			await chat.subagentBackBtn.click();
			await expect(page).toHaveURL(new RegExp(`/s/${parentId}(?:\\?|$)`));
			await expect(chat.subagentBackBar).not.toBeVisible();
			await expect(chat.userMessages).toHaveCount(parentUserText.length);
			await expect(chat.assistantMessages).toHaveCount(
				parentAssistantText.length,
			);
			await expect(userBodies).toHaveText(parentUserText);
			await expect(assistantBodies).toHaveText(parentAssistantText);
			await expect(chat.userMessages.filter({ hasText: question })).toHaveCount(
				0,
			);
			expect(transcript(harness.eventsDbPath, parentId)).toEqual(
				parentTranscript,
			);
			expect(await parentSettings(relayUrl, parentId)).toEqual(settingsBefore);
			const parentScreenshot = testInfo.outputPath(
				`${command}-unchanged-parent.png`,
			);
			await page.screenshot({ path: parentScreenshot, fullPage: true });
			await testInfo.attach(`${command}-unchanged-parent`, {
				path: parentScreenshot,
				contentType: "image/png",
			});
		});
	}

	test("a missing parent is a typed failure before any event is written", async ({
		page,
		relayUrl,
		harness,
	}) => {
		await new AppPage(page).goto(relayUrl);
		const before = sessionEvents(harness.eventsDbPath);
		const result = await rpc(relayUrl, (client) =>
			Effect.result(
				client.StartSideThread({
					sessionId: "missing-side-thread-parent",
					title: question,
					inputId: randomUUID(),
					text: question,
				}),
			),
		);
		expect(result._tag).toBe("Failure");
		if (result._tag !== "Failure")
			throw new Error("Missing parent started a Side Thread");
		expect(result.failure).toBeInstanceOf(WsRpcError);
		if (!(result.failure instanceof WsRpcError))
			throw new Error("Missing parent failed outside the typed RPC contract");
		expect(result.failure._tag).toBe("WsRpcError");
		expect(result.failure.code).toBe("unknown-session");
		expect(result.failure.message).toBe(
			"Unknown session: missing-side-thread-parent",
		);
		expect(sessionEvents(harness.eventsDbPath)).toEqual(before);
	});
});

test.describe("Claude Side Threads", () => {
	test.beforeEach(({ page }) => {
		const viewport = page.viewportSize();
		test.skip(
			!viewport || viewport.width < 1440,
			"Chat tests run on desktop viewport only",
		);
	});

	for (const command of ["btw", "side"]) {
		test.describe(`$${command}`, () => {
			test.use({
				claudeReplay: {
					turns: ["pong-thinking-text-turn", "side-thread-ask-turn"],
				},
			});

			test("asks in a hidden Ask-mode fork and leaves its parent untouched", async ({
				page,
				relayUrl,
				harness,
			}, testInfo) => {
				const app = new AppPage(page);
				const chat = new ChatPage(page);
				await app.goto(relayUrl);
				const parentId = new URL(page.url()).pathname.split("/").at(-1);
				if (!parentId) throw new Error("Parent session route is missing");

				await app.input.fill("$");
				for (const name of ["btw", "side"]) {
					await expect(
						app.commandMenu.getByRole("option").filter({ hasText: `$${name}` }),
					).toHaveCount(1);
				}
				await app.input.fill("");

				await app.sendMessage(parentPrompt);
				await expect(chat.assistantMessages).toHaveText([/pong/i]);
				await chat.waitForStreamingComplete();
				// The SDK resume cursor commits after the completed-turn event.
				await expect
					.poll(
						async () =>
							(await readNativeThread(harness.eventsDbPath, parentId))
								?.resumeSessionId,
					)
					.toBeTruthy();
				// A non-default mode, so a leak from the Side Thread cannot pass.
				await rpc(relayUrl, (client) =>
					client.SwitchPermissionMode({
						sessionId: parentId,
						mode: "full",
					}),
				);
				const settingsBefore = await rpc(relayUrl, (client) =>
					client.GetModels({ sessionId: parentId }),
				).then(({ active, permissionMode }) => ({ active, permissionMode }));
				expect(settingsBefore.permissionMode).toBe("full");
				const parentTranscript = transcript(harness.eventsDbPath, parentId);
				const parentTitle = await page
					.locator(
						`#session-list [data-session-id="${parentId}"] .session-title-inner`,
					)
					.innerText();

				await app.sendMessage(`$${command} ${question}`);
				await expect(page).not.toHaveURL(new RegExp(`/s/${parentId}(?:\\?|$)`));
				const sideId = new URL(page.url()).pathname.split("/").at(-1);
				if (!sideId) throw new Error("Side Thread route is missing");
				await expect(
					chat.userMessages.filter({ hasText: question }),
				).toBeVisible();
				await expect(chat.assistantMessages.last()).toContainText(/alpha/i);
				await chat.waitForStreamingComplete();
				await expect(page.getByTestId("session-bar-title")).toHaveText(
					question,
				);
				await expect(chat.subagentBackBar).toContainText("Side Thread of");
				await expect(chat.subagentBackBar).toContainText(parentTitle.trim());
				await expect(page.getByTestId("permission-mode-badge")).toContainText(
					"Ask",
				);
				await expect(
					page.locator(`#session-list [data-session-id="${sideId}"]`),
				).toHaveCount(0);
				const sideSettings = await rpc(relayUrl, (client) =>
					client.GetModels({ sessionId: sideId }),
				);
				expect(sideSettings.permissionMode).toBe("ask");
				// The Side Thread asked for Ask ("default"), not the parent's "full".
				expect(harness.claudeReplayer?.sentPermissionModes).toEqual([
					"default",
					"default",
				]);

				const sideEvents = sessionEvents(harness.eventsDbPath, sideId);
				const creations = sideEvents.filter(
					(event) => event.type === "session.created",
				);
				expect(creations).toHaveLength(1);
				expect(creations[0]?.payload).toMatchObject({
					parentId,
					title: question,
					provider: "claude",
					sideThread: true,
					permissionMode: "ask",
				});
				const firstTurn = sideEvents.find((event) =>
					event.type.startsWith("turn."),
				);
				expect(firstTurn).toBeDefined();
				expect(creations[0]?.sequence).toBeLessThan(firstTurn?.sequence ?? 0);
				const eventsPath = testInfo.outputPath(
					`claude-${command}-canonical-events.json`,
				);
				await writeFile(eventsPath, JSON.stringify(sideEvents, null, 2));
				await testInfo.attach(`claude-${command}-canonical-events`, {
					path: eventsPath,
					contentType: "application/json",
				});

				await page.reload();
				await app.connectOverlay.waitFor({
					state: "detached",
					timeout: 30_000,
				});
				await expect(
					chat.userMessages.filter({ hasText: question }),
				).toBeVisible();
				await expect(chat.assistantMessages.last()).toContainText(/alpha/i);
				await expect(page.getByTestId("session-bar-title")).toHaveText(
					question,
				);
				await expect(page.getByTestId("permission-mode-badge")).toContainText(
					"Ask",
				);
				await expect(
					page.locator(`#session-list [data-session-id="${sideId}"]`),
				).toHaveCount(0);
				const sideScreenshot = testInfo.outputPath(
					`claude-${command}-side-thread-after-reload.png`,
				);
				await page.screenshot({ path: sideScreenshot, fullPage: true });
				await testInfo.attach(`claude-${command}-side-thread-after-reload`, {
					path: sideScreenshot,
					contentType: "image/png",
				});

				await chat.subagentBackBtn.click();
				await expect(page).toHaveURL(new RegExp(`/s/${parentId}(?:\\?|$)`));
				await expect(chat.subagentBackBar).not.toBeVisible();
				await expect(chat.assistantMessages).toHaveText([/pong/i]);
				await expect(
					chat.userMessages.filter({ hasText: question }),
				).toHaveCount(0);
				expect(transcript(harness.eventsDbPath, parentId)).toEqual(
					parentTranscript,
				);
				expect(
					await rpc(relayUrl, (client) =>
						client.GetModels({ sessionId: parentId }),
					).then(({ active, permissionMode }) => ({ active, permissionMode })),
				).toEqual(settingsBefore);
				await expect(
					page.locator(`#session-list [data-session-id="${sideId}"]`),
				).toHaveCount(0);
			});
		});
	}

	test.describe("without a transcript", () => {
		test.use({ claudeReplay: { turns: [] } });

		test("keeps the question in the composer and writes nothing", async ({
			page,
			relayUrl,
			harness,
		}) => {
			const app = new AppPage(page);
			await app.goto(relayUrl);
			const parentId = new URL(page.url()).pathname.split("/").at(-1);
			const before = sessionEvents(harness.eventsDbPath);
			const text = `$btw ${question}`;
			await app.sendMessage(text);
			await expect(
				page.getByText(
					"This session has no Claude transcript yet. Send a message first.",
					{ exact: true },
				),
			).toBeVisible();
			await expect(app.input).toHaveValue(text);
			await expect(page).toHaveURL(new RegExp(`/s/${parentId}(?:\\?|$)`));
			expect(sessionEvents(harness.eventsDbPath)).toEqual(before);
		});
	});

	test.describe("before its first output", () => {
		// Held mid auto-compaction: a long parent's inherited context makes the
		// first turn compact before it says anything.
		test.use({
			claudeReplay: {
				turns: ["pong-thinking-text-turn", "side-thread-compacting-turn"],
				holdBefore: { turn: 2, message: 11 },
			},
		});

		test("shows the Side Thread working, live and after a reload", async ({
			page,
			relayUrl,
			harness,
		}) => {
			const app = new AppPage(page);
			const chat = new ChatPage(page);
			await app.goto(relayUrl);
			const parentId = new URL(page.url()).pathname.split("/").at(-1);
			await app.sendMessage(parentPrompt);
			await expect(chat.assistantMessages).toHaveText([/pong/i]);
			await chat.waitForStreamingComplete();
			await expect
				.poll(
					async () =>
						(await readNativeThread(harness.eventsDbPath, parentId ?? ""))
							?.resumeSessionId,
				)
				.toBeTruthy();

			await app.sendMessage(`$side ${question}`);
			await expect(page).not.toHaveURL(new RegExp(`/s/${parentId}(?:\\?|$)`));
			await harness.claudeReplayer?.held();
			const compacting = page.getByText("Compacting conversation…");
			await expect(
				chat.userMessages.filter({ hasText: question }),
			).toBeVisible();
			await expect(chat.stopBtn).toBeVisible();
			await expect(compacting).toBeVisible();

			await page.reload();
			await expect(
				chat.userMessages.filter({ hasText: question }),
			).toBeVisible();
			await expect(chat.stopBtn).toBeVisible();
			await expect(compacting).toBeVisible();

			harness.claudeReplayer?.release();
			await expect(chat.assistantMessages.last()).toContainText(/alpha/i);
			await chat.waitForStreamingComplete();
		});
	});

	test.describe("started while its parent is answering", () => {
		test.use({
			claudeReplay: {
				turns: [
					"pong-thinking-text-turn",
					"pong-thinking-text-turn",
					"side-thread-compacting-turn",
				],
				holdBefore: [
					{ turn: 2, message: 10 },
					{ turn: 3, message: 11 },
				],
			},
		});

		test("shows the Side Thread working", async ({
			page,
			relayUrl,
			harness,
		}) => {
			const app = new AppPage(page);
			const chat = new ChatPage(page);
			await app.goto(relayUrl);
			const parentId = new URL(page.url()).pathname.split("/").at(-1);
			await app.sendMessage(parentPrompt);
			await expect(chat.assistantMessages).toHaveText([/pong/i]);
			await chat.waitForStreamingComplete();
			await expect
				.poll(
					async () =>
						(await readNativeThread(harness.eventsDbPath, parentId ?? ""))
							?.resumeSessionId,
				)
				.toBeTruthy();
			await app.sendMessage(parentPrompt);
			await harness.claudeReplayer?.held();
			await expect(chat.stopBtn).toBeVisible();

			await app.sendMessage(`$side ${question}`);
			await expect(page).not.toHaveURL(new RegExp(`/s/${parentId}(?:\\?|$)`));
			await expect(
				chat.userMessages.filter({ hasText: question }),
			).toBeVisible();
			await expect(chat.stopBtn).toBeVisible();
			await page.reload();
			await expect(
				chat.userMessages.filter({ hasText: question }),
			).toBeVisible();
			await expect(chat.stopBtn).toBeVisible();

			harness.claudeReplayer?.release();
			harness.claudeReplayer?.release();
			await expect(chat.assistantMessages.last()).toContainText(/alpha/i);
		});
	});
});
