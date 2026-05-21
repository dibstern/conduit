// Regression guard: relay-stack should use Effect OpenCode runtime ingress only.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";
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
			res.write(": heartbeat\n\n");
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
});
