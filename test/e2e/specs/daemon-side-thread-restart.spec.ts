// An OpenCode Side Thread stays in Plan across a daemon restart: the selector
// still shows Plan and the next prompt still runs OpenCode's plan agent.
// Spawns its own ephemeral OpenCode, so no live instance or password is needed.

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

async function startDaemon(configDir: string, opencodeUrl: string) {
	const daemon = await startForegroundDaemon({
		port: 0,
		host: "127.0.0.1",
		configDir,
		socketPath: join(configDir, "relay.sock"),
		opencodeUrl,
		staticDir,
		logLevel: "error",
	});
	await expect
		.poll(() => daemon.getInstances().some((i) => i.status === "healthy"), {
			timeout: 15_000,
		})
		.toBe(true);
	return daemon;
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

test("a Side Thread keeps Plan and the plan agent after a daemon restart", async ({
	page,
	isMobile,
}) => {
	test.skip(isMobile, "One viewport proves the restart path");
	test.setTimeout(120_000);
	const opencode = await spawnOpenCode({ timeoutMs: 60_000 });
	const configDir = mkdtempSync(join(tmpdir(), "e2e-side-restart-"));
	const projectDir = mkdtempSync(join(tmpdir(), "e2e-side-restart-project-"));
	let daemon: ForegroundDaemonHandle | undefined;
	try {
		daemon = await startDaemon(configDir, opencode.url);
		const projectSlug = (await daemon.addProject(projectDir)).slug;
		const sideId = await rpc(daemon, (client) =>
			Effect.gen(function* () {
				const parent = yield* client.CreateSession({
					projectSlug,
					originId: "daemon-side-thread-restart",
					providerId: "opencode",
					title: "Parent",
				});
				const side = yield* client.StartSideThread({
					projectSlug,
					parentSessionId: parent.sessionId,
					title: "What is in this project?",
				});
				return side.sessionId;
			}),
		);

		await daemon.stop();
		daemon = await startDaemon(configDir, opencode.url);
		expect(daemon.getProjects().map((project) => project.slug)).toContain(
			projectSlug,
		);
		const restored = await rpc(daemon, (client) =>
			client.GetModels({ projectSlug, sessionId: sideId }),
		);
		expect(restored.permissionMode).toBe("plan");

		const app = new AppPage(page);
		await page.goto(`http://127.0.0.1:${daemon.port}/s/${sideId}`);
		await app.connectOverlay.waitFor({ state: "detached", timeout: 30_000 });
		await expect(page.getByTestId("permission-mode-badge")).toContainText(
			"Plan",
		);

		await app.sendMessage("List the files here.");
		const agents = async () => {
			const response = await fetch(
				`${opencode.url}/session/${sideId}/message?directory=${encodeURIComponent(projectDir)}`,
			);
			const messages = (await response.json()) as Array<{
				info: { role: string; agent?: string };
			}>;
			return messages
				.filter((message) => message.info.role === "user")
				.map((message) => message.info.agent);
		};
		await expect.poll(agents, { timeout: 30_000 }).toEqual(["plan"]);
		const session = (await (
			await fetch(
				`${opencode.url}/session/${sideId}?directory=${encodeURIComponent(projectDir)}`,
			)
		).json()) as { permission?: unknown[] };
		expect(session.permission).toEqual([
			{ permission: "edit", pattern: "*", action: "deny" },
			{ permission: "bash", pattern: "*", action: "ask" },
			{ permission: "task", pattern: "*", action: "deny" },
		]);
	} finally {
		await daemon?.stop();
		await stopPtyHost({ configDir, force: true });
		opencode.stop();
		rmSync(configDir, { recursive: true, force: true });
		rmSync(projectDir, { recursive: true, force: true });
	}
});
