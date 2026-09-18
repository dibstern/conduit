// ─── Session Manager parentID propagation (ticket 5.3) ──────────────────────
import { describe, expect, it, vi } from "vitest";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import { SessionManager } from "../../../src/lib/session/session-manager.js";
import type { RelayMessage } from "../../../src/lib/types.js";

describe("toSessionInfoList parentID propagation (ticket 5.3)", () => {
	it("includes parentID when present in SessionDetail", async () => {
		const mockClient = {
			session: {
				list: vi.fn().mockResolvedValue([
					{
						id: "ses_child",
						title: "Forked Session",
						parentID: "ses_parent",
						time: { created: 1000, updated: 2000 },
					},
					{
						id: "ses_parent",
						title: "Original Session",
						time: { created: 500, updated: 1500 },
					},
				]),
			},
		} as unknown as OpenCodeAPI;

		const mgr = new SessionManager({ client: mockClient });
		const sessions = await mgr.listSessions();

		const child = sessions.find((s) => s.id === "ses_child");
		expect(child).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(child!.parentID).toBe("ses_parent");

		const parent = sessions.find((s) => s.id === "ses_parent");
		expect(parent).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(parent!.parentID).toBeUndefined();
	});
});

describe("cascade delete forgets counts down the parentID lineage", () => {
	it("prunes a descendant the parent cache never saw", async () => {
		const mockClient = {
			session: {
				list: vi.fn().mockResolvedValue([
					{
						id: "ses_parent",
						title: "Parent",
						time: { created: 500, updated: 1500 },
					},
					{
						id: "ses_child",
						title: "Child",
						parentID: "ses_parent",
						time: { created: 1000, updated: 2000 },
					},
					{
						id: "ses_grandchild",
						title: "Grandchild",
						parentID: "ses_child",
						time: { created: 1200, updated: 2200 },
					},
				]),
				delete: vi.fn().mockResolvedValue(undefined),
			},
		} as unknown as OpenCodeAPI;

		const mgr = new SessionManager({ client: mockClient });

		// The parent cache is a by-product of listSessions(), so a manager that
		// has not listed yet knows no child→parent edges — and counts can arrive
		// before that first refresh. Lineage has to come from the provider, not
		// from the cache.
		expect(mgr.getSessionParentMap().size).toBe(0);
		mgr.incrementPendingQuestionCount("ses_child");
		mgr.incrementPendingQuestionCount("ses_grandchild");

		const broadcasts: RelayMessage[] = [];
		mgr.on("broadcast", (msg) => broadcasts.push(msg));

		await mgr.deleteSession("ses_parent");

		// Counts ride the `session_list` message now, so one left behind rebuilds
		// an attention badge for a session the browser can no longer show.
		const rootsList = broadcasts.find((m) => m.type === "session_list");
		expect(rootsList).toBeDefined();
		expect(rootsList).not.toHaveProperty("pendingQuestionCounts");
	});
});
