// OpenCode stream events reach the daemon's read model through Effect runtime ingress.
// Isolated race failures (public ContinueSession refuses busy turns):
// - A provider switch during workspace resolution aborts unrelated provider events.
// - A refused move leaves its runner receipt uncommitted and is replayed.
// - A refused move changes the workspace or loses its warning.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Context,
	Deferred,
	Effect,
	Fiber,
	Layer,
	ManagedRuntime,
	Option,
	PubSub,
	Stream,
} from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it, vi } from "vitest";
import { AccountIdSchema } from "../../../src/lib/contracts/provider-instance.js";
import type { DaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import {
	type OpenCodeInstanceEvent,
	OpenCodeInstancesTag,
} from "../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import { ProjectServices } from "../../../src/lib/domain/daemon/Services/project-services.js";
import { SessionDirectory } from "../../../src/lib/domain/daemon/Services/session-directory.js";
import { makeEffectOpenCodeRuntimeIngress } from "../../../src/lib/domain/relay/Services/opencode-runtime-ingress-service.js";
import {
	ProviderRuntimeIngestionLive,
	ProviderRuntimeIngestionTag,
} from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { LoggerTag } from "../../../src/lib/domain/relay/Services/services.js";
import { applySessionCommand } from "../../../src/lib/domain/relay/Services/session-command.js";
import { projectSessionManager } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import { SessionWorkspaceTag } from "../../../src/lib/domain/relay/Services/session-workspace.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { makeRunnerAuthority } from "../../../src/lib/provider/runner/runner-authority.js";
import {
	currentRunnerOutput,
	makeRunnerReceiptStore,
} from "../../../src/lib/provider/runner/runner-receipts.js";
import {
	createDaemonProject,
	type DaemonProject,
	FixedShellEnv,
} from "../../helpers/in-process-daemon.js";
import {
	makeMockOpenCodeAPI,
	makeOpenCodeInstancesStub,
} from "../../helpers/mock-factories.js";
import { providerRuntimeEvent } from "../../helpers/provider-runtime-event.js";
import { makeSSEEvent } from "../../helpers/sse-factories.js";

interface MockOpenCode {
	readonly url: string;
	readonly waitForSseClient: () => Promise<void>;
	readonly injectSSE: (
		events: readonly { type: string; properties: Record<string, unknown> }[],
	) => void;
	readonly disconnectSse: () => void;
	readonly sseConnectionCount: () => number;
	readonly historyRequestCount: () => number;
	readonly close: () => Promise<void>;
}

const listenOnRandomPort = (server: ReturnType<typeof createServer>) =>
	new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

const closeServer = (server: ReturnType<typeof createServer>) =>
	new Promise<void>((resolve) => server.close(() => resolve()));

async function createMockOpenCode(directory: string): Promise<MockOpenCode> {
	const sseClients = new Set<ServerResponse>();
	const globalClients = new Set<ServerResponse>();
	let eventId = 0;
	let sseConnections = 0;
	let historyRequests = 0;
	let resolveSseClient: (() => void) | undefined;
	const sseClientConnected = new Promise<void>((resolve) => {
		resolveSseClient = resolve;
	});

	function handler(req: IncomingMessage, res: ServerResponse) {
		const url = new URL(req.url ?? "/", "http://localhost");

		if (url.pathname === "/event" || url.pathname === "/global/event") {
			const global = url.pathname === "/global/event";
			sseConnections++;
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			});
			const connected = {
				id: "evt_connected",
				type: "server.connected",
				properties: {},
			};
			res.write(
				`data: ${JSON.stringify(global ? { payload: connected } : connected)}\n\n`,
			);
			sseClients.add(res);
			if (global) globalClients.add(res);
			resolveSseClient?.();
			req.on("close", () => {
				sseClients.delete(res);
				globalClients.delete(res);
			});
			return;
		}

		res.setHeader("Content-Type", "application/json");
		if (url.pathname === "/global/health" && req.method === "GET") {
			res.end(JSON.stringify({ healthy: true, version: "1.0.0" }));
			return;
		}
		if (url.pathname === "/path") {
			res.end(
				JSON.stringify({
					state: "/test/state",
					config: "/test/config",
					worktree: "/test",
					directory: "/test",
				}),
			);
			return;
		}
		if (url.pathname === "/session" && req.method === "GET") {
			res.end(
				JSON.stringify([
					{
						id: "sess-1",
						projectID: "project-1",
						directory: "/test",
						title: "Session 1",
						version: "1.0.0",
						time: { created: 1, updated: 1 },
						modelID: "gpt-4",
						providerID: "openai",
					},
				]),
			);
			return;
		}
		if (url.pathname === "/session/status") {
			res.end(JSON.stringify({ "sess-1": { type: "idle" } }));
			return;
		}
		if (url.pathname.match(/^\/session\/[\w-]+$/) && req.method === "GET") {
			res.end(
				JSON.stringify({
					id: "sess-1",
					projectID: "project-1",
					directory: "/test",
					title: "Session 1",
					version: "1.0.0",
					time: { created: 1, updated: 1 },
					modelID: "gpt-4",
					providerID: "openai",
				}),
			);
			return;
		}
		if (
			url.pathname.match(/^\/session\/[\w-]+\/message$/) &&
			req.method === "GET"
		) {
			historyRequests++;
			res.end(JSON.stringify([]));
			return;
		}
		if (url.pathname === "/agent") {
			res.end(
				JSON.stringify([
					{
						name: "coder",
						mode: "primary",
						builtIn: true,
						permission: { edit: "ask", bash: {} },
						tools: {},
						options: {},
					},
				]),
			);
			return;
		}
		if (url.pathname === "/provider") {
			res.end(JSON.stringify({ all: [], default: {}, connected: [] }));
			return;
		}
		if (url.pathname === "/question" || url.pathname === "/permission") {
			res.end(JSON.stringify([]));
			return;
		}

		res.end("{}");
	}

	const server = createServer(handler);
	await listenOnRandomPort(server);
	const address = server.address();
	if (address == null || typeof address === "string") {
		throw new Error("mock OpenCode server did not bind to a TCP port");
	}

	return {
		url: `http://127.0.0.1:${address.port}`,
		waitForSseClient: () => sseClientConnected,
		injectSSE(events) {
			for (const event of events) {
				const payload = { id: `evt_${++eventId}`, ...event };
				for (const client of sseClients) {
					client.write(
						`data: ${JSON.stringify(globalClients.has(client) ? { directory, payload } : payload)}\n\n`,
					);
				}
			}
		},
		disconnectSse() {
			for (const client of sseClients) client.end();
		},
		sseConnectionCount: () => sseConnections,
		historyRequestCount: () => historyRequests,
		async close() {
			for (const client of sseClients) client.end();
			sseClients.clear();
			await closeServer(server);
		},
	};
}

async function eventually<T>(
	read: () => Promise<T>,
	matches: (value: T) => boolean,
	timeoutMs = 3_000,
): Promise<T> {
	return vi.waitFor(
		async () => {
			const value = await read();
			if (matches(value)) return value;
			throw new Error(
				`condition not met before timeout; last value=${JSON.stringify(value)}`,
			);
		},
		{ timeout: timeoutMs },
	);
}

describe("Daemon Effect OpenCode runtime ingress", () => {
	it("EffectOpenCodeRuntimeIngress can process SSE events with Effect persistence", async () => {
		const dir = mkdtempSync(join(tmpdir(), "conduit-effect-runtime-ingress-"));
		const persistenceLayer = makePersistenceEffectLayer(
			join(dir, "events.db"),
			"test-project",
		);
		const runtime = ManagedRuntime.make(
			Layer.mergeAll(
				persistenceLayer,
				ProviderRuntimeIngestionLive.pipe(Layer.provide(persistenceLayer)),
			),
		);
		try {
			const hook = await runtime.runPromise(
				makeEffectOpenCodeRuntimeIngress(
					createSilentLogger().child("opencode-runtime-ingress"),
				),
			);

			const result = await Effect.runPromise(
				hook.onSSEEventEffect(
					{
						type: "message.created",
						properties: {
							sessionID: "test-session",
							messageID: "msg-001",
							info: { role: "assistant", parts: [] },
						},
					},
					"test-session",
					"opencode",
				),
			);

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.eventsWritten).toBeGreaterThan(0);
			}
		} finally {
			await runtime.dispose();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("wires daemon SSE events into the read model and resolves only its stored owner", async () => {
		const dir = mkdtempSync(join(tmpdir(), "conduit-daemon-runtime-ingress-"));
		const projectDir = join(dir, "project");
		mkdirSync(projectDir, { recursive: true });
		const mock = await createMockOpenCode(projectDir);
		let project: DaemonProject | undefined;
		try {
			// The daemon uses each external OpenCode at start, which opens the stream.
			project = await createDaemonProject("chat-simple", {
				opencodeUrl: mock.url,
				projectDir,
				slug: "runtime-ingress-smoke",
			});
			const { run } = project;
			await mock.waitForSseClient();

			mock.injectSSE([
				{
					type: "message.created",
					properties: {
						sessionID: "sess-1",
						messageID: "msg-1",
						info: { role: "assistant", parts: [] },
					},
				},
				{
					type: "message.part.delta",
					properties: {
						sessionID: "sess-1",
						messageID: "msg-1",
						partID: "part-1",
						field: "text",
						delta: "hello from the daemon",
					},
				},
			]);

			const messages = await eventually(
				() =>
					run(
						Effect.flatMap(ReadQueryEffectTag, (readQuery) =>
							readQuery.getSessionMessagesWithParts("sess-1"),
						),
					),
				(rows) =>
					rows.some(
						(row) =>
							row.id === "msg-1" &&
							row.role === "assistant" &&
							row.parts.some((part) => part.text === "hello from the daemon"),
					),
			);

			expect(messages).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						id: "msg-1",
						role: "assistant",
						parts: expect.arrayContaining([
							expect.objectContaining({ text: "hello from the daemon" }),
						]),
					}),
				]),
			);
			const owners = await run(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`INSERT INTO sessions (id, provider, title, status, created_at, updated_at, project_id)
						VALUES ('foreign-owner', 'claude', 'Foreign', 'idle', 1, 1, 'another-project')`;
					const directory = yield* SessionDirectory;
					return yield* Effect.all(
						["sess-1", "foreign-owner", "missing"].map(directory.projectOf),
					);
				}),
			);
			expect(owners).toEqual([
				Option.some("runtime-ingress-smoke"),
				Option.none(),
				Option.none(),
			]);
		} finally {
			await project?.stop();
			await mock.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("commits provider output when a resolved workspace move is refused", async () => {
		const dir = mkdtempSync(join(tmpdir(), "conduit-workspace-provider-race-"));
		const projectDir = join(dir, "project");
		mkdirSync(projectDir);
		const mock = await createMockOpenCode(projectDir);
		let project: DaemonProject | undefined;
		try {
			project = await createDaemonProject("chat-simple", {
				opencodeUrl: mock.url,
				projectDir,
				slug: "workspace-provider-race",
			});
			// The project's ingestion logs with the project's logger (82tn.16), not the relay's.
			const log = await project.daemon.runPromise(
				Effect.flatMap(ProjectServices, (projects) =>
					projects.forProject("workspace-provider-race"),
				).pipe(Effect.map((context) => Context.get(context, LoggerTag))),
			);
			const warning = vi.spyOn(log, "warn");
			const program = Effect.scoped(
				Effect.gen(function* () {
					const sessionId = "workspace-provider-race";
					yield* applySessionCommand(
						{
							type: "session.created",
							data: {
								sessionId,
								title: "Workspace race",
								provider: "claude",
							},
						},
						{ upstreamAdapter: null },
					);
					const sql = yield* SqlClient.SqlClient;
					const receipts = yield* makeRunnerReceiptStore(sql);
					const runnerId = "workspace-race-runner";
					const attachmentId = "workspace-race-attachment";
					const authority = yield* makeRunnerAuthority(receipts);
					const grant = (yield* authority.adopt(
						[{ runnerId, sessionId }],
						"live",
					)).grants.get(runnerId);
					if (!grant)
						return yield* Effect.die("Missing adopted workspace runner grant");
					yield* receipts.attach(runnerId, attachmentId);
					const committed = yield* Deferred.make<void>();
					const resolved = yield* Deferred.make<void>();
					const release = yield* Deferred.make<void>();
					const workspace = yield* SessionWorkspaceTag;
					const resolve = vi
						.spyOn(workspace, "resolve")
						.mockImplementationOnce(() =>
							Effect.gen(function* () {
								yield* Deferred.succeed(resolved, undefined);
								yield* Deferred.await(release);
								return {
									path: projectDir,
									projectFolder: projectDir,
									reset: true,
									provider: "claude",
								};
							}),
						);
					return yield* Effect.gen(function* () {
						const ingestion = yield* ProviderRuntimeIngestionTag;
						const receipt = {
							runnerId,
							attachmentId,
							sequence: 1,
							committed,
							consumed: false,
						};
						const append = yield* Effect.forkChild(
							authority.guarded(
								grant,
								{ kind: "output" },
								ingestion
									.ingestBatch([
										providerRuntimeEvent("workspace.changed", sessionId, {
											path: projectDir,
											source: "tool",
										}),
										providerRuntimeEvent("session.status", sessionId, {
											sessionId,
											status: "busy",
										}),
									])
									.pipe(Effect.provideService(currentRunnerOutput, receipt)),
							),
						);
						yield* Deferred.await(resolved);
						yield* applySessionCommand(
							{
								type: "session.provider_changed",
								data: {
									sessionId,
									oldProvider: "claude",
									newProvider: "opencode",
									reason: "user",
								},
							},
							{ upstreamAdapter: null },
						);
						yield* Deferred.succeed(release, undefined);
						yield* Fiber.join(append);
						const read = yield* ReadQueryEffectTag;
						const store = yield* EventStoreEffectTag;
						return {
							row: yield* read.getSession(sessionId),
							events: yield* store.readBySession(sessionId),
							checkpoint: yield* receipts.read(runnerId),
							consumed: receipt.consumed,
						};
					}).pipe(Effect.ensuring(Effect.sync(() => resolve.mockRestore())));
				}),
			);
			const result = await project.run(program);
			expect(result.row).toMatchObject({
				provider: "opencode",
				status: "busy",
				workspace: null,
			});
			expect(result.events.map(({ type }) => type)).toContain("session.status");
			expect(result.events.map(({ type }) => type)).not.toContain(
				"session.workspace_changed",
			);
			expect(result.checkpoint.sequence).toBe(1);
			expect(result.consumed).toBe(true);
			expect(warning).toHaveBeenCalledWith(
				"Invalid agent workspace move",
				expect.objectContaining({ reason: "unsupported-provider" }),
			);
		} finally {
			vi.restoreAllMocks();
			await project?.stop();
			await mock.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps named OpenCode stream provider bindings isolated through the shared ingress", async () => {
		const dir = mkdtempSync(join(tmpdir(), "conduit-daemon-named-ingress-"));
		const projectDir = join(dir, "project");
		const configDir = join(dir, "config");
		const personalSessionId = "sess-daemon-personal";
		const workSessionId = "sess-daemon-work";
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(configDir, { recursive: true });
		const defaultMock = await createMockOpenCode(projectDir);
		const workMock = await createMockOpenCode(projectDir);
		const personalMock = await createMockOpenCode(projectDir);
		writeFileSync(
			join(configDir, "daemon.json"),
			JSON.stringify({
				pid: 1234,
				port: 2633,
				pinHash: null,
				tls: false,
				debug: false,
				keepAwake: false,
				projects: [],
				instances: [
					{
						id: "work-oc",
						name: "Work OpenCode",
						port: 0,
						managed: false,
						driver: "opencode",
						url: workMock.url,
					},
					{
						id: "personal-oc",
						name: "Personal OpenCode",
						port: 0,
						managed: false,
						driver: "opencode",
						url: personalMock.url,
					},
				],
			} satisfies DaemonConfig),
		);

		let project: DaemonProject | undefined;
		let held: Fiber.Fiber<never, unknown> | undefined;
		try {
			// The daemon uses both named instances at start, opening their streams.
			project = await createDaemonProject("chat-simple", {
				opencodeUrl: defaultMock.url,
				projectDir,
				configDir,
				slug: "named-runtime-ingress",
			});
			const { run } = project;
			// The start-up use is released at once; hold both streams as a bound
			// session would.
			held = await run(
				Effect.forkDetach(
					Effect.scoped(
						Effect.flatMap(OpenCodeInstancesTag, (instances) =>
							Effect.andThen(
								Effect.all([
									instances.use("work-oc", null),
									instances.use("personal-oc", null),
								]),
								Effect.never,
							),
						),
					),
				),
			);
			await Promise.all([
				workMock.waitForSseClient(),
				personalMock.waitForSseClient(),
			]);

			personalMock.injectSSE([
				{
					type: "message.created",
					properties: {
						sessionID: personalSessionId,
						messageID: "msg-daemon-personal",
						info: { role: "assistant", parts: [] },
					},
				},
			]);
			workMock.injectSSE([
				{
					type: "message.created",
					properties: {
						sessionID: workSessionId,
						messageID: "msg-daemon-work",
						info: { role: "assistant", parts: [] },
					},
				},
			]);

			const providerBindings = await eventually(
				() =>
					run(
						Effect.gen(function* () {
							const sql = yield* SqlClient.SqlClient;
							return yield* sql<{
								session_id: string;
								session_provider: string;
								binding_provider: string;
							}>`
								SELECT
									sessions.id AS session_id,
									sessions.provider AS session_provider,
									session_providers.provider AS binding_provider
								FROM sessions
								JOIN session_providers ON session_providers.session_id = sessions.id
								WHERE sessions.id IN (${personalSessionId}, ${workSessionId})
									AND session_providers.status = 'active'
								ORDER BY sessions.id`;
						}),
					),
				(rows) => rows.length === 2,
			);

			expect(providerBindings).toEqual([
				{
					session_id: personalSessionId,
					session_provider: "personal-oc",
					binding_provider: "personal-oc",
				},
				{
					session_id: workSessionId,
					session_provider: "work-oc",
					binding_provider: "work-oc",
				},
			]);
			const historyBeforeReconnect = workMock.historyRequestCount();
			const connectsBeforeReconnect = workMock.sseConnectionCount();
			workMock.disconnectSse();
			await eventually(
				async () => workMock.sseConnectionCount(),
				(count) => count > connectsBeforeReconnect,
				10_000,
			);
			workMock.injectSSE([
				{
					type: "message.created",
					properties: {
						sessionID: workSessionId,
						messageID: "msg-daemon-work-after-reconnect",
						info: { role: "assistant", parts: [] },
					},
				},
			]);
			expect(
				await eventually(
					async () => workMock.historyRequestCount(),
					(count) => count > historyBeforeReconnect,
				),
			).toBeGreaterThan(historyBeforeReconnect);
		} finally {
			if (held) await Effect.runPromise(Fiber.interrupt(held));
			await project?.stop();
			await defaultMock.close();
			await workMock.close();
			await personalMock.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// Failure modes: stopping a named server settles managed sessions, stopping
// managed settles named sessions, secondary stops leak across accounts, or
// permission/question waits stop being pending. The stand-in stops every
// server as conduit's own (managedStopped): an external server conduit only
// disconnects from keeps running, so its sessions settle by OpenCode's
// work-ended rule instead (CONTRACT.md 9, "An unmanaged server exposes no
// process token").
it.each([
	{ stoppedId: "managed-test" },
	{ stoppedId: "opencode" },
	{ stoppedId: "secondary" },
])("a confirmed stop of $stoppedId settles only its sessions and keeps every wait", async ({
	stoppedId,
}) => {
	const dir = mkdtempSync(join(tmpdir(), "conduit-daemon-named-stop-"));
	const bus = await Effect.runPromise(
		PubSub.unbounded<OpenCodeInstanceEvent>(),
	);
	const health = {
		connected: false,
		stale: false,
		lastEventAt: null,
		reconnectCount: 0,
	};
	const send = (instanceId: string, payload: ReturnType<typeof makeSSEEvent>) =>
		PubSub.publish(bus, { _tag: "event", instanceId, payload, health });
	const client = makeMockOpenCodeAPI();
	let project: DaemonProject | undefined;
	try {
		project = await createDaemonProject("chat-simple", {
			projectDir: dir,
			slug: "named-stop",
			shellEnv: new FixedShellEnv({}),
			openCodeInstances: {
				...makeOpenCodeInstancesStub({
					"managed-test": client,
					opencode: client,
					secondary: client,
				}),
				events: () => Stream.fromPubSub(bus),
				stop: (instanceId) =>
					PubSub.publish(bus, {
						_tag: "connection",
						instanceId,
						state: "stopped",
						managedStopped: true,
						health,
					}).pipe(Effect.asVoid),
			},
		});
		const { run } = project;
		const rows = [
			{ id: "named-work", provider: "managed-test" },
			{ id: "managed-work", provider: "opencode" },
			{ id: "secondary-work", provider: "secondary" },
			{ id: "named-permission", provider: "managed-test" },
			{ id: "managed-question", provider: "opencode" },
		];
		await run(
			Effect.gen(function* () {
				const manager = yield* projectSessionManager;
				for (const row of rows) {
					yield* manager.establishOpenCodeSession(
						{
							id: row.id,
							projectID: "named-stop",
							directory: dir,
							title: row.id,
							version: "test",
							time: { created: 0, updated: 0 },
						},
						AccountIdSchema.make(row.provider),
					);
					yield* send(
						row.provider,
						makeSSEEvent("session.status", {
							sessionID: row.id,
							status: { type: "busy" },
						}),
					);
				}
				yield* send(
					"managed-test",
					makeSSEEvent("permission.asked", {
						id: "stop-permission",
						sessionID: "named-permission",
						permission: "bash",
						patterns: ["git *"],
						metadata: {},
						always: [],
					}),
				);
				yield* send(
					"opencode",
					makeSSEEvent("question.asked", {
						id: "stop-question",
						sessionID: "managed-question",
						questions: [],
					}),
				);
			}),
		);
		const snapshot = () =>
			run(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					return {
						sessions: yield* sql<{
							id: string;
							provider: string;
							status: string;
						}>`SELECT id, provider, status FROM sessions WHERE id IN ${sql.in(rows.map((row) => row.id))} ORDER BY id`,
						pending: yield* sql<{ type: string; status: string }>`
							SELECT type, status FROM pending_approvals ORDER BY type`,
						completed: yield* sql<{ count: number }>`
							SELECT COUNT(*) AS count FROM events WHERE type = 'turn.completed'`,
					};
				}),
			);
		const expected = (settled: boolean) => ({
			sessions: rows
				.map((row) => ({
					...row,
					status: settled && row.provider === stoppedId ? "idle" : "busy",
				}))
				.sort((a, b) => a.id.localeCompare(b.id)),
			pending: [
				{ type: "permission", status: "pending" },
				{ type: "question", status: "pending" },
			],
			completed: [{ count: 0 }],
		});
		const busy = expected(false);
		expect(
			await eventually(
				snapshot,
				(value) => JSON.stringify(value) === JSON.stringify(busy),
			),
		).toEqual(busy);
		await run(
			Effect.flatMap(OpenCodeInstancesTag, (view) => view.stop(stoppedId)),
		);
		const settled = expected(true);
		expect(
			await eventually(
				snapshot,
				(value) => JSON.stringify(value) === JSON.stringify(settled),
			),
		).toEqual(settled);
	} finally {
		await project?.stop();
		await Effect.runPromise(PubSub.shutdown(bus));
		rmSync(dir, { recursive: true, force: true });
	}
});
