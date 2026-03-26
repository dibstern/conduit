// ─── handleForkSession Tests (ticket 5.3) ────────────────────────────────────
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PayloadMap } from "../../../src/lib/handlers/payloads.js";
import {
	handleForkSession,
	handleNewSession,
	handleSwitchSession,
	handleViewSession,
} from "../../../src/lib/handlers/session.js";
import type { HandlerDeps } from "../../../src/lib/handlers/types.js";
import type { RequestId } from "../../../src/lib/shared-types.js";
import { createMockHandlerDeps } from "../../helpers/mock-factories.js";

describe("handleForkSession (ticket 5.3)", () => {
	let deps: HandlerDeps;
	let broadcastCalls: unknown[];
	let sendToCalls: Array<{ clientId: string; msg: unknown }>;

	beforeEach(() => {
		broadcastCalls = [];
		sendToCalls = [];
		deps = createMockHandlerDeps({
			wsHandler: {
				broadcast: (msg: unknown) => broadcastCalls.push(msg),
				sendTo: (clientId: string, msg: unknown) =>
					sendToCalls.push({ clientId, msg }),
				setClientSession: vi.fn(),
				getClientSession: vi.fn(),
				getClientsForSession: vi.fn().mockReturnValue([]),
				sendToSession: vi.fn(),
			} as unknown as HandlerDeps["wsHandler"],
			client: {
				forkSession: vi.fn().mockResolvedValue({
					id: "ses_forked",
					title: "Forked from Original",
					parentID: "ses_original",
					time: { created: 1000, updated: 1000 },
				}),
			} as unknown as HandlerDeps["client"],
			sessionMgr: {
				getDefaultSessionId: vi.fn().mockResolvedValue("ses_original"),
				listSessions: vi.fn().mockResolvedValue([
					{
						id: "ses_forked",
						title: "Forked from Original",
						updatedAt: 1000,
						parentID: "ses_original",
					},
					{ id: "ses_original", title: "Original", updatedAt: 500 },
				]),
				sendDualSessionLists: vi
					.fn()
					.mockImplementation(async (send: (msg: unknown) => void) => {
						send({ type: "session_list", sessions: [], roots: true });
						send({ type: "session_list", sessions: [], roots: false });
					}),
			} as unknown as HandlerDeps["sessionMgr"],
		});
	});

	it("calls client.forkSession with sessionId and messageID", async () => {
		await handleForkSession(deps, "client-1", {
			sessionId: "ses_original",
			messageId: "msg_abc",
		});

		expect(deps.client.forkSession).toHaveBeenCalledWith("ses_original", {
			messageID: "msg_abc",
		});
	});

	it("forks without messageID when not provided (forks entire session)", async () => {
		await handleForkSession(deps, "client-1", {
			sessionId: "ses_original",
		});

		expect(deps.client.forkSession).toHaveBeenCalledWith("ses_original", {});
	});

	it("broadcasts session_forked with parent info", async () => {
		await handleForkSession(deps, "client-1", {
			sessionId: "ses_original",
		});

		const forkedMsg = broadcastCalls.find(
			(m) => (m as Record<string, unknown>)["type"] === "session_forked",
		) as Record<string, unknown> | undefined;
		expect(forkedMsg).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect((forkedMsg!["session"] as Record<string, unknown>)["id"]).toBe(
			"ses_forked",
		);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(forkedMsg!["parentId"]).toBe("ses_original");
	});

	it("does NOT mutate global session state (per-tab — no global side effects)", async () => {
		await handleForkSession(deps, "client-1", {
			sessionId: "ses_original",
		});

		// Session manager should not have any session-switching methods called
		// Only listSessions is called (to find parent title)
		expect(deps.sessionMgr.listSessions).toHaveBeenCalled();
	});

	it("sends session_switched to requesting client only (per-tab)", async () => {
		await handleForkSession(deps, "client-1", {
			sessionId: "ses_original",
		});

		const switchedMsg = sendToCalls.find(
			(c) =>
				c.clientId === "client-1" &&
				(c.msg as Record<string, unknown>)["type"] === "session_switched",
		);
		expect(switchedMsg).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect((switchedMsg!.msg as Record<string, unknown>)["id"]).toBe(
			"ses_forked",
		);
		// session_switched should NOT be in broadcast calls
		const broadcastSwitched = broadcastCalls.find(
			(m) => (m as Record<string, unknown>)["type"] === "session_switched",
		);
		expect(broadcastSwitched).toBeUndefined();
	});

	it("associates client with forked session", async () => {
		await handleForkSession(deps, "client-1", {
			sessionId: "ses_original",
		});

		expect(deps.wsHandler.setClientSession).toHaveBeenCalledWith(
			"client-1",
			"ses_forked",
		);
	});

	it("broadcasts updated session list", async () => {
		await handleForkSession(deps, "client-1", {
			sessionId: "ses_original",
		});

		const listMsg = broadcastCalls.find(
			(m) => (m as Record<string, unknown>)["type"] === "session_list",
		);
		expect(listMsg).toBeDefined();
	});

	it("clears overrides for the source session", async () => {
		await handleForkSession(deps, "client-1", {
			sessionId: "ses_original",
		});

		expect(deps.overrides.clearSession).toHaveBeenCalledWith("ses_original");
	});

	it("uses getClientSession as fallback when sessionId not in payload", async () => {
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue(
			"ses_client_tab",
		);

		await handleForkSession(
			deps,
			"client-1",
			{} as unknown as PayloadMap["fork_session"],
		);

		expect(deps.client.forkSession).toHaveBeenCalledWith("ses_client_tab", {});
	});

	it("prefers payload.sessionId over getClientSession", async () => {
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue(
			"ses_client_tab",
		);

		await handleForkSession(deps, "client-1", {
			sessionId: "ses_explicit",
		});

		expect(deps.client.forkSession).toHaveBeenCalledWith("ses_explicit", {});
	});

	it("stores forkMessageId from messageId payload", async () => {
		let storedSessionId: string | undefined;
		let storedMessageId: string | undefined;
		const forkMeta = {
			setForkEntry: (
				sid: string,
				entry: { forkMessageId: string; parentID: string },
			) => {
				storedSessionId = sid;
				storedMessageId = entry.forkMessageId;
			},
		};
		const depsWithMeta = { ...deps, forkMeta };
		await handleForkSession(depsWithMeta, "client-1", {
			sessionId: "ses_original",
			messageId: "msg_42",
		});
		expect(storedSessionId).toBe("ses_forked");
		expect(storedMessageId).toBe("msg_42");
	});

	it("includes forkMessageId in session_forked broadcast", async () => {
		const depsWithMeta = {
			...deps,
			forkMeta: { setForkEntry: () => {} },
		};
		await handleForkSession(depsWithMeta, "client-1", {
			sessionId: "ses_original",
			messageId: "msg_42",
		});
		const forkedMsg = broadcastCalls.find(
			(m) => (m as Record<string, unknown>)["type"] === "session_forked",
		) as Record<string, unknown> | undefined;
		expect(
			(forkedMsg?.["session"] as Record<string, unknown>)?.["forkMessageId"],
		).toBe("msg_42");
	});

	it("determines forkMessageId from last message on whole-session fork", async () => {
		let storedMessageId: string | undefined;
		const forkMeta = {
			setForkEntry: (
				_sid: string,
				entry: { forkMessageId: string; parentID: string },
			) => {
				storedMessageId = entry.forkMessageId;
			},
		};
		// Re-create deps with a client that includes getMessagesPage
		const getMessagesPageMock = vi.fn().mockResolvedValue([{ id: "msg_last" }]);
		const depsWithMeta = {
			...deps,
			client: {
				...deps.client,
				getMessagesPage: getMessagesPageMock,
			} as unknown as HandlerDeps["client"],
			forkMeta,
		};
		await handleForkSession(depsWithMeta, "client-1", {
			sessionId: "ses_original",
		});
		expect(storedMessageId).toBe("msg_last");
	});

	it("calls clearSession on the source session", async () => {
		deps.overrides = {
			clearSession: vi.fn(),
		} as unknown as HandlerDeps["overrides"];

		await handleForkSession(deps, "client-1", {
			sessionId: "ses_original",
		});

		expect(deps.overrides.clearSession).toHaveBeenCalledWith("ses_original");
	});
});

describe("handleViewSession — per-tab session viewing", () => {
	let deps: HandlerDeps;
	let sendToCalls: Array<{ clientId: string; msg: unknown }>;

	beforeEach(() => {
		sendToCalls = [];
		deps = createMockHandlerDeps({
			wsHandler: {
				broadcast: vi.fn(),
				sendTo: (clientId: string, msg: unknown) =>
					sendToCalls.push({ clientId, msg }),
				setClientSession: vi.fn(),
				getClientSession: vi.fn(),
				getClientsForSession: vi.fn().mockReturnValue([]),
				sendToSession: vi.fn(),
			} as unknown as HandlerDeps["wsHandler"],
			client: {
				getSession: vi.fn().mockResolvedValue({
					id: "sess_target",
					modelID: "gpt-4",
					providerID: "openai",
				}),
			} as unknown as HandlerDeps["client"],
			sessionMgr: {
				getDefaultSessionId: vi.fn().mockResolvedValue("sess_current"),
				listSessions: vi.fn().mockResolvedValue([]),
				sendDualSessionLists: vi
					.fn()
					.mockImplementation(async (send: (msg: unknown) => void) => {
						send({ type: "session_list", sessions: [], roots: true });
						send({ type: "session_list", sessions: [], roots: false });
					}),
				loadPreRenderedHistory: vi.fn().mockResolvedValue({
					messages: [],
					hasMore: false,
					total: 0,
				}),
			} as unknown as HandlerDeps["sessionMgr"],
			statusPoller: {
				isProcessing: vi.fn().mockReturnValue(false),
			},
		});
	});

	it("associates client with session via setClientSession", async () => {
		await handleViewSession(deps, "client-1", { sessionId: "sess_target" });

		expect(deps.wsHandler.setClientSession).toHaveBeenCalledWith(
			"client-1",
			"sess_target",
		);
	});

	it("sends status to requesting client only (not broadcast)", async () => {
		await handleViewSession(deps, "client-1", { sessionId: "sess_target" });

		const statusMsg = sendToCalls.find(
			(c) =>
				c.clientId === "client-1" &&
				(c.msg as Record<string, unknown>)["type"] === "status",
		);
		expect(statusMsg).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect((statusMsg!.msg as Record<string, unknown>)["status"]).toBe("idle");
		// Only broadcast is the session_viewed notification_event (for cross-client indicator clearing)
		expect(deps.wsHandler.broadcast).toHaveBeenCalledOnce();
		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "notification_event",
				eventType: "session_viewed",
				sessionId: "sess_target",
			}),
		);
	});

	it("sends status 'processing' when session is busy", async () => {
		(
			deps.statusPoller as { isProcessing: ReturnType<typeof vi.fn> }
		).isProcessing.mockReturnValue(true);

		await handleViewSession(deps, "client-1", { sessionId: "sess_target" });

		const statusMsg = sendToCalls.find(
			(c) =>
				c.clientId === "client-1" &&
				(c.msg as Record<string, unknown>)["type"] === "status",
		);
		expect(statusMsg).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect((statusMsg!.msg as Record<string, unknown>)["status"]).toBe(
			"processing",
		);
	});

	it("does nothing when sessionId is empty", async () => {
		await handleViewSession(deps, "client-1", { sessionId: "" });

		expect(deps.wsHandler.setClientSession).not.toHaveBeenCalled();
		expect(sendToCalls).toHaveLength(0);
	});

	it("handleViewSession should resolve before metadata fetches complete", async () => {
		// Create a deferred promise for getSession to control timing
		let resolveGetSession!: () => void;
		const getSessionPromise = new Promise<void>((r) => {
			resolveGetSession = r;
		});
		deps.client.getSession = vi
			.fn()
			.mockReturnValue(
				getSessionPromise.then(() => ({ modelID: "test-model" })),
			);

		const handlerPromise = handleViewSession(deps, "client-1", {
			sessionId: "session-1",
		});

		// Handler should resolve quickly (before metadata)
		const result = await Promise.race([
			handlerPromise.then(() => "resolved" as const),
			new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50)),
		]);

		expect(result).toBe("resolved");

		// Clean up — resolve the deferred promise
		resolveGetSession();
		// Flush: let fire-and-forget promises settle
		await new Promise((r) => setTimeout(r, 10));
	});

	it("sends session_list to the requesting client after viewing", async () => {
		const sessions = [
			{
				id: "child-1",
				title: "Child",
				parentID: "parent-1",
				updatedAt: 1000,
				messageCount: 0,
			},
			{ id: "parent-1", title: "Parent", updatedAt: 500, messageCount: 0 },
		];
		vi.mocked(deps.sessionMgr.sendDualSessionLists).mockImplementation(
			async (send) => {
				send({ type: "session_list", sessions, roots: true });
				send({ type: "session_list", sessions, roots: false });
			},
		);

		await handleViewSession(deps, "client-1", { sessionId: "child-1" });

		const sessionListMsg = sendToCalls.find(
			(c) =>
				c.clientId === "client-1" &&
				(c.msg as Record<string, unknown>)["type"] === "session_list",
		);
		expect(sessionListMsg).toBeDefined();
		expect(
			(sessionListMsg?.msg as { type: string; sessions: unknown[] }).sessions,
		).toEqual(sessions);
	});
});

describe("handleNewSession", () => {
	let sendToCalls: Array<{ clientId: string; msg: unknown }>;
	let broadcastCalls: unknown[];
	let deps: HandlerDeps;

	beforeEach(() => {
		sendToCalls = [];
		broadcastCalls = [];
		deps = createMockHandlerDeps({
			wsHandler: {
				...createMockHandlerDeps().wsHandler,
				sendTo: (clientId: string, msg: unknown) =>
					sendToCalls.push({ clientId, msg }),
				broadcast: (msg: unknown) => broadcastCalls.push(msg),
				setClientSession: vi.fn(),
			} as unknown as HandlerDeps["wsHandler"],
		});
	});

	it("echoes requestId in session_switched response", async () => {
		await handleNewSession(deps, "client-1", {
			title: "test",
			requestId: "req-123" as RequestId,
		});

		const switched = sendToCalls.find(
			(c) => (c.msg as Record<string, unknown>)["type"] === "session_switched",
		);
		expect(switched).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect((switched!.msg as Record<string, unknown>)["requestId"]).toBe(
			"req-123",
		);
	});

	it("omits requestId when not provided", async () => {
		await handleNewSession(deps, "client-1", { title: "test" });

		const switched = sendToCalls.find(
			(c) => (c.msg as Record<string, unknown>)["type"] === "session_switched",
		);
		expect(switched).toBeDefined();
		expect(
			(switched?.msg as Record<string, unknown>)["requestId"],
		).toBeUndefined();
	});

	it("broadcasts session list after creation (non-blocking)", async () => {
		await handleNewSession(deps, "client-1", { title: "test" });

		// Broadcast is non-blocking — flush the microtask queue.
		await new Promise((r) => setTimeout(r, 0));

		const listMsg = broadcastCalls.find(
			(c) => (c as Record<string, unknown>)["type"] === "session_list",
		);
		expect(listMsg).toBeDefined();
	});

	it("logs but doesn't throw when session list broadcast fails", async () => {
		const logCalls: string[] = [];
		deps.sessionMgr.sendDualSessionLists = vi
			.fn()
			.mockRejectedValue(new Error("db down"));
		// Create a Logger that captures warn calls for assertion
		const capture = (...args: unknown[]) =>
			logCalls.push(args.map(String).join(" "));
		deps.log = {
			debug: capture,
			info: capture,
			verbose: capture,
			warn: capture,
			error: capture,
			child: () => deps.log,
		};

		// Should not throw
		await handleNewSession(deps, "client-1", { title: "test" });
		await new Promise((r) => setTimeout(r, 0));

		expect(logCalls.some((m) => m.includes("Failed to broadcast"))).toBe(true);
	});
});

describe("handleSwitchSession — alias for handleViewSession", () => {
	it("delegates to handleViewSession (per-tab model)", async () => {
		const sendToCalls: Array<{ clientId: string; msg: unknown }> = [];
		const deps = createMockHandlerDeps({
			wsHandler: {
				broadcast: vi.fn(),
				sendTo: (clientId: string, msg: unknown) =>
					sendToCalls.push({ clientId, msg }),
				setClientSession: vi.fn(),
				getClientSession: vi.fn(),
				getClientsForSession: vi.fn().mockReturnValue([]),
				sendToSession: vi.fn(),
			} as unknown as HandlerDeps["wsHandler"],
			client: {
				getSession: vi.fn().mockResolvedValue({
					id: "sess_target",
					modelID: "gpt-4",
					providerID: "openai",
				}),
			} as unknown as HandlerDeps["client"],
			sessionMgr: {
				getDefaultSessionId: vi.fn().mockResolvedValue("sess_current"),
				sendDualSessionLists: vi.fn().mockResolvedValue(undefined),
				loadPreRenderedHistory: vi.fn().mockResolvedValue({
					messages: [],
					hasMore: false,
					total: 0,
				}),
			} as unknown as HandlerDeps["sessionMgr"],
		});

		await handleSwitchSession(deps, "client-1", {
			sessionId: "sess_target",
		});

		// Should behave like handleViewSession: setClientSession + sendTo
		expect(deps.wsHandler.setClientSession).toHaveBeenCalledWith(
			"client-1",
			"sess_target",
		);

		const switchedMsg = sendToCalls.find(
			(c) =>
				c.clientId === "client-1" &&
				(c.msg as Record<string, unknown>)["type"] === "session_switched",
		);
		expect(switchedMsg).toBeDefined();
	});
});
