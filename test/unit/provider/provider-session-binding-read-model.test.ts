import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { SqliteClient as EffectSqliteClient } from "@effect/sql-sqlite-node";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
	InMemoryProviderSessionBindingReadModel,
	type ProviderSessionBindingReadModel,
	SqliteProviderSessionBindingReadModel,
} from "../../../src/lib/provider/provider-session-binding-read-model.js";

function revisionEntries(
	model: ProviderSessionBindingReadModel,
): ReadonlyMap<string, number> {
	const entries: unknown = Reflect.get(model, "bindingRevisions");
	if (!(entries instanceof Map))
		throw new Error("binding revisions not available");
	return entries;
}

describe("provider binding revisions", () => {
	it("preserves a same-provider replacement after its predecessor ends", async () => {
		const model = new InMemoryProviderSessionBindingReadModel();
		model.bindSession("session", "opencode");
		const stale = await Effect.runPromise(model.getBindingRevision("session"));
		model.unbindSession("session");
		model.bindSession("session", "opencode");
		await Effect.runPromise(
			model.unbindSessionIfBoundTo("session", "opencode", stale),
		);
		expect(
			await Effect.runPromise(model.getProviderForSession("session")),
		).toBe("opencode");
	});

	it("does not reuse a revision after transient bindings are cleared", async () => {
		const model = new InMemoryProviderSessionBindingReadModel();
		model.bindSession("session", "opencode");
		const stale = await Effect.runPromise(model.getBindingRevision("session"));
		model.clearTransientBindings();
		model.bindSession("session", "opencode");
		await Effect.runPromise(
			model.unbindSessionIfBoundTo("session", "opencode", stale),
		);
		expect(
			await Effect.runPromise(model.getProviderForSession("session")),
		).toBe("opencode");
	});

	it("compares durable row identity and activation time before unbinding", async () => {
		const dir = mkdtempSync(join(tmpdir(), "conduit-binding-revision-"));
		const layer = EffectSqliteClient.layer({
			filename: join(dir, "events.db"),
		}).pipe(
			Layer.merge(
				Layer.scopedDiscard(
					Effect.addFinalizer(() =>
						Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
					),
				),
			),
		);
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`CREATE TABLE session_providers (
				id TEXT PRIMARY KEY, session_id TEXT NOT NULL, provider TEXT NOT NULL,
				status TEXT NOT NULL, activated_at INTEGER NOT NULL)`;
				yield* sql`INSERT INTO session_providers VALUES ('initial', 'session', 'opencode', 'active', 1)`;
				const model = new SqliteProviderSessionBindingReadModel(sql);
				const stale = yield* model.getBindingRevision("session");
				yield* sql`UPDATE session_providers SET status = 'stopped' WHERE id = 'initial'`;
				yield* sql`INSERT INTO session_providers VALUES ('replacement', 'session', 'opencode', 'active', 2)`;
				yield* model.unbindSessionIfBoundTo("session", "opencode", stale);
				expect(yield* model.getProviderForSession("session")).toBe("opencode");
				expect(yield* model.getBindingRevision("session")).not.toBe(stale);
			}).pipe(Effect.provide(layer)),
		);
	});

	it("does not let a stale revision unbind a reactivated deterministic durable row", async () => {
		const dir = mkdtempSync(join(tmpdir(), "conduit-binding-revision-"));
		const layer = EffectSqliteClient.layer({
			filename: join(dir, "events.db"),
		}).pipe(
			Layer.merge(
				Layer.scopedDiscard(
					Effect.addFinalizer(() =>
						Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
					),
				),
			),
		);
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`CREATE TABLE session_providers (
					id TEXT PRIMARY KEY, session_id TEXT NOT NULL, provider TEXT NOT NULL,
					status TEXT NOT NULL, activated_at INTEGER NOT NULL)`;
				yield* sql`INSERT INTO session_providers VALUES ('deterministic', 'session', 'opencode', 'active', 1)`;
				const model = new SqliteProviderSessionBindingReadModel(sql);
				const stale = yield* model.getBindingRevision("session");
				yield* sql`DELETE FROM session_providers WHERE id = 'deterministic'`;
				yield* sql`INSERT INTO session_providers VALUES ('deterministic', 'session', 'opencode', 'active', 2)`;
				yield* model.unbindSessionIfBoundTo("session", "opencode", stale);
				expect(yield* model.getProviderForSession("session")).toBe("opencode");
				expect(yield* model.getBindingRevision("session")).not.toBe(stale);
			}).pipe(Effect.provide(layer)),
		);
	});

	it("invalidates a captured revision when its durable binding is deleted", async () => {
		const dir = mkdtempSync(join(tmpdir(), "conduit-binding-revision-"));
		const layer = EffectSqliteClient.layer({
			filename: join(dir, "events.db"),
		}).pipe(
			Layer.merge(
				Layer.scopedDiscard(
					Effect.addFinalizer(() =>
						Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
					),
				),
			),
		);
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`CREATE TABLE session_providers (
					id TEXT PRIMARY KEY, session_id TEXT NOT NULL, provider TEXT NOT NULL,
					status TEXT NOT NULL, activated_at INTEGER NOT NULL)`;
				yield* sql`INSERT INTO session_providers VALUES ('initial', 'session', 'opencode', 'active', 1)`;
				const model = new SqliteProviderSessionBindingReadModel(sql);
				expect(yield* model.getBindingRevision("session")).not.toBe(0);
				expect(revisionEntries(model).size).toBe(0);
				yield* sql`DELETE FROM session_providers WHERE session_id = 'session'`;
				expect(yield* model.getProviderForSession("session")).toBeUndefined();
				expect(yield* model.getBindingRevision("session")).toBe(0);
			}).pipe(Effect.provide(layer)),
		);
	});

	it("releases revisions during many-session churn while retaining live bindings", async () => {
		const model = new InMemoryProviderSessionBindingReadModel();
		for (let index = 0; index < 100; index += 1) {
			const sessionId = `churned-${index}`;
			model.bindSession(sessionId, "opencode");
			model.unbindSession(sessionId);
			expect(await Effect.runPromise(model.getBindingRevision(sessionId))).toBe(
				0,
			);
		}
		expect(revisionEntries(model).size).toBe(0);
		model.bindSession("live-1", "opencode");
		model.bindSession("live-2", "claude");
		expect([...revisionEntries(model).keys()]).toEqual(["live-1", "live-2"]);
		expect(await Effect.runPromise(model.listBoundSessions())).toEqual([
			{ sessionId: "live-1", providerId: "opencode" },
			{ sessionId: "live-2", providerId: "claude" },
		]);
	});

	it("successful CAS releases its revision entry", async () => {
		const model = new InMemoryProviderSessionBindingReadModel();
		model.bindSession("session", "opencode");
		const revision = await Effect.runPromise(
			model.getBindingRevision("session"),
		);
		await Effect.runPromise(
			model.unbindSessionIfBoundTo("session", "opencode", revision),
		);
		expect(await Effect.runPromise(model.getBindingRevision("session"))).toBe(
			0,
		);
		expect(revisionEntries(model).size).toBe(0);
		expect(await Effect.runPromise(model.listBoundSessions())).toEqual([]);
	});

	it("SQLite revisions are released during churn and after successful CAS", async () => {
		const dir = mkdtempSync(join(tmpdir(), "conduit-binding-revision-"));
		const layer = EffectSqliteClient.layer({
			filename: join(dir, "events.db"),
		}).pipe(
			Layer.merge(
				Layer.scopedDiscard(
					Effect.addFinalizer(() =>
						Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
					),
				),
			),
		);
		await Effect.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`CREATE TABLE session_providers (
				id TEXT PRIMARY KEY, session_id TEXT NOT NULL, provider TEXT NOT NULL,
				status TEXT NOT NULL, activated_at INTEGER NOT NULL)`;
				const model = new SqliteProviderSessionBindingReadModel(sql);
				for (let index = 0; index < 100; index += 1) {
					const id = `churned-${index}`;
					model.bindSession(id, "opencode");
					model.unbindSession(id);
				}
				expect(revisionEntries(model).size).toBe(0);
				model.bindSession("live-1", "opencode");
				model.bindSession("live-2", "claude");
				expect([...revisionEntries(model).keys()]).toEqual([
					"live-1",
					"live-2",
				]);
				expect(yield* model.listBoundSessions()).toEqual([
					{ sessionId: "live-1", providerId: "opencode" },
					{ sessionId: "live-2", providerId: "claude" },
				]);
				const revision = yield* model.getBindingRevision("live-1");
				yield* model.unbindSessionIfBoundTo("live-1", "opencode", revision);
				expect([...revisionEntries(model).keys()]).toEqual(["live-2"]);
				expect(yield* model.getProviderForSession("live-1")).toBeUndefined();
			}).pipe(Effect.provide(layer)),
		);
	});
});
