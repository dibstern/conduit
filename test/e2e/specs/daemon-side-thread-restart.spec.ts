// An OpenCode Side Thread switched to Plan stays there across a daemon restart: the selector
// still shows Plan and OpenCode still holds the read-only session rules.
// Spawns its own ephemeral OpenCode, so no live instance or password is needed.

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Socket } from "@effect/platform";
import { RpcClient, RpcSerialization } from "@effect/rpc";
import { expect, test } from "@playwright/test";
import { Effect } from "effect";
import NodeWebSocket from "ws";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import {
	type ForegroundDaemonHandle,
	startForegroundDaemon,
} from "../../../src/lib/domain/daemon/Layers/daemon-foreground.js";
import { stopPtyHost } from "../../../src/lib/terminal/pty-host-client.js";
import { spawnOpenCode } from "../helpers/opencode-spawner.js";
import { AppPage } from "../page-objects/app.page.js";

const staticDir = resolve(import.meta.dirname, "../../../dist/frontend");
const modelPick = "opencode/mimo-v2.6-flash-free";

function startDaemon(configDir: string, opencodeUrl: string) {
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
	const opencode = await spawnOpenCode({
		timeoutMs: 60_000,
		env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: modelPick }) },
	});
	const configDir = mkdtempSync(join(tmpdir(), "e2e-side-restart-"));
	const projectDir = mkdtempSync(join(tmpdir(), "e2e-side-restart-project-"));
	let daemon: ForegroundDaemonHandle | undefined;
	try {
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
						providerId: "opencode",
						modelId: "mimo-v2.6-flash-free",
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

		await daemon.stop();
		daemon = await startDaemon(configDir, opencode.url);
		expect(daemon.getProjects().map((project) => project.slug)).toContain(
			projectSlug,
		);
		const restored = await rpc(daemon, (client) =>
			client.GetModels({ sessionId: sideId }),
		);
		expect(restored.permissionMode).toBe("plan");
		expect(restored.active).toMatchObject({
			provider: "opencode",
			model: "mimo-v2.6-flash-free",
		});

		const app = new AppPage(page);
		await page.goto(`http://127.0.0.1:${daemon.port}/s/${sideId}`);
		await app.connectOverlay.waitFor({ state: "detached", timeout: 30_000 });
		await expect(page.getByTestId("permission-mode-badge")).toContainText(
			"Plan",
		);

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
				},
				null,
				2,
			),
			contentType: "application/json",
		});
	} finally {
		await daemon?.stop();
		await stopPtyHost({ configDir, force: true });
		opencode.stop();
		rmSync(configDir, { recursive: true, force: true });
		rmSync(projectDir, { recursive: true, force: true });
	}
});
