import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import {
	ToolContentServiceLive,
	ToolContentServiceNoop,
	ToolContentServiceTag,
} from "../../../src/lib/domain/relay/Services/tool-content-service.js";
import { getToolContentValue } from "../../../src/lib/handlers/tool-content.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";

describe("getToolContentValue with Effect read persistence", () => {
	it.effect("returns tool content from the Effect service boundary", () => {
		const toolContent = {
			get: vi.fn((toolId: string) =>
				toolId === "tool-service-1"
					? Effect.succeed("full service output")
					: Effect.succeed(undefined),
			),
		};
		return getToolContentValue("tool-service-1").pipe(
			Effect.provide(Layer.succeed(ToolContentServiceTag, toolContent)),
			Effect.tap((content) => {
				expect(toolContent.get).toHaveBeenCalledWith("tool-service-1");
				expect(content).toBe("full service output");
			}),
		);
	});

	it.effect(
		"returns tool content from a real Effect SQLite read service",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "conduit-tool-content-effect-"));
			const filename = join(dir, "events.db");
			const persistenceLayer = makePersistenceEffectLayer(filename);
			const layer = ToolContentServiceLive.pipe(
				Layer.provideMerge(persistenceLayer),
			);

			return Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`
				INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
				VALUES ('session-effect-read', 'opencode', 'Tool Content', 'idle', 1, 1)`;
				yield* sql`
				INSERT INTO tool_content (tool_id, session_id, content, created_at)
				VALUES ('tool-effect-1', 'session-effect-read', 'full effect output', 2)`;

				expect(yield* getToolContentValue("tool-effect-1")).toBe(
					"full effect output",
				);
			}).pipe(
				Effect.provide(layer),
				Effect.ensuring(
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			);
		},
	);

	it.effect("returns nothing when Effect persistence is unavailable", () =>
		getToolContentValue("tool-legacy-only").pipe(
			Effect.provide(ToolContentServiceNoop),
			Effect.tap((content) => {
				expect(content).toBeUndefined();
			}),
		),
	);
});
