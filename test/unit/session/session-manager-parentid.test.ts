// Session Manager parentID propagation (ticket 5.3)
import { assert, describe, expect, it, vi } from "vitest";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import type { SessionDetail } from "../../../src/lib/instance/sdk-types.js";
import { SessionManager } from "../../../src/lib/session/session-manager.js";
import { partialFake } from "../../helpers/partial-fake.js";

describe("toSessionInfoList parentID propagation (ticket 5.3)", () => {
	it("includes parentID when present in SessionDetail", async () => {
		const mockClient = partialFake<OpenCodeAPI>({
			session: partialFake<OpenCodeAPI["session"]>({
				list: vi.fn<OpenCodeAPI["session"]["list"]>().mockResolvedValue([
					partialFake<SessionDetail>({
						id: "ses_child",
						title: "Forked Session",
						parentID: "ses_parent",
						time: { created: 1000, updated: 2000 },
					}),
					partialFake<SessionDetail>({
						id: "ses_parent",
						title: "Original Session",
						time: { created: 500, updated: 1500 },
					}),
				]),
			}),
		});

		const mgr = new SessionManager({ client: mockClient });
		const sessions = await mgr.listSessions();

		const child = sessions.find((s) => s.id === "ses_child");
		expect(child).toBeDefined();
		assert.exists(child, "expected child session");
		expect(child.parentID).toBe("ses_parent");

		const parent = sessions.find((s) => s.id === "ses_parent");
		expect(parent).toBeDefined();
		assert.exists(parent, "expected parent session");
		expect(parent.parentID).toBeUndefined();
	});
});
