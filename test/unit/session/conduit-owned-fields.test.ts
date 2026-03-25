import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenCodeClient } from "../../../src/lib/instance/opencode-client.js";
import { SessionManager } from "../../../src/lib/session/session-manager.js";

describe("conduit-owned fields survive session list refresh", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "conduit-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	describe("toSessionInfoList fork metadata enrichment", () => {
		it("applies parentID from fork metadata when OpenCode has no parentID", async () => {
			const mockClient = {
				listSessions: vi.fn().mockResolvedValue([
					{
						id: "ses_forked",
						title: "Forked Session",
						time: { created: 1000, updated: 2000 },
					},
					{
						id: "ses_parent",
						title: "Original Session",
						time: { created: 500, updated: 1500 },
					},
				]),
			} as unknown as OpenCodeClient;

			const mgr = new SessionManager({ client: mockClient, configDir: tmpDir });
			mgr.setForkEntry("ses_forked", {
				forkMessageId: "msg_42",
				parentID: "ses_parent",
			});

			const sessions = await mgr.listSessions();

			const forked = sessions.find((s) => s.id === "ses_forked");
			expect(forked).toBeDefined();
			expect(forked?.parentID).toBe("ses_parent");
			expect(forked?.forkMessageId).toBe("msg_42");
		});

		it("prefers OpenCode parentID over fork metadata parentID", async () => {
			const mockClient = {
				listSessions: vi.fn().mockResolvedValue([
					{
						id: "ses_sub",
						title: "Subagent Session",
						parentID: "ses_opencode_parent",
						time: { created: 1000, updated: 2000 },
					},
				]),
			} as unknown as OpenCodeClient;

			const mgr = new SessionManager({ client: mockClient, configDir: tmpDir });
			mgr.setForkEntry("ses_sub", {
				forkMessageId: "msg_99",
				parentID: "ses_conduit_parent",
			});

			const sessions = await mgr.listSessions();
			const sub = sessions.find((s) => s.id === "ses_sub");
			expect(sub?.parentID).toBe("ses_opencode_parent");
		});

		it("applies forkMessageId even when parentID comes from OpenCode", async () => {
			const mockClient = {
				listSessions: vi.fn().mockResolvedValue([
					{
						id: "ses_sub",
						title: "Subagent Session",
						parentID: "ses_parent",
						time: { created: 1000 },
					},
				]),
			} as unknown as OpenCodeClient;

			const mgr = new SessionManager({ client: mockClient, configDir: tmpDir });
			mgr.setForkEntry("ses_sub", {
				forkMessageId: "msg_77",
				parentID: "ses_parent",
			});

			const sessions = await mgr.listSessions();
			const sub = sessions.find((s) => s.id === "ses_sub");
			expect(sub?.forkMessageId).toBe("msg_77");
		});

		it("non-forked sessions have neither parentID nor forkMessageId", async () => {
			const mockClient = {
				listSessions: vi.fn().mockResolvedValue([
					{
						id: "ses_normal",
						title: "Normal Session",
						time: { created: 1000 },
					},
				]),
			} as unknown as OpenCodeClient;

			const mgr = new SessionManager({ client: mockClient, configDir: tmpDir });
			const sessions = await mgr.listSessions();
			const normal = sessions.find((s) => s.id === "ses_normal");

			expect(normal?.parentID).toBeUndefined();
			expect(normal?.forkMessageId).toBeUndefined();
		});
	});

	describe("server-side enrichment guarantees", () => {
		it("repeated listSessions calls always include fork metadata", async () => {
			const mockClient = {
				listSessions: vi.fn().mockResolvedValue([
					{
						id: "ses_forked",
						title: "Forked",
						time: { created: 1000 },
					},
				]),
			} as unknown as OpenCodeClient;

			const mgr = new SessionManager({ client: mockClient, configDir: tmpDir });
			mgr.setForkEntry("ses_forked", {
				forkMessageId: "msg_1",
				parentID: "ses_parent",
			});

			// First call
			const first = await mgr.listSessions();
			expect(first[0]?.parentID).toBe("ses_parent");
			expect(first[0]?.forkMessageId).toBe("msg_1");

			// Second call (simulates session_list refresh)
			const second = await mgr.listSessions();
			expect(second[0]?.parentID).toBe("ses_parent");
			expect(second[0]?.forkMessageId).toBe("msg_1");

			// Third call (another refresh)
			const third = await mgr.listSessions();
			expect(third[0]?.parentID).toBe("ses_parent");
			expect(third[0]?.forkMessageId).toBe("msg_1");
		});

		it("searchSessions also includes fork metadata", async () => {
			const mockClient = {
				listSessions: vi.fn().mockResolvedValue([
					{
						id: "ses_forked",
						title: "Forked Search Target",
						time: { created: 1000 },
					},
				]),
			} as unknown as OpenCodeClient;

			const mgr = new SessionManager({ client: mockClient, configDir: tmpDir });
			mgr.setForkEntry("ses_forked", {
				forkMessageId: "msg_search",
				parentID: "ses_p",
			});

			const results = await mgr.searchSessions("Search Target");
			expect(results[0]?.parentID).toBe("ses_p");
			expect(results[0]?.forkMessageId).toBe("msg_search");
		});
	});
});
