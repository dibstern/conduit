// An OpenCode Side Thread switched to Plan stays there across a daemon restart: the selector
// still shows Plan and OpenCode still holds the read-only session rules.
// Spawns its own ephemeral OpenCode, so no live instance or password is needed.

import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { Effect } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import NodeWebSocket from "ws";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import {
	type ForegroundDaemonHandle,
	startForegroundDaemon,
} from "../../../src/lib/domain/daemon/Layers/daemon-foreground.js";
import { stopPtyHost } from "../../../src/lib/terminal/pty-host-client.js";
import {
	captureExistingChildren,
	stopDaemonAndAssertNoSurvivors,
} from "../helpers/daemon-survivors.js";
import { spawnOpenCode } from "../helpers/opencode-spawner.js";
import { AppPage } from "../page-objects/app.page.js";

const staticDir = resolve(import.meta.dirname, "../../../dist/frontend");
const modelPick = { providerId: "side-restart", modelId: "ready" } as const;

function startDaemon(configDir: string, opencodeUrl: string) {
	// The user has already answered the avatar question, so the first-run
	// dialog stays shut over the composer. A restart keeps what the first start saved.
	if (!existsSync(join(configDir, "daemon.json")))
		writeFileSync(
			join(configDir, "daemon.json"),
			JSON.stringify({
				pid: 0,
				port: 0,
				pinHash: null,
				tls: false,
				debug: false,
				keepAwake: false,
				projects: [],
				avatar: { kind: "initial" },
			}),
		);
	return startForegroundDaemon({
		port: 0,
		host: "127.0.0.1",
		configDir,
		socketPath: join(configDir, "relay.sock"),
		opencodeUrl,
		staticDir,
		logLevel: "error",
	});
}

async function rpc<A>(
	daemon: ForegroundDaemonHandle,
	call: (
		client: RpcClient.FromGroup<typeof WsRpcGroup, unknown>,
	) => Effect.Effect<A, unknown>,
): Promise<A> {
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
				Effect.provide(
					Socket.layerWebSocket(`ws://127.0.0.1:${daemon.port}/rpc`),
				),
				Effect.provide(Socket.layerWebSocketConstructorGlobal),
				Effect.provide(RpcSerialization.layerJson),
			),
		);
	} finally {
		globalThis.WebSocket = previousWebSocket;
	}
}

test("a Side Thread keeps Plan and its read-only rules after a daemon restart", async ({
	page,
	isMobile,
}, testInfo) => {
	test.skip(isMobile, "One viewport proves the restart path");
	test.setTimeout(120_000);
	const configDir = mkdtempSync(join(tmpdir(), "e2e-side-restart-"));
	const projectDir = mkdtempSync(join(tmpdir(), "e2e-side-restart-project-"));
	let modelRequestCount = 0;
	const modelRequests: Array<{
		method: string;
		path: string;
		stream: boolean;
	}> = [];
	const modelServer = createServer(async (request, response) => {
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
			response.writeHead(404).end();
			return;
		}
		try {
			let body = "";
			for await (const chunk of request) body += String(chunk);
			const input: { stream?: boolean } = JSON.parse(body);
			modelRequestCount++;
			if (modelRequests.length < 8)
				modelRequests.push({
					method: request.method,
					path: request.url,
					stream: input.stream === true,
				});
			const result = {
				id: "side-restart-text",
				created: 1,
				model: modelPick.modelId,
				usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
			};
			const message = { role: "assistant", content: "READY" };
			if (input.stream) {
				response.writeHead(200, { "Content-Type": "text/event-stream" });
				response.write(
					`data: ${JSON.stringify({ ...result, object: "chat.completion.chunk", choices: [{ index: 0, delta: message, finish_reason: null }] })}\n\n`,
				);
				response.write(
					`data: ${JSON.stringify({ ...result, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
				);
				response.end("data: [DONE]\n\n");
			} else {
				response.writeHead(200, { "Content-Type": "application/json" });
				response.end(
					JSON.stringify({
						...result,
						object: "chat.completion",
						choices: [{ index: 0, message, finish_reason: "stop" }],
					}),
				);
			}
		} catch {
			response.writeHead(400).end();
		}
	});
	let opencodeHandle: Awaited<ReturnType<typeof spawnOpenCode>> | undefined;
	let daemon: ForegroundDaemonHandle | undefined;
	let existingChildren = captureExistingChildren();
	try {
		await new Promise<void>((resolve, reject) => {
			modelServer.once("error", reject);
			modelServer.listen(0, "127.0.0.1", () => {
				modelServer.off("error", reject);
				resolve();
			});
		});
		const address = modelServer.address();
		if (!address || typeof address === "string")
			throw new Error("Missing local model port");
		const opencode = await spawnOpenCode({
			timeoutMs: 60_000,
			env: {
				OPENCODE_DISABLE_MODELS_FETCH: "true",
				OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
				OPENCODE_CONFIG_CONTENT: JSON.stringify({
					enabled_providers: [modelPick.providerId],
					model: `${modelPick.providerId}/${modelPick.modelId}`,
					small_model: `${modelPick.providerId}/${modelPick.modelId}`,
					provider: {
						[modelPick.providerId]: {
							npm: "@ai-sdk/openai-compatible",
							options: {
								baseURL: `http://127.0.0.1:${address.port}/v1`,
								apiKey: "fixture",
							},
							models: {
								[modelPick.modelId]: {
									name: "Side Thread restart fixture",
									tool_call: true,
									limit: { context: 16384, output: 1024 },
									cost: { input: 0, output: 0 },
								},
							},
						},
					},
				}),
			},
		});
		opencodeHandle = opencode;
		existingChildren = captureExistingChildren();
		daemon = await startDaemon(configDir, opencode.url);
		const projectSlug = (await daemon.addProject(projectDir)).slug;
		const sideId = await rpc(daemon, (client) =>
			Effect.gen(function* () {
				const parent = yield* client.CreateSession({
					permissionMode: "ask",
					projectSlug,
					originId: "daemon-side-thread-restart",
					providerId: "opencode",
					title: "Parent",
					model: {
						...modelPick,
						variant: "",
						contextWindow: "",
					},
				});
				const side = yield* client.StartSideThread({
					sessionId: parent.sessionId,
					title: "What is in this project?",
					inputId: randomUUID(),
					text: "Reply with exactly READY. Do not use tools.",
				});
				return side.sessionId;
			}),
		);
		const sideMessages = async () => {
			const response = await fetch(
				`${opencode.url}/session/${sideId}/message?directory=${encodeURIComponent(projectDir)}`,
			);
			return (await response.json()) as Array<{
				info: { role: string; agent?: string; time: { completed?: number } };
			}>;
		};
		// The first prompt rides on the start; let its turn finish so the
		// restart below does not interrupt it.
		await expect
			.poll(
				async () =>
					(await sideMessages()).some(
						(message) =>
							message.info.role === "assistant" &&
							message.info.time.completed !== undefined,
					),
				{ timeout: 60_000 },
			)
			.toBe(true);
		// Side Threads start in Ask; Plan proves a chosen mode is persisted
		// rather than re-derived from the default.
		await rpc(daemon, (client) =>
			client.SwitchPermissionMode({
				sessionId: sideId,
				mode: "plan",
			}),
		);

		const previousDaemon = daemon;
		await stopDaemonAndAssertNoSurvivors(
			() => previousDaemon.stop(),
			existingChildren,
		);
		daemon = await startDaemon(configDir, opencode.url);
		expect(daemon.getProjects().map((project) => project.slug)).toContain(
			projectSlug,
		);
		const restored = await rpc(daemon, (client) =>
			client.GetModels({ sessionId: sideId }),
		);
		expect(restored.permissionMode).toBe("plan");
		expect(restored.active).toMatchObject({
			provider: modelPick.providerId,
			model: modelPick.modelId,
		});

		const app = new AppPage(page);
		await page.goto(`http://127.0.0.1:${daemon.port}/s/${sideId}`);
		await app.connectOverlay.waitFor({ state: "detached", timeout: 30_000 });
		await expect(
			page.getByTestId("permission-mode-badge"),
		).toHaveAccessibleName("Permissions: Plan. Open options");

		await app.sendMessage("List the files here.");
		const agents = async () =>
			(await sideMessages())
				.filter((message) => message.info.role === "user")
				.map((message) => message.info.agent);
		// Side Threads keep the chosen agent in Plan; the session rules below
		// are what make it read-only.
		await expect.poll(agents, { timeout: 30_000 }).toEqual(["build", "build"]);
		const session = (await (
			await fetch(
				`${opencode.url}/session/${sideId}?directory=${encodeURIComponent(projectDir)}`,
			)
		).json()) as { permission?: unknown[] };
		// OpenCode appends each rule update and the last match wins: the Ask
		// rules from creation, then the Plan rules that override them.
		expect(session.permission).toEqual([
			{ permission: "edit", pattern: "*", action: "ask" },
			{ permission: "bash", pattern: "*", action: "ask" },
			{ permission: "task", pattern: "*", action: "allow" },
			{ permission: "edit", pattern: "*", action: "deny" },
			{ permission: "bash", pattern: "*", action: "ask" },
			{ permission: "task", pattern: "*", action: "deny" },
		]);
		await testInfo.attach("side-thread-restart-proof.json", {
			body: JSON.stringify(
				{
					sideId,
					restoredPick: restored,
					agents: await agents(),
					rules: session.permission,
					localModel: {
						requestCount: modelRequestCount,
						requests: modelRequests,
					},
				},
				null,
				2,
			),
			contentType: "application/json",
		});
	} finally {
		try {
			await stopDaemonAndAssertNoSurvivors(async () => {
				try {
					await daemon?.stop();
				} finally {
					await stopPtyHost({ configDir, force: true });
				}
			}, existingChildren);
		} finally {
			try {
				opencodeHandle?.stop();
			} finally {
				try {
					modelServer.closeAllConnections();
					if (modelServer.listening)
						await new Promise<void>((resolve, reject) =>
							modelServer.close((error) => (error ? reject(error) : resolve())),
						);
				} finally {
					rmSync(configDir, { recursive: true, force: true });
					rmSync(projectDir, { recursive: true, force: true });
				}
			}
		}
	}
});
