import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "../../../src/lib/instance/opencode-client.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { SessionManager } from "../../../src/lib/session/session-manager.js";

describe("SessionManager.listSessions — processing flag", () => {
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

	it("sets processing=true for busy sessions when statuses provided", async () => {
		const statuses: Record<string, SessionStatus> = {
			sess_1: { type: "busy" },
			sess_2: { type: "idle" },
			sess_3: { type: "idle" },
		};

		const sessions = await mgr.listSessions({ statuses });

		const s1 = sessions.find((s) => s.id === "sess_1");
		const s2 = sessions.find((s) => s.id === "sess_2");
		expect(s1?.processing).toBe(true);
		expect(s2?.processing).toBeUndefined();
	});

	it("sets processing=true for retry sessions when statuses provided", async () => {
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
		expect(s1?.processing).toBe(true);
	});

	it("does not set processing when statuses not provided", async () => {
		const sessions = await mgr.listSessions();

		for (const s of sessions) {
			expect(s.processing).toBeUndefined();
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
		expect(s1?.processing).toBe(true);
	});
});
