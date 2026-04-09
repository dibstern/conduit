// test/unit/session/session-status-poller-sqlite.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "../../../src/lib/instance/opencode-client.js";
import type { ReadFlagMode } from "../../../src/lib/persistence/read-flags.js";
import { isActive } from "../../../src/lib/persistence/read-flags.js";

// ─── Inline algorithm helper (mirrors SessionStatusPoller.poll raw fetch) ─────

async function resolveRawStatuses(
	restFetch: () => Promise<Record<string, SessionStatus>>,
	sqliteRead: (() => Record<string, SessionStatus>) | undefined,
	readFlags: { sessionStatus: ReadFlagMode } | undefined,
): Promise<Record<string, SessionStatus>> {
	// (C1) Use isActive(), not truthy check on the flag
	if (isActive(readFlags?.sessionStatus) && sqliteRead) {
		return Promise.resolve(sqliteRead());
	}
	return restFetch();
}

// ─── Algorithm spec ───────────────────────────────────────────────────────────

describe("Session status poller SQLite switchover algorithm (spec)", () => {
	const restStatuses: Record<string, SessionStatus> = {
		s1: { type: "busy" },
		s2: { type: "idle" },
	};

	const sqliteStatuses: Record<string, SessionStatus> = {
		s1: { type: "busy" },
		s2: { type: "idle" },
		s3: { type: "idle" },
	};

	const restFetch = vi.fn(async () => restStatuses);
	const sqliteRead = vi.fn(() => sqliteStatuses);

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("uses REST when flag is 'legacy'", async () => {
		const result = await resolveRawStatuses(restFetch, sqliteRead, {
			sessionStatus: "legacy",
		});
		expect(result).toBe(restStatuses);
		expect(restFetch).toHaveBeenCalled();
		expect(sqliteRead).not.toHaveBeenCalled();
	});

	it("uses SQLite when flag is 'sqlite'", async () => {
		const result = await resolveRawStatuses(restFetch, sqliteRead, {
			sessionStatus: "sqlite",
		});
		expect(result).toBe(sqliteStatuses);
		expect(sqliteRead).toHaveBeenCalled();
		expect(restFetch).not.toHaveBeenCalled();
	});

	it("uses SQLite when flag is 'shadow'", async () => {
		const result = await resolveRawStatuses(restFetch, sqliteRead, {
			sessionStatus: "shadow",
		});
		expect(result).toBe(sqliteStatuses);
		expect(sqliteRead).toHaveBeenCalled();
		expect(restFetch).not.toHaveBeenCalled();
	});

	it("falls back to REST when sqliteRead is unavailable", async () => {
		const result = await resolveRawStatuses(restFetch, undefined, {
			sessionStatus: "sqlite",
		});
		expect(result).toBe(restStatuses);
		expect(restFetch).toHaveBeenCalled();
	});

	it("falls back to REST when readFlags is absent", async () => {
		const result = await resolveRawStatuses(restFetch, sqliteRead, undefined);
		expect(result).toBe(restStatuses);
		expect(restFetch).toHaveBeenCalled();
		expect(sqliteRead).not.toHaveBeenCalled();
	});
});
