// @vitest-environment jsdom
// The client's processing phase follows the session's shell row (ni8.35):
// the row's status is the only server signal for "a turn is running", so
// a busy row starts the turn and the row going idle ends it, in every tab.
import { type Effect, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getOrCreateSessionSlot,
	sessionActivity,
	sessionMessages,
} from "../../../src/lib/frontend/stores/chat.svelte.js";
import { permissionsState } from "../../../src/lib/frontend/stores/permissions.svelte.js";
import {
	replaceRoute,
	routerState,
} from "../../../src/lib/frontend/stores/router.svelte.js";
import { selection } from "../../../src/lib/frontend/stores/selection.svelte.js";
import {
	applyFamilyChange,
	clearSessionState,
	resetSessionFamily,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import { uiState } from "../../../src/lib/frontend/stores/ui.svelte.js";
import { usageState } from "../../../src/lib/frontend/stores/usage.svelte.js";
import { _resetRateLimit } from "../../../src/lib/frontend/stores/ws-send.svelte.js";
import { openSessionForSetup } from "../../../src/lib/frontend/stories/session-setup.js";
import {
	makeWsRpcClientsLayer,
	type WsRpcClients,
} from "../../../src/lib/frontend/transport/shared-client.js";
import type { SessionInfo } from "../../../src/lib/frontend/types.js";
import { makeRpcWire } from "../../helpers/rpc-wire.js";
import type { StubTable } from "../../helpers/stub-ws-rpc.js";
import {
	applyFamilyFeedChange,
	applySessionChange,
} from "./session-fixtures.js";

let runtime: ManagedRuntime.ManagedRuntime<WsRpcClients, never>;
vi.mock("../../../src/lib/frontend/transport/runtime.js", () => ({
	runTransportEffect: <A, E>(effect: Effect.Effect<A, E, WsRpcClients>) =>
		runtime.runPromise(effect),
}));

const row = (status: SessionInfo["status"]): SessionInfo => ({
	projectSlug: "project-a",
	accountId: null,
	id: "s",
	title: "s",
	status,
});
const upsert = (status: SessionInfo["status"]) =>
	applySessionChange({ _tag: "upsert", item: row(status) });
const snapshot = (status: SessionInfo["status"]) =>
	applySessionChange({ _tag: "snapshot", rows: [row(status)] });
const activity = () => {
	const slot = sessionActivity.get("s");
	if (!slot) throw new Error("no slot");
	return slot;
};

beforeEach(() => {
	clearSessionState();
	sessionActivity.clear();
	openSessionForSetup("s", "project-a");
});

it("a busy row starts the turn and the row going idle ends it once", () => {
	snapshot("idle");
	getOrCreateSessionSlot("s");
	upsert("busy");
	expect(activity().phase).toBe("processing");
	activity().currentMessageId = "m1";
	expect(activity().endedGeneration).not.toBe(activity().turnGeneration);

	upsert("idle");

	expect(activity().phase).toBe("idle");
	expect(activity().endedGeneration).toBe(activity().turnGeneration);
	expect(activity().currentMessageId).toBeNull();
	// An interrupted subagent may become idle without a new turn-end version.
	applySessionChange({
		_tag: "upsert",
		item: { ...row("idle"), lastTurnEndVersion: 2 },
	});
	applySessionChange({
		_tag: "upsert",
		item: { ...row("busy"), lastTurnEndVersion: 2 },
	});
	applySessionChange({
		_tag: "upsert",
		item: { ...row("idle"), lastTurnEndVersion: 2 },
	});
	expect(activity().phase).toBe("idle");
});

it("a retrying row keeps the turn running", () => {
	snapshot("busy");
	getOrCreateSessionSlot("s");
	upsert("retry");
	expect(activity().phase).toBe("processing");
});

it("a stale busy write after the turn ended does not restart it", () => {
	snapshot("busy");
	const { activity: slot } = getOrCreateSessionSlot("s");
	expect(slot.phase).toBe("processing");
	slot.phase = "idle"; // `done` ended the turn first
	const generation = slot.turnGeneration;

	upsert("busy");

	expect(slot.phase).toBe("idle");
	expect(slot.turnGeneration).toBe(generation);
});

it("a slot opened on a busy session starts processing", () => {
	snapshot("busy");
	expect(getOrCreateSessionSlot("s").activity.phase).toBe("processing");
});

it("a snapshot aligns the phase in both directions", () => {
	snapshot("idle");
	const { activity: slot } = getOrCreateSessionSlot("s");
	snapshot("busy");
	expect(slot.phase).toBe("processing");
	snapshot("idle");
	expect(slot.phase).toBe("idle");
});

it("a child session, which has no shell row, starts from its family row", () => {
	const { activity: slot } = getOrCreateSessionSlot("child");
	applyFamilyChange({
		_tag: "snapshot",
		sequence: 1,
		rows: [
			{
				projectSlug: "project-a",
				accountId: null,
				id: "root",
				title: "Root",
				status: "busy",
			},
			{
				projectSlug: "project-a",
				accountId: null,
				id: "child",
				title: "Child",
				status: "busy",
				parentID: "root",
			},
		],
	});
	expect(slot.phase).toBe("processing");
});

it("a row end finalizes an assistant whose turn started and ended between updates once", () => {
	snapshot("idle");
	const { messages } = getOrCreateSessionSlot("s");
	messages.messages = [
		{
			type: "assistant",
			uuid: "a",
			rawText: "Answer",
			html: "Answer",
			finalized: false,
		},
	];
	const ended = {
		...row("idle"),
		lastTurnEndVersion: 2,
		lastTurnEndInputId: "input",
	};
	applySessionChange({ _tag: "upsert", item: ended });
	expect(messages.messages).toMatchObject([
		{ type: "assistant", rawText: "Answer", finalized: true },
	]);
	const finalized = messages.messages;
	applySessionChange({ _tag: "upsert", item: ended });
	expect(messages.messages).toBe(finalized);
});

// Failure modes at the browser RPC wire: incorrect handoff guesses, replies
// racing row ends/reconnects, missed turn starts, holds, steers and family rows.
describe("turn control sends over the browser RPC wire", () => {
	let control: typeof import("../../../src/lib/frontend/stores/turn.svelte.js");
	let reply: (
		value:
			| { ok: true; sessionId: string; handedOff: boolean }
			| { ok: false; reason: "model_differs" },
	) => void;
	let reject: (error: Error) => void;
	let inputId: string;
	let wire: ReturnType<typeof makeRpcWire>;
	const request = () =>
		control.send({ sessionId: "s", text: "Hello", delivery: "queue" });
	const serve = (table: StubTable = {}) => {
		wire = makeRpcWire({
			"input.submit": (input) => {
				inputId = input.inputId;
				return new Promise((resolve, fail) => {
					reply = resolve;
					reject = fail;
				});
			},
			...table,
		});
		runtime = ManagedRuntime.make(makeWsRpcClientsLayer(wire.connect));
	};
	const received = () => vi.waitFor(() => expect(inputId).toBeTruthy());
	const end = (id = inputId, version = 2) =>
		applySessionChange({
			_tag: "upsert",
			item: {
				...row("idle"),
				lastTurnEndVersion: version,
				lastTurnEndInputId: id,
			},
		});
	beforeEach(async () => {
		control = await import("../../../src/lib/frontend/stores/turn.svelte.js");
		replaceRoute("/s/s");
		sessionMessages.clear();
		permissionsState.pendingPermissions = [];
		permissionsState.pendingQuestions = [];
		usageState.readings = [];
		uiState.toasts = [];
		_resetRateLimit();
		inputId = "";
		snapshot("idle");
		getOrCreateSessionSlot("s");
		serve();
	});
	afterEach(async () => {
		await runtime?.dispose();
		for (const id of ["s", "side", "created", "redirected", "other"]) {
			control.deleteTurn(id);
			applySessionChange({ _tag: "remove", id });
		}
		clearSessionState();
		sessionMessages.clear();
		vi.unstubAllGlobals();
	});

	it("a late redirect places its destination without moving the newly opened session", async () => {
		const sent = request();
		await received();
		applySessionChange({
			_tag: "upsert",
			item: { ...row("idle"), id: "other", projectSlug: "project-b" },
		});
		selection.open("other");
		reply({ ok: true, sessionId: "redirected", handedOff: true });
		await expect(sent).resolves.toEqual({ kind: "started" });

		expect(routerState.path).toBe("/s/other");
		expect(selection.shown).toEqual({
			kind: "placed",
			project: "project-b",
			sessionId: "other",
		});
		expect(control.turn().working).toBe(false);
		selection.open("redirected");
		expect(selection.shown).toEqual({
			kind: "placed",
			project: "project-a",
			sessionId: "redirected",
		});
		expect(control.turn().working).toBe(true);
	});

	it("a redirect follows while the original scope is still shown", async () => {
		const sent = request();
		await received();
		reply({ ok: true, sessionId: "redirected", handedOff: true });
		await expect(sent).resolves.toEqual({ kind: "started" });
		expect(routerState.path).toBe("/s/redirected");
		expect(selection.shown).toEqual({
			kind: "placed",
			project: "project-a",
			sessionId: "redirected",
		});
		expect(control.turn().working).toBe(true);
	});

	it.each([
		false,
		true,
	])("a draft create followed by a redirect respects navigation away: %s", async (left) => {
		await runtime.dispose();
		serve({
			CreateSession: () => ({ projectSlug: "project-a", sessionId: "created" }),
		});
		openSessionForSetup(null);
		replaceRoute("/new?project=project-a");
		const sent = control.send({
			draft: {
				projectSlug: "project-a",
				originId: "browser",
				draftId: "redirect-draft",
				permissionMode: "ask",
			},
			text: "Hello",
			delivery: "queue",
		});
		await received();
		expect(selection.shown).toEqual({
			kind: "placed",
			project: "project-a",
			sessionId: "created",
		});
		if (left) selection.openDraft("project-b");
		reply({ ok: true, sessionId: "redirected", handedOff: true });
		await expect(sent).resolves.toEqual({ kind: "started" });
		expect(selection.shown).toEqual(
			left
				? { kind: "draft", project: "project-b", draftId: expect.any(String) }
				: { kind: "placed", project: "project-a", sessionId: "redirected" },
		);
		selection.open("redirected");
		expect(selection.shown).toEqual({
			kind: "placed",
			project: "project-a",
			sessionId: "redirected",
		});
	});

	it("a draft create completing after a project change places its session without navigating", async () => {
		await runtime.dispose();
		let created!: (reply: { projectSlug: string; sessionId: string }) => void;
		serve({
			CreateSession: () =>
				new Promise((resolve) => {
					created = resolve;
				}),
		});
		openSessionForSetup(null);
		replaceRoute("/new?project=project-a");
		const sent = control.send({
			draft: {
				projectSlug: "project-a",
				originId: "browser",
				draftId: "late-draft",
				permissionMode: "ask",
			},
			text: "Hello",
			delivery: "queue",
		});
		await vi.waitFor(() => expect(created).toBeTypeOf("function"));
		selection.openDraft("project-b");
		created({ projectSlug: "project-a", sessionId: "created" });
		await received();
		expect(selection.shown).toEqual({
			kind: "draft",
			project: "project-b",
			draftId: expect.any(String),
		});
		reply({ ok: true, sessionId: "created", handedOff: true });
		await sent;
		selection.open("created");
		expect(selection.shown).toEqual({
			kind: "placed",
			project: "project-a",
			sessionId: "created",
		});
	});

	it.each([
		false,
		true,
	])("a side-thread start follows only the captured parent scope and records no intent: left=%s", async (left) => {
		await runtime.dispose();
		let started!: (reply: { sessionId: string }) => void;
		serve({
			StartSideThread: () =>
				new Promise((resolve) => {
					started = resolve;
				}),
		});
		const sent = control.send({
			sideThread: { sessionId: "s", title: "Side" },
			text: "Ask on the side",
			delivery: "queue",
		});
		await vi.waitFor(() => expect(started).toBeTypeOf("function"));
		expect(control.turn().working).toBe(false);
		expect(
			wire.requests.filter((request) => request.tag === "input.submit"),
		).toHaveLength(0);
		if (left) selection.openDraft("project-b");
		started({ sessionId: "side" });
		await expect(sent).resolves.toEqual({ kind: "started" });
		expect(selection.shown).toEqual(
			left
				? { kind: "draft", project: "project-b", draftId: expect.any(String) }
				: { kind: "placed", project: "project-a", sessionId: "side" },
		);
		selection.open("side");
		expect(selection.shown).toEqual({
			kind: "placed",
			project: "project-a",
			sessionId: "side",
		});
		getOrCreateSessionSlot("side");
		expect(control.turn().working).toBe(false);
		applyFamilyFeedChange({
			_tag: "upsert",
			item: { ...row("busy"), id: "side", parentID: "s", sideThread: true },
		});
		expect(control.turn().working).toBe(true);
		applyFamilyFeedChange({
			_tag: "upsert",
			item: { ...row("idle"), id: "side", parentID: "s", sideThread: true },
		});
		expect(control.turn().working).toBe(false);
	});

	it("stop after the turn ended raises no error and working stays off", async () => {
		const cancel = vi.fn(() => ({ ok: true as const }));
		serve({ CancelSession: cancel });
		const sent = request();
		await received();
		reply({ ok: true, sessionId: "s", handedOff: true });
		await sent;
		end();
		expect(control.turn().working).toBe(false);
		await control.stop("s");
		expect(control.turn().working).toBe(false);
		expect(cancel).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "s",
				commandId: expect.any(String),
			}),
		);
		expect(uiState.toasts).toEqual([]);
	});

	it("hides Stop between the stopped reply's end and its retained steer's placement without releasing admission", async () => {
		serve({ CancelSession: () => ({ ok: true as const }) });
		upsert("busy");
		const { messages } = getOrCreateSessionSlot("s");
		// Ordinary first-send reservation still exposes Stop before placement.
		expect(control.turn().working).toBe(true);
		messages.transcript = {
			rows: [
				{
					id: "a",
					role: "user",
					turnTiming: { startedAt: 1, waits: [] },
				},
			],
			pending: [
				{
					inputId: "b",
					state: "steering",
					admittedAt: 2,
					request: { text: "correction" },
				},
			],
			hwm: 1,
			hasMore: false,
			status: { _tag: "live" },
			project: "project-a",
			waiting: new Map(),
			partOrder: new Map(),
		};
		expect(control.turn().working).toBe(true);
		await control.stop("s");
		messages.transcript = {
			...messages.transcript,
			rows: [
				{
					id: "a",
					role: "user",
					turnTiming: { startedAt: 1, endedAt: 3, waits: [] },
				},
			],
		};
		applySessionChange({
			_tag: "upsert",
			item: {
				...row("busy"),
				canStop: false,
				lastTurnEndInputId: "a",
				lastTurnEndVersion: 2,
			},
		});
		expect(control.turn().working).toBe(false);
		expect(activity().phase).toBe("processing");
		expect(messages.transcript.pending).toMatchObject([
			{ inputId: "b", state: "steering" },
		]);
		// An indeterminate delivery remains a Stop target after the reply ended.
		applySessionChange({
			_tag: "upsert",
			item: { ...row("busy"), canStop: true },
		});
		expect(control.turn().working).toBe(true);
		// Placement, not an invented intake fact, makes the next input stoppable.
		messages.transcript = {
			...messages.transcript,
			rows: [
				...messages.transcript.rows,
				{
					id: "b",
					role: "user",
					turnTiming: { startedAt: 4, waits: [] },
				},
			],
			pending: [],
		};
		expect(control.turn().working).toBe(true);
	});

	it("a slow stop reply ends an unstarted turn immediately", async () => {
		let finishStop!: (value: { ok: true }) => void;
		const cancel = vi.fn(
			() =>
				new Promise<{ ok: true }>((resolve) => {
					finishStop = resolve;
				}),
		);
		serve({ CancelSession: cancel });
		const sent = request();
		await received();
		reply({ ok: true, sessionId: "s", handedOff: true });
		await sent;
		expect(control.turn().working).toBe(true);
		const stopped = control.stop("s");
		expect(control.turn().working).toBe(false);
		await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
		expect(control.turn().working).toBe(false);
		finishStop({ ok: true });
		await stopped;
		expect(control.turn().working).toBe(false);
	});

	it.each([
		true,
		false,
	])("stop before the send reply prevents it restarting working, guessed handoff: %s", async (handoff) => {
		serve({ CancelSession: () => ({ ok: true }) });
		if (!handoff)
			permissionsState.pendingQuestions = [
				{ toolId: "q", sessionId: "s", questions: [] },
			];
		const sent = request();
		await received();
		expect(control.turn().working).toBe(handoff);
		await control.stop("s");
		expect(control.turn().working).toBe(false);
		reply({ ok: true, sessionId: "s", handedOff: true });
		await sent;
		expect(control.turn().working).toBe(false);
		// Stop does not prevent a later send from starting a fresh turn.
		permissionsState.pendingQuestions = [];
		inputId = "";
		const next = request();
		await received();
		expect(control.turn().working).toBe(true);
		reply({ ok: true, sessionId: "s", handedOff: true });
		await next;
		end();
	});

	it("stop leaves a server-reported busy turn working until its idle row", async () => {
		const cancel = vi.fn(() => ({ ok: true as const }));
		serve({ CancelSession: cancel });
		upsert("busy");
		expect(control.turn().working).toBe(true);
		const stopped = control.stop("s");
		expect(control.turn().working).toBe(true);
		await stopped;
		expect(cancel).toHaveBeenCalledOnce();
		expect(control.turn().working).toBe(true);
		upsert("idle");
		expect(control.turn().working).toBe(false);
	});

	it("a guessed start clears working when the inbox queues and displays the queued input", async () => {
		const sent = request();
		expect(control.turn().working).toBe(true);
		await received();
		const { messages } = getOrCreateSessionSlot("s");
		messages.transcript = {
			rows: [],
			hwm: null,
			hasMore: false,
			project: "project-a",
			status: { _tag: "live" },
			pending: [
				{
					inputId,
					request: { text: "Hello", images: [] },
					state: "queued",
					admittedAt: 1,
				},
			],
			waiting: new Map(),
			partOrder: new Map(),
		};
		reply({ ok: true, sessionId: "s", handedOff: false });
		await expect(sent).resolves.toEqual({ kind: "waiting" });
		expect(control.turn().working).toBe(false);
		expect(messages.transcript.pending).toMatchObject([
			{ request: { text: "Hello" }, state: "queued" },
		]);
	});

	it("every throttled send reaches the wire and settles working when its turn ends", async () => {
		const sent: string[] = [];
		serve({
			"input.submit": (input) => {
				sent.push(input.text);
				end(input.inputId, sent.length + 2);
				return Promise.resolve({ ok: true, sessionId: "s", handedOff: true });
			},
		});
		for (let index = 0; index < 5; index++)
			await control.send({
				sessionId: "s",
				text: String(index),
				delivery: "queue",
			});
		vi.useFakeTimers();
		try {
			const sixth = control.send({
				sessionId: "s",
				text: "5",
				delivery: "queue",
			});
			const seventh = control.send({
				sessionId: "s",
				text: "6",
				delivery: "queue",
			});
			expect(control.turn().working).toBe(true);
			await vi.advanceTimersByTimeAsync(10_001);
			expect(sent).toEqual(["0", "1", "2", "3", "4", "5", "6"]);
			await expect(Promise.all([sixth, seventh])).resolves.toEqual([
				{ kind: "started" },
				{ kind: "started" },
			]);
			expect(control.turn().working).toBe(false);
		} finally {
			_resetRateLimit();
			vi.useRealTimers();
		}
	});

	it("a guessed wait starts working when the inbox hands off", async () => {
		permissionsState.pendingQuestions = [
			{ toolId: "q", sessionId: "s", questions: [] },
		];
		const sent = request();
		expect(control.turn().working).toBe(false);
		await received();
		reply({ ok: true, sessionId: "s", handedOff: true });
		await expect(sent).resolves.toEqual({ kind: "started" });
		expect(control.turn().working).toBe(true);
		end();
	});

	it.each([
		true,
		false,
	])("a turn ending before the reply never restarts working, known starter: %s", async (known) => {
		const sent = request();
		await received();
		applySessionChange({
			_tag: "upsert",
			item: {
				...row("idle"),
				lastTurnEndVersion: 2,
				...(known ? { lastTurnEndInputId: inputId } : {}),
			},
		});
		expect(control.turn().working).toBe(false);
		reply({ ok: true, sessionId: "s", handedOff: true });
		await sent;
		expect(control.turn().working).toBe(false);
	});

	it("an unknown interruption settles the starter while the queued handoff follows the server phase", async () => {
		const started = request();
		await received();
		reply({ ok: true, sessionId: "s", handedOff: true });
		await started;
		upsert("busy");
		inputId = "";
		const queued = control.send({
			sessionId: "s",
			inputId: "queued-input",
			text: "Queued",
			delivery: "queue",
		});
		await received();
		reply({ ok: true, sessionId: "s", handedOff: false });
		await expect(queued).resolves.toEqual({ kind: "waiting" });
		applySessionChange({
			_tag: "upsert",
			item: { ...row("idle"), lastTurnEndVersion: 2 },
		});
		expect(control.turn().working).toBe(false);
		applySessionChange({
			_tag: "upsert",
			item: { ...row("busy"), lastTurnEndVersion: 2 },
		});
		expect(control.turn().working).toBe(true);
		end("queued-input", 3);
		expect(control.turn().working).toBe(false);
	});

	it("an unknown interruption cannot settle a send pressed at its advanced baseline", async () => {
		const first = request();
		await received();
		const firstReply = reply;
		applySessionChange({
			_tag: "upsert",
			item: { ...row("idle"), lastTurnEndVersion: 2 },
		});
		expect(control.turn().working).toBe(false);
		inputId = "";
		const next = request();
		await received();
		applySessionChange({
			_tag: "upsert",
			item: { ...row("idle"), lastTurnEndVersion: 2 },
		});
		firstReply({ ok: true, sessionId: "s", handedOff: true });
		await first;
		expect(control.turn().working).toBe(true);
		reply({ ok: true, sessionId: "s", handedOff: true });
		await next;
		expect(control.turn().working).toBe(true);
		end(inputId, 3);
		expect(control.turn().working).toBe(false);
	});

	it.each([
		false,
		true,
	])("a transport failure resolves failed and leaves working only for a busy row: %s", async (busy) => {
		const sent = request();
		await received();
		if (busy) upsert("busy");
		reject(new Error("socket closed"));
		await expect(sent).resolves.toEqual({ kind: "failed" });
		expect(control.turn().working).toBe(busy);
	});

	it("a refused steer resolves with the server reason", async () => {
		upsert("busy");
		const sent = control.send({
			sessionId: "s",
			text: "Steer",
			delivery: "steer",
		});
		await received();
		reply({ ok: false, reason: "model_differs" });
		await expect(sent).resolves.toEqual({
			kind: "refused",
			reason: "model_differs",
		});
		expect(control.turn().refusal).toMatchObject({
			reason: "model_differs",
		});
	});

	it.each([
		"idle",
		"busy",
	] as const)("a reconnect clears the live intent and follows the %s snapshot", async (status) => {
		const sent = request();
		await received();
		snapshot(status);
		reply({ ok: true, sessionId: "s", handedOff: true });
		await sent;
		expect(control.turn().working).toBe(status === "busy");
	});

	it("a reconnect after this and a later queued turn ended leaves working off", async () => {
		const sent = request();
		await received();
		reply({ ok: true, sessionId: "s", handedOff: true });
		await sent;
		applySessionChange({
			_tag: "snapshot",
			rows: [
				{
					...row("idle"),
					lastTurnEndVersion: 5,
					lastTurnEndInputId: "later-input",
				},
			],
		});
		expect(control.turn().working).toBe(false);
	});

	it("a draft's first send follows the placed session and works before its row arrives", async () => {
		openSessionForSetup(null);
		replaceRoute("/new?project=project-a");
		await runtime.dispose();
		serve({
			CreateSession: () => ({ projectSlug: "project-a", sessionId: "created" }),
		});
		const sent = control.send({
			draft: {
				projectSlug: "project-a",
				originId: "browser",
				draftId: "draft",
				permissionMode: "ask",
			},
			text: "Hello",
			delivery: "queue",
		});
		await received();
		expect(routerState.path).toBe("/s/created");
		expect(selection.shown).toEqual({
			kind: "placed",
			project: "project-a",
			sessionId: "created",
		});
		expect(control.turn().working).toBe(true);
		reply({ ok: true, sessionId: "created", handedOff: true });
		await sent;
		resetSessionFamily();
		const created = { ...row("idle"), id: "created" };
		applyFamilyFeedChange({ _tag: "snapshot", rows: [created] });
		expect(control.turn().working).toBe(true);
		applyFamilyFeedChange({
			_tag: "upsert",
			item: {
				...created,
				lastTurnEndVersion: 2,
				lastTurnEndInputId: inputId,
			},
		});
		expect(control.turn().working).toBe(false);
		control.deleteTurn("created");
		applySessionChange({ _tag: "remove", id: "created" });
	});

	it("an accepted steer resolves waiting and ends with the running turn", async () => {
		upsert("busy");
		const sent = control.send({
			sessionId: "s",
			text: "Steer",
			delivery: "steer",
		});
		await received();
		reply({ ok: true, sessionId: "s", handedOff: true });
		await expect(sent).resolves.toEqual({ kind: "waiting" });
		end("original-turn");
		expect(control.turn().working).toBe(false);
	});

	it("a usage-held send stays queued without working", async () => {
		applySessionChange({
			_tag: "upsert",
			item: { ...row("idle"), accountId: "limited" },
		});
		usageState.readings = [
			{
				accountId: "limited",
				harness: "claude",
				status: "limited",
				windows: [],
				readAt: 0,
				stale: false,
			},
		];
		const sent = request();
		expect(control.turn().working).toBe(false);
		await received();
		reply({ ok: true, sessionId: "s", handedOff: false });
		await expect(sent).resolves.toEqual({ kind: "waiting" });
		expect(control.turn().working).toBe(false);
	});

	it.each([
		"upsert",
		"cold snapshot",
	] as const)("a side thread's send settles from its family feed: %s", async (change) => {
		const child = {
			...row("idle"),
			id: "side",
			parentID: "s",
			sideThread: true,
		};
		applyFamilyFeedChange({ _tag: "snapshot", rows: [row("idle"), child] });
		replaceRoute("/s/side");
		const sent = control.send({
			sessionId: "side",
			text: "Hello",
			delivery: "queue",
		});
		await received();
		const ended = {
			...child,
			lastTurnEndVersion: 2,
			lastTurnEndInputId: inputId,
		};
		if (change === "upsert")
			applyFamilyFeedChange({ _tag: "upsert", item: ended });
		else {
			resetSessionFamily();
			applyFamilyFeedChange({ _tag: "snapshot", rows: [ended] });
		}
		reply({ ok: true, sessionId: "side", handedOff: true });
		await sent;
		expect(control.turn().working).toBe(false);
	});

	it("a guessed wait whose turn ends before the reply stays idle", async () => {
		permissionsState.pendingQuestions = [
			{ toolId: "q", sessionId: "s", questions: [] },
		];
		const sent = request();
		await received();
		end();
		reply({ ok: true, sessionId: "s", handedOff: true });
		await sent;
		expect(control.turn().working).toBe(false);
	});

	it("the guess ignores rolled-up processing and prompts belonging to descendants or no session", async () => {
		applySessionChange({
			_tag: "upsert",
			item: {
				...row("idle"),
				processing: true,
				pendingQuestionCount: 2,
				pendingPermissionCount: 2,
			},
		});
		permissionsState.pendingQuestions = ["child", ""].map((sessionId) => ({
			toolId: sessionId || "unknown",
			sessionId,
			questions: [],
		}));
		const sent = request();
		expect(control.turn().working).toBe(true);
		await received();
		reply({ ok: true, sessionId: "s", handedOff: false });
		await sent;
		expect(control.turn().working).toBe(false);
	});

	it("leaving a feed keeps the intent but deleting the session defeats a late reply", async () => {
		const id = "deleted-with-late-reply";
		applySessionChange({ _tag: "upsert", item: { ...row("idle"), id } });
		selection.open(id);
		const from = selection.scope;
		if (!from) throw new Error("session has no scope");
		selection.follow(from, id, "replace");
		const sent = control.send({
			sessionId: id,
			text: "Hello",
			delivery: "queue",
		});
		await received();
		applySessionChange({ _tag: "remove", id });
		expect(control.turn().working).toBe(true);
		applySessionChange({ _tag: "remove", id, deleted: true });
		reply({ ok: true, sessionId: id, handedOff: true });
		await sent;
		expect(control.turn().working).toBe(false);
	});

	it("a family reconnect clears a live side-thread intent even after later turns ended", async () => {
		const child = {
			...row("idle"),
			id: "side",
			parentID: "s",
			sideThread: true,
		};
		applyFamilyFeedChange({ _tag: "snapshot", rows: [child] });
		replaceRoute("/s/side");
		const sent = control.send({
			sessionId: "side",
			text: "Hello",
			delivery: "queue",
		});
		await received();
		applyFamilyFeedChange({
			_tag: "snapshot",
			rows: [{ ...child, lastTurnEndVersion: 5, lastTurnEndInputId: "later" }],
		});
		reply({ ok: true, sessionId: "side", handedOff: true });
		await sent;
		expect(control.turn().working).toBe(false);
	});
});
