import { mkdtempSync } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
	getDefaultModel,
	getDefaultVariant,
} from "../../../src/lib/effect/session-overrides-state.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { saveRelaySettings } from "../../../src/lib/relay/relay-settings.js";
import {
	createProjectRelay,
	type ProjectRelay,
} from "../../../src/lib/relay/relay-stack.js";

interface MockOpenCode {
	server: Server;
	port: number;
	close(): Promise<void>;
}

async function createMockOpenCode(): Promise<MockOpenCode> {
	const sseClients = new Set<ServerResponse>();

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
			req.on("close", () => sseClients.delete(res));
			return;
		}

		res.setHeader("Content-Type", "application/json");
		if (url.pathname === "/path") {
			res.end(JSON.stringify("/test"));
			return;
		}
		if (url.pathname === "/session" && req.method === "GET") {
			res.end(
				JSON.stringify([
					{
						id: "sess-1",
						title: "Session 1",
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
		if (url.pathname === "/provider") {
			res.end(JSON.stringify({ providers: [], defaults: {}, connected: [] }));
			return;
		}
		if (url.pathname === "/permission" || url.pathname === "/question") {
			res.end(JSON.stringify([]));
			return;
		}
		res.end(JSON.stringify({}));
	}

	const server = createServer(handler);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	return {
		server,
		port,
		async close() {
			for (const client of sseClients) client.end();
			sseClients.clear();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

describe("createProjectRelay override-state defaults", () => {
	let relay: ProjectRelay | undefined;
	let relayServer: Server | undefined;
	let mock: MockOpenCode | undefined;

	afterEach(async () => {
		if (relay) await relay.stop();
		relay = undefined;
		if (relayServer) {
			await new Promise<void>((resolve) => relayServer?.close(() => resolve()));
		}
		relayServer = undefined;
		if (mock) await mock.close();
		mock = undefined;
	});

	it("seeds persisted default model and variant into Effect override state", async () => {
		const configDir = mkdtempSync(join(tmpdir(), "conduit-relay-defaults-"));
		saveRelaySettings(
			{
				defaultModel: "claude/claude-sonnet-4-7",
				defaultVariants: {
					"claude/claude-sonnet-4-7": "thinking",
				},
			},
			configDir,
		);
		mock = await createMockOpenCode();
		relayServer = createServer();
		await new Promise<void>((resolve) =>
			relayServer?.listen(0, "127.0.0.1", resolve),
		);

		relay = await createProjectRelay({
			httpServer: relayServer,
			opencodeUrl: `http://127.0.0.1:${mock.port}`,
			projectDir: process.cwd(),
			slug: "test-default-overrides",
			configDir,
			log: createSilentLogger(),
		});

		const seeded = await relay.effectRuntime.runtime.runPromise(
			Effect.gen(function* () {
				return {
					defaultModel: yield* getDefaultModel(),
					defaultVariant: yield* getDefaultVariant(),
				};
			}),
		);

		expect(seeded).toEqual({
			defaultModel: {
				providerID: "claude",
				modelID: "claude-sonnet-4-7",
			},
			defaultVariant: "thinking",
		});
	});
});
