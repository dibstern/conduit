import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import type {
	SessionDetail,
	SessionStatus,
} from "../../../src/lib/instance/sdk-types.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { SessionManager } from "../../../src/lib/session/session-manager.js";
import { partialFake } from "../../helpers/partial-fake.js";

describe("SessionManager.listSessions — status", () => {
	let mgr: SessionManager;
	const mockSessions = [
		partialFake<SessionDetail>({
			id: "sess_1",
			title: "Session 1",
			time: partialFake<SessionDetail["time"]>({ updated: 1000 }),
		}),
		partialFake<SessionDetail>({
			id: "sess_2",
			title: "Session 2",
			time: partialFake<SessionDetail["time"]>({ updated: 2000 }),
		}),
		partialFake<SessionDetail>({
			id: "sess_3",
			title: "Session 3",
			time: partialFake<SessionDetail["time"]>({ updated: 500 }),
		}),
	];

	beforeEach(() => {
		mgr = new SessionManager({
			client: partialFake<OpenCodeAPI>({
				session: partialFake<OpenCodeAPI["session"]>({
					list: vi
						.fn<OpenCodeAPI["session"]["list"]>()
						.mockResolvedValue(mockSessions),
				}),
			}),
			log: createSilentLogger(),
		});
	});

	it("carries the provider's busy status when statuses are provided", async () => {
		const statuses: Record<string, SessionStatus> = {
			sess_1: { type: "busy" },
			sess_2: { type: "idle" },
			sess_3: { type: "idle" },
		};

		const sessions = await mgr.listSessions({ statuses });

		const s1 = sessions.find((s) => s.id === "sess_1");
		const s2 = sessions.find((s) => s.id === "sess_2");
		expect(s1?.status).toBe("busy");
		expect(s2?.status).toBe("idle");
	});

	it("carries the provider's retry status when statuses are provided", async () => {
		const statuses: Record<string, SessionStatus> = {
			sess_1: {
				type: "retry",
				attempt: 1,
				message: "rate limited",
				next: 9999,
			},
			sess_2: { type: "idle" },
		};

		const sessions = await mgr.listSessions({ statuses });

		const s1 = sessions.find((s) => s.id === "sess_1");
		expect(s1?.status).toBe("retry");
	});

	it("reads as idle when no statuses are provided", async () => {
		const sessions = await mgr.listSessions();

		for (const s of sessions) {
			expect(s.status).toBe("idle");
		}
	});

	it("handles statuses with session IDs not in the session list", async () => {
		const statuses: Record<string, SessionStatus> = {
			sess_1: { type: "busy" },
			sess_unknown: { type: "busy" },
		};

		const sessions = await mgr.listSessions({ statuses });

		// sess_unknown is not in the list, should not crash
		expect(sessions).toHaveLength(3);
		const s1 = sessions.find((s) => s.id === "sess_1");
		expect(s1?.status).toBe("busy");
	});
});
