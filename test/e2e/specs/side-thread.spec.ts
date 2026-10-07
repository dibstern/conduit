// Real relay and event store, with OpenCode REST/SSE replayed from the capture
// and Claude SDK turns replayed from committed traces.

import { writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { Socket } from "@effect/platform";
import { RpcClient, RpcSerialization } from "@effect/rpc";
import { Effect } from "effect";
import NodeWebSocket from "ws";
import { WsRpcError, WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";
import { ChatPage } from "../page-objects/chat.page.js";

const projectSlug = "e2e-replay";
const parentPrompt =
	"Remember the word 'alpha'. Reply with only: ok, remembered.";
const question =
	"What word did I ask you to remember? Reply with only the word.";
const raisedPrompt = "Reply with only: ok, raised.";
const readOnlyRules = [
	{ permission: "edit", pattern: "*", action: "deny" },
	{ permission: "bash", pattern: "*", action: "ask" },
	{ permission: "task", pattern: "*", action: "deny" },
];
const raisedRules = [
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
			const models = yield* client.GetModels({ projectSlug, sessionId });
			const agents = yield* client.GetAgents({ projectSlug, sessionId });
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
						projectSlug,
						sessionId: parentId,
					});
					const alternate = catalog.providers
						.find((provider) => provider.id === "opencode")
						?.models.find((model) => model.id !== "big-pickle");
					if (!alternate)
						throw new Error("Recording needs a second OpenCode model");
					yield* client.SwitchModel({
						projectSlug,
						sessionId: parentId,
						providerId: "opencode",
						modelId: alternate.id,
					});
					yield* client.SwitchAgent({
						projectSlug,
						sessionId: parentId,
						agentId: "plan",
					});
					yield* client.SwitchPermissionMode({
						projectSlug,
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
					projectSlug,
					sessionId: sideId,
				}),
			);
			expect(sideSettings.permissionMode).toBe("plan");

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
			).toEqual({ title: question, permission: readOnlyRules });
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
				permissionMode: "plan",
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
				Effect.either(
					client.StartSideThread({
						projectSlug,
						parentSessionId: sideId,
						title: "Nested question",
					}),
				),
			);
			expect(nested._tag).toBe("Left");
			if (nested._tag !== "Left")
				throw new Error("Nested Side Thread was created");
			expect(nested.left).toBeInstanceOf(WsRpcError);
			if (!(nested.left instanceof WsRpcError))
				throw new Error("Nested start failed outside the typed RPC contract");
			expect(nested.left._tag).toBe("WsRpcError");
			expect(nested.left.message).toBe(
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

			// Session rules enforce Plan, so the agent remains selectable.
			const modelPicker = page.locator(
				'[data-testid="model-picker-trigger"]:visible, [data-testid="composer-word-model"]:visible',
			);
			const agentRow = page.getByTestId("picker-row-agent");
			await modelPicker.click();
			await expect(agentRow).not.toHaveAttribute("data-locked", "plan");
			await expect(agentRow).toContainText("Build");
			await agentRow.click();
			await page.getByTestId("picker-agent-plan").click();
			await expect(agentRow).toContainText("Plan");
			await expect
				.poll(() => parentSettings(relayUrl, sideId))
				.toMatchObject({ permissionMode: "plan", agent: "plan" });
			await agentRow.click();
			await page.getByTestId("picker-agent-build").click();
			await expect(agentRow).toContainText("Build");
			// Escape in an empty Side Thread composer goes back to the parent.
			await modelPicker.click();
			await expect(page.getByTestId("model-picker")).toBeHidden();
			await expect(approvalPill).toContainText("Plan");
			await expect
				.poll(() => parentSettings(relayUrl, sideId))
				.toMatchObject({ permissionMode: "plan", agent: "build" });
			await app.sendMessage(raisedPrompt);
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
			await page.getByTestId("permission-mode-option-ask").click();
			await expect(approvalPill).toContainText("Ask");
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
					{ title: question, permission: readOnlyRules },
					{ permission: raisedRules },
				]);
			await modelPicker.click();
			await expect(agentRow).not.toHaveAttribute("data-locked", "plan");
			await modelPicker.click();
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
			Effect.either(
				client.StartSideThread({
					projectSlug,
					parentSessionId: "missing-side-thread-parent",
					title: question,
				}),
			),
		);
		expect(result._tag).toBe("Left");
		if (result._tag !== "Left")
			throw new Error("Missing parent started a Side Thread");
		expect(result.left).toBeInstanceOf(WsRpcError);
		if (!(result.left instanceof WsRpcError))
			throw new Error("Missing parent failed outside the typed RPC contract");
		expect(result.left._tag).toBe("WsRpcError");
		expect(result.left.message).toBe(
			"Parent session missing-side-thread-parent was not found",
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
					turns: ["pong-thinking-text-turn", "side-thread-plan-turn"],
				},
			});

			test("asks in a hidden plan-mode fork and leaves its parent untouched", async ({
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
					.poll(() => {
						const db = new DatabaseSync(harness.eventsDbPath, {
							readOnly: true,
						});
						try {
							return db
								.prepare(
									"SELECT value FROM provider_state WHERE session_id = ? AND key = 'resumeSessionId'",
								)
								.get(parentId)?.["value"];
						} finally {
							db.close();
						}
					})
					.toBeTruthy();
				// A non-default mode, so a leak from the Side Thread cannot pass.
				await rpc(relayUrl, (client) =>
					client.SwitchPermissionMode({
						projectSlug,
						sessionId: parentId,
						mode: "full",
					}),
				);
				const settingsBefore = await rpc(relayUrl, (client) =>
					client.GetModels({ projectSlug, sessionId: parentId }),
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
					"Plan",
				);
				await expect(
					page.locator(`#session-list [data-session-id="${sideId}"]`),
				).toHaveCount(0);
				const sideSettings = await rpc(relayUrl, (client) =>
					client.GetModels({ projectSlug, sessionId: sideId }),
				);
				expect(sideSettings.permissionMode).toBe("plan");
				// The Side Thread's first SDK turn asked for plan; the parent's did not.
				expect(harness.claudeReplayer?.sentPermissionModes).toEqual([
					"default",
					"plan",
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
					permissionMode: "plan",
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
					"Plan",
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
						client.GetModels({ projectSlug, sessionId: parentId }),
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
});
