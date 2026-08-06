// Regression guard: relay-stack should use Effect OpenCode runtime ingress only.
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";
import type { DaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import { OpenCodeInstanceClientsTag } from "../../../src/lib/domain/relay/Services/opencode-instance-clients.js";
import { makeEffectOpenCodeRuntimeIngress } from "../../../src/lib/domain/relay/Services/opencode-runtime-ingress-service.js";
import { ProviderRuntimeIngestionLive } from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { createProjectRelay } from "../../../src/lib/relay/relay-stack.js";

interface MockOpenCode {
	readonly url: string;
	readonly waitForSseClient: () => Promise<void>;
	readonly injectSSE: (
		events: readonly { type: string; properties: Record<string, unknown> }[],
	) => void;
	readonly close: () => Promise<void>;
}

const listenOnRandomPort = (server: ReturnType<typeof createServer>) =>
	new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

const closeServer = (server: ReturnType<typeof createServer>) =>
	new Promise<void>((resolve) => server.close(() => resolve()));

async function createMockOpenCode(): Promise<MockOpenCode> {
	const sseClients = new Set<ServerResponse>();
	let resolveSseClient: (() => void) | undefined;
	const sseClientConnected = new Promise<void>((resolve) => {
		resolveSseClient = resolve;
	});

	function handler(req: IncomingMessage, res: ServerResponse) {
		const url = new URL(req.url ?? "/", "http://localhost");

		if (url.pathname === "/event") {
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			});
			res.write(
				`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`,
			);
			sseClients.add(res);
			resolveSseClient?.();
			req.on("close", () => sseClients.delete(res));
			return;
		}

		res.setHeader("Content-Type", "application/json");
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
				const data = JSON.stringify(event);
				for (const client of sseClients) {
					client.write(`data: ${data}\n\n`);
				}
			}
		},
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
	const deadline = Date.now() + timeoutMs;
	let lastValue: T | undefined;
	while (Date.now() < deadline) {
		lastValue = await read();
		if (matches(lastValue)) return lastValue;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(
		`condition not met before timeout; last value=${JSON.stringify(lastValue)}`,
	);
}

describe("Relay stack Effect OpenCode runtime ingress wiring", () => {
	it("does not construct the legacy OpenCodeRuntimeIngress fallback", () => {
		const source = readFileSync("src/lib/relay/relay-stack.ts", "utf8");

		expect(source).not.toContain("new OpenCodeRuntimeIngress");
		expect(source).toContain("makeEffectOpenCodeRuntimeIngress");
		expect(source).toContain("ProviderRuntimeIngestionLive");
	});

	it("EffectOpenCodeRuntimeIngress can process SSE events with Effect persistence", async () => {
		const dir = mkdtempSync(join(tmpdir(), "conduit-effect-runtime-ingress-"));
		const persistenceLayer = makePersistenceEffectLayer(join(dir, "events.db"));
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

	it("wires relay-stack SSE events through Effect persistence into the read model", async () => {
		const dir = mkdtempSync(join(tmpdir(), "conduit-relay-runtime-ingress-"));
		const projectDir = join(dir, "project");
		mkdirSync(join(projectDir, ".conduit"), { recursive: true });
		const dbPath = join(projectDir, ".conduit", "events.db");
		const mock = await createMockOpenCode();
		const relayServer = createServer();
		await listenOnRandomPort(relayServer);

		let relay: Awaited<ReturnType<typeof createProjectRelay>> | undefined;
		try {
			relay = await createProjectRelay({
				httpServer: relayServer,
				opencodeUrl: mock.url,
				projectDir,
				persistenceDbPath: dbPath,
				slug: "runtime-ingress-smoke",
				log: createSilentLogger(),
				statusPollerInterval: 60_000,
				messagePollerInterval: 60_000,
			});
			await eventually(
				() =>
					Promise.race([
						mock.waitForSseClient().then(() => true),
						new Promise<false>((resolve) =>
							setTimeout(() => resolve(false), 50),
						),
					]),
				(connected) => connected,
			);

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
						delta: "hello from relay",
					},
				},
			]);

			const messages = await eventually(
				() =>
					relay?.effectRuntime.runtime.runPromise(
						Effect.gen(function* () {
							const readQuery = yield* ReadQueryEffectTag;
							return yield* readQuery.getSessionMessagesWithParts("sess-1");
						}),
					) ?? Promise.resolve([]),
				(rows) =>
					rows.some(
						(row) =>
							row.id === "msg-1" &&
							row.role === "assistant" &&
							row.parts.some((part) => part.text === "hello from relay"),
					),
			);

			expect(messages).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						id: "msg-1",
						role: "assistant",
						parts: expect.arrayContaining([
							expect.objectContaining({ text: "hello from relay" }),
						]),
					}),
				]),
			);
		} finally {
			if (relay != null) await relay.stop();
			await closeServer(relayServer);
			await mock.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps named OpenCode stream provider bindings isolated through the shared ingress", async () => {
		const dir = mkdtempSync(join(tmpdir(), "conduit-relay-named-ingress-"));
		const projectDir = join(dir, "project");
		const personalSessionId = "sess-relay-personal";
		const workSessionId = "sess-relay-work";
		mkdirSync(join(projectDir, ".conduit"), { recursive: true });
		const dbPath = join(projectDir, ".conduit", "events.db");
		const defaultMock = await createMockOpenCode();
		const workMock = await createMockOpenCode();
		const personalMock = await createMockOpenCode();
		writeFileSync(
			join(dir, "daemon.json"),
			JSON.stringify({
				pid: 1234,
				port: 2633,
				pinHash: null,
				tls: false,
				debug: false,
				keepAwake: false,
				dangerouslySkipPermissions: false,
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
		const relayServer = createServer();
		await listenOnRandomPort(relayServer);

		let relay: Awaited<ReturnType<typeof createProjectRelay>> | undefined;
		try {
			relay = await createProjectRelay({
				httpServer: relayServer,
				opencodeUrl: defaultMock.url,
				projectDir,
				persistenceDbPath: dbPath,
				configDir: dir,
				slug: "named-runtime-ingress",
				log: createSilentLogger(),
				statusPollerInterval: 60_000,
				messagePollerInterval: 60_000,
			});

			await relay.effectRuntime.runtime.runPromise(
				Effect.gen(function* () {
					const instanceClients = yield* OpenCodeInstanceClientsTag;
					yield* instanceClients.clientFor("work-oc");
					yield* instanceClients.clientFor("personal-oc");
				}),
			);

			personalMock.injectSSE([
				{
					type: "message.created",
					properties: {
						sessionID: personalSessionId,
						messageID: "msg-relay-personal",
						info: { role: "assistant", parts: [] },
					},
				},
			]);
			workMock.injectSSE([
				{
					type: "message.created",
					properties: {
						sessionID: workSessionId,
						messageID: "msg-relay-work",
						info: { role: "assistant", parts: [] },
					},
				},
			]);

			const providerBindings = await eventually(
				() =>
					relay?.effectRuntime.runtime.runPromise(
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
					) ?? Promise.resolve([]),
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
		} finally {
			if (relay != null) await relay.stop();
			await closeServer(relayServer);
			await defaultMock.close();
			await workMock.close();
			await personalMock.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
