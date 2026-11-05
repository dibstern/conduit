// 82tn.49: admission for head moves, fork and provider switch, and the inbox's admit during a head
// move. Failure modes (lane 49 audit): 1-5, 9 a head move admitted while a Run is active, an
// interaction is pending, a send is queued or a limit waits; 6, 20 background work alone refuses;
// 10, 17, 21 a command admitted while a head move is in progress; 18 a fork refused during a Run;
// 19 a switch admitted during a Run; 22 the limit policy's own continuation refused; 11, 13 a send,
// send-now or drain handed off during a head move.
import { describe, expect, it } from "vitest";
import {
	admitSessionCommand,
	type SessionCommandFacts,
} from "../../../../src/lib/domain/relay/Services/session-command.js";
import {
	decideInbox,
	type InboxView,
} from "../../../../src/lib/domain/relay/Services/session-inbox.js";

const idle: SessionCommandFacts = {
	runActive: false,
	interactionPending: false,
	inputsQueued: false,
	limitRecovery: false,
	headMoving: false,
};

describe("admitSessionCommand", () => {
	it.each([
		["runActive", "run_active"],
		["interactionPending", "interaction_pending"],
		["inputsQueued", "inputs_queued"],
		["limitRecovery", "limit_recovery"],
		["headMoving", "head_move_in_progress"],
	] as const)("refuses a head move while %s, with %s", (fact, reason) => {
		expect(
			admitSessionCommand({ kind: "head_move" }, { ...idle, [fact]: true }),
		).toBe(reason);
	});

	// 82tn.51: a rewind lands at once, so no pending rewind admits a move over its cut-off.
	it("admits a head move on an idle session", () => {
		expect(admitSessionCommand({ kind: "head_move" }, idle)).toBeUndefined();
	});

	it("refuses a head move in progress before any other reason", () => {
		expect(
			admitSessionCommand(
				{ kind: "head_move" },
				{ ...idle, runActive: true, headMoving: true },
			),
		).toBe("head_move_in_progress");
	});

	it("admits a fork during a Run, a prompt or a queue, and refuses it only during a head move", () => {
		expect(
			admitSessionCommand(
				{ kind: "fork" },
				{
					...idle,
					runActive: true,
					interactionPending: true,
					inputsQueued: true,
					limitRecovery: true,
				},
			),
		).toBeUndefined();
		expect(
			admitSessionCommand({ kind: "fork" }, { ...idle, headMoving: true }),
		).toBe("head_move_in_progress");
	});

	// 82tn.51: no pending rewind is left to refuse a switch.
	it("refuses a user's switch during a Run or during a head move", () => {
		const user = { kind: "provider_switch", policy: false } as const;
		expect(admitSessionCommand(user, idle)).toBeUndefined();
		expect(
			admitSessionCommand(user, {
				...idle,
				interactionPending: true,
				inputsQueued: true,
				limitRecovery: true,
			}),
		).toBeUndefined();
		expect(admitSessionCommand(user, { ...idle, runActive: true })).toBe(
			"run_active",
		);
		expect(admitSessionCommand(user, { ...idle, headMoving: true })).toBe(
			"head_move_in_progress",
		);
	});

	it("lets the limit policy's continuation past a Run, not past a head move (82tn.51)", () => {
		const policy = { kind: "provider_switch", policy: true } as const;
		expect(
			admitSessionCommand(policy, { ...idle, runActive: true }),
		).toBeUndefined();
		expect(admitSessionCommand(policy, { ...idle, headMoving: true })).toBe(
			"head_move_in_progress",
		);
	});
});

const view: InboxView = {
	provider: "claude",
	queued: [],
	steering: false,
	busy: false,
	stoppedSinceHandoff: false,
	limited: false,
	usageResetsAt: undefined,
	scheduled: false,
	known: false,
	providerSteers: true,
	promptOpen: false,
	running: undefined,
	headMoving: true,
};
const request = { text: "after the move" } as never;
const queuedInput = { inputId: "queued", request };

describe("decideInbox during a head move", () => {
	it("admits a send without handing it off", () => {
		for (const delivery of ["queue", "steer"] as const)
			expect(
				decideInbox("s1", view, {
					_tag: "Submit",
					inputId: "i1",
					delivery,
					request,
				}),
			).toEqual({
				_tag: "Accepted",
				events: [
					{
						type: "input.admitted",
						data: { sessionId: "s1", inputId: "i1", delivery, request },
					},
				],
			});
	});

	it("keeps a queued input in place on send-now and on drain", () => {
		const queued = { ...view, queued: [queuedInput] };
		for (const interrupt of [false, true])
			expect(
				decideInbox("s1", queued, {
					_tag: "SendNow",
					inputId: "queued",
					interrupt,
				}),
			).toEqual({ _tag: "Accepted", events: [] });
		expect(decideInbox("s1", queued, { _tag: "Drain" })).toEqual({
			_tag: "Accepted",
			events: [],
		});
	});

	it("hands the queued input off once the move has landed", () => {
		const landed = { ...view, queued: [queuedInput], headMoving: false };
		expect(decideInbox("s1", landed, { _tag: "Drain" })).toMatchObject({
			_tag: "Accepted",
			handoff: queuedInput,
		});
	});
});
