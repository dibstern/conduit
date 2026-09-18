// ─── Session Manager parentID propagation (ticket 5.3) ──────────────────────
import { describe, expect, it, vi } from "vitest";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import { SessionManager } from "../../../src/lib/session/session-manager.js";

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
