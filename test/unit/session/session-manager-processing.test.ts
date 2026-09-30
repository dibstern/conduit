import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "../../../src/lib/instance/sdk-types.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { SessionManager } from "../../../src/lib/session/session-manager.js";

describe("SessionManager.listSessions — status", () => {
	let mgr: SessionManager;
	const mockSessions = [
		{ id: "sess_1", title: "Session 1", time: { updated: 1000 } },
		{ id: "sess_2", title: "Session 2", time: { updated: 2000 } },
		{ id: "sess_3", title: "Session 3", time: { updated: 500 } },
	];

	beforeEach(() => {
		mgr = new SessionManager({
			client: {
				session: {
					list: vi.fn().mockResolvedValue(mockSessions),
				},
			} as unknown as ConstructorParameters<typeof SessionManager>[0]["client"],
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
