import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { Effect, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DualWriteLog } from "../../../src/lib/persistence/dual-write-hook.js";
import { EffectDualWriteHook } from "../../../src/lib/persistence/effect/dual-write-hook-effect.js";
import {
	makePersistenceEffectLayer,
	type PersistenceEffectRuntime,
} from "../../../src/lib/persistence/effect/live.js";
import { makeSSEEvent } from "../../helpers/sse-factories.js";

const SESSION_ID = "sess-effect-dw-001";

function makeLogger(): DualWriteLog & {
	warn: ReturnType<typeof vi.fn>;
	debug: ReturnType<typeof vi.fn>;
	info: ReturnType<typeof vi.fn>;
	verbose: ReturnType<typeof vi.fn>;
} {
	return {
		warn: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		verbose: vi.fn(),
	};
}

describe("EffectDualWriteHook", () => {
	let dir: string | undefined;
	let runtime: PersistenceEffectRuntime | undefined;
	let hook: EffectDualWriteHook | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "conduit-effect-dual-write-"));
		const filename = join(dir, "events.db");
		runtime = ManagedRuntime.make(makePersistenceEffectLayer(filename));
		hook = new EffectDualWriteHook({ runtime, log: makeLogger() });
	});

	afterEach(async () => {
		hook?.stopStatsLogging();
		await runtime?.dispose();
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	it("persists and projects translated SSE events through Effect services", () => {
		if (!hook || !runtime) throw new Error("test runtime not initialized");
		const result = hook.onSSEEvent(
			makeSSEEvent("message.created", {
				sessionID: SESSION_ID,
				messageID: "msg-effect-001",
				info: { role: "assistant", parts: [] },
			}),
			SESSION_ID,
		);

		if (!result.ok) throw new Error(result.error ?? result.reason);
		expect(result).toMatchObject({
			ok: true,
			eventsWritten: 2,
			sessionSeeded: true,
		});

		const rows = runtime.runSync(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				return yield* sql<{
					session_provider: string;
					message_id: string;
					message_role: string;
					event_count: number;
				}>`
					SELECT
						sessions.provider AS session_provider,
						messages.id AS message_id,
						messages.role AS message_role,
						(SELECT COUNT(*) FROM events WHERE session_id = ${SESSION_ID}) AS event_count
					FROM sessions
					JOIN messages ON messages.session_id = sessions.id
					WHERE sessions.id = ${SESSION_ID}`;
			}),
		);

		expect(rows).toEqual([
			{
				session_provider: "opencode",
				message_id: "msg-effect-001",
				message_role: "assistant",
				event_count: 2,
			},
		]);
	});
});
