// ─── Regression: Claude session history wiring ──────────────────────────────
//
// Verifies the three wiring gaps that caused Claude sessions to show no history
// when switching away and back:
//
//   Gap 1 – wireHandlerDeps must propagate claudeEventPersist through to
//            handlerDeps so handleMessage can write user turns to SQLite.
//
//   Gap 2 – toSessionSwitchDeps() (inside handlers/session.ts) must include
//            readQuery so handleViewSession uses SQLite history, not REST.
//
//   Gap 3 – handleClientConnected (client-init.ts) must pass readQuery to
//            switchClientToSession so the initial connect uses SQLite history.
//
// Each test seeds a real in-memory SQLite database, calls the production code,
// and asserts the session_switched message contains SQLite history — not the
// REST mock, not an empty payload.  Removing any of the three wiring lines
// causes the corresponding test to fail.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ClientInitDeps,
	handleClientConnected,
} from "../../src/lib/bridges/client-init.js";
import { handleViewSession } from "../../src/lib/handlers/session.js";
import type { HandlerDeps } from "../../src/lib/handlers/types.js";
import { ReadQueryService } from "../../src/lib/persistence/read-query-service.js";
import type { RelayEventSinkPersist } from "../../src/lib/provider/relay-event-sink.js";
import { wireHandlerDeps } from "../../src/lib/relay/handler-deps-wiring.js";
import {
	createMockClientInitDeps,
	createMockHandlerDeps,
} from "../helpers/mock-factories.js";
import {
	createTestHarness,
	type TestHarness,
} from "../helpers/persistence-factories.js";

// ─── Shared helpers ──────────────────────────────────────────────────────────

/** Spy that records every sendTo(clientId, msg) call. */
function makeSendToSpy() {
	const calls: Array<{ clientId: string; msg: unknown }> = [];
	const fn = (clientId: string, msg: unknown) => calls.push({ clientId, msg });
	const findSessionSwitched = (clientId: string) =>
		calls.find(
			(c) =>
				c.clientId === clientId &&
				(c.msg as { type?: string }).type === "session_switched",
		)?.msg as { type: string; history?: { messages: unknown[] } } | undefined;
	return { fn, calls, findSessionSwitched };
}

// ─── Gap 1 ───────────────────────────────────────────────────────────────────
// wireHandlerDeps must propagate claudeEventPersist to handlerDeps.
// If the spread `...(claudeEventPersist != null && { claudeEventPersist })` is
// removed from handler-deps-wiring.ts the resulting handlerDeps would have
// claudeEventPersist=undefined, so user turns never reach SQLite.

describe("Gap 1 – wireHandlerDeps propagates claudeEventPersist", () => {
	let harness: TestHarness;

	beforeEach(() => {
		harness = createTestHarness();
	});
	afterEach(() => {
		harness.close();
	});

	it("handlerDeps.claudeEventPersist is defined when wired with persistence", () => {
		const persist: RelayEventSinkPersist = {
			eventStore: harness.eventStore,
			projectionRunner: {
				projectEvent: vi.fn(),
			} as RelayEventSinkPersist["projectionRunner"],
			ensureSession: vi.fn(),
		};

		const base = createMockHandlerDeps();
		// wireHandlerDeps registers event listeners via wsHandler.on().
		// Provide a minimal .on() stub so the wiring call doesn't throw.
		type WiringDeps = Parameters<typeof wireHandlerDeps>[0];
		const wsHandlerWithOn = {
			...base.wsHandler,
			on: vi.fn(),
		} as unknown as WiringDeps["wsHandler"];

		const result = wireHandlerDeps({
			wsHandler: wsHandlerWithOn,
			client: base.client,
			sessionMgr: base.sessionMgr,
			permissionBridge: base.permissionBridge,
			overrides: base.overrides,
			ptyManager: base.ptyManager,
			config: base.config,
			log: base.log,
			wsLog: base.log,
			statusPoller: base.statusPoller as unknown as WiringDeps["statusPoller"],
			registry: base.registry,
			pollerManager:
				base.pollerManager as unknown as WiringDeps["pollerManager"],
			ptyDeps: {} as unknown as WiringDeps["ptyDeps"],
			claudeEventPersist: persist,
		});

		expect(result.handlerDeps.claudeEventPersist).toBeDefined();
		expect(result.handlerDeps.claudeEventPersist).toBe(persist);
	});

	it("handlerDeps.claudeEventPersist is undefined when wired without persistence", () => {
		const base = createMockHandlerDeps();
		type WiringDeps = Parameters<typeof wireHandlerDeps>[0];
		const wsHandlerWithOn = {
			...base.wsHandler,
			on: vi.fn(),
		} as unknown as WiringDeps["wsHandler"];

		const result = wireHandlerDeps({
			wsHandler: wsHandlerWithOn,
			client: base.client,
			sessionMgr: base.sessionMgr,
			permissionBridge: base.permissionBridge,
			overrides: base.overrides,
			ptyManager: base.ptyManager,
			config: base.config,
			log: base.log,
			wsLog: base.log,
			statusPoller: base.statusPoller as unknown as WiringDeps["statusPoller"],
			registry: base.registry,
			pollerManager:
				base.pollerManager as unknown as WiringDeps["pollerManager"],
			ptyDeps: {} as unknown as WiringDeps["ptyDeps"],
			// claudeEventPersist intentionally omitted
		});

		expect(result.handlerDeps.claudeEventPersist).toBeUndefined();
	});
});

// ─── Gap 2 ───────────────────────────────────────────────────────────────────
// toSessionSwitchDeps() in handlers/session.ts must include readQuery.
// If the spread `...(deps.readQuery != null && { readQuery: deps.readQuery })`
// is removed, handleViewSession falls back to the REST mock instead of SQLite.

describe("Gap 2 – handleViewSession uses SQLite history when readQuery is provided", () => {
	let harness: TestHarness;
	let readQuery: ReadQueryService;

	beforeEach(() => {
		harness = createTestHarness();
		readQuery = new ReadQueryService(harness.db);

		// Seed session + messages so SQLite has real history
		harness.seedSession("sess-a");
		harness.seedMessage("msg-1", "sess-a", {
			role: "user",
			createdAt: 1000,
			parts: [{ id: "p1", type: "text", text: "Hello from SQLite" }],
		});
		harness.seedMessage("msg-2", "sess-a", {
			role: "assistant",
			createdAt: 2000,
			parts: [{ id: "p2", type: "text", text: "Response from SQLite" }],
		});
	});
	afterEach(() => {
		harness.close();
	});

	it("session_switched contains SQLite messages, not REST mock", async () => {
		const spy = makeSendToSpy();
		const deps = createMockHandlerDeps({
			readQuery,
			wsHandler: {
				broadcast: vi.fn(),
				sendTo: spy.fn,
				setClientSession: vi.fn(),
				getClientSession: vi.fn().mockReturnValue("sess-a"),
				getClientsForSession: vi.fn().mockReturnValue(["client-1"]),
				sendToSession: vi.fn(),
			} as unknown as HandlerDeps["wsHandler"],
			sessionMgr: {
				getDefaultSessionId: vi.fn().mockResolvedValue("sess-a"),
				listSessions: vi.fn().mockResolvedValue([]),
				sendDualSessionLists: vi.fn().mockResolvedValue(undefined),
				// REST mock returns completely different data — verifies SQLite wins
				loadPreRenderedHistory: vi.fn().mockResolvedValue({
					messages: [{ id: "rest-msg", role: "user", parts: [] }],
					hasMore: false,
					total: 1,
				}),
				clearPaginationCursor: vi.fn(),
				seedPaginationCursor: vi.fn(),
			} as unknown as HandlerDeps["sessionMgr"],
			client: {
				session: {
					get: vi
						.fn()
						.mockResolvedValue({ id: "sess-a", modelID: "", providerID: "" }),
				},
				question: { list: vi.fn().mockResolvedValue([]) },
				permission: { list: vi.fn().mockResolvedValue([]) },
			} as unknown as HandlerDeps["client"],
			statusPoller: {
				isProcessing: vi.fn().mockReturnValue(false),
			},
		});

		await handleViewSession(deps, "client-1", { sessionId: "sess-a" });

		const switchedMsg = spy.findSessionSwitched("client-1");
		expect(switchedMsg).toBeDefined();

		// SQLite history uses the `history` key (rest-history source)
		expect(switchedMsg?.history).toBeDefined();
		const messages = switchedMsg?.history?.messages ?? [];
		// Must be SQLite data (2 rows), not REST mock data (1 row with id "rest-msg")
		expect(messages).toHaveLength(2);
		expect((messages[0] as { id: string }).id).toBe("msg-1");
		expect((messages[1] as { id: string }).id).toBe("msg-2");
	});

	it("falls back to REST when readQuery is absent", async () => {
		const spy = makeSendToSpy();
		const deps = createMockHandlerDeps({
			// readQuery intentionally absent
			wsHandler: {
				broadcast: vi.fn(),
				sendTo: spy.fn,
				setClientSession: vi.fn(),
				getClientSession: vi.fn().mockReturnValue("sess-a"),
				getClientsForSession: vi.fn().mockReturnValue(["client-1"]),
				sendToSession: vi.fn(),
			} as unknown as HandlerDeps["wsHandler"],
			sessionMgr: {
				getDefaultSessionId: vi.fn().mockResolvedValue("sess-a"),
				listSessions: vi.fn().mockResolvedValue([]),
				sendDualSessionLists: vi.fn().mockResolvedValue(undefined),
				loadPreRenderedHistory: vi.fn().mockResolvedValue({
					messages: [{ id: "rest-msg", role: "user", parts: [] }],
					hasMore: false,
					total: 1,
				}),
				clearPaginationCursor: vi.fn(),
				seedPaginationCursor: vi.fn(),
			} as unknown as HandlerDeps["sessionMgr"],
			client: {
				session: {
					get: vi
						.fn()
						.mockResolvedValue({ id: "sess-a", modelID: "", providerID: "" }),
				},
				question: { list: vi.fn().mockResolvedValue([]) },
				permission: { list: vi.fn().mockResolvedValue([]) },
			} as unknown as HandlerDeps["client"],
			statusPoller: {
				isProcessing: vi.fn().mockReturnValue(false),
			},
		});

		await handleViewSession(deps, "client-1", { sessionId: "sess-a" });

		const switchedMsg = spy.findSessionSwitched("client-1");
		expect(switchedMsg).toBeDefined();
		const messages = switchedMsg?.history?.messages ?? [];
		// REST mock data returned when no readQuery
		expect(messages).toHaveLength(1);
		expect((messages[0] as { id: string }).id).toBe("rest-msg");
	});
});

// ─── Gap 3 ───────────────────────────────────────────────────────────────────
// handleClientConnected must pass readQuery to switchClientToSession.
// If `...(deps.readQuery != null && { readQuery: deps.readQuery })` is removed
// from the SessionSwitchDeps in client-init.ts, the initial connect ignores
// SQLite and falls back to the REST mock.

describe("Gap 3 – handleClientConnected uses SQLite history when readQuery is provided", () => {
	let harness: TestHarness;
	let readQuery: ReadQueryService;

	beforeEach(() => {
		harness = createTestHarness();
		readQuery = new ReadQueryService(harness.db);

		// Seed session + messages
		harness.seedSession("sess-b");
		harness.seedMessage("msg-user", "sess-b", {
			role: "user",
			createdAt: 1000,
			parts: [{ id: "pp1", type: "text", text: "Hi from SQLite" }],
		});
		harness.seedMessage("msg-asst", "sess-b", {
			role: "assistant",
			createdAt: 2000,
			parts: [{ id: "pp2", type: "text", text: "Reply from SQLite" }],
		});
	});
	afterEach(() => {
		harness.close();
	});

	it("session_switched on connect contains SQLite messages, not REST mock", async () => {
		const spy = makeSendToSpy();

		const deps: ClientInitDeps = {
			...createMockClientInitDeps({
				readQuery,
				wsHandler: {
					broadcast: vi.fn(),
					sendTo: spy.fn,
					setClientSession: vi.fn(),
					markClientBootstrapped: vi.fn(),
				},
				client: {
					session: {
						get: vi.fn().mockResolvedValue({
							id: "sess-b",
							modelID: "",
							providerID: "",
						}),
					},
					permission: { list: vi.fn().mockResolvedValue([]) },
					question: { list: vi.fn().mockResolvedValue([]) },
					provider: {
						list: vi.fn().mockResolvedValue({
							providers: [],
							defaults: {},
							connected: [],
						}),
					},
					app: { agents: vi.fn().mockResolvedValue([]) },
				} as unknown as ClientInitDeps["client"],
				sessionMgr: {
					getDefaultSessionId: vi.fn().mockResolvedValue("sess-b"),
					listSessions: vi.fn().mockResolvedValue([]),
					sendDualSessionLists: vi.fn().mockResolvedValue(undefined),
					// REST mock returns different data — verifies SQLite wins
					loadPreRenderedHistory: vi.fn().mockResolvedValue({
						messages: [{ id: "rest-msg", role: "user", parts: [] }],
						hasMore: false,
						total: 1,
					}),
					clearPaginationCursor: vi.fn(),
					seedPaginationCursor: vi.fn(),
				} as unknown as ClientInitDeps["sessionMgr"],
				statusPoller: {
					isProcessing: vi.fn().mockReturnValue(false),
					getCurrentStatuses: vi.fn().mockReturnValue({}),
				},
				ptyManager: {
					sessionCount: 0,
					listSessions: vi.fn().mockReturnValue([]),
					getScrollback: vi.fn().mockReturnValue(null),
					getSession: vi.fn().mockReturnValue(null),
				} as unknown as ClientInitDeps["ptyManager"],
			}),
		};

		await handleClientConnected(deps, "client-2");

		const switchedMsg = spy.findSessionSwitched("client-2");
		expect(switchedMsg).toBeDefined();

		const messages = switchedMsg?.history?.messages ?? [];
		// Must be SQLite data (2 rows), not REST mock (1 row "rest-msg")
		expect(messages).toHaveLength(2);
		expect((messages[0] as { id: string }).id).toBe("msg-user");
		expect((messages[1] as { id: string }).id).toBe("msg-asst");
	});

	it("falls back to REST when readQuery is absent from client-init deps", async () => {
		const spy = makeSendToSpy();

		const deps: ClientInitDeps = {
			...createMockClientInitDeps({
				// readQuery intentionally absent
				wsHandler: {
					broadcast: vi.fn(),
					sendTo: spy.fn,
					setClientSession: vi.fn(),
					markClientBootstrapped: vi.fn(),
				},
				client: {
					session: {
						get: vi.fn().mockResolvedValue({
							id: "sess-b",
							modelID: "",
							providerID: "",
						}),
					},
					permission: { list: vi.fn().mockResolvedValue([]) },
					question: { list: vi.fn().mockResolvedValue([]) },
					provider: {
						list: vi.fn().mockResolvedValue({
							providers: [],
							defaults: {},
							connected: [],
						}),
					},
					app: { agents: vi.fn().mockResolvedValue([]) },
				} as unknown as ClientInitDeps["client"],
				sessionMgr: {
					getDefaultSessionId: vi.fn().mockResolvedValue("sess-b"),
					listSessions: vi.fn().mockResolvedValue([]),
					sendDualSessionLists: vi.fn().mockResolvedValue(undefined),
					loadPreRenderedHistory: vi.fn().mockResolvedValue({
						messages: [{ id: "rest-msg", role: "user", parts: [] }],
						hasMore: false,
						total: 1,
					}),
					clearPaginationCursor: vi.fn(),
					seedPaginationCursor: vi.fn(),
				} as unknown as ClientInitDeps["sessionMgr"],
				statusPoller: {
					isProcessing: vi.fn().mockReturnValue(false),
					getCurrentStatuses: vi.fn().mockReturnValue({}),
				},
				ptyManager: {
					sessionCount: 0,
					listSessions: vi.fn().mockReturnValue([]),
					getScrollback: vi.fn().mockReturnValue(null),
					getSession: vi.fn().mockReturnValue(null),
				} as unknown as ClientInitDeps["ptyManager"],
			}),
		};

		await handleClientConnected(deps, "client-2");

		const switchedMsg = spy.findSessionSwitched("client-2");
		expect(switchedMsg).toBeDefined();
		const messages = switchedMsg?.history?.messages ?? [];
		// REST mock returned when no readQuery
		expect(messages).toHaveLength(1);
		expect((messages[0] as { id: string }).id).toBe("rest-msg");
	});
});
