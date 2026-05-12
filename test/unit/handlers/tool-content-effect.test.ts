import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import {
	type WebSocketHandlerShape,
	WebSocketHandlerTag,
} from "../../../src/lib/effect/services.js";
import { handleGetToolContent } from "../../../src/lib/handlers/tool-content.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";

function mockWsHandler(): WebSocketHandlerShape {
	return {
		broadcast: vi.fn(),
		sendTo: vi.fn(),
		setClientSession: vi.fn(),
		getClientSession: vi.fn(() => "session-effect-read"),
		getClientsForSession: vi.fn(() => []),
		sendToSession: vi.fn(),
		broadcastPerSessionEvent: vi.fn(),
		markClientBootstrapped: vi.fn(),
		getClientCount: vi.fn(() => 0),
		getClientIds: vi.fn(() => []),
		handleUpgrade: vi.fn(),
		close: vi.fn(),
		drain: vi.fn(async () => undefined),
		on: vi.fn(),
		once: vi.fn(),
	};
}

describe("handleGetToolContent with Effect read persistence", () => {
	it.effect(
		"returns tool content from a real Effect SQLite read service",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "conduit-tool-content-effect-"));
			const filename = join(dir, "events.db");
			const ws = mockWsHandler();
			const layer = Layer.merge(
				Layer.succeed(WebSocketHandlerTag, ws),
				makePersistenceEffectLayer(filename),
			);

			return Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
				INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
				VALUES ('session-effect-read', 'opencode', 'Tool Content', 'idle', 1, 1)`;
				yield* sql`
				INSERT INTO tool_content (tool_id, session_id, content, created_at)
				VALUES ('tool-effect-1', 'session-effect-read', 'full effect output', 2)`;

				yield* handleGetToolContent("client-1", { toolId: "tool-effect-1" });

				expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
					type: "tool_content",
					sessionId: "session-effect-read",
					toolId: "tool-effect-1",
					content: "full effect output",
				});
			}).pipe(
				Effect.provide(layer),
				Effect.ensuring(
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			);
		},
	);
});
