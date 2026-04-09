// test/unit/session/session-status-sqlite.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReadQueryService } from "../../../src/lib/persistence/read-query-service.js";
import { SessionStatusSqliteReader } from "../../../src/lib/session/session-status-sqlite.js";
import {
	createTestHarness,
	type TestHarness,
} from "../../helpers/persistence-factories.js";

function seedSessionStatus(
	harness: TestHarness,
	id: string,
	status: string,
): void {
	harness.seedSession(id, { status });
}

describe("SessionStatusSqliteReader", () => {
	let harness: TestHarness;
	let readQuery: ReadQueryService;
	let reader: SessionStatusSqliteReader;

	beforeEach(() => {
		harness = createTestHarness();
		readQuery = new ReadQueryService(harness.db);
		reader = new SessionStatusSqliteReader(readQuery);
	});

	afterEach(() => {
		harness.close();
	});

	it("returns statuses for all sessions in OpenCode format", () => {
		seedSessionStatus(harness, "s1", "idle");
		seedSessionStatus(harness, "s2", "busy");

		const statuses = reader.getSessionStatuses();
		expect(statuses["s1"]).toEqual({ type: "idle" });
		expect(statuses["s2"]).toEqual({ type: "busy" });
	});

	it("isProcessing returns true for busy sessions", () => {
		seedSessionStatus(harness, "s1", "busy");
		seedSessionStatus(harness, "s2", "idle");

		expect(reader.isProcessing("s1")).toBe(true);
		expect(reader.isProcessing("s2")).toBe(false);
	});

	it("isProcessing returns true for retry sessions", () => {
		seedSessionStatus(harness, "s1", "retry");
		expect(reader.isProcessing("s1")).toBe(true);
	});

	it("isProcessing returns false for nonexistent session", () => {
		expect(reader.isProcessing("nonexistent")).toBe(false);
	});

	it("returns empty object when no sessions exist", () => {
		expect(reader.getSessionStatuses()).toEqual({});
	});

	it("reflects status changes from projection updates", () => {
		seedSessionStatus(harness, "s1", "idle");
		expect(reader.isProcessing("s1")).toBe(false);

		// Simulate projector updating the status
		harness.db.execute("UPDATE sessions SET status = 'busy' WHERE id = ?", [
			"s1",
		]);
		expect(reader.isProcessing("s1")).toBe(true);
	});
});
