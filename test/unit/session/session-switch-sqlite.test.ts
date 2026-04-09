// test/unit/session/session-switch-sqlite.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReadQueryService } from "../../../src/lib/persistence/read-query-service.js";
import { resolveSessionHistoryFromSqlite } from "../../../src/lib/session/session-switch.js";
import {
	createTestHarness,
	type TestHarness,
} from "../../helpers/persistence-factories.js";

describe("resolveSessionHistoryFromSqlite", () => {
	let harness: TestHarness;
	let readQuery: ReadQueryService;

	beforeEach(() => {
		harness = createTestHarness();
		readQuery = new ReadQueryService(harness.db);
	});

	afterEach(() => {
		harness.close();
	});

	it("returns rest-history source with messages from SQLite", () => {
		harness.seedSession("s1");
		harness.seedMessage("m1", "s1", { role: "user", createdAt: 1000 });
		harness.seedMessage("m2", "s1", { role: "assistant", createdAt: 2000 });

		const source = resolveSessionHistoryFromSqlite("s1", readQuery, {
			pageSize: 50,
		});

		expect(source.kind).toBe("rest-history");
		if (source.kind === "rest-history") {
			const { messages } = source.history;
			expect(messages).toHaveLength(2);
			expect(messages[0]!.id).toBe("m1");
			expect(messages[0]!.role).toBe("user");
			expect(messages[1]!.id).toBe("m2");
			expect(messages[1]!.role).toBe("assistant");
			expect(source.history.hasMore).toBe(false);
		}
	});

	it("returns empty source for session with no messages", () => {
		harness.seedSession("s1");

		const source = resolveSessionHistoryFromSqlite("s1", readQuery, {
			pageSize: 50,
		});

		expect(source.kind).toBe("empty");
	});

	it("returns empty source for unknown session", () => {
		const source = resolveSessionHistoryFromSqlite("unknown", readQuery, {
			pageSize: 50,
		});

		expect(source.kind).toBe("empty");
	});

	it("paginates when messages exceed page size", () => {
		harness.seedSession("s1");
		harness.seedMessage("m1", "s1", { role: "user", createdAt: 1000 });
		harness.seedMessage("m2", "s1", { role: "assistant", createdAt: 2000 });
		harness.seedMessage("m3", "s1", { role: "user", createdAt: 3000 });

		const source = resolveSessionHistoryFromSqlite("s1", readQuery, {
			pageSize: 2,
		});

		expect(source.kind).toBe("rest-history");
		if (source.kind === "rest-history") {
			expect(source.history.messages).toHaveLength(2);
			expect(source.history.hasMore).toBe(true);
		}
	});

	it("includes message parts in the history", () => {
		harness.seedSession("s1");
		harness.seedMessage("m1", "s1", {
			role: "user",
			parts: [{ id: "p1", type: "text", text: "Hello" }],
		});

		const source = resolveSessionHistoryFromSqlite("s1", readQuery, {
			pageSize: 50,
		});

		expect(source.kind).toBe("rest-history");
		if (source.kind === "rest-history") {
			const parts = source.history.messages[0]?.parts ?? [];
			expect(parts).toHaveLength(1);
			expect(parts[0]!.id).toBe("p1");
			expect(parts[0]!.type).toBe("text");
			expect(parts[0]!.text).toBe("Hello");
		}
	});

	it("chronological order is preserved", () => {
		harness.seedSession("s1");
		// Insert out of order
		harness.seedMessage("m3", "s1", { role: "user", createdAt: 3000 });
		harness.seedMessage("m1", "s1", { role: "user", createdAt: 1000 });
		harness.seedMessage("m2", "s1", { role: "assistant", createdAt: 2000 });

		const source = resolveSessionHistoryFromSqlite("s1", readQuery, {
			pageSize: 50,
		});

		expect(source.kind).toBe("rest-history");
		if (source.kind === "rest-history") {
			const ids = source.history.messages.map((m) => m.id);
			expect(ids).toEqual(["m1", "m2", "m3"]);
		}
	});
});
