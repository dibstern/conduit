// conduit-test-ni8.14: the instance and project lists are daemon-global. A
// connection must learn about a change whichever project, connection, or CLI
// call it came from, and a health transition must reach it with no request.
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber, Layer, Stream } from "effect";
import { RpcClient, type RpcClientError, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import { describe, expect, it, vi } from "vitest";
import { run } from "../../../src/bin/cli-core.js";
import {
	type OpenCodeInstance,
	type ProjectInfo,
	WsRpcGroup,
} from "../../../src/lib/contracts/ws-rpc.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import { startForegroundDaemon } from "../../../src/lib/domain/daemon/Layers/daemon-foreground.js";
import { signedInCodexDiscoveryTrace } from "../../helpers/codex-app-server.js";

const browserProtocol = (port: number) =>
	RpcClient.layerProtocolSocket().pipe(
		Layer.provide(Socket.layerWebSocket(`ws://127.0.0.1:${port}/rpc`)),
		Layer.provide(Socket.layerWebSocketConstructorGlobal),
		Layer.provide(RpcSerialization.layerJson),
	);

type Client = RpcClient.FromGroup<
	typeof WsRpcGroup,
	RpcClientError.RpcClientError
>;

/** One unary call on its own browser connection. */
const browserCall = <A, E>(
	port: number,
	call: (client: Client) => Effect.Effect<A, E>,
) =>
	Effect.runPromise(
		Effect.scoped(Effect.flatMap(RpcClient.make(WsRpcGroup), call)).pipe(
			Effect.provide(browserProtocol(port)),
		),
	);

/** A connection that subscribes to both lists, in no project's scope. */
const subscribe = (port: number) => {
	const instances: (readonly OpenCodeInstance[])[] = [];
	const projects: (readonly ProjectInfo[])[] = [];
	const fiber = Effect.runFork(
		Effect.scoped(
			Effect.gen(function* () {
				const client = yield* RpcClient.make(WsRpcGroup);
				yield* Effect.all(
					[
						Stream.runForEach(client.SubscribeInstances({}), (list) =>
							Effect.sync(() => instances.push(list.instances)),
						),
						Stream.runForEach(client.SubscribeShell({}), (frame) =>
							Effect.sync(() => {
								if (frame._tag === "projects") projects.push(frame.projects);
							}),
						),
					],
					{ concurrency: "unbounded" },
				);
			}),
		).pipe(Effect.provide(browserProtocol(port))),
	);
	return {
		instances,
		projects,
		close: () => Effect.runPromise(Fiber.interrupt(fiber)),
	};
};

const healthServer = async () => {
	let healthy = false;
	const server = createServer((_request, response) => {
		response.setHeader("Content-Type", "application/json");
		response.end(JSON.stringify({ healthy }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Expected HTTP test listener");
	return {
		url: `http://127.0.0.1:${address.port}`,
		setHealthy: (next: boolean) => {
			healthy = next;
		},
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
};

describe("daemon instance and project lists fan out to every connection", () => {
	it("acknowledges an added instance while another provider's inventory is pending", async () => {
		const root = mkdtempSync(join(tmpdir(), "conduit-list-inventory-"));
		const configDir = join(root, "config");
		const socketPath = join(root, "relay.sock");
		const tracePath = join(root, "discovery.jsonl");
		const gatePath = join(root, "gate");
		const transportsPath = join(root, "transports.jsonl");
		writeFileSync(
			tracePath,
			`${signedInCodexDiscoveryTrace()
				.map((row) => JSON.stringify(row))
				.join("\n")}\n`,
		);
		writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
		vi.stubEnv("CONDUIT_CODEX_APP_SERVER_TRACE", tracePath);
		vi.stubEnv("CONDUIT_CODEX_APP_SERVER_TRACE_GATE", gatePath);
		vi.stubEnv("CONDUIT_TEST_CODEX_TRANSPORTS", transportsPath);
		let daemon: Awaited<ReturnType<typeof startForegroundDaemon>> | undefined;
		let inventory:
			| Promise<{ readonly instances: readonly OpenCodeInstance[] }>
			| undefined;
		try {
			daemon = await startForegroundDaemon({
				configDir,
				socketPath,
				port: 0,
				host: "127.0.0.1",
				keepAwake: false,
				smartDefault: false,
			});
			const running = daemon;
			await expect
				.poll(() =>
					running.getInstances().find(({ driver }) => driver === "codex"),
				)
				.toBeDefined();
			writeFileSync(gatePath, "0");
			inventory = browserCall(running.getStatus().port, (client) =>
				client.GetInstances({}),
			);
			// The named account's first discovery is held at its initialize reply.
			await expect
				.poll(() =>
					existsSync(transportsPath)
						? readFileSync(transportsPath, "utf8").includes(configDir)
						: false,
				)
				.toBe(true);
			const added = await sendRpcRequest(socketPath, {
				_tag: "AddInstance",
				name: "added-during-discovery",
				managed: false,
				url: "http://127.0.0.1:1",
			});
			expect(
				added.instances.find(({ id }) => id === added.addedInstanceId),
			).toMatchObject({
				name: "added-during-discovery",
				driver: "opencode",
			});
			writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
			expect(
				(await inventory).instances.find(({ driver }) => driver === "codex"),
			).toMatchObject({ available: true });
		} finally {
			writeFileSync(gatePath, String(Number.MAX_SAFE_INTEGER));
			await inventory?.catch(() => undefined);
			await daemon?.stop();
			vi.unstubAllEnvs();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("delivers changes made via another project's connection and via the CLI", async () => {
		const root = mkdtempSync(join(tmpdir(), "conduit-list-fanout-"));
		const socketPath = join(root, "relay.sock");
		const [dirA, dirB, dirCli] = ["a", "b", "cli"].map((name) => {
			const path = join(root, name);
			mkdirSync(path);
			return path;
		}) as [string, string, string];
		const health = await healthServer();
		let daemon: Awaited<ReturnType<typeof startForegroundDaemon>> | undefined;
		let subscriber: ReturnType<typeof subscribe> | undefined;
		try {
			daemon = await startForegroundDaemon({
				configDir: join(root, "config"),
				socketPath,
				port: 0,
				host: "127.0.0.1",
				keepAwake: false,
				smartDefault: false,
			});
			const port = daemon.getStatus().port;
			const projectA = await daemon.addProject(dirA);
			const projectB = await daemon.addProject(dirB);
			subscriber = subscribe(port);
			const latestProjects = () => subscriber?.projects.at(-1) ?? [];
			const latestInstances = () => subscriber?.instances.at(-1) ?? [];

			// Snapshot on subscribe.
			await expect
				.poll(
					() =>
						latestProjects()
							.map((p) => p.slug)
							.sort(),
					{
						timeout: 10_000,
					},
				)
				.toEqual([projectA.slug, projectB.slug].sort());
			await expect
				.poll(() => subscriber?.instances.length, { timeout: 10_000 })
				.toBeGreaterThan(0);

			// A connection working on project B renames B and adds an instance.
			await browserCall(port, (client) =>
				client.SaveProject({
					projectSlug: projectB.slug,
					slug: projectB.slug,
					folders: [dirB],
					title: "Renamed B",
				}),
			);
			await expect
				.poll(
					() => latestProjects().find((p) => p.slug === projectB.slug)?.title,
					{ timeout: 10_000 },
				)
				.toBe("Renamed B");
			await browserCall(port, (client) =>
				client.AddInstance({
					projectSlug: projectB.slug,
					name: "from-b",
					managed: false,
					url: health.url,
				}),
			);
			await expect
				.poll(() => latestInstances().map((i) => i.name), { timeout: 10_000 })
				.toContain("from-b");

			// The CLI adds an instance and a project over the Unix socket.
			await sendRpcRequest(socketPath, {
				_tag: "AddInstance",
				name: "from-cli",
				managed: false,
				url: health.url,
			});
			await expect
				.poll(() => latestInstances().map((i) => i.name), { timeout: 10_000 })
				.toContain("from-cli");
			const exits: number[] = [];
			await run(["node", "conduit", "--add"], {
				cwd: dirCli,
				stdout: { write: () => {} },
				stderr: { write: () => {} },
				exit: (code) => {
					exits.push(code);
				},
				isDaemonRunning: async () => true,
				sendRPC: (request) => sendRpcRequest(socketPath, request),
			});
			expect(exits).toEqual([]);
			await expect
				.poll(() => latestProjects().length, { timeout: 10_000 })
				.toBe(3);
		} finally {
			await subscriber?.close();
			await daemon?.stop();
			await health.close();
			rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);

	it("delivers an instance health transition with no request behind it", async () => {
		const root = mkdtempSync(join(tmpdir(), "conduit-list-fanout-"));
		const socketPath = join(root, "relay.sock");
		const options = {
			configDir: join(root, "config"),
			socketPath,
			port: 0,
			host: "127.0.0.1",
			keepAwake: false,
			smartDefault: false,
		};
		const health = await healthServer();
		let daemon: Awaited<ReturnType<typeof startForegroundDaemon>> | undefined;
		let subscriber: ReturnType<typeof subscribe> | undefined;
		try {
			daemon = await startForegroundDaemon(options);
			await sendRpcRequest(socketPath, {
				_tag: "AddInstance",
				name: "probe",
				managed: false,
				url: health.url,
			});
			// Restart so the persisted instance gets a real health poller. External
			// instances are health-checked from first use, so start it once; the
			// start rejects while the server is unhealthy.
			await daemon.stop();
			daemon = await startForegroundDaemon(options);
			subscriber = subscribe(daemon.getStatus().port);
			const probe = () =>
				subscriber?.instances.at(-1)?.find((i) => i.name === "probe");
			const probeStatus = () => probe()?.status;
			await expect.poll(probeStatus, { timeout: 15_000 }).toBe("stopped");
			await sendRpcRequest(socketPath, {
				_tag: "StartInstance",
				instanceId: probe()?.id ?? "",
			}).catch(() => undefined);
			await expect
				.poll(probeStatus, { timeout: 15_000, interval: 100 })
				.toBe("unhealthy");
			health.setHealthy(true);
			await expect
				.poll(probeStatus, { timeout: 15_000, interval: 100 })
				.toBe("healthy");
		} finally {
			await subscriber?.close();
			await daemon?.stop();
			await health.close();
			rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);
});
