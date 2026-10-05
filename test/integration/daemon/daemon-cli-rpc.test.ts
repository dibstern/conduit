import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Socket } from "@effect/platform";
import { RpcClient, RpcSerialization } from "@effect/rpc";
import { Effect, Layer, Queue, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { run } from "../../../src/bin/cli-core.js";
import {
	AddInstance,
	GetInstances,
	GetProjects,
	GetStatus,
	SetDefaultModel,
	Shutdown,
	UpdateInstance,
	WsRpcGroup,
} from "../../../src/lib/contracts/ws-rpc.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import { makeDaemonRpcSocketLayer } from "../../../src/lib/daemon/daemon-rpc-server.js";
import { startForegroundDaemon } from "../../../src/lib/domain/daemon/Layers/daemon-foreground.js";
import { subscribeProjectSettings } from "../../../src/lib/domain/relay/Services/project-settings.js";
import { getDefaultModel } from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { loadRelaySettings } from "../../../src/lib/relay/relay-settings.js";
import {
	makeRoutedWsRpcServerLayer,
	type WsRpcServerLayer,
} from "../../../src/lib/server/ws-rpc.js";
import {
	makeMockConfig,
	makeMockOpenCodeAPI,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";

describe("CLI and browser daemon RPC parity", () => {
	it("sets model defaults over the Unix transport using the existing browser RPC", async () => {
		const root = mkdtempSync(join(tmpdir(), "conduit-model-rpc-"));
		const socketPath = join(root, "relay.sock");
		const api = makeMockOpenCodeAPI();
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const context =
							yield* Effect.context<
								Layer.Layer.Context<typeof WsRpcServerLayer>
							>();
						yield* Layer.build(
							makeDaemonRpcSocketLayer(
								socketPath,
								makeRoutedWsRpcServerLayer(() => Effect.succeed(context)),
							),
						);
						// An open browser tab on the project (ni8.12 acceptance 4).
						const tab = yield* Queue.unbounded<unknown>();
						yield* Stream.runForEach(subscribeProjectSettings(), (envelope) =>
							Queue.offer(tab, envelope),
						).pipe(Effect.forkScoped);
						yield* Queue.takeBetween(tab, 2, 2); // snapshot + synchronized
						const result = yield* Effect.promise(() =>
							sendRpcRequest(
								socketPath,
								new SetDefaultModel({
									projectSlug: "project",
									provider: "openai",
									model: "gpt-4",
								}),
							),
						);
						expect(result).toMatchObject({
							projectSlug: "project",
							provider: "openai",
							model: "gpt-4",
						});
						expect(yield* getDefaultModel()).toEqual({
							providerID: "openai",
							modelID: "gpt-4",
						});
						expect(loadRelaySettings(root).defaultModel).toBe("openai/gpt-4");
						expect(yield* Queue.take(tab)).toMatchObject({
							_tag: "upsert",
							item: {
								_tag: "defaultModel",
								model: "gpt-4",
								provider: "openai",
							},
						});
						expect(api.config.update).toHaveBeenCalledWith({
							model: "openai/gpt-4",
						});
					}),
				).pipe(
					Effect.provide(
						makeTestHandlerLayer({
							api,
							config: makeMockConfig({ configDir: root }),
						}),
					),
				),
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("starts over an abandoned socket and flushes the shutdown reply before stopping", async () => {
		const root = mkdtempSync(join(tmpdir(), "conduit-stale-rpc-"));
		const socketPath = join(root, "relay.sock");
		execFileSync(process.execPath, [
			"-e",
			"require('node:net').createServer().listen(process.argv[1], () => process.exit(0))",
			socketPath,
		]);
		expect(statSync(socketPath).isSocket()).toBe(true);
		let daemon: Awaited<ReturnType<typeof startForegroundDaemon>> | undefined;
		try {
			daemon = await startForegroundDaemon({
				configDir: join(root, "config"),
				socketPath,
				port: 0,
				host: "127.0.0.1",
				keepAwake: false,
				smartDefault: false,
			});
			const status = await sendRpcRequest(socketPath, new GetStatus({}));
			expect(status.port).toBeGreaterThan(0);
			expect(status.clientCount).toBe(1);
			expect(await sendRpcRequest(socketPath, new Shutdown({}))).toEqual({
				ok: true,
			});
			await daemon.stopped;
			expect(existsSync(socketPath)).toBe(false);
		} finally {
			await daemon?.stop();
			rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);

	it("keeps failed instance commands unsuccessful without registering invalid instances", async () => {
		const root = mkdtempSync(join(tmpdir(), "conduit-instance-rpc-"));
		const socketPath = join(root, "relay.sock");
		let daemon: Awaited<ReturnType<typeof startForegroundDaemon>> | undefined;
		try {
			daemon = await startForegroundDaemon({
				configDir: join(root, "config"),
				socketPath,
				port: 0,
				host: "127.0.0.1",
				keepAwake: false,
				smartDefault: false,
			});
			for (const action of ["start", "stop", "remove", "status"]) {
				let output = "";
				let errors = "";
				const exits: number[] = [];
				await run(["node", "conduit", "--instance", action, "missing"], {
					stdout: {
						write: (text) => {
							output += text;
						},
					},
					stderr: {
						write: (text) => {
							errors += text;
						},
					},
					exit: (code) => {
						exits.push(code);
					},
					isDaemonRunning: async () => true,
					sendRPC: (request) => sendRpcRequest(socketPath, request),
				});
				expect(output).toBe("");
				const label =
					action === "status" ? "get instance status" : `${action} instance`;
				expect(errors).toBe(
					`Failed to ${label}: Instance "missing" not found\n`,
				);
				expect(exits).toEqual([1]);
			}
			for (const flags of [
				[],
				["--managed"],
				["--port", "0"],
				["--url", "invalid"],
			]) {
				let output = "";
				let errors = "";
				const exits: number[] = [];
				await run(
					["node", "conduit", "--instance", "add", "invalid", ...flags],
					{
						stdout: {
							write: (text) => {
								output += text;
							},
						},
						stderr: {
							write: (text) => {
								errors += text;
							},
						},
						exit: (code) => {
							exits.push(code);
						},
						isDaemonRunning: async () => true,
						sendRPC: (request) => sendRpcRequest(socketPath, request),
					},
				);
				expect(output).toBe("");
				expect(errors).toMatch(/^Failed to add instance:/);
				expect(exits).toEqual([1]);
			}
			expect(
				(await sendRpcRequest(socketPath, new GetInstances({}))).instances,
			).toEqual([]);
			await expect(
				sendRpcRequest(
					socketPath,
					new UpdateInstance({ instanceId: "missing", name: "updated" }),
				),
			).rejects.toMatchObject({ message: 'Instance "missing" not found' });
		} finally {
			await daemon?.stop();
			rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);

	it("registers CLI projects with the healthy default and flushes browser restart replies", async () => {
		const root = mkdtempSync(join(tmpdir(), "conduit-default-rpc-"));
		const socketPath = join(root, "relay.sock");
		const configDir = join(root, "config");
		const options = {
			configDir,
			socketPath,
			port: 0,
			host: "127.0.0.1",
			keepAwake: false,
			smartDefault: false,
		};
		const servers = [false, true].map((healthy) =>
			createServer((_request, response) => {
				response.setHeader("Content-Type", "application/json");
				response.end(JSON.stringify({ healthy }));
			}),
		);
		let daemon: Awaited<ReturnType<typeof startForegroundDaemon>> | undefined;
		try {
			for (const server of servers) {
				await new Promise<void>((resolve) =>
					server.listen(0, "127.0.0.1", resolve),
				);
			}
			daemon = await startForegroundDaemon(options);
			for (const [index, server] of servers.entries()) {
				const address = server.address();
				if (!address || typeof address === "string")
					throw new Error("Expected HTTP test listener");
				await sendRpcRequest(
					socketPath,
					new AddInstance({
						name: index === 0 ? "unhealthy" : "healthy",
						managed: false,
						url: `http://127.0.0.1:${address.port}`,
					}),
				);
			}
			await daemon.stop();
			daemon = await startForegroundDaemon(options);
			await expect
				.poll(
					async () =>
						(
							await sendRpcRequest(socketPath, new GetInstances({}))
						).instances.find((instance) => instance.id === "healthy")?.status,
				)
				.toBe("healthy");
			let output = "";
			let errors = "";
			const exits: number[] = [];
			await run(["node", "conduit", "--add"], {
				cwd: root,
				stdout: {
					write: (text) => {
						output += text;
					},
				},
				stderr: {
					write: (text) => {
						errors += text;
					},
				},
				exit: (code) => {
					exits.push(code);
				},
				isDaemonRunning: async () => true,
				sendRPC: (request) => sendRpcRequest(socketPath, request),
			});
			const projects = (await sendRpcRequest(socketPath, new GetProjects({})))
				.projects;
			expect(projects).toHaveLength(1);
			expect(projects[0]?.instanceId).toBe("healthy");
			expect(output).toBe(`Project added: ${projects[0]?.slug}\n`);
			expect(errors).toBe("");
			expect(exits).toEqual([]);
			const browserProtocol = RpcClient.layerProtocolSocket().pipe(
				Layer.provide(
					Socket.layerWebSocket(`ws://127.0.0.1:${daemon.port}/rpc`),
				),
				Layer.provide(Socket.layerWebSocketConstructorGlobal),
				Layer.provide(RpcSerialization.layerJson),
			);
			const restarted = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const client = yield* RpcClient.make(WsRpcGroup);
						return yield* client.RestartWithConfig({
							config: { keepAwake: true },
						});
					}),
				).pipe(Effect.provide(browserProtocol)),
			);
			expect(restarted).toEqual({ ok: true });
			await daemon.stopped;
			expect(
				JSON.parse(readFileSync(join(configDir, "daemon.json"), "utf-8")),
			).toMatchObject({ keepAwake: true });
		} finally {
			await daemon?.stop();
			for (const server of servers) {
				server.closeAllConnections();
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
			rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);

	it("removes projects through the CLI and browser with the same persisted dismissal", async () => {
		const root = mkdtempSync(join(tmpdir(), "conduit-cli-rpc-"));
		const configDir = join(root, "config");
		const cliDirectory = join(root, "cli-project");
		const browserDirectory = join(root, "browser-project");
		mkdirSync(cliDirectory);
		mkdirSync(browserDirectory);
		const socketPath = join(root, "relay.sock");
		const options = {
			configDir,
			socketPath,
			port: 0,
			host: "127.0.0.1",
			keepAwake: false,
			smartDefault: false,
		};
		let daemon: Awaited<ReturnType<typeof startForegroundDaemon>> | undefined;
		try {
			daemon = await startForegroundDaemon(options);
			const cliProject = await daemon.addProject(cliDirectory);
			const browserProject = await daemon.addProject(browserDirectory);
			let output = "";
			let errors = "";
			const exits: number[] = [];
			await run(["node", "conduit", "--remove"], {
				cwd: cliDirectory,
				stdout: {
					write: (text) => {
						output += text;
					},
				},
				stderr: {
					write: (text) => {
						errors += text;
					},
				},
				exit: (code) => {
					exits.push(code);
				},
				isDaemonRunning: async () => true,
				sendRPC: (request) => sendRpcRequest(socketPath, request),
			});
			expect(output).toBe(`Project removed: ${cliProject.slug}\n`);
			expect(errors).toBe("");
			expect(exits).toEqual([]);
			const browserProtocol = RpcClient.layerProtocolSocket().pipe(
				Layer.provide(
					Socket.layerWebSocket(
						`ws://127.0.0.1:${daemon.getStatus().port}/rpc`,
					),
				),
				Layer.provide(Socket.layerWebSocketConstructorGlobal),
				Layer.provide(RpcSerialization.layerJson),
			);
			const browserResult = await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const client = yield* RpcClient.make(WsRpcGroup);
						return yield* client.RemoveProject({ slug: browserProject.slug });
					}),
				).pipe(Effect.provide(browserProtocol)),
			);
			expect(browserResult.projects).toEqual([]);
			expect(
				(await sendRpcRequest(socketPath, new GetProjects({}))).projects,
			).toEqual([]);
			await daemon.stop();
			daemon = undefined;
			const persisted: unknown = JSON.parse(
				readFileSync(join(configDir, "daemon.json"), "utf-8"),
			);
			expect(persisted).toMatchObject({ projects: [] });
			daemon = await startForegroundDaemon(options);
			expect(
				(await sendRpcRequest(socketPath, new GetProjects({}))).projects,
			).toEqual([]);
		} finally {
			await daemon?.stop();
			rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);
});
