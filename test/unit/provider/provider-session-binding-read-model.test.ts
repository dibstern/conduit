import { afterEach, describe, expect, it } from "vitest";
import { SqliteClient } from "../../../src/lib/persistence/sqlite-client.js";
import {
	InMemoryProviderSessionBindingReadModel,
	type ProviderSessionBindingReadModel,
	SqliteProviderSessionBindingReadModel,
} from "../../../src/lib/provider/provider-session-binding-read-model.js";

type RevisionInspectable = {
	readonly bindingRevisions: Pick<Map<string, number>, "keys" | "size">;
};

type ReadModelImplementation = {
	readonly name: string;
	readonly create: () => ProviderSessionBindingReadModel;
};

const emptyDb = {
	query: <T>(): T[] => [],
	queryOne: <T>(): T | undefined => undefined,
};

const implementations = [
	{
		name: "InMemoryProviderSessionBindingReadModel",
		create: () => new InMemoryProviderSessionBindingReadModel(),
	},
	{
		name: "SqliteProviderSessionBindingReadModel",
		create: () => new SqliteProviderSessionBindingReadModel(emptyDb),
	},
] satisfies readonly ReadModelImplementation[];

function createDurableBindingDb(): SqliteClient {
	const db = SqliteClient.memory();
	db.exec(`CREATE TABLE session_providers (
		id TEXT PRIMARY KEY,
		session_id TEXT NOT NULL,
		provider TEXT NOT NULL,
		status TEXT NOT NULL,
		activated_at INTEGER NOT NULL
	)`);
	db.execute(
		"INSERT INTO session_providers (id, session_id, provider, status, activated_at) VALUES (?, ?, ?, 'active', ?)",
		["session-1:initial", "session-1", "opencode", 1],
	);
	return db;
}

describe("SqliteProviderSessionBindingReadModel durable bindings", () => {
	let db: SqliteClient;

	afterEach(() => {
		db?.close();
	});

	it("does not let a stale revision unbind a replacement durable binding", () => {
		db = createDurableBindingDb();
		const readModel = new SqliteProviderSessionBindingReadModel(db);
		const staleRevision = readModel.getBindingRevision("session-1");

		db.execute(
			"UPDATE session_providers SET status = 'stopped' WHERE session_id = ? AND status = 'active'",
			["session-1"],
		);
		db.execute(
			"INSERT INTO session_providers (id, session_id, provider, status, activated_at) VALUES (?, ?, ?, 'active', ?)",
			["session-1:2", "session-1", "claude", 2],
		);
		db.execute(
			"UPDATE session_providers SET status = 'stopped' WHERE session_id = ? AND status = 'active'",
			["session-1"],
		);
		db.execute(
			"INSERT INTO session_providers (id, session_id, provider, status, activated_at) VALUES (?, ?, ?, 'active', ?)",
			["session-1:3", "session-1", "opencode", 3],
		);

		readModel.unbindSessionIfBoundTo("session-1", "opencode", staleRevision);

		expect(readModel.getProviderForSession("session-1")).toBe("opencode");
	});

	it("invalidates a captured revision when its durable binding is deleted", () => {
		db = createDurableBindingDb();
		const readModel = new SqliteProviderSessionBindingReadModel(db);
		const capturedRevision = readModel.getBindingRevision("session-1");
		expect(capturedRevision).not.toBe(0);
		expect(revisionEntries(readModel).size).toBe(0);

		db.execute("DELETE FROM session_providers WHERE session_id = ?", [
			"session-1",
		]);

		expect(readModel.getProviderForSession("session-1")).toBeUndefined();
		expect(readModel.getBindingRevision("session-1")).toBe(0);
	});

	it("does not let a stale revision unbind a reactivated deterministic durable row", () => {
		db = createDurableBindingDb();
		const readModel = new SqliteProviderSessionBindingReadModel(db);
		const staleRevision = readModel.getBindingRevision("session-1");

		db.execute("DELETE FROM session_providers WHERE session_id = ?", [
			"session-1",
		]);
		db.execute(
			"INSERT INTO session_providers (id, session_id, provider, status, activated_at) VALUES (?, ?, ?, 'active', ?)",
			["session-1:initial", "session-1", "opencode", 2],
		);

		readModel.unbindSessionIfBoundTo("session-1", "opencode", staleRevision);

		expect(readModel.getProviderForSession("session-1")).toBe("opencode");
	});
});

function revisionEntries(
	readModel: ProviderSessionBindingReadModel,
): RevisionInspectable["bindingRevisions"] {
	return (readModel as unknown as RevisionInspectable).bindingRevisions;
}

describe.each(implementations)("$name", ({ create }) => {
	it("preserves a same-provider rebind after a public unbind", () => {
		const readModel = create();
		readModel.bindSession("session-1", "opencode");
		const staleRevision = readModel.getBindingRevision("session-1");

		readModel.unbindSession("session-1");
		readModel.bindSession("session-1", "opencode");
		expect(readModel.getBindingRevision("session-1")).not.toBe(staleRevision);

		readModel.unbindSessionIfBoundTo("session-1", "opencode", staleRevision);

		expect(readModel.getProviderForSession("session-1")).toBe("opencode");
	});

	it("does not reuse a revision across clearTransientBindings", () => {
		const readModel = create();
		readModel.bindSession("session-1", "opencode");
		const staleRevision = readModel.getBindingRevision("session-1");

		readModel.clearTransientBindings();
		readModel.bindSession("session-1", "opencode");
		readModel.unbindSessionIfBoundTo("session-1", "opencode", staleRevision);

		expect(readModel.getProviderForSession("session-1")).toBe("opencode");
	});

	it("releases revisions during many-session churn while retaining live bindings", () => {
		const readModel = create();
		for (let index = 0; index < 100; index += 1) {
			const sessionId = `churned-session-${index}`;
			readModel.bindSession(sessionId, "opencode");
			readModel.unbindSession(sessionId);
		}
		readModel.unbindSession("never-bound-session");

		expect(revisionEntries(readModel).size).toBe(0);

		readModel.bindSession("live-session-1", "opencode");
		readModel.bindSession("live-session-2", "claude");

		expect([...revisionEntries(readModel).keys()]).toEqual([
			"live-session-1",
			"live-session-2",
		]);
		expect(readModel.getProviderForSession("live-session-1")).toBe("opencode");
		expect(readModel.getProviderForSession("live-session-2")).toBe("claude");
	});

	it("successful CAS releases its revision entry", () => {
		const readModel = create();
		readModel.bindSession("session-1", "opencode");
		const bindingRevision = readModel.getBindingRevision("session-1");

		readModel.unbindSessionIfBoundTo("session-1", "opencode", bindingRevision);

		expect(revisionEntries(readModel).size).toBe(0);
		expect(readModel.getProviderForSession("session-1")).toBeUndefined();
	});
});
