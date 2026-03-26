// ─── Session Manager PBT Tests (Ticket 2.3) ──────────────────────────────────

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import type {
	Message,
	OpenCodeClient,
	SessionDetail,
} from "../../../src/lib/instance/opencode-client.js";
import { SessionManager } from "../../../src/lib/session/session-manager.js";
import type { RelayMessage } from "../../../src/lib/types.js";

const SEED = 42;
const NUM_RUNS = 50;

// ─── Mock OpenCodeClient ─────────────────────────────────────────────────────

interface MockSession {
	id: string;
	title: string;
	time: { created: number; updated: number };
}

function createMockClient(initial: MockSession[] = []): OpenCodeClient & {
	_sessions: MockSession[];
	_messages: Map<string, Message[]>;
} {
	const sessions = [...initial];
	const messages = new Map<string, Message[]>();
	let nextId = sessions.length;

	return {
		_sessions: sessions,
		_messages: messages,

		async listSessions() {
			return sessions.map((s) => ({
				id: s.id,
				title: s.title,
				time: s.time,
			})) as SessionDetail[];
		},

		async createSession(options?: { title?: string }) {
			const id = `ses_${++nextId}`;
			const now = Date.now();
			const session: MockSession = {
				id,
				title: options?.title ?? "Untitled",
				time: { created: now, updated: now },
			};
			sessions.push(session);
			return { id, title: session.title, time: session.time } as SessionDetail;
		},

		async deleteSession(sessionId: string) {
			const idx = sessions.findIndex((s) => s.id === sessionId);
			if (idx >= 0) sessions.splice(idx, 1);
		},

		async updateSession(sessionId: string, updates: { title?: string }) {
			const session = sessions.find((s) => s.id === sessionId);
			if (session && updates.title) {
				session.title = updates.title;
				session.time.updated = Date.now();
			}
			return session as unknown as SessionDetail;
		},

		async getMessages(sessionId: string) {
			return messages.get(sessionId) ?? [];
		},

		async getMessagesPage(
			sessionId: string,
			options?: { limit?: number; before?: string },
		) {
			const all = messages.get(sessionId) ?? [];
			const limit = options?.limit ?? all.length;
			if (!options?.before) {
				// No cursor: return the last `limit` messages (most recent page)
				return all.slice(-limit);
			}
			// Cursor: return `limit` messages before the given ID
			const idx = all.findIndex((m) => m.id === options.before);
			if (idx <= 0) return [];
			const start = Math.max(0, idx - limit);
			return all.slice(start, idx);
		},

		// Stubs for other methods that SessionManager doesn't call
		async getHealth() {
			return { ok: true };
		},
		getAuthHeaders() {
			return {};
		},
		getBaseUrl() {
			return "http://localhost:4096";
		},
	} as unknown as OpenCodeClient & {
		_sessions: MockSession[];
		_messages: Map<string, Message[]>;
	};
}

// ─── Arbitraries ─────────────────────────────────────────────────────────────

const arbSessionTitle = fc.string({ minLength: 1, maxLength: 50 });

const arbSession = fc.record({
	id: fc.stringMatching(/^ses_[a-z0-9]{4,12}$/),
	title: arbSessionTitle,
	time: fc.record({
		created: fc.integer({ min: 1700000000000, max: 1800000000000 }),
		updated: fc.integer({ min: 1700000000000, max: 1800000000000 }),
	}),
});

const _arbMessage = (sessionId: string) =>
	fc.record({
		id: fc.stringMatching(/^msg_[a-z0-9]{4,8}$/),
		role: fc.constantFrom("user", "assistant"),
		sessionID: fc.constant(sessionId),
	});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Ticket 2.3 — Session Manager PBT", () => {
	describe("P1: Initialize resumes most recent session or creates one (AC8)", () => {
		it("property: with existing sessions, resumes the one with most recent time.updated (or createdAt)", async () => {
			await fc.assert(
				fc.asyncProperty(
					fc.array(arbSession, { minLength: 1, maxLength: 10 }),
					async (sessions) => {
						// Ensure unique IDs
						const unique = dedup(sessions);
						if (unique.length === 0) return;

						const client = createMockClient(unique);
						const mgr = new SessionManager({ client });

						const id = await mgr.initialize();

						// Should reuse an existing session
						const existingIds = new Set(unique.map((s) => s.id));
						expect(existingIds.has(id)).toBe(true);
						// No new session created — total count unchanged
						expect(client._sessions.length).toBe(unique.length);
						// Returned session should be the one with the highest time.updated
						// (initialize seeds lastMessageAt from time.updated)
						const sorted = unique
							.slice()
							.sort(
								(a, b) =>
									(b.time?.updated ?? b.time?.created ?? 0) -
									(a.time?.updated ?? a.time?.created ?? 0),
							);
						// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
						expect(id).toBe(sorted[0]!.id);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS },
			);
		});

		it("property: with existing sessions, prefers session with most recent time.updated", async () => {
			const sessions: MockSession[] = [
				{
					id: "ses_old",
					title: "Old",
					time: { created: 1000, updated: 5000 },
				},
				{
					id: "ses_new",
					title: "New",
					time: { created: 2000, updated: 2000 },
				},
			];
			const client = createMockClient(sessions);

			const mgr = new SessionManager({ client });
			const id = await mgr.initialize();

			// ses_old has time.updated=5000 > ses_new time.updated=2000
			expect(id).toBe("ses_old");
		});

		it("property: with no sessions, creates one", async () => {
			const client = createMockClient([]);
			const mgr = new SessionManager({ client });

			const id = await mgr.initialize("Test");
			expect(id).toBeTruthy();
			expect(client._sessions.length).toBe(1);
		});
	});

	it("initialize does not fetch messages (uses session time.updated)", async () => {
		const sessions: MockSession[] = [
			{
				id: "ses_a",
				title: "A",
				time: { created: 1000, updated: 5000 },
			},
			{
				id: "ses_b",
				title: "B",
				time: { created: 2000, updated: 3000 },
			},
		];
		const client = createMockClient(sessions);
		// Add messages that should NOT be fetched
		client._messages.set("ses_a", [
			{
				id: "msg_1",
				role: "user",
				sessionID: "ses_a",
				time: { created: 9000 },
			},
		] as Message[]);

		// Spy on getMessages to verify it is NOT called
		let getMessagesCalled = false;
		const origGetMessages = client.getMessages.bind(client);
		client.getMessages = async (
			...args: Parameters<typeof origGetMessages>
		) => {
			getMessagesCalled = true;
			return origGetMessages(...args);
		};

		const mgr = new SessionManager({ client });
		const id = await mgr.initialize();

		// getMessages should NOT have been called during initialize
		expect(getMessagesCalled).toBe(false);

		// lastMessageAt should be seeded from session time.updated
		const map = mgr.getLastMessageAtMap();
		expect(map.get("ses_a")).toBe(5000);
		expect(map.get("ses_b")).toBe(3000);

		// Should return session with highest time.updated
		expect(id).toBe("ses_a");
	});

	describe("P2: Create session (AC1)", () => {
		it("property: creates session and broadcasts list", async () => {
			await fc.assert(
				fc.asyncProperty(arbSessionTitle, async (title) => {
					const client = createMockClient([]);
					const mgr = new SessionManager({ client });

					const broadcasts: RelayMessage[] = [];
					mgr.on("broadcast", (msg) => broadcasts.push(msg));

					const session = await mgr.createSession(title);

					expect(session.id).toBeTruthy();

					// Flush microtasks for background all-sessions broadcast
					await new Promise((r) => setTimeout(r, 0));

					// Should broadcast dual session_list (roots + all) — no session_switched
					expect(broadcasts.length).toBe(2);
					// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
					expect(broadcasts[0]!.type).toBe("session_list");
					// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
					expect(broadcasts[1]!.type).toBe("session_list");
				}),
				{ seed: SEED, numRuns: NUM_RUNS },
			);
		});
	});

	describe("P3: getDefaultSessionId", () => {
		it("returns most recent session when sessions exist", async () => {
			const client = createMockClient([
				{ id: "ses_old", title: "old", time: { created: 1000, updated: 1000 } },
				{ id: "ses_new", title: "new", time: { created: 2000, updated: 2000 } },
			]);
			const mgr = new SessionManager({ client });
			const defaultId = await mgr.getDefaultSessionId();
			expect(defaultId).toBe("ses_new");
		});

		it("creates a new session when none exist", async () => {
			const client = createMockClient([]);
			const mgr = new SessionManager({ client });
			const defaultId = await mgr.getDefaultSessionId();
			expect(defaultId).toBeTruthy();
			// Verify session was actually created
			const sessions = await client.listSessions();
			expect(sessions).toHaveLength(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
			expect(sessions[0]!.id).toBe(defaultId);
		});

		it("emits session_lifecycle when creating a new session", async () => {
			const client = createMockClient([]);
			const mgr = new SessionManager({ client });

			const events: { type: string; sessionId: string }[] = [];
			mgr.on("session_lifecycle", (ev) => events.push(ev));

			const defaultId = await mgr.getDefaultSessionId();

			expect(events).toHaveLength(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
			expect(events[0]!.type).toBe("created");
			// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
			expect(events[0]!.sessionId).toBe(defaultId);
		});

		it("does not emit session_lifecycle when returning existing session", async () => {
			const client = createMockClient([
				{ id: "ses_1", title: "One", time: { created: 1000, updated: 1000 } },
			]);
			const mgr = new SessionManager({ client });

			const events: { type: string; sessionId: string }[] = [];
			mgr.on("session_lifecycle", (ev) => events.push(ev));

			await mgr.getDefaultSessionId();

			expect(events).toHaveLength(0);
		});
	});

	describe("P4: List sessions sorted by last message time / createdAt (AC3)", () => {
		it("property: sessions are sorted most-recent first (by createdAt when no messages)", async () => {
			await fc.assert(
				fc.asyncProperty(
					fc.array(arbSession, { minLength: 2, maxLength: 10 }),
					async (sessions) => {
						const unique = dedup(sessions);
						if (unique.length < 2) return;

						const client = createMockClient(unique);
						const mgr = new SessionManager({ client });

						const list = await mgr.listSessions();

						// Verify sorted descending by updatedAt
						for (let i = 1; i < list.length; i++) {
							expect(
								// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
								Number(list[i - 1]!.updatedAt ?? 0),
								// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
							).toBeGreaterThanOrEqual(Number(list[i]!.updatedAt ?? 0));
						}
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS },
			);
		});

		it("sessions with recent time.updated sort before sessions with only older timestamps", async () => {
			const sessions: MockSession[] = [
				{
					id: "ses_newer_created",
					title: "Newer Created",
					time: { created: 5000, updated: 5000 },
				},
				{
					id: "ses_older_but_active",
					title: "Older But Active",
					time: { created: 1000, updated: 10000 },
				},
			];
			const client = createMockClient(sessions);

			const mgr = new SessionManager({ client });
			// Seed lastMessageAt via initialize (uses time.updated)
			await mgr.initialize();

			const list = await mgr.listSessions();

			// ses_older_but_active has time.updated=10000 > ses_newer_created time.updated=5000
			// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
			expect(list[0]!.id).toBe("ses_older_but_active");
			// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
			expect(list[1]!.id).toBe("ses_newer_created");
		});

		it("property: each session has required fields", async () => {
			await fc.assert(
				fc.asyncProperty(
					fc.array(arbSession, { minLength: 1, maxLength: 5 }),
					async (sessions) => {
						const unique = dedup(sessions);
						if (unique.length === 0) return;

						const client = createMockClient(unique);
						const mgr = new SessionManager({ client });

						const list = await mgr.listSessions();
						for (const s of list) {
							expect(typeof s.id).toBe("string");
							expect(typeof s.title).toBe("string");
							expect(typeof s.updatedAt).toBe("number");
							expect(typeof s.messageCount).toBe("number");
						}
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS },
			);
		});
	});

	describe("P5: Delete session (AC4)", () => {
		it("property: deleting a session removes it and emits session_lifecycle", async () => {
			const sessions: MockSession[] = [
				{ id: "ses_a", title: "A", time: { created: 1000, updated: 1000 } },
				{ id: "ses_b", title: "B", time: { created: 2000, updated: 3000 } },
				{ id: "ses_c", title: "C", time: { created: 2000, updated: 2000 } },
			];
			const client = createMockClient(sessions);
			const mgr = new SessionManager({ client });

			const lifecycleEvents: { type: string; sessionId: string }[] = [];
			mgr.on("session_lifecycle", (ev) => lifecycleEvents.push(ev));

			const broadcasts: RelayMessage[] = [];
			mgr.on("broadcast", (msg) => broadcasts.push(msg));

			await mgr.deleteSession("ses_b");

			// Should emit session_lifecycle with type "deleted"
			expect(
				lifecycleEvents.some(
					(e) => e.type === "deleted" && e.sessionId === "ses_b",
				),
			).toBe(true);
			// Should broadcast session_list
			expect(broadcasts.some((m) => m.type === "session_list")).toBe(true);
			// Session should be removed
			expect(client._sessions.find((s) => s.id === "ses_b")).toBeUndefined();
		});

		it("property: deleting non-existent session still emits lifecycle", async () => {
			const sessions: MockSession[] = [
				{ id: "ses_x", title: "X", time: { created: 1000, updated: 2000 } },
			];
			const client = createMockClient(sessions);
			const mgr = new SessionManager({ client });

			const lifecycleEvents: { type: string; sessionId: string }[] = [];
			mgr.on("session_lifecycle", (ev) => lifecycleEvents.push(ev));

			await mgr.deleteSession("ses_y");

			expect(lifecycleEvents).toHaveLength(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
			expect(lifecycleEvents[0]!.type).toBe("deleted");
			// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
			expect(lifecycleEvents[0]!.sessionId).toBe("ses_y");
		});

		it("property: deleting last session emits lifecycle", async () => {
			const sessions: MockSession[] = [
				{
					id: "ses_only",
					title: "Only",
					time: { created: 1000, updated: 1000 },
				},
			];
			const client = createMockClient(sessions);
			const mgr = new SessionManager({ client });

			const lifecycleEvents: { type: string; sessionId: string }[] = [];
			mgr.on("session_lifecycle", (ev) => lifecycleEvents.push(ev));

			await mgr.deleteSession("ses_only");

			expect(lifecycleEvents).toHaveLength(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
			expect(lifecycleEvents[0]!.type).toBe("deleted");
		});
	});

	describe("P6: Rename session (AC5)", () => {
		it("property: rename updates title and broadcasts list", async () => {
			await fc.assert(
				fc.asyncProperty(arbSessionTitle, async (newTitle) => {
					const sessions: MockSession[] = [
						{
							id: "ses_r",
							title: "Old Title",
							time: { created: 1000, updated: 1000 },
						},
					];
					const client = createMockClient(sessions);
					const mgr = new SessionManager({ client });

					const broadcasts: RelayMessage[] = [];
					mgr.on("broadcast", (msg) => broadcasts.push(msg));

					await mgr.renameSession("ses_r", newTitle);

					// Title updated in mock
					// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
					expect(client._sessions[0]!.title).toBe(newTitle);

					// Broadcasts session_list
					expect(broadcasts.some((m) => m.type === "session_list")).toBe(true);
				}),
				{ seed: SEED, numRuns: NUM_RUNS },
			);
		});
	});

	describe("P7: Search sessions (AC6)", () => {
		it("property: search filters by title substring", async () => {
			const sessions: MockSession[] = [
				{
					id: "ses_1",
					title: "Auth Feature",
					time: { created: 1000, updated: 1000 },
				},
				{
					id: "ses_2",
					title: "Bug Fix Login",
					time: { created: 2000, updated: 2000 },
				},
				{
					id: "ses_3",
					title: "Authentication Refactor",
					time: { created: 3000, updated: 3000 },
				},
			];
			const client = createMockClient(sessions);
			const mgr = new SessionManager({ client });

			const results = await mgr.searchSessions("auth");

			// Should match "Auth Feature" and "Authentication Refactor"
			expect(results.length).toBe(2);
			expect(results.every((r) => r.title.toLowerCase().includes("auth"))).toBe(
				true,
			);
		});

		it("property: search is case-insensitive", async () => {
			const sessions: MockSession[] = [
				{
					id: "ses_1",
					title: "My Project",
					time: { created: 1000, updated: 1000 },
				},
			];
			const client = createMockClient(sessions);
			const mgr = new SessionManager({ client });

			const upper = await mgr.searchSessions("MY PROJECT");
			const lower = await mgr.searchSessions("my project");

			expect(upper.length).toBe(lower.length);
		});

		it("property: empty query returns all sessions", async () => {
			await fc.assert(
				fc.asyncProperty(
					fc.array(arbSession, { minLength: 1, maxLength: 5 }),
					async (sessions) => {
						const unique = dedup(sessions);
						if (unique.length === 0) return;

						const client = createMockClient(unique);
						const mgr = new SessionManager({ client });

						const all = await mgr.searchSessions("");
						expect(all.length).toBe(unique.length);
					},
				),
				{ seed: SEED, numRuns: 20 },
			);
		});
	});

	describe("P8: History pagination (AC7)", () => {
		// Pagination loads from the END backwards:
		//   offset=0  → most recent pageSize messages
		//   offset=50 → the 50 messages before those

		it("property: first page returns most recent pageSize messages", async () => {
			const client = createMockClient([
				{
					id: "ses_h",
					title: "History",
					time: { created: 1000, updated: 1000 },
				},
			]);

			// Add 120 messages (msg_0 oldest, msg_119 newest)
			const msgs: Message[] = Array.from({ length: 120 }, (_, i) => ({
				id: `msg_${i}`,
				role: i % 2 === 0 ? "user" : "assistant",
				sessionID: "ses_h",
			})) as Message[];
			client._messages.set("ses_h", msgs);

			const mgr = new SessionManager({ client, historyPageSize: 50 });

			// offset=0: most recent 50 (msg_70..msg_119)
			const page1 = await mgr.loadHistory("ses_h", 0);
			expect(page1.messages.length).toBe(50);
			// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
			expect(page1.messages[0]!.id).toBe("msg_70");
			// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
			expect(page1.messages[49]!.id).toBe("msg_119");
			expect(page1.hasMore).toBe(true);

			// offset=50: next older 50 (msg_20..msg_69) via cursor
			const page2 = await mgr.loadHistory("ses_h", 50);
			expect(page2.messages.length).toBe(50);
			// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
			expect(page2.messages[0]!.id).toBe("msg_20");
			// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
			expect(page2.messages[49]!.id).toBe("msg_69");
			expect(page2.hasMore).toBe(true);

			// offset=100: oldest 20 (msg_0..msg_19) via cursor
			const page3 = await mgr.loadHistory("ses_h", 100);
			expect(page3.messages.length).toBe(20);
			// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
			expect(page3.messages[0]!.id).toBe("msg_0");
			// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
			expect(page3.messages[19]!.id).toBe("msg_19");
			expect(page3.hasMore).toBe(false);
		});

		it("property: pageSize configurable", async () => {
			await fc.assert(
				fc.asyncProperty(
					fc.integer({ min: 5, max: 100 }),
					fc.integer({ min: 1, max: 200 }),
					async (pageSize, msgCount) => {
						const client = createMockClient([
							{
								id: "ses_p",
								title: "Page",
								time: { created: 1000, updated: 1000 },
							},
						]);
						const msgs = Array.from({ length: msgCount }, (_, i) => ({
							id: `msg_${i}`,
							role: "user",
							sessionID: "ses_p",
						})) as Message[];
						client._messages.set("ses_p", msgs);

						const mgr = new SessionManager({
							client,
							historyPageSize: pageSize,
						});
						// offset=0: most recent pageSize messages
						const page = await mgr.loadHistory("ses_p", 0);

						expect(page.messages.length).toBe(Math.min(pageSize, msgCount));
						// Cursor-based pagination: hasMore = page.length >= pageSize,
						// so it's true when msgCount >= pageSize (can't distinguish exact boundary)
						expect(page.hasMore).toBe(msgCount >= pageSize);
					},
				),
				{ seed: SEED, numRuns: NUM_RUNS },
			);
		});
	});

	describe("P9: Session lifecycle integration", () => {
		it("create → rename → delete lifecycle", async () => {
			const client = createMockClient([]);
			const mgr = new SessionManager({ client });

			const broadcasts: RelayMessage[] = [];
			mgr.on("broadcast", (msg) => broadcasts.push(msg));

			// Create two sessions
			const s1 = await mgr.createSession("First");
			const s2 = await mgr.createSession("Second");

			// Rename first
			await mgr.renameSession(s1.id, "Renamed First");

			// Delete first
			const lifecycleEvents: { type: string; sessionId: string }[] = [];
			mgr.on("session_lifecycle", (ev) => lifecycleEvents.push(ev));

			await mgr.deleteSession(s1.id);
			expect(
				lifecycleEvents.some(
					(e) => e.type === "deleted" && e.sessionId === s1.id,
				),
			).toBe(true);

			// Delete second
			await mgr.deleteSession(s2.id);
			expect(
				lifecycleEvents.some(
					(e) => e.type === "deleted" && e.sessionId === s2.id,
				),
			).toBe(true);
		});
	});

	describe("P10: Silent option for createSession and deleteSession", () => {
		it("createSession with { silent: true } does NOT emit broadcast events", async () => {
			const client = createMockClient([]);
			const mgr = new SessionManager({ client });

			const broadcasts: RelayMessage[] = [];
			mgr.on("broadcast", (msg) => broadcasts.push(msg));

			await mgr.createSession("Silent", { silent: true });

			// No broadcasts at all (no session_switched, no session_list)
			expect(broadcasts.length).toBe(0);
		});

		it("createSession with { silent: true } still emits session_lifecycle", async () => {
			const client = createMockClient([]);
			const mgr = new SessionManager({ client });

			const sessionChangedEvents: { type: string; sessionId: string }[] = [];
			mgr.on("session_lifecycle", (ev) => sessionChangedEvents.push(ev));

			const session = await mgr.createSession("Silent", { silent: true });

			// session_lifecycle should still fire (needed for internal state like SSE filter)
			expect(sessionChangedEvents.length).toBe(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
			expect(sessionChangedEvents[0]!.sessionId).toBe(session.id);
			// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
			expect(sessionChangedEvents[0]!.type).toBe("created");
		});

		it("createSession without opts still broadcasts list (backward compatible)", async () => {
			await fc.assert(
				fc.asyncProperty(arbSessionTitle, async (title) => {
					const client = createMockClient([]);
					const mgr = new SessionManager({ client });

					const broadcasts: RelayMessage[] = [];
					mgr.on("broadcast", (msg) => broadcasts.push(msg));

					await mgr.createSession(title);

					// Flush microtasks for background all-sessions broadcast
					await new Promise((r) => setTimeout(r, 0));

					// Should broadcast dual session_list (roots + all) — no session_switched
					expect(broadcasts.length).toBe(2);
					// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
					expect(broadcasts[0]!.type).toBe("session_list");
					// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
					expect(broadcasts[1]!.type).toBe("session_list");
				}),
				{ seed: SEED, numRuns: NUM_RUNS },
			);
		});

		it("deleteSession with { silent: true } does NOT broadcast session_list", async () => {
			const sessions: MockSession[] = [
				{ id: "ses_a", title: "A", time: { created: 1000, updated: 1000 } },
				{ id: "ses_b", title: "B", time: { created: 2000, updated: 3000 } },
			];
			const client = createMockClient(sessions);
			const mgr = new SessionManager({ client });

			const broadcasts: RelayMessage[] = [];
			mgr.on("broadcast", (msg) => broadcasts.push(msg));

			await mgr.deleteSession("ses_b", { silent: true });

			// Should NOT broadcast anything
			expect(broadcasts.length).toBe(0);
		});

		it("deleteSession with { silent: true } still emits session_lifecycle", async () => {
			const sessions: MockSession[] = [
				{ id: "ses_a", title: "A", time: { created: 1000, updated: 1000 } },
				{ id: "ses_b", title: "B", time: { created: 2000, updated: 3000 } },
			];
			const client = createMockClient(sessions);
			const mgr = new SessionManager({ client });

			const sessionChangedEvents: { type: string; sessionId: string }[] = [];
			mgr.on("session_lifecycle", (ev) => sessionChangedEvents.push(ev));

			await mgr.deleteSession("ses_b", { silent: true });

			// session_lifecycle should still fire for the deleted session
			expect(sessionChangedEvents.length).toBe(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
			expect(sessionChangedEvents[0]!.sessionId).toBe("ses_b");
			// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
			expect(sessionChangedEvents[0]!.type).toBe("deleted");
		});

		it("deleteSession without opts still broadcasts session_list (backward compatible)", async () => {
			const sessions: MockSession[] = [
				{ id: "ses_a", title: "A", time: { created: 1000, updated: 1000 } },
				{ id: "ses_b", title: "B", time: { created: 2000, updated: 3000 } },
			];
			const client = createMockClient(sessions);
			const mgr = new SessionManager({ client });

			const broadcasts: RelayMessage[] = [];
			mgr.on("broadcast", (msg) => broadcasts.push(msg));

			await mgr.deleteSession("ses_b");

			expect(broadcasts.some((m) => m.type === "session_list")).toBe(true);
		});
	});

	describe("session_lifecycle event", () => {
		it("emits { type: 'created' } on createSession", async () => {
			const client = createMockClient([]);
			const mgr = new SessionManager({ client });
			const events: Array<{ type: string; sessionId: string }> = [];
			mgr.on("session_lifecycle", (ev) => events.push(ev));
			await mgr.createSession("test");
			expect(events).toHaveLength(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
			expect(events[0]!.type).toBe("created");
		});

		it("emits { type: 'deleted' } on deleteSession", async () => {
			const client = createMockClient([
				{ id: "ses_1", title: "a", time: { created: 1, updated: 1 } },
			]);
			const mgr = new SessionManager({ client });
			await mgr.initialize();
			const events: Array<{ type: string; sessionId: string }> = [];
			mgr.on("session_lifecycle", (ev) => events.push(ev));
			await mgr.deleteSession("ses_1", { silent: true });
			expect(events).toHaveLength(1);
			// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
			expect(events[0]!.type).toBe("deleted");
		});
	});
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function dedup(sessions: MockSession[]): MockSession[] {
	const seen = new Set<string>();
	return sessions.filter((s) => {
		if (seen.has(s.id)) return false;
		seen.add(s.id);
		return true;
	});
}
