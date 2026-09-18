// `last_viewed_at` is the first read-model column with no event behind it, so
// it is the first write that could move a row without anyone hearing about it.
// These tests drive the real seam against a real SQLite file and assert on what
// reached the bus — the announcement is the feature, the column is incidental.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { Effect, Layer, Stream } from "effect";
import { expect, it } from "vitest";
import type { ReadModelAdvance } from "../../../src/lib/contracts/read-model-advance.js";
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
import { markSessionViewed } from "../../../src/lib/persistence/effect/session-viewed.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";

const recordingBus = (advances: ReadModelAdvance[]) =>
	Layer.succeed(SessionEventBusTag, {
		publish: () => Effect.void,
		publishAdvance: (advance) => Effect.sync(() => void advances.push(advance)),
		subscribe: () => Effect.succeed(Stream.empty),
		subscribeAdvances: () => Effect.succeed(Stream.empty),
	} satisfies SessionEventBus);

const withPersistence = async <A>(
	body: (
		advances: ReadModelAdvance[],
	) => Effect.Effect<A, unknown, PersistenceEffectContext>,
): Promise<A> => {
	const dir = mkdtempSync(join(tmpdir(), "conduit-session-viewed-"));
	const advances: ReadModelAdvance[] = [];
	const bus = recordingBus(advances);
	const persistence = makePersistenceEffectLayer(
		join(dir, "events.db"),
		createAllEffectProjectors(),
		bus,
	);
	try {
		return await Effect.runPromise(
			body(advances).pipe(
				Effect.provide(Layer.merge(persistence, bus)),
				Effect.orDie,
			),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

const createSession = (id: string) =>
	Effect.gen(function* () {
		const commit = yield* makeCommitAndSignal;
		yield* commit([
			canonicalEvent(
				"session.created",
				id,
				{ sessionId: id, title: id, provider: "claude" },
				{ provider: "claude" },
			),
		]);
	});

it("viewing a session writes the column and announces the version it stamped", async () => {
	await withPersistence((advances) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* createSession("s1");
			advances.length = 0;

			yield* markSessionViewed("s1", 1_700_000_000_000);

			const rows = yield* sql<{
				last_viewed_at: number | null;
				version: number;
			}>`SELECT last_viewed_at, version FROM sessions WHERE id = 's1'`;

			// The announced version IS the stamped version. A subscriber that
			// re-queries on the advance and compares must not find the row behind
			// what it was told — that silence is C2.
			expect(rows).toEqual([{ last_viewed_at: 1_700_000_000_000, version: 2 }]);
			expect(advances).toEqual([{ version: 2, sessionIds: ["s1"] }]);
		}),
	);
});

it("viewing appends no event — it is not a mutation of the session", async () => {
	await withPersistence(() =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* createSession("s1");
			const before = yield* sql<{
				n: number;
			}>`SELECT COUNT(*) AS n FROM events`;

			yield* markSessionViewed("s1", 1_700_000_000_000);

			const after = yield* sql<{
				n: number;
			}>`SELECT COUNT(*) AS n FROM events`;
			expect(after).toEqual(before);
		}),
	);
});

it("viewing an unknown session stamps nothing and announces nothing", async () => {
	await withPersistence((advances) =>
		Effect.gen(function* () {
			yield* createSession("s1");
			advances.length = 0;

			yield* markSessionViewed("ghost", 1_700_000_000_000);

			// Nothing moved, so nothing is claimed to have moved. An advance for a
			// row that does not exist would send every subscriber to re-query it.
			expect(advances).toEqual([]);
		}),
	);
});

it("a later view moves the column and the version forward again", async () => {
	await withPersistence((advances) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* createSession("s1");
			yield* markSessionViewed("s1", 1_700_000_000_000);
			advances.length = 0;

			yield* markSessionViewed("s1", 1_700_000_005_000);

			const rows = yield* sql<{
				last_viewed_at: number | null;
				version: number;
			}>`SELECT last_viewed_at, version FROM sessions WHERE id = 's1'`;
			expect(rows).toEqual([{ last_viewed_at: 1_700_000_005_000, version: 3 }]);
			expect(advances).toEqual([{ version: 3, sessionIds: ["s1"] }]);
		}),
	);
});

it("a direct write shares the counter with projection — no version is reused", async () => {
	await withPersistence((advances) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			yield* createSession("s1");
			yield* markSessionViewed("s1", 1_700_000_000_000);
			advances.length = 0;

			// A projection after a direct write must take a version above it.
			// Two producers on one counter is what keeps a subscriber's "have I
			// seen this?" comparison meaningful.
			const commit = yield* makeCommitAndSignal;
			yield* commit([
				canonicalEvent(
					"session.renamed",
					"s1",
					{ sessionId: "s1", title: "Renamed" },
					{ provider: "claude" },
				),
			]);

			const rows = yield* sql<{
				version: number;
			}>`SELECT version FROM sessions WHERE id = 's1'`;
			expect(rows).toEqual([{ version: 3 }]);
			expect(advances).toEqual([{ version: 3, sessionIds: ["s1"] }]);
		}),
	);
});
