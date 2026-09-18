// Every write that moves the badge has to move `sessions.version` and say so.
//
// The badge is four facts on the session row (unread, pending approvals,
// pending questions, last alert). A subscriber learns the row moved by watching
// its version, so a write that changes a badge fact without advancing the
// version — or without publishing the advance — is invisible: the count on
// screen is simply wrong until something unrelated happens to touch the row.
//
// T-6 (conduit-test-ni8.5.13) replaces the shell orchestrator with per-advance
// bounded re-queries keyed on exactly that row version. These tests are the
// contract its design relies on, asserted through the real seam and the real
// bus: for each badge-moving write, an advance arrives naming the session at a
// version equal to the version stamped on the row.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import Database from "better-sqlite3";
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

const recordingBus = (advances: ReadModelAdvance[], filename: string) => {
	let previousVersion = 0;
	return Layer.succeed(SessionEventBusTag, {
		publish: () => Effect.void,
		publishAdvance: (advance) =>
			Effect.sync(() => {
				// A separate connection cannot see the writer's uncommitted changes.
				// Read synchronously at publication, before the writer can finish later.
				const reader = new Database(filename, { readonly: true });
				try {
					const counter = reader
						.prepare<[], { value: number }>(
							"SELECT value FROM read_model_counter WHERE id = 1",
						)
						.get();
					const row = reader
						.prepare<[string], { version: number }>(
							"SELECT version FROM sessions WHERE id = ?",
						)
						.get(SESSION);
					expect(advance.version).toBeGreaterThan(previousVersion);
					expect(counter?.value).toBe(advance.version);
					expect(row?.version).toBe(advance.version);
					previousVersion = advance.version;
					advances.push(advance);
				} finally {
					reader.close();
				}
			}),
		subscribe: () => Effect.succeed(Stream.empty),
		subscribeAdvances: () => Effect.succeed(Stream.empty),
	} satisfies SessionEventBus);
};

const withPersistence = async <A>(
	body: (
		advances: ReadModelAdvance[],
	) => Effect.Effect<A, unknown, PersistenceEffectContext>,
): Promise<A> => {
	const dir = mkdtempSync(join(tmpdir(), "conduit-badge-advance-"));
	const advances: ReadModelAdvance[] = [];
	const bus = recordingBus(advances, join(dir, "events.db"));
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

const SESSION = "s1";

const createSession = Effect.gen(function* () {
	const commit = yield* makeCommitAndSignal;
	yield* commit([
		canonicalEvent(
			"session.created",
			SESSION,
			{ sessionId: SESSION, title: SESSION, provider: "claude" },
			{ provider: "claude" },
		),
	]);
});

const rowVersion = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;
	const rows = yield* sql<{
		version: number;
	}>`SELECT version FROM sessions WHERE id = ${SESSION}`;
	return rows[0]?.version;
});

/**
 * The whole assertion, in one place: the last advance names this session, and
 * the version it announces is the version now on the row. Anything less and a
 * subscriber re-querying on the advance reads a row it was never told about, or
 * reads one behind the number it was given and discards it as already seen.
 */
const expectAdvanceMatchesRow = (advances: readonly ReadModelAdvance[]) =>
	Effect.gen(function* () {
		const version = yield* rowVersion;
		expect(advances.length).toBeGreaterThan(0);
		const last = advances[advances.length - 1];
		expect(last?.sessionIds).toContain(SESSION);
		expect(last?.version).toBe(version);
	});

it("a view advances the row version and announces it", async () => {
	await withPersistence((advances) =>
		Effect.gen(function* () {
			yield* createSession;
			advances.length = 0;

			yield* markSessionViewed(SESSION, 1_700_000_000_000);

			yield* expectAdvanceMatchesRow(advances);
		}),
	);
});

it("asking for permission advances the row version and announces it", async () => {
	await withPersistence((advances) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const commit = yield* makeCommitAndSignal;
			yield* createSession;
			advances.length = 0;

			yield* commit([
				canonicalEvent(
					"permission.asked",
					SESSION,
					{
						id: "perm-1",
						sessionId: SESSION,
						toolName: "bash",
						input: { command: "ls" },
					},
					{ provider: "claude" },
				),
			]);

			const pending = yield* sql<{
				n: number;
			}>`SELECT COUNT(*) AS n FROM pending_approvals WHERE session_id = ${SESSION} AND status = 'pending'`;
			expect(pending[0]?.n).toBe(1);
			yield* expectAdvanceMatchesRow(advances);
		}),
	);
});

it("resolving a permission advances the row version and announces it", async () => {
	await withPersistence((advances) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const commit = yield* makeCommitAndSignal;
			yield* createSession;
			yield* commit([
				canonicalEvent(
					"permission.asked",
					SESSION,
					{
						id: "perm-1",
						sessionId: SESSION,
						toolName: "bash",
						input: { command: "ls" },
					},
					{ provider: "claude" },
				),
			]);
			advances.length = 0;

			yield* commit([
				canonicalEvent(
					"permission.resolved",
					SESSION,
					{ id: "perm-1", decision: "once" },
					{ provider: "claude" },
				),
			]);

			const pending = yield* sql<{
				n: number;
			}>`SELECT COUNT(*) AS n FROM pending_approvals WHERE session_id = ${SESSION} AND status = 'pending'`;
			expect(pending[0]?.n).toBe(0);
			yield* expectAdvanceMatchesRow(advances);
		}),
	);
});

it("asking a question advances the row version and announces it", async () => {
	await withPersistence((advances) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const commit = yield* makeCommitAndSignal;
			yield* createSession;
			advances.length = 0;

			yield* commit([
				canonicalEvent(
					"question.asked",
					SESSION,
					{
						id: "que-1",
						sessionId: SESSION,
						questions: [{ text: "which?" }],
					},
					{ provider: "opencode" },
				),
			]);

			const pending = yield* sql<{
				n: number;
			}>`SELECT COUNT(*) AS n FROM pending_approvals WHERE session_id = ${SESSION} AND status = 'pending'`;
			expect(pending[0]?.n).toBe(1);
			yield* expectAdvanceMatchesRow(advances);
		}),
	);
});

it("resolving a question advances the row version and announces it", async () => {
	await withPersistence((advances) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const commit = yield* makeCommitAndSignal;
			yield* createSession;
			yield* commit([
				canonicalEvent(
					"question.asked",
					SESSION,
					{
						id: "que-1",
						sessionId: SESSION,
						questions: [{ text: "which?" }],
					},
					{ provider: "opencode" },
				),
			]);
			advances.length = 0;

			yield* commit([
				canonicalEvent(
					"question.resolved",
					SESSION,
					{ id: "que-1", answers: { "0": "yes" } },
					{ provider: "opencode" },
				),
			]);

			// This is the write that did not exist before ni8.23 delta 1: the
			// browser answered, the card vanished, and the count stayed at one
			// until the database was deleted.
			const pending = yield* sql<{
				n: number;
			}>`SELECT COUNT(*) AS n FROM pending_approvals WHERE session_id = ${SESSION} AND status = 'pending'`;
			expect(pending[0]?.n).toBe(0);
			yield* expectAdvanceMatchesRow(advances);
		}),
	);
});
