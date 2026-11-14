import { assert, describe, expect, it, vi } from "vitest";
import {
	decide,
	evolve,
	initialSessionLedgerState,
	type LedgerEvent,
	replay,
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
	])("%s exposes an empty view and decides without writing or minting", (provider) => {
		const state = Object.freeze(initialSessionLedgerState("session", provider));
		const newId = vi.fn(() => "unused");
		const ctx: DecideContext = {
			now: 100,
			newId,
			policy: { settleMs: 7_000, probeMs: 10, nativeCommandMs: 30 },
		};
		const empty = {
			live: [],
			tasks: { tag: "none" },
			anythingMayAct: false,
			lostWork: [],
			nativeCommands: [],
			interactions: [],
		};
		expect(viewLedger(state)).toEqual(empty);
		// No input writes the frozen state or mints an id.
		const commands: readonly (readonly [
			LedgerCommand,
			"Accepted" | "Rejected",
		])[] = [
			[
				{
					verb: "admit",
					inputId: "A",
					delivery: "queue",
					request: { text: "hello" },
				},
				"Accepted",
			],
			[
				{
					verb: "control",
					control: { kind: "stop", commandId: "stop-1", deadlineAt: 30_100 },
				},
				"Accepted",
			],
			[
				{
					verb: "control",
					control: { kind: "end", commandId: "end-1", deadlineAt: null },
				},
				"Accepted",
			],
			[
				{
					verb: "settle",
					settlement: { kind: "process_lost", runnerId: "host", retiredAt: 99 },
				},
				"Accepted",
			],
			[
				{
					verb: "settle",
					settlement: {
						kind: "process_started",
						label: "host:7",
						reattached: false,
					},
				},
				"Accepted",
			],
			[
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
				// 8.1: a provider with no background tasks rejects a snapshot; on one that has them, a
				// runner not started changes nothing (L1).
				provider === "claude" || provider === "codex" ? "Accepted" : "Rejected",
			],
			[
				{
					verb: "observe",
					observation: { tag: "Answer", token, kind: "input_accepted" },
				},
				"Accepted",
			],
		];
		for (const [command, tag] of commands) {
			expect(decide(state, command, ctx).tag).toBe(tag);
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
		const policy: ProviderPolicyTable["cursor"] = {
			capabilities: {
				backgroundTasks: false,
				runnerHost: true,
				commandReceipts: false,
				wakeTurns: false,
			},
			runEnd: "result",
			intake: { terminal: () => undefined },
			rules: {
				fences: () => true,
				idleCovers: () => false,
				workEnded: () => false,
			},
		};
		// @ts-expect-error The policy table is exhaustive for every ProviderKind, Codex included.
		const missingCodex: ProviderPolicyTable = {
			claude: policy,
			cursor: policy,
			opencode: policy,
		};
		const pendingEntry: ProviderPolicyTable = {
			claude: policy,
			codex: policy,
			cursor: policy,
			// @ts-expect-error No provider's fence or idle rules are Pending; CONTRACT 9 states each (82tn.32.2.14).
			opencode: { tag: "Pending" },
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
			pendingEntry,
		]).toHaveLength(10);
	});

	it("replays a stored log as evolve folds it, skipping an entry it no longer records", () => {
		let minted = 0;
		const policy = { settleMs: 7_000, probeMs: 10, nativeCommandMs: 30 };
		const initial = initialSessionLedgerState("session", "opencode");
		const admitted = decide(
			initial,
			{
				verb: "admit",
				inputId: "A",
				delivery: "queue",
				request: { text: "hello" },
			},
			{ now: 100, newId: () => `id-${++minted}`, policy },
		);
		assert(admitted.tag === "Accepted");
		const folded = admitted.events.reduce(evolve, initial);
		// A stored fact this decider now rejects, as after an upgrade, changes nothing,
		// though rejecting it starts by counting it (8.1: OpenCode has no task snapshot).
		const stale = {
			kind: "fact",
			command: {
				verb: "observe",
				observation: {
					tag: "Unsolicited",
					label: "host:7",
					eventId: "snapshot",
					kind: "tasks_snapshot",
					tasks: [],
				},
			},
			now: 100,
			policy,
			ids: [],
		} as unknown as LedgerEvent;
		expect(evolve(folded, stale)).toBe(folded);
		const log = [...admitted.events, stale, ...admitted.events];
		expect(replay(initial, log)).toEqual(log.reduce(evolve, initial));
		expect(replay(folded, [])).toBe(folded);
	});
});
