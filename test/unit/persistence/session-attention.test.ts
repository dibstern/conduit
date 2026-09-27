// SessionAttention against a real SQLite file with the real projectors.
// Ways it can be wrong, listed before it exists:
// - a turn end does not raise last_turn_end_version, or a turn.error does not;
// - markSeen stores an upTo past the latest turn end, so the next turn end
//   is already "seen";
// - markSeen lowers seen_version when a stale report arrives (a tab that
//   rendered an older turn end), resurrecting a dot the user cleared;
// - markSeen stamps and announces when nothing changed, so every pick of a
//   read session fans out a list update;
// - markSeen marks a sub-agent, a session with no turn end, or an unknown id;
// - markUnread does not bring the dot back, or does it without announcing;
// - markUnread is a no-op on a session with no turn end yet (hk9m.7).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { Effect, Layer, Stream } from "effect";
import { expect, it } from "vitest";
import type { ReadModelAdvance } from "../../../src/lib/contracts/read-model-advance.js";
import {
	markSeen,
	markUnread,
} from "../../../src/lib/domain/relay/Services/session-attention.js";
import {
	type SessionEventBus,
	SessionEventBusTag,
} from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import {
	makePersistenceEffectLayer,
	type PersistenceEffectContext,
} from "../../../src/lib/persistence/effect/live.js";
import { createAllEffectProjectors } from "../../../src/lib/persistence/effect/projectors-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";

const withPersistence = async (
	body: (
		advances: ReadModelAdvance[],
	) => Effect.Effect<void, unknown, PersistenceEffectContext>,
) => {
	const dir = mkdtempSync(join(tmpdir(), "conduit-session-attention-"));
	const advances: ReadModelAdvance[] = [];
	const bus = Layer.succeed(SessionEventBusTag, {
		publish: () => Effect.void,
		publishAdvance: (advance) => Effect.sync(() => void advances.push(advance)),
		subscribe: () => Effect.succeed(Stream.empty),
		subscribeAdvances: () => Effect.succeed(Stream.empty),
	} satisfies SessionEventBus);
	try {
		await Effect.runPromise(
			body(advances).pipe(
				Effect.provide(
					Layer.merge(
						makePersistenceEffectLayer(
							join(dir, "events.db"),
							createAllEffectProjectors(),
							bus,
						),
						bus,
					),
				),
				Effect.orDie,
			),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

// Creates root (turn ends at stream versions 1 and 2), a sub-agent child and
// a fork of root (each with a turn end at version 1), and an idle session
// with no turn end.
const seed = Effect.gen(function* () {
	const commit = yield* makeCommitAndSignal;
	const created = (
		sessionId: string,
		extra: { parentId?: string; forkPointEvent?: string } = {},
	) =>
		canonicalEvent(
			"session.created",
			sessionId,
			{ sessionId, title: sessionId, provider: "claude", ...extra },
			{ provider: "claude" },
		);
	const completed = (sessionId: string) =>
		canonicalEvent(
			"turn.completed",
			sessionId,
			{ messageId: `${sessionId}-a` },
			{ provider: "claude" },
		);
	yield* commit([created("root"), completed("root")]);
	yield* commit([
		canonicalEvent(
			"turn.error",
			"root",
			{ messageId: "root-b", error: "boom" },
			{ provider: "claude" },
		),
	]);
	yield* commit([
		created("child", { parentId: "root" }),
		completed("child"),
		created("fork", { parentId: "root", forkPointEvent: "root-a" }),
		completed("fork"),
		created("idle"),
	]);
});

const state = (sessionId: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const [row] = yield* sql<{
			last: number | null;
			seen: number | null;
			unread: number;
		}>`SELECT last_turn_end_version AS last, seen_version AS seen, unread FROM sessions WHERE id = ${sessionId}`;
		return row;
	});

it("turn.completed and turn.error both raise last_turn_end_version", async () => {
	await withPersistence(() =>
		Effect.gen(function* () {
			yield* seed;
			expect(yield* state("root")).toEqual({ last: 2, seen: null, unread: 1 });
			expect(yield* state("fork")).toEqual({ last: 1, seen: null, unread: 1 });
			expect(yield* state("child")).toEqual({ last: 1, seen: null, unread: 0 });
		}),
	);
});

it("markSeen caps at the latest turn end and announces the row once", async () => {
	await withPersistence((advances) =>
		Effect.gen(function* () {
			yield* seed;
			advances.length = 0;
			expect(yield* markSeen("root", 99)).toBe(true);
			expect(yield* state("root")).toEqual({ last: 2, seen: 2, unread: 0 });
			expect(advances.map((advance) => advance.sessionIds)).toEqual([["root"]]);

			expect(yield* markSeen("root", 2)).toBe(false);
			expect(advances).toHaveLength(1);
		}),
	);
});

it("markSeen never lowers seen_version", async () => {
	await withPersistence((advances) =>
		Effect.gen(function* () {
			yield* seed;
			expect(yield* markSeen("root", 1)).toBe(true);
			expect(yield* state("root")).toEqual({ last: 2, seen: 1, unread: 1 });
			expect(yield* markSeen("root", 2)).toBe(true);
			advances.length = 0;
			expect(yield* markSeen("root", 1)).toBe(false);
			expect(yield* state("root")).toEqual({ last: 2, seen: 2, unread: 0 });
			expect(advances).toEqual([]);
		}),
	);
});

it("markSeen is a quiet no-op for a sub-agent, an idle session and an unknown id, and works on a fork", async () => {
	await withPersistence((advances) =>
		Effect.gen(function* () {
			yield* seed;
			advances.length = 0;
			expect(yield* markSeen("child", 1)).toBe(false);
			expect(yield* markSeen("idle", 1)).toBe(false);
			expect(yield* markSeen("missing", 1)).toBe(false);
			expect(yield* state("child")).toEqual({ last: 1, seen: null, unread: 0 });
			expect(advances).toEqual([]);

			expect(yield* markSeen("fork", 1)).toBe(true);
			expect(yield* state("fork")).toEqual({ last: 1, seen: 1, unread: 0 });
		}),
	);
});

it("markUnread puts seen one below the latest turn end and announces it", async () => {
	await withPersistence((advances) =>
		Effect.gen(function* () {
			yield* seed;
			yield* markSeen("root", 2);
			advances.length = 0;
			expect(yield* markUnread("root")).toBe(true);
			expect(yield* state("root")).toEqual({ last: 2, seen: 1, unread: 1 });
			expect(advances.map((advance) => advance.sessionIds)).toEqual([["root"]]);
			expect(yield* markUnread("root")).toBe(false);
			expect(yield* markUnread("child")).toBe(false);
		}),
	);
});

it("markUnread on a session with no turn end shows a dot until it is seen", async () => {
	await withPersistence(() =>
		Effect.gen(function* () {
			yield* seed;
			expect(yield* markUnread("idle")).toBe(true);
			expect(yield* state("idle")).toEqual({ last: null, seen: -2, unread: 1 });
			expect(yield* markSeen("idle", 0)).toBe(true);
			expect(yield* state("idle")).toEqual({ last: null, seen: -1, unread: 0 });
		}),
	);
});
