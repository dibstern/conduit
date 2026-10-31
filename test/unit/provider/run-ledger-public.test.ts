import { describe, expect, it, vi } from "vitest";
import {
	decide,
	evolve,
	initialSessionLedgerState,
	viewLedger,
} from "../../../src/lib/provider/run-ledger/run-ledger-decider.js";
import type {
	DecideContext,
	IssuedEffect,
	LedgerCommand,
	Observation,
	ProviderKind,
	ProviderPolicyTable,
	SendToken,
} from "../../../src/lib/provider/run-ledger/run-ledger-model.js";

const token = "host-1" as SendToken;

describe("Run Ledger public model", () => {
	it.each<ProviderKind>([
		"claude",
		"codex",
		"cursor",
		"opencode",
	])("%s exposes an empty view and rejects commands without writing or minting", (provider) => {
		const state = Object.freeze(initialSessionLedgerState("session", provider));
		const newId = vi.fn(() => "unused");
		const ctx: DecideContext = {
			now: 100,
			newId,
			policy: { settleMs: 7_000, probeMs: 10, nativeCommandMs: 30 },
		};
		const empty = {
			paused: false,
			inbox: [],
			live: [],
			tasks: { tag: "none" },
			anythingMayAct: false,
			lostWork: [],
			nativeCommands: [],
			interactions: [],
		};
		expect(viewLedger(state)).toEqual(empty);
		const commands: readonly LedgerCommand[] = [
			{
				verb: "admit",
				inputId: "A",
				delivery: "queue",
				request: { text: "hello" },
			},
			{
				verb: "control",
				control: { kind: "stop", commandId: "stop-1", deadlineAt: 30_100 },
			},
			{
				verb: "control",
				control: { kind: "end", commandId: "end-1", deadlineAt: null },
			},
			{
				verb: "settle",
				settlement: { kind: "process_lost", runnerId: "host", retiredAt: 99 },
			},
			{
				verb: "settle",
				settlement: {
					kind: "process_started",
					label: "host:7",
					reattached: false,
				},
			},
			{
				verb: "observe",
				observation: {
					tag: "Unsolicited",
					label: "host:7",
					eventId: "snapshot",
					kind: "tasks_snapshot",
					tasks: [],
				},
			},
			{
				verb: "observe",
				observation: { tag: "Answer", token, kind: "input_accepted" },
			},
		];
		for (const command of commands) {
			expect(decide(state, command, ctx)).toEqual({
				tag: "Rejected",
				diagnostic: "Run Ledger decider pending redesign implementation",
			});
			expect(viewLedger(state)).toEqual(empty);
		}
		expect(newId).not.toHaveBeenCalled();
		expect([].reduce(evolve, state)).toBe(state);
	});

	it("types the observation, effect and policy seams", () => {
		const answer: Observation = {
			tag: "Answer",
			token,
			kind: "result",
			outcome: "completed",
		};
		const unsolicited: Observation = {
			tag: "Unsolicited",
			label: "host:7",
			eventId: "e1",
			kind: "turn_ended",
		};
		// @ts-expect-error An Answer must name its send's token.
		const tokenless: Observation = { tag: "Answer", kind: "query_ended" };
		const tokened: Observation = {
			tag: "Unsolicited",
			label: "host:7",
			eventId: "e2",
			kind: "activity",
			// @ts-expect-error An Unsolicited observation cannot carry a token.
			token,
		};
		// @ts-expect-error Only host-label evidence is Unsolicited.
		const unlabelled: Observation = {
			tag: "Unsolicited",
			label: "host:7",
			eventId: "e3",
			kind: "input_accepted",
		};
		const held: IssuedEffect = {
			tag: "Main",
			commandId: "c1",
			effect: { kind: "start", runId: "r1", inputId: "A", mode: "fresh" },
		};
		// @ts-expect-error A Main effect has no token; main names its transmissions (3.4).
		const heldToken: IssuedEffect = { ...held, token };
		const interruptMs: DecideContext["policy"] = {
			settleMs: 1,
			probeMs: 1,
			nativeCommandMs: 1,
			// @ts-expect-error The policy has no interrupt budget; the stop's is the commit's.
			interruptMs: 1,
		};
		const pending = {
			tag: "Pending",
			capabilities: { backgroundTasks: false },
			runEnd: "result",
			ticket: "t",
		} as const;
		// @ts-expect-error The policy table is exhaustive for every ProviderKind, Codex included.
		const missingCodex: ProviderPolicyTable = {
			claude: pending,
			cursor: pending,
			opencode: pending,
		};
		expect([
			answer,
			unsolicited,
			tokenless,
			tokened,
			unlabelled,
			held,
			heldToken,
			interruptMs,
			missingCodex,
		]).toHaveLength(9);
	});
});
