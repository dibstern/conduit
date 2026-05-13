import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import {
	ReadQueryTag,
	type WebSocketHandlerShape,
	WebSocketHandlerTag,
} from "../../../src/lib/effect/services.js";
import {
	ToolContentServiceLive,
	ToolContentServiceNoop,
	ToolContentServiceTag,
} from "../../../src/lib/effect/tool-content-service.js";
import { handleGetToolContent } from "../../../src/lib/handlers/tool-content.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import type { ReadQueryService } from "../../../src/lib/persistence/read-query-service.js";

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
	it.effect("returns tool content from the Effect service boundary", () => {
		const ws = mockWsHandler();
		const toolContent = {
			get: vi.fn((toolId: string) =>
				toolId === "tool-service-1"
					? Effect.succeed("full service output")
					: Effect.succeed(undefined),
			),
		};
		const layer = Layer.mergeAll(
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(ToolContentServiceTag, toolContent),
		);

		return handleGetToolContent("client-1", {
			toolId: "tool-service-1",
		}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(toolContent.get).toHaveBeenCalledWith("tool-service-1");
				expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
					type: "tool_content",
					sessionId: "session-effect-read",
					toolId: "tool-service-1",
					content: "full service output",
				});
			}),
		);
	});

	it.effect(
		"returns tool content from a real Effect SQLite read service",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "conduit-tool-content-effect-"));
			const filename = join(dir, "events.db");
			const ws = mockWsHandler();
			const persistenceLayer = makePersistenceEffectLayer(filename);
			const layer = Layer.mergeAll(
				Layer.succeed(WebSocketHandlerTag, ws),
				ToolContentServiceLive.pipe(Layer.provideMerge(persistenceLayer)),
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

	it.effect(
		"does not fall back to the legacy read query when Effect persistence is unavailable",
		() => {
			const ws = mockWsHandler();
			const legacyReadQuery = {
				getToolContent: vi.fn(() => "legacy output"),
			} as unknown as ReadQueryService;
			const layer = Layer.mergeAll(
				Layer.succeed(WebSocketHandlerTag, ws),
				ToolContentServiceNoop,
				Layer.succeed(ReadQueryTag, legacyReadQuery),
			);

			return handleGetToolContent("client-1", {
				toolId: "tool-legacy-only",
			}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(legacyReadQuery.getToolContent).not.toHaveBeenCalled();
					expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
						type: "error",
						sessionId: "session-effect-read",
						code: "NOT_FOUND",
						message: "Full tool content not available",
					});
				}),
			);
		},
	);

	it.effect(
		"prefers Effect read query and ignores legacy read query when both are provided",
		() => {
			const ws = mockWsHandler();
			const effectReadQuery = {
				getToolContent: vi.fn(() => Effect.succeed("effect output")),
				getSessionStatus: vi.fn(() => Effect.succeed(undefined)),
				getAllSessionStatuses: vi.fn(() => Effect.succeed({})),
				listSessions: vi.fn(() => Effect.succeed([])),
				getSessionMessagesWithParts: vi.fn(() => Effect.succeed([])),
			};
			const legacyReadQuery = {
				getToolContent: vi.fn(() => {
					throw new Error("legacy read query should not be used");
				}),
			} as unknown as ReadQueryService;
			const layer = Layer.provideMerge(
				ToolContentServiceLive,
				Layer.mergeAll(
					Layer.succeed(WebSocketHandlerTag, ws),
					Layer.succeed(ReadQueryEffectTag, effectReadQuery),
					Layer.succeed(ReadQueryTag, legacyReadQuery),
				),
			);

			return handleGetToolContent("client-1", {
				toolId: "tool-effect-first",
			}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(effectReadQuery.getToolContent).toHaveBeenCalledWith(
						"tool-effect-first",
					);
					expect(legacyReadQuery.getToolContent).not.toHaveBeenCalled();
					expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
						type: "tool_content",
						sessionId: "session-effect-read",
						toolId: "tool-effect-first",
						content: "effect output",
					});
				}),
			);
		},
	);
});
