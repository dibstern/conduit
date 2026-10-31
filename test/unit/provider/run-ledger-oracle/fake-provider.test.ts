import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import type {
	Evidence,
	IssuedEffect,
	LedgerCommand,
	LedgerView,
	Observation,
	ProviderKind,
	SendToken,
} from "../../../../src/lib/provider/run-ledger/run-ledger-model.js";
import {
	FakeProvider,
	type GateOutcome,
	type Send,
	type TraceAction,
} from "./fake-provider.js";

const emptyView = (): LedgerView => ({
	paused: false,
	inbox: [],
	live: [],
	interactions: [],
	tasks: { tag: "none" },
	anythingMayAct: false,
	lostWork: [],
	nativeCommands: [],
});
const action: TraceAction = {
	operation: 3,
	selection: 4,
	index: 0,
	variant: 0,
	input: 0,
	advance: 0,
};
const token = (value: string): SendToken => value as SendToken;
function answer(fake: FakeProvider, send: Send, evidence: Evidence): void {
	fake.observe(
		{
			verb: "observe",
			observation: {
				tag: "Answer",
				token: send.token,
				...evidence,
			} as Observation,
		},
		emptyView(),
	);
}
function started(
	fake: FakeProvider,
	label = "host-0:1",
	live: readonly IssuedEffect[] = [],
): void {
	fake.observe(
		{
			verb: "settle",
			settlement: { kind: "process_started", label, reattached: false },
		},
		{ ...emptyView(), live },
	);
}
function reattached(fake: FakeProvider, label: string): void {
	fake.observe(
		{
			verb: "settle",
			settlement: { kind: "process_started", label, reattached: true },
		},
		emptyView(),
	);
}
function lost(fake: FakeProvider, runnerId: string): void {
	fake.observe(
		{
			verb: "settle",
			settlement: { kind: "process_lost", runnerId, retiredAt: 0 },
		},
		emptyView(),
	);
}
/** The ledger reads each pending host notification, run.dispatched included (D50: a dispatched hold may have reached). */
function readNotifications(fake: FakeProvider): void {
	for (const observation of fake.pendingObservations())
		fake.observe({ verb: "observe", observation }, emptyView());
}
function held(kind: "start" | "steer", commandId: string = kind): IssuedEffect {
	return {
		tag: "Held",
		commandId,
		effect:
			kind === "start"
				? { kind, runId: "R", inputId: commandId, mode: "resume" }
				: { kind, runId: "R", inputId: commandId },
	};
}

// Round 8 failure modes: a killed label opens another wake Run (8.3/D41),
// Run sends move to another process or query (3.3/D42), and a null kill loses
// its next-process binding with the end_session it covers (8.4/D40, 5.1).
describe("fake provider round 8 contract decisions", () => {
	it("rejects a confirm view that retains a runner's old label (L3, D33, LI5)", () => {
		const fake = new FakeProvider("claude");
		started(fake);
		const before: LedgerView = {
			...emptyView(),
			anythingMayAct: true,
			pendingConfirm: {
				step: "retire",
				labels: ["host-0:1"],
				snapshotEntry: 1,
				tasks: { tag: "unknown", label: "host-0:1" },
			},
		};
		const pendingConfirm = before.pendingConfirm;
		assert(pendingConfirm);
		expect(() =>
			fake.assertStep(
				{
					verb: "settle",
					settlement: {
						kind: "process_started",
						label: "host-0:2",
						reattached: true,
					},
				},
				before,
				{
					...before,
					tasks: { tag: "unknown", label: "host-0:2" },
					pendingConfirm: { ...pendingConfirm, snapshotEntry: 2 },
				},
				[],
				[],
			),
		).toThrow(/LI5:.*\(L3, D33\)/);
	});

	it.each([
		"claude",
		"codex",
		"cursor",
		"opencode",
	] as const)("addresses a %s steer to its execution's runner under the runner's latest label (L2 case 2; OpenCode case 3)", (provider) => {
		const fake = new FakeProvider(provider);
		started(fake, "execution:1");
		fake.issued([held("start")]);
		started(fake, "execution:2");
		const [steer] = fake.issued([held("steer")]);
		assert(steer);
		expect(fake.labelFor(steer)).toBe("execution:2");
	});

	it.each([
		"claude",
		"codex",
		"cursor",
	] as const)("covers a %s interrupt addressed to its execution's retired runner at issue (L2 case 2, L1 item 1, H3)", (provider) => {
		const fake = new FakeProvider(provider);
		started(fake, "execution:1");
		fake.issued([held("start")]);
		// The start reached, so its execution survives the retirement (3.6 D50).
		readNotifications(fake);
		lost(fake, "execution");
		started(fake, "newer:1");
		const [interrupt] = fake.issued([
			{
				tag: "Tokened",
				token: token("interrupt"),
				effect: { kind: "interrupt", runId: "R", runIds: ["R"] },
			},
		]);
		assert(interrupt);
		expect(fake.labelFor(interrupt)).toBe("execution:1");
		expect(fake.groundTruth().unfinished).not.toContain(interrupt.token);
	});

	it("addresses an OpenCode interrupt to the current process (L2 case 3)", () => {
		const fake = new FakeProvider("opencode");
		started(fake, "opencode:a1:0");
		fake.issued([held("start")]);
		lost(fake, "opencode:a1");
		started(fake, "opencode:b2:0");
		const [interrupt] = fake.issued([
			{
				tag: "Tokened",
				token: token("interrupt"),
				effect: { kind: "interrupt", runId: "R", runIds: ["R"] },
			},
		]);
		assert(interrupt);
		expect(fake.labelFor(interrupt)).toBe("opencode:b2:0");
	});
});

describe("fake provider round 3 alphabet", () => {
	it.each([
		"dead",
		"lost",
	] as const)("keeps a newly issued hold physically undispatched while its host is %s (3.3)", (condition) => {
		const fake = new FakeProvider("cursor");
		if (condition === "lost") {
			started(fake);
			fake.observe(
				{
					verb: "settle",
					settlement: {
						kind: "process_lost",
						runnerId: "host-0",
						retiredAt: 0,
					},
				},
				emptyView(),
			);
		}
		const issue = held("start");
		const send = fake.bound(issue);
		expect(fake.groundTruth().unfinished).toEqual([]);
		fake.issued([issue]);
		expect(fake.groundTruth().unfinished).toEqual([]);
		expect(fake.pendingObservations()).toEqual([]);
		const snapshot = { issued: [issue], view: emptyView(), now: 101 };
		const generated = fake.next({ ...action, variant: 34 }, snapshot);
		// A never-started host reports its process before any frame (6.1, H1); a lost one has no frame to send.
		expect(generated.command).toEqual({
			verb: "settle",
			settlement:
				condition === "dead"
					? { kind: "process_started", label: "host-0:1", reattached: true }
					: { kind: "alarm_fired" },
		});
		expect(fake.bound(issue)).toBe(send);
	});

	it("dispatches a deferred hold once on a live replacement with its original binding (3.3)", () => {
		const fake = new FakeProvider("cursor");
		started(fake);
		fake.observe(
			{
				verb: "settle",
				settlement: { kind: "process_lost", runnerId: "host-0", retiredAt: 0 },
			},
			emptyView(),
		);
		const issue = held("start");
		const send = fake.bound(issue);
		fake.issued([issue]);
		fake.pendingObservations();
		started(fake, "replacement:1", [issue]);
		expect(fake.groundTruth().unfinished).toEqual([send.token]);
		expect(fake.pendingObservations()).toEqual([
			{
				tag: "Answer",
				token: send.token,
				kind: "run_dispatched",
				runId: "R",
				runnerId: "replacement",
				commandId: "start",
				transmission: 1,
			},
		]);
		fake.issued([issue]);
		expect(fake.pendingObservations()).toEqual([]);
	});

	it("never executes a deferred hold after its Run has emitted a terminal (3.8)", () => {
		const fake = new FakeProvider("cursor");
		const issue = held("start");
		fake.issued([issue]);
		fake.assertStep(
			{ verb: "settle", settlement: { kind: "alarm_fired" } },
			emptyView(),
			emptyView(),
			[],
			[{ runId: "R", outcome: "completed", reason: { tag: "completed" } }],
		);
		started(fake, "replacement:1");
		fake.issued([issue]);
		const redispatch = fake.next(
			{ ...action, operation: 24 },
			{ issued: [issue], view: emptyView(), now: 101 },
		);
		expect(redispatch.command).toEqual({
			verb: "settle",
			settlement: { kind: "alarm_fired" },
		});
		expect(fake.groundTruth().unfinished).toEqual([]);
		expect(fake.pendingObservations()).toEqual([]);
	});

	it("does not revive a lost runner by observing a different query label on that runner (3.3)", () => {
		const fake = new FakeProvider("cursor");
		started(fake);
		fake.observe(
			{
				verb: "settle",
				settlement: { kind: "process_lost", runnerId: "host-0", retiredAt: 0 },
			},
			emptyView(),
		);
		const issue = held("start");
		fake.issued([issue]);
		started(fake, "host-0:2");
		expect(fake.groundTruth().processAlive).toBe(false);
		expect(fake.groundTruth().unfinished).toEqual([]);
		expect(fake.pendingObservations()).toEqual([]);
		started(fake, "replacement:1", [issue]);
		expect(fake.groundTruth().unfinished).toEqual([fake.bound(issue).token]);
		expect(fake.pendingObservations()).toHaveLength(1);
	});

	it("keeps bound-only metadata from originating a run_dispatched fact (3.3)", () => {
		const fake = new FakeProvider("cursor");
		started(fake);
		const issue = held("start");
		fake.bound(issue);
		const generated = fake.next(
			{ ...action, variant: 34 },
			{ issued: [issue], view: emptyView(), now: 101 },
		);
		expect(generated.command).toEqual({
			verb: "settle",
			settlement: { kind: "alarm_fired" },
		});
		expect(fake.groundTruth().unfinished).toEqual([]);
		expect(fake.pendingObservations()).toEqual([]);
	});

	it.each([
		"session_ended",
	] as const)("never dispatches a deferred hold retired by %s (3.4)", (kind) => {
		const fake = new FakeProvider("cursor");
		fake.issued([held("start")]);
		fake.pendingObservations();
		fake.observe(
			{
				verb: "settle",
				settlement: { kind, cause: "native_session_vanished" },
			},
			emptyView(),
		);
		started(fake, "replacement:1");
		expect(fake.groundTruth().unfinished).toEqual([]);
		expect(fake.pendingObservations()).toEqual([]);
	});

	it("can deliver a previously real dispatch after runner loss without originating new native work (3.4)", () => {
		const fake = new FakeProvider("cursor");
		started(fake);
		const issue = held("start");
		const [send] = fake.issued([issue]);
		assert(send);
		fake.observe(
			{
				verb: "settle",
				settlement: { kind: "process_lost", runnerId: "host-0", retiredAt: 0 },
			},
			emptyView(),
		);
		const delayed = fake.next(
			{ ...action, operation: 9 },
			{ issued: [issue], view: emptyView(), now: 101 },
		);
		expect(delayed.command).toMatchObject({
			verb: "observe",
			observation: {
				token: send.token,
				kind: "run_dispatched",
				runId: "R",
				runnerId: "host-0",
			},
		});
		fake.observe(delayed.command, emptyView());
		expect(fake.groundTruth().unfinished).toEqual([]);
	});
	it("does not redispatch a lost runner's hold while another process is alive (3.3)", () => {
		const fake = new FakeProvider("claude");
		started(fake, "lost:1");
		const issue = held("start");
		fake.issued([issue]);
		fake.observe(
			{
				verb: "settle",
				settlement: { kind: "process_lost", runnerId: "lost", retiredAt: 0 },
			},
			emptyView(),
		);
		started(fake, "alive:1");
		const packet = fake.next(
			{ ...action, operation: 24 },
			{ issued: [issue], view: emptyView(), now: 10 },
		);
		expect(packet.command).toEqual({
			verb: "settle",
			settlement: { kind: "alarm_fired" },
		});
		expect(fake.groundTruth().unfinished).toEqual([]);
	});
	it("never transmits a case 2 send whose execution's runner is retired (L2 case 2, L1, H3)", () => {
		const fake = new FakeProvider("claude");
		started(fake, "first:1");
		const start = held("start");
		fake.issued([start]);
		// The start reached, so its execution survives the retirement (3.6 D50).
		readNotifications(fake);
		fake.observe(
			{
				verb: "settle",
				settlement: { kind: "process_lost", runnerId: "first", retiredAt: 0 },
			},
			emptyView(),
		);
		started(fake, "second:1");
		fake.pendingObservations();
		const steer = held("steer");
		const packet = fake.next(
			{ ...action, operation: 24 },
			{ issued: [steer], view: { ...emptyView(), live: [steer] }, now: 10 },
		);
		expect(packet.command).toEqual({
			verb: "settle",
			settlement: { kind: "alarm_fired" },
		});
		expect(fake.pendingObservations()).toEqual([]);
	});
	it("retires a dispatched runner not yet started when another runner starts (L1 totality, 4073cc6b)", () => {
		const fake = new FakeProvider("claude");
		started(fake);
		fake.observe(
			{
				verb: "settle",
				settlement: { kind: "process_lost", runnerId: "host-0", retiredAt: 0 },
			},
			emptyView(),
		);
		const start = held("start");
		fake.issued([start]);
		const view = { ...emptyView(), live: [start] };
		const spawn = fake.next(
			{ ...action, operation: 12, variant: 4 },
			{ issued: [start], view, now: 1 },
		).command;
		assert(
			spawn.verb === "observe" && spawn.observation.kind === "run_dispatched",
		);
		const spawned = spawn.observation.runnerId;
		fake.observe(spawn, view);
		started(fake, "other:1", [start]);
		expect(fake.pendingObservations()).toEqual([]);
		started(fake, `${spawned}:1`, [start]);
		expect(fake.label).toBe("other:1");
		expect(
			fake.next({ ...action, operation: 24 }, { issued: [start], view, now: 2 })
				.command,
		).toEqual({ verb: "settle", settlement: { kind: "alarm_fired" } });
	});
	it("keeps process-loss coverage when an old held command is reissued on a replacement (5.1)", () => {
		const fake = new FakeProvider("cursor");
		started(fake);
		const issue = held("start");
		fake.issued([issue]);
		readNotifications(fake);
		fake.observe(
			{
				verb: "settle",
				settlement: { kind: "process_lost", runnerId: "host-0", retiredAt: 0 },
			},
			emptyView(),
		);
		started(fake, "replacement:1");
		fake.issued([{ ...issue }]);
		expect(fake.groundTruth().unfinished).toEqual([]);
		expect(fake.pendingObservations()).toEqual([]);
	});
	it("generates reuse of a delivered event id on a different label (D8)", () => {
		const fake = new FakeProvider("claude");
		started(fake, "host:1");
		const snapshot = { issued: [], view: emptyView(), now: 0 };
		const original = fake.next({ ...action, operation: 13 }, snapshot).command;
		assert(
			original.verb === "observe" && original.observation.tag === "Unsolicited",
		);
		fake.observe(original, emptyView());
		started(fake, "host:2");
		const reused = fake.next({ ...action, operation: 26 }, snapshot).command;
		assert(
			reused.verb === "observe" && reused.observation.tag === "Unsolicited",
		);
		expect(reused.observation.eventId).toBe(original.observation.eventId);
		expect(reused.observation.label).toBe("host:2");
	});

	it("generates the original copied confirmation after process replacement (D3)", () => {
		const fake = new FakeProvider("claude");
		started(fake, "host:1");
		const pending = (snapshotEntry: number): LedgerView => ({
			...emptyView(),
			anythingMayAct: true,
			pendingConfirm: {
				step: "retire",
				labels: [fake.label],
				snapshotEntry,
				tasks: { tag: "unknown", label: fake.label },
			},
		});
		fake.next(
			{ ...action, operation: 6 },
			{ issued: [], view: pending(1), now: 0 },
		);
		started(fake, "host:2");
		const stale = fake.next(
			{ ...action, operation: 17, selection: 2 },
			{ issued: [], view: pending(2), now: 0 },
		);
		expect(stale.command).toEqual({
			verb: "control",
			control: { kind: "confirm_escalation", snapshotEntry: 1 },
		});
	});
	it("rejects destruction from a copied confirmation that predates process replacement (D3/LI5)", () => {
		const fake = new FakeProvider("claude");
		const pending = (snapshotEntry: number, label: string): LedgerView => ({
			...emptyView(),
			anythingMayAct: true,
			pendingConfirm: {
				step: "retire",
				labels: [label],
				snapshotEntry,
				tasks: { tag: "unknown", label },
			},
		});
		fake.assertStep(
			{
				verb: "settle",
				settlement: {
					kind: "process_started",
					label: "host:1",
					reattached: true,
				},
			},
			emptyView(),
			pending(1, "host:1"),
			[],
			[],
		);
		fake.assertStep(
			{
				verb: "settle",
				settlement: {
					kind: "process_started",
					label: "host:2",
					reattached: true,
				},
			},
			pending(1, "host:1"),
			// D44: the reattach makes host:1 older, deciding its lost work.
			{
				...pending(2, "host:2"),
				lostWork: [{ tag: "unknown", label: "host:1" }],
			},
			[],
			[],
		);
		const destroy: IssuedEffect = {
			tag: "Tokened",
			token: token("stale-kill"),
			effect: { kind: "end_session", runId: null, label: "host:2" },
		};
		expect(() =>
			fake.assertStep(
				{
					verb: "control",
					control: { kind: "confirm_escalation", snapshotEntry: 1 },
				},
				{
					...pending(2, "host:2"),
					lostWork: [{ tag: "unknown", label: "host:1" }],
				},
				{
					...emptyView(),
					anythingMayAct: true,
					lostWork: [
						{ tag: "unknown", label: "host:1" },
						{ tag: "unknown", label: "host:2" },
					],
				},
				[destroy],
				[],
			),
		).toThrow(/LI5: destructive effect without confirmation/);
	});
	it("rejects destruction from a confirmation copied before a query replacement (D45/LI5)", () => {
		const fake = new FakeProvider("claude");
		const pending = (snapshotEntry: number, label: string): LedgerView => ({
			...emptyView(),
			anythingMayAct: true,
			pendingConfirm: {
				step: "retire",
				labels: [label],
				snapshotEntry,
				tasks: { tag: "unknown", label },
			},
		});
		fake.assertStep(
			{
				verb: "settle",
				settlement: {
					kind: "process_started",
					label: "host:1",
					reattached: true,
				},
			},
			emptyView(),
			pending(1, "host:1"),
			[],
			[],
		);
		// The view keeps entry 1 across the replacement, so the copied confirm still matches it.
		const replaced: LedgerView = {
			...pending(1, "host:2"),
			lostWork: [{ tag: "unknown", label: "host:1" }],
		};
		fake.assertStep(
			{
				verb: "observe",
				observation: {
					tag: "Unsolicited",
					label: "host:2",
					eventId: "e1",
					kind: "activity",
				},
			},
			pending(1, "host:1"),
			replaced,
			[],
			[],
		);
		const destroy: IssuedEffect = {
			tag: "Tokened",
			token: token("stale-kill"),
			effect: { kind: "end_session", runId: null, label: "host:2" },
		};
		expect(() =>
			fake.assertStep(
				{
					verb: "control",
					control: { kind: "confirm_escalation", snapshotEntry: 1 },
				},
				replaced,
				{
					...emptyView(),
					anythingMayAct: true,
					lostWork: [
						{ tag: "unknown", label: "host:1" },
						{ tag: "unknown", label: "host:2" },
					],
				},
				[destroy],
				[],
			),
		).toThrow(/LI5: destructive effect without confirmation/);
	});

	it.each([
		"succeeded",
		"retryable",
		"permanent",
		"delivery_unknown",
	] as const)("generates %s outcomes for a Run-less kill (D4)", (tag) => {
		const fake = new FakeProvider("claude");
		started(fake);
		const issue: IssuedEffect = {
			tag: "Tokened",
			token: token("runless"),
			effect: { kind: "end_session", runId: null, label: "host-0:1" },
		};
		fake.issued([issue]);
		const variant = [
			"succeeded",
			"retryable",
			"permanent",
			"delivery_unknown",
		].indexOf(tag);
		const packet = fake.next(
			{ ...action, variant },
			{ issued: [issue], view: emptyView(), now: 0 },
		);
		assert(
			packet.command.verb === "observe" &&
				packet.command.observation.kind === "effect_outcome",
		);
		expect(packet.command.observation.token).toBe("runless");
		expect(packet.command.observation.outcome.tag).toBe(tag);
	});

	it("fires successive silent probe transmission alarms without fabricating a response (D13)", () => {
		const fake = new FakeProvider("opencode");
		started(fake);
		const probe = (id: string): IssuedEffect => ({
			tag: "Tokened",
			token: token(id),
			effect: { kind: "probe", runId: "R", target: { tag: "native_session" } },
		});
		const first = probe("first");
		const second = probe("second");
		fake.issued([first]);
		const firstAlarm = fake.next(
			{ ...action, operation: 6 },
			{ issued: [first], view: emptyView(), now: 0, alarmAt: 1000 },
		);
		fake.issued([second]);
		const nextAlarm = fake.next(
			{ ...action, operation: 6 },
			{
				issued: [first, second],
				view: emptyView(),
				now: firstAlarm.now,
				alarmAt: 3000,
			},
		);
		expect(firstAlarm).toEqual({
			now: 1000,
			command: { verb: "settle", settlement: { kind: "alarm_fired" } },
		});
		expect(nextAlarm).toEqual({
			now: 3000,
			command: { verb: "settle", settlement: { kind: "alarm_fired" } },
		});
		expect(fake.groundTruth().unfinished).toEqual(["first", "second"]);
	});
});

describe("fake provider round 3 contract decisions", () => {
	it("retains OpenCode accepted work after native result and query end until a covering idle probe (3.5/9/D6)", () => {
		const fake = new FakeProvider("opencode");
		started(fake);
		const [send] = fake.issued([
			{
				tag: "Tokened",
				token: token("accepted"),
				effect: { kind: "start", runId: "R", inputId: "A", mode: "resume" },
			},
		]);
		assert(send);
		answer(fake, send, { kind: "input_accepted" });
		answer(fake, send, { kind: "result", outcome: "completed" });
		expect(fake.groundTruth().acceptedUnended).toEqual([send.token]);
		answer(fake, send, { kind: "query_ended" });
		expect(fake.groundTruth().acceptedUnended).toEqual([send.token]);
		const [probe] = fake.issued([
			{
				tag: "Tokened",
				token: token("idle"),
				effect: {
					kind: "probe",
					runId: "R",
					target: { tag: "native_session" },
				},
			},
		]);
		assert(probe);
		answer(fake, probe, {
			kind: "probe_result",
			finding: { tag: "native_idle" },
		});
		expect(fake.groundTruth().unfinished).toEqual([]);
	});
	it.each([
		"claude",
		"cursor",
	] as const)("retires %s interrupt only after all targeted native input work ends (3.5/9)", (provider) => {
		const fake = new FakeProvider(provider);
		started(fake);
		const [first, sibling, interrupt, close] = fake.issued([
			held("start"),
			held("steer"),
			{
				tag: "Tokened",
				token: token("interrupt"),
				effect: { kind: "interrupt", runId: "R", runIds: ["R"] },
			},
			{
				tag: "Tokened",
				token: token("close"),
				effect: { kind: "end_session", runId: "R", label: "host-0:1" },
			},
		]);
		assert(first && sibling && interrupt && close);
		answer(fake, first, { kind: "input_accepted" });
		answer(fake, sibling, { kind: "input_accepted" });
		answer(fake, first, { kind: "result", outcome: "completed" });
		if (provider === "claude") {
			expect(fake.groundTruth().unfinished).toEqual([
				sibling.token,
				interrupt.token,
				close.token,
			]);
			answer(fake, sibling, { kind: "result", outcome: "completed" });
		}
		expect(fake.groundTruth().unfinished).toEqual([close.token]);
	});
	it.each([
		"claude",
		"codex",
		"cursor",
		"opencode",
	] as const)("ends only %s query-scoped controls at query end (D1)", (provider) => {
		const fake = new FakeProvider(provider);
		started(fake);
		const sends = fake.issued([
			held("start"),
			held("steer"),
			{
				tag: "Tokened",
				token: token("interrupt"),
				effect: { kind: "interrupt", runId: "R", runIds: ["R"] },
			},
			// REDESIGN-7 removed close, the other query-scoped control.
			{
				tag: "Tokened",
				token: token("cancel"),
				effect: { kind: "cancel_request", runId: "R" },
			},
		]);
		assert(sends[0]);
		answer(fake, sends[0], { kind: "query_ended" });
		expect(fake.groundTruth().unfinished).toEqual(
			sends
				.filter(
					(send) => provider === "opencode" || send.effect.kind !== "interrupt",
				)
				.map(({ token }) => token),
		);
	});

	it.each([
		"dead",
		"lost",
	] as const)("does not redispatch a %s host (3.3)", (condition) => {
		const fake = new FakeProvider("claude");
		const issue = held("start");
		if (condition === "lost") {
			started(fake);
			fake.issued([issue]);
			fake.observe(
				{
					verb: "settle",
					settlement: {
						kind: "process_lost",
						runnerId: "host-0",
						retiredAt: 0,
					},
				},
				emptyView(),
			);
		}
		const before = fake.groundTruth();
		const packet = fake.next(
			{ ...action, operation: 24 },
			{ issued: [issue], view: emptyView(), now: 10 },
		);
		expect(packet.command).toEqual({
			verb: "settle",
			settlement: { kind: "alarm_fired" },
		});
		expect(fake.groundTruth()).toEqual(before);
	});

	it("accepts event-id reuse on another label and still deduplicates its own pair (D8)", () => {
		const fake = new FakeProvider("claude");
		const snapshot = (label: string, tasks: readonly []) =>
			({
				verb: "observe",
				observation: {
					tag: "Unsolicited",
					label,
					eventId: "reused",
					kind: "tasks_snapshot",
					tasks,
				},
			}) as const;
		started(fake, "host-0:1");
		fake.observe(snapshot(fake.label, []), emptyView());
		started(fake, "host-0:2");
		const task = {
			key: { taskId: "live" },
			taskType: "local_bash",
			description: "live",
			ambient: false,
		};
		const next: LedgerCommand = {
			verb: "observe",
			observation: {
				tag: "Unsolicited",
				label: fake.label,
				eventId: "reused",
				kind: "tasks_snapshot",
				tasks: [task],
			},
		};
		fake.observe(next, emptyView());
		expect(fake.groundTruth().tasks).toEqual([task]);
		fake.observe(snapshot(fake.label, []), emptyView());
		expect(fake.groundTruth().tasks).toEqual([task]);
	});

	it.each([
		"start",
		"steer",
	] as const)("tracks %s lifecycle cancellation before and after started (D5)", (kind) => {
		const fake = new FakeProvider("claude");
		started(fake);
		const [before, after, mismatch] = fake.issued([
			held(kind, "before"),
			held(kind, "after"),
			held(kind, "mismatch"),
		]);
		assert(before && after && mismatch);
		answer(fake, before, {
			kind: "command_lifecycle",
			commandId: "before",
			state: "cancelled",
		});
		answer(fake, after, {
			kind: "command_lifecycle",
			commandId: "after",
			state: "started",
		});
		answer(fake, after, {
			kind: "command_lifecycle",
			commandId: "after",
			state: "cancelled",
		});
		answer(fake, after, {
			kind: "effect_outcome",
			outcome: { tag: "permanent", code: "Trace" },
		});
		answer(fake, mismatch, {
			kind: "command_lifecycle",
			commandId: "wrong",
			state: "cancelled",
		});
		expect(fake.groundTruth().unfinished).toEqual([
			after.token,
			mismatch.token,
		]);
	});

	it.each([
		"start",
		"steer",
	] as const)("generates tokened %s lifecycle with the hold command id (D5)", (kind) => {
		const fake = new FakeProvider("claude");
		started(fake);
		const issue = held(kind, "native-held");
		const [send] = fake.issued([issue]);
		assert(send);
		// The hold's run.dispatched is read first (3.4).
		fake.pendingObservations();
		for (const [offset, state] of [
			"queued",
			"started",
			"completed",
			"cancelled",
		].entries()) {
			const packet = fake.next(
				{ ...action, variant: 51 + offset },
				{ issued: [issue], view: emptyView(), now: 10 },
			);
			expect(packet.command).toEqual({
				verb: "observe",
				observation: {
					tag: "Answer",
					token: send.token,
					kind: "command_lifecycle",
					commandId: "native-held",
					state,
				},
			});
		}
	});

	it.each([
		"answer",
		"native",
	] as const)("settles every transmission of a resolved interaction through %s evidence (D12)", (source) => {
		const fake = new FakeProvider("claude");
		started(fake);
		const [start, first, retry, other] = fake.issued([
			held("start"),
			...(["first", "retry", "other"] as const).map(
				(id): IssuedEffect => ({
					tag: "Tokened",
					token: token(id),
					effect: {
						kind: "deliver_answer",
						runId: "R",
						label: "host-0:1",
						interactionId: id === "other" ? "other" : "Q",
						answer: "yes",
					},
				}),
			),
		]);
		assert(start && first && retry && other);
		answer(fake, source === "answer" ? retry : start, {
			kind: "interaction_resolved",
			interactionId: "Q",
		});
		expect(fake.groundTruth().unfinished).toEqual([start.token, other.token]);
	});

	it("uses a named OpenCode result as idle delivery proof without clearing an unconfirmed sibling (D6)", () => {
		const fake = new FakeProvider("opencode");
		started(fake);
		const [named, sibling] = fake.issued([
			{
				tag: "Tokened",
				token: token("named"),
				effect: { kind: "start", runId: "R", inputId: "A", mode: "resume" },
			},
			{
				tag: "Tokened",
				token: token("sibling"),
				effect: { kind: "steer", runId: "R", inputId: "B" },
			},
		]);
		assert(named && sibling);
		for (const send of [named, sibling])
			answer(fake, send, {
				kind: "effect_outcome",
				outcome: { tag: "delivery_unknown" },
			});
		answer(fake, named, { kind: "result", outcome: "completed" });
		answer(fake, named, { kind: "query_ended" });
		const [probe] = fake.issued([
			{
				tag: "Tokened",
				token: token("idle"),
				effect: {
					kind: "probe",
					runId: "R",
					target: { tag: "native_session" },
				},
			},
		]);
		assert(probe);
		answer(fake, probe, {
			kind: "probe_result",
			finding: { tag: "native_idle" },
		});
		expect(fake.groundTruth().unfinished).toEqual([sibling.token]);
	});

	it("requires lost work under the destroyed runner's latest label (D15)", () => {
		const fake = new FakeProvider("claude");
		started(fake, "old:1");
		fake.issued([held("start")]);
		started(fake, "old:2");
		started(fake, "current:1");
		const before = { ...emptyView(), anythingMayAct: true };
		const destroy: IssuedEffect = {
			tag: "Tokened",
			token: token("kill"),
			effect: { kind: "end_session", runId: "R", label: "old:1" },
		};
		expect(() =>
			fake.assertStep(
				{ verb: "settle", settlement: { kind: "alarm_fired" } },
				before,
				{ ...before, lostWork: [{ tag: "known", label: "old:2", tasks: [] }] },
				[destroy],
				[],
			),
		).not.toThrow();
	});

	it("session end covers every send (D10/D11)", () => {
		const fake = new FakeProvider("claude");
		started(fake);
		const [send, probe] = fake.issued([
			held("start"),
			{
				tag: "Tokened",
				token: token("probe"),
				effect: {
					kind: "probe",
					runId: "R",
					target: { tag: "input", inputId: "start" },
				},
			},
		]);
		assert(send && probe);
		expect(fake.groundTruth().unfinished).toContain(send.token);
		fake.observe(
			{
				verb: "settle",
				settlement: { kind: "session_ended", cause: "native_session_vanished" },
			},
			emptyView(),
		);
		expect(fake.groundTruth().unfinished).toEqual([]);
	});

	// Cursor starts no unsolicited turn (8.3).
	it.each([
		"claude",
		"codex",
		"opencode",
	] satisfies readonly ProviderKind[])("ends %s wake execution at its session's end (8.3, 3.4)", (provider) => {
		const fake = new FakeProvider(provider);
		started(fake);
		fake.observe(
			{
				verb: "observe",
				observation: {
					tag: "Unsolicited",
					label: fake.label,
					eventId: "wake",
					kind: "turn_started",
				},
			},
			emptyView(),
		);
		fake.observe(
			{
				verb: "settle",
				settlement: { kind: "session_ended", cause: "native_session_vanished" },
			},
			emptyView(),
		);
		expect(fake.groundTruth().runningTurn).toBe(false);
	});
});

describe("fake provider round 4 contract", () => {
	it.each([
		["claude", "running", true],
		["claude", "result", true],
		["claude", "result-then-query-end", false],
		["claude", "session-end", false],
		["claude", "coverage", false],
		["codex", "running", true],
		["codex", "result", false],
		["cursor", "running", true],
		["cursor", "result", false],
		["opencode", "running", true],
		["opencode", "query-end", true],
		["opencode", "query-end-then-idle", false],
		["opencode", "old-probe-then-query-end", true],
	] as const)("checks %s wake fence at %s before resume start (8.3/9/D18, LI1)", (provider, phase, blocked) => {
		const fake = new FakeProvider(provider);
		started(fake);
		const probe: IssuedEffect = {
			tag: "Tokened",
			token: token("idle"),
			effect: {
				kind: "probe",
				runId: "wake",
				target: { tag: "native_session" },
			},
		};
		if (phase === "old-probe-then-query-end") fake.issued([probe]);
		fake.observe(
			{
				verb: "observe",
				observation: {
					tag: "Unsolicited",
					label: fake.label,
					eventId: "wake",
					kind: "turn_started",
				},
			},
			emptyView(),
		);
		if (phase === "result" || phase === "result-then-query-end")
			fake.observe(
				{
					verb: "observe",
					observation: {
						tag: "Unsolicited",
						label: fake.label,
						eventId: "result",
						kind: "result",
						outcome: "completed",
					},
				},
				emptyView(),
			);
		if (
			phase === "query-end" ||
			phase === "result-then-query-end" ||
			phase === "query-end-then-idle" ||
			phase === "old-probe-then-query-end"
		)
			fake.observe(
				{
					verb: "observe",
					observation: {
						tag: "Unsolicited",
						label: fake.label,
						eventId: "query-end",
						kind: "query_ended",
					},
				},
				emptyView(),
			);
		if (phase === "query-end-then-idle") fake.issued([probe]);
		if (phase === "query-end-then-idle" || phase === "old-probe-then-query-end")
			answer(fake, probe, {
				kind: "probe_result",
				finding: { tag: "native_idle" },
			});
		if (phase === "session-end")
			fake.observe(
				{
					verb: "settle",
					settlement: {
						kind: "session_ended",
						cause: "native_session_vanished",
					},
				},
				emptyView(),
			);
		if (phase === "coverage") {
			const close: IssuedEffect = {
				tag: "Tokened",
				token: token("close"),
				effect: { kind: "end_session", runId: "wake", label: "host-0:1" },
			};
			fake.issued([close]);
			answer(fake, close, {
				kind: "effect_outcome",
				outcome: { tag: "succeeded" },
			});
		}
		const start = () =>
			fake.assertStep(
				{ verb: "settle", settlement: { kind: "alarm_fired" } },
				{ ...emptyView(), anythingMayAct: true },
				{ ...emptyView(), anythingMayAct: true },
				[held("start")],
				[],
			);
		if (blocked)
			expect(start).toThrow(/LI1: resume start overlaps a running wake/);
		else expect(start).not.toThrow();
	});

	it.each([
		"activity",
		"result",
		"query_ended",
	] as const)("ignores unsolicited %s without a wake execution (8.3)", (kind) => {
		const fake = new FakeProvider("claude");
		started(fake);
		if (kind !== "activity") {
			const [send] = fake.issued([held("start")]);
			assert(send);
			answer(fake, send, { kind: "started" });
			fake.issued([
				{
					tag: "Tokened",
					token: token("queued"),
					effect: {
						kind: "send_native_command",
						commandId: "queued",
						text: "/clear",
					},
				},
			]);
		}
		fake.pendingObservations();
		const before = fake.groundTruth();
		fake.observe(
			{
				verb: "observe",
				observation: {
					tag: "Unsolicited",
					label: fake.label,
					eventId: "spurious",
					...(kind === "result"
						? ({ kind, outcome: "completed" } as const)
						: { kind }),
				},
			},
			emptyView(),
		);
		expect(fake.groundTruth()).toEqual(before);
		expect(fake.pendingObservations()).toEqual([]);
	});

	it("records wake destruction under the execution runner's latest label (8.4/D15)", () => {
		const fake = new FakeProvider("claude");
		started(fake, "wake-host:1");
		const wakeView: LedgerView = {
			...emptyView(),
			anythingMayAct: true,
			active: {
				runId: "wake-run",
				origin: "wake",
				tag: "Running",
				inputs: [],
				deadline: { owner: "Stop", at: 500 },
			},
		};
		fake.assertStep(
			{
				verb: "observe",
				observation: {
					tag: "Unsolicited",
					label: fake.label,
					eventId: "wake",
					kind: "turn_started",
				},
			},
			emptyView(),
			wakeView,
			[],
			[],
		);
		started(fake, "wake-host:2");
		started(fake, "other-host:1");
		expect(() =>
			fake.assertStep(
				{ verb: "settle", settlement: { kind: "alarm_fired" } },
				wakeView,
				{
					...wakeView,
					lostWork: [{ tag: "known", label: "wake-host:2", tasks: [] }],
				},
				[
					{
						tag: "Tokened",
						token: token("kill-wake"),
						effect: {
							kind: "end_session",
							runId: "wake-run",
							label: "wake-host:1",
						},
					},
				],
				[],
			),
		).not.toThrow();
		expect(fake.groundTruth().processAlive).toBe(true);
		expect(fake.groundTruth().runningTurn).toBe(false);
	});

	it.each([
		false,
		true,
	])("requires a native command in its requesting decision with alive=%s (8.5, D22, LI6)", (alive) => {
		const fake = new FakeProvider("claude");
		if (alive) started(fake);
		expect(() =>
			fake.assertStep(
				{
					verb: "control",
					control: {
						kind: "native_command",
						commandId: "command",
						text: "/clear",
					},
				},
				emptyView(),
				{ ...emptyView(), anythingMayAct: true },
				[],
				[],
			),
		).toThrow(/LI6: native command was not issued in its requesting decision/);
	});

	it("holds an issued native command without inventing a process until process_started (8.5/D22)", () => {
		const fake = new FakeProvider("claude");
		const command: IssuedEffect = {
			tag: "Tokened",
			token: token("command"),
			effect: {
				kind: "send_native_command",
				commandId: "command",
				text: "/clear",
			},
		};
		fake.issued([command]);
		expect(fake.groundTruth().processAlive).toBe(false);
		expect(fake.groundTruth().unfinished).toEqual([]);
		expect(fake.pendingObservations()).toEqual([]);
		started(fake, "host-0:1", [command]);
		expect(fake.groundTruth().unfinished).toEqual([command.token]);
		expect(fake.pendingObservations()).toEqual([
			{
				tag: "Unsolicited",
				label: fake.label,
				eventId: "fake-event:0",
				kind: "command_result",
				commandId: "command",
			},
		]);
	});

	const refusedPause: IssuedEffect = {
		tag: "Tokened",
		token: token("pause"),
		effect: {
			kind: "send_native_command",
			commandId: "pause",
			text: "/goal pause",
		},
	};
	const refusal = {
		tag: "Answer",
		token: token("pause"),
		kind: "effect_outcome",
		outcome: { tag: "permanent", code: "NoGoalExists" },
	} as const;
	it.each([
		0, 1, 2, 3,
	])("refuses a Codex /goal pause with no goal for every outcome draw %i (8.5/D34)", (variant) => {
		const fake = new FakeProvider("codex");
		started(fake);
		fake.issued([refusedPause]);
		expect(fake.pendingObservations()).toEqual([]);
		const packet = fake.next(
			{ ...action, variant },
			{ issued: [refusedPause], view: emptyView(), now: 0 },
		);
		expect(packet.command).toEqual({ verb: "observe", observation: refusal });
	});

	it("requires a refused command to be Failed with the outcome's code (8.5/D34, LI6)", () => {
		const step = (nativeCommands: LedgerView["nativeCommands"]) => () => {
			const fake = new FakeProvider("codex");
			started(fake);
			fake.issued([refusedPause]);
			fake.assertStep(
				{ verb: "observe", observation: refusal },
				{ ...emptyView(), anythingMayAct: true, live: [refusedPause] },
				{ ...emptyView(), nativeCommands },
				[],
				[],
			);
			expect(fake.groundTruth().unfinished).toEqual([]);
		};
		expect(step([])).toThrow(/D34/);
		expect(
			step([{ tag: "Failed", commandId: "pause", code: "NoGoalExists" }]),
		).not.toThrow();
	});

	it("exempts an unfinished probe from anythingMayAct (8.3/D31, LI8)", () => {
		const fake = new FakeProvider("opencode");
		started(fake);
		const probe: IssuedEffect = {
			tag: "Tokened",
			token: token("idle"),
			effect: { kind: "probe", runId: "R", target: { tag: "native_session" } },
		};
		expect(() =>
			fake.assertStep(
				{ verb: "settle", settlement: { kind: "alarm_fired" } },
				emptyView(),
				emptyView(),
				[probe],
				[],
			),
		).not.toThrow();
		expect(fake.groundTruth().unfinished).toEqual([probe.token]);
	});

	const close = (label: string | null): IssuedEffect => ({
		tag: "Tokened",
		token: token("destroy"),
		effect: { kind: "end_session", runId: "R", label },
	});
	it.each([
		[
			"a Run label off its execution runner",
			close("other:1"),
			/not an execution label of its Run \(D33\)/,
		],
		[
			"a null Run label after its process was seen",
			close(null),
			/null after its Run's process was seen \(D33\)/,
		],
	] as const)("rejects %s (8.4/D32/D33, LI5)", (_name, destroy, message) => {
		const fake = new FakeProvider("claude");
		started(fake);
		fake.issued([
			held("start"),
			{
				tag: "Tokened",
				token: token("end"),
				effect: { kind: "end_session", runId: null, label: "host-0:1" },
			},
		]);
		if (message.source.includes("lost"))
			fake.observe(
				{
					verb: "settle",
					settlement: {
						kind: "process_lost",
						runnerId: "host-0",
						retiredAt: 0,
					},
				},
				emptyView(),
			);
		expect(() =>
			fake.assertStep(
				{ verb: "settle", settlement: { kind: "alarm_fired" } },
				{ ...emptyView(), anythingMayAct: true },
				{
					...emptyView(),
					anythingMayAct: true,
					lostWork: [{ tag: "known", label: "host-0:1", tasks: [] }],
				},
				[destroy],
				[],
			),
		).toThrow(message);
	});

	// Round 13 newseeds claude-20261047: a start retried with no process is pending, and a send of a
	// Run whose start is pending is pending too, so its close carries null even though an earlier try
	// was addressed to a process (L2 case 2, wire label).
	it.each([
		true,
		false,
	])("accepts a null close label only while the Run's retried start is pending: retried=%s (L2, D33, LI5)", (retried) => {
		const fake = new FakeProvider("claude");
		started(fake);
		fake.issued([held("start")]);
		// Its run.dispatched read, the start may have reached, so the retirement does not unlaunch it (D50).
		if (!retried) readNotifications(fake);
		lost(fake, "host-0");
		// A new try, as after a not_sent answer: not a later transmission of the first send.
		if (retried) fake.issued([held("start", "retry")]);
		const step = () =>
			fake.assertStep(
				{ verb: "settle", settlement: { kind: "alarm_fired" } },
				{ ...emptyView(), anythingMayAct: true },
				{ ...emptyView(), anythingMayAct: true },
				[close(null)],
				[],
			);
		if (retried) expect(step).not.toThrow();
		else expect(step).toThrow(/null after its Run's process was seen \(D33\)/);
	});

	// The seed itself: the hold's next try got not_sent, so its start was unlaunched (3.6, H4); the
	// relaunch is a new send under the same commandId, not a later transmission of the dropped one (L2).
	it.each([
		[true, "served"],
		[true, "not_served"],
		[false, "served"],
	] as const)("addresses a relaunch after a not_sent hold anew: unlaunched=%s, gate=%s (3.6, L2, D33, LI5)", (unlaunched, gate) => {
		const fake = new FakeProvider("claude");
		started(fake);
		fake.issued([held("start")]);
		// Its run.dispatched read, the start may have reached, so the retirement does not unlaunch it (D50).
		if (unlaunched)
			fake.assertStep(
				{
					verb: "settle",
					settlement: {
						kind: "unheld_outcome",
						runId: "R",
						commandId: "start",
						outcome: { tag: "not_sent", retryAt: 0 },
					},
				},
				{ ...emptyView(), anythingMayAct: true },
				{ ...emptyView(), anythingMayAct: true },
				[],
				[],
			);
		else readNotifications(fake);
		lost(fake, "host-0");
		// A relaunch that meets the gate with no process current is pending too (H4, L2 case 3).
		fake.setGate(gate);
		fake.issued([held("start")]);
		const step = () =>
			fake.assertStep(
				{ verb: "settle", settlement: { kind: "alarm_fired" } },
				{ ...emptyView(), anythingMayAct: true },
				{ ...emptyView(), anythingMayAct: true },
				[close(null)],
				[],
			);
		if (unlaunched) expect(step).not.toThrow();
		else expect(step).toThrow(/null after its Run's process was seen \(D33\)/);
	});

	// claude-20261047 again: the unlaunch dropped the Run's only execution (3.6), so a destruction of
	// that Run has no execution to follow and goes to pending once its process is lost (L2 case 3).
	it.each([
		true,
		false,
	])("addresses a destruction of an unlaunched Run as case 3: unlaunched=%s (3.6, L2, D33, LI5)", (unlaunched) => {
		const fake = new FakeProvider("claude");
		started(fake);
		fake.issued([held("start")]);
		if (unlaunched)
			fake.assertStep(
				{
					verb: "settle",
					settlement: {
						kind: "unheld_outcome",
						runId: "R",
						commandId: "start",
						outcome: { tag: "not_sent", retryAt: 0 },
					},
				},
				{ ...emptyView(), anythingMayAct: true },
				{ ...emptyView(), anythingMayAct: true },
				[],
				[],
			);
		else readNotifications(fake);
		lost(fake, "host-0");
		const step = () =>
			fake.assertStep(
				{ verb: "settle", settlement: { kind: "alarm_fired" } },
				{ ...emptyView(), anythingMayAct: true },
				{ ...emptyView(), anythingMayAct: true },
				[
					{
						tag: "Tokened",
						token: token("end"),
						effect: { kind: "end_session", runId: "R", label: null },
					},
				],
				[],
			);
		if (unlaunched) expect(step).not.toThrow();
		else expect(step).toThrow(/null after its Run's process was seen \(D33\)/);
	});

	it("records no lost work for a destruction issued with no live process (8.4/D38, LI5)", () => {
		const fake = new FakeProvider("claude");
		started(fake);
		fake.issued([held("start")]);
		lost(fake, "host-0");
		reattached(fake, "host-1:1");
		expect(() =>
			fake.assertStep(
				{
					verb: "settle",
					settlement: {
						kind: "process_lost",
						runnerId: "host-1",
						retiredAt: 0,
					},
				},
				{ ...emptyView(), anythingMayAct: true },
				{
					...emptyView(),
					anythingMayAct: true,
					lostWork: [{ tag: "unknown", label: "host-1:1" }],
				},
				[close("host-0:1")],
				[],
			),
		).not.toThrow();
	});
});

// Round 9: one live process, addressed at issue (H1-H3, L1-L5). Each case was red on the round 8 fake.
describe("fake provider round 9 redesign", () => {
	const running = (runId: string): LedgerView => ({
		...emptyView(),
		anythingMayAct: true,
		active: {
			runId,
			origin: "input",
			tag: "Running",
			inputs: [],
			deadline: { owner: "Stop", at: 500 },
		},
	});

	it("requires lost work when a reattached Claude runner with unknown tasks is lost (L5)", () => {
		const fake = new FakeProvider("claude");
		reattached(fake, "host-0:1");
		expect(() =>
			fake.assertStep(
				{
					verb: "settle",
					settlement: {
						kind: "process_lost",
						runnerId: "host-0",
						retiredAt: 0,
					},
				},
				emptyView(),
				emptyView(),
				[],
				[],
			),
		).toThrow(/did not record lost work for host-0:1 \(L5\)/);
	});

	it("rejects lost work recorded twice for one label (LI5, L5)", () => {
		const fake = new FakeProvider("claude");
		reattached(fake, "host-0:1");
		const once: LedgerView = {
			...emptyView(),
			lostWork: [{ tag: "unknown", label: "host-0:1" }],
		};
		fake.assertStep(
			{
				verb: "settle",
				settlement: { kind: "process_lost", runnerId: "host-0", retiredAt: 0 },
			},
			emptyView(),
			once,
			[],
			[],
		);
		expect(() =>
			fake.assertStep(
				{
					verb: "settle",
					settlement: {
						kind: "session_ended",
						cause: "native_session_vanished",
					},
				},
				once,
				{ ...once, lostWork: [...once.lostWork, ...once.lostWork] },
				[],
				[],
			),
		).toThrow(/already decided label host-0:1 \(L5\)/);
	});

	it("splits an older host's label with no querySeq as the whole runnerId (L1)", () => {
		const fake = new FakeProvider("claude");
		started(fake, "legacy-host");
		lost(fake, "legacy-host");
		expect(fake.groundTruth().processAlive).toBe(false);
	});

	it("retires the serving runner when another runner starts (L1 totality)", () => {
		const fake = new FakeProvider("claude");
		started(fake, "host-0:1");
		const [start] = fake.issued([held("start")]);
		assert(start);
		expect(fake.groundTruth().unfinished).toEqual([start.token]);
		started(fake, "host-1:1");
		expect(fake.groundTruth().unfinished).toEqual([]);
		expect(fake.label).toBe("host-1:1");
	});

	it("checks LI9 for a self-started turn on a newer query of the live runner (label not older, 3.4)", () => {
		const fake = new FakeProvider("claude");
		started(fake, "host-0:1");
		expect(() =>
			fake.assertStep(
				{
					verb: "observe",
					observation: {
						tag: "Unsolicited",
						label: "host-0:2",
						eventId: "turn",
						kind: "turn_started",
					},
				},
				emptyView(),
				// A query replacement (6.1) leaves the newer query's turn able to act (LI8).
				{ ...emptyView(), anythingMayAct: true },
				[],
				[],
			),
		).toThrow(/LI9: self-started turn did not create a wake Run/);
	});

	it("does not transmit a pending send the ledger no longer holds at process_started (H3)", () => {
		const fake = new FakeProvider("claude");
		const [start] = fake.issued([held("start")]);
		assert(start);
		started(fake, "host-0:1");
		expect(fake.groundTruth().unfinished).toEqual([]);
		expect(fake.pendingObservations()).toEqual([]);
	});

	it("rejects Run state changed by a result answering a covered send (3.4)", () => {
		const fake = new FakeProvider("claude");
		started(fake, "host-0:1");
		const [start] = fake.issued([held("start")]);
		assert(start);
		// D59 removed kill_and_respawn: a retirement covers the send (L1).
		lost(fake, "host-0");
		expect(() =>
			fake.assertStep(
				{
					verb: "observe",
					observation: {
						tag: "Answer",
						token: token(start.token),
						kind: "result",
						outcome: "completed",
					},
				},
				running("R"),
				emptyView(),
				[],
				[],
			),
		).toThrow(/3\.4: lifecycle evidence on a retired or covered send/);
	});
});

// Round 9 phase 2 failure modes: a host replaying a trace it did not generate
// must agree with the generating host, query replacement (6.1, 3.3), D44, the
// 8.4 tasks rule, and the close step's wire label (L3).
describe("fake provider round 9 contract decisions", () => {
	it("resolves a pending start to a fresh runner named by run_dispatched on a replaying host (6.1, L2)", () => {
		const fake = new FakeProvider("cursor");
		started(fake, "host-0:1");
		lost(fake, "host-0");
		const [start] = fake.issued([held("start", "c1")]);
		assert(start);
		answer(fake, start, {
			kind: "run_dispatched",
			runId: "R",
			runnerId: "host-1",
			commandId: "c1",
			transmission: 1,
		});
		fake.issued([
			{
				tag: "Tokened",
				token: token("close:1"),
				effect: { kind: "end_session", runId: "R", label: null },
			},
		]);
		lost(fake, "host-1");
		expect(fake.groundTruth().unfinished).toEqual([]);
	});

	const frame = (
		label: string,
		kind: "activity" | "turn_started" | "result" | "query_ended",
		eventId: string,
	): LedgerCommand => ({
		verb: "observe",
		observation:
			kind === "result"
				? { tag: "Unsolicited", label, eventId, kind, outcome: "completed" }
				: { tag: "Unsolicited", label, eventId, kind },
	});

	it.each([
		["a query replacement", frame("host-0:3", "activity", "e1")],
		[
			"a reattach",
			{
				verb: "settle",
				settlement: {
					kind: "process_started",
					label: "host-0:3",
					reattached: true,
				},
			} satisfies LedgerCommand,
		],
	] as const)("ends the older label's lost-work scope at %s (L5, D44)", (_, command) => {
		const fake = new FakeProvider("claude");
		started(fake);
		reattached(fake, "host-0:2");
		expect(() =>
			fake.assertStep(
				command,
				emptyView(),
				{ ...emptyView(), anythingMayAct: true },
				[],
				[],
			),
		).toThrow(/LI5: scope end did not record lost work for host-0:2 \(L5\)/);
	});

	it.each([
		"claude",
		"codex",
		"cursor",
	] as const)("ends a %s held start's native turn by its runner reply, which carries the TurnResult (4.11)", (provider) => {
		// seed cursor-82103303, long run: the fake kept the replied send unfinished.
		const fake = new FakeProvider(provider);
		started(fake, "host-0:1");
		const [start] = fake.issued([held("start", "c1")]);
		assert(start);
		answer(fake, start, {
			kind: "run_dispatched",
			runId: "R",
			runnerId: "host-0",
			commandId: "c1",
			transmission: 1,
		});
		answer(fake, start, {
			kind: "runner_reply",
			outcome: { tag: "succeeded" },
		});
		expect(fake.groundTruth()).toMatchObject({
			unfinished: [],
			runningTurn: false,
		});
	});

	it("leaves the newer query's tasks unknown until its first snapshot (8.4, D44)", () => {
		const fake = new FakeProvider("codex");
		started(fake);
		fake.observe(frame("host-0:2", "activity", "e1"), emptyView());
		expect(fake.label).toBe("host-0:2");
		expect(fake.groundTruth().tasks).toBe("unknown");
	});

	it("generates a query replacement whose replaced query_ended answers its Run send (6.1, 3.3)", () => {
		const fake = new FakeProvider("claude");
		started(fake);
		const [start] = fake.issued([held("start")]);
		assert(start);
		const packet = fake.next(
			{ ...action, operation: 12, variant: 1, index: 2 },
			{ issued: [], view: emptyView(), now: 1 },
		);
		expect(packet.command).toMatchObject({
			verb: "observe",
			observation: { tag: "Unsolicited", label: "host-0:2" },
		});
		expect(fake.pendingObservations()).toContainEqual({
			tag: "Answer",
			token: start.token,
			kind: "query_ended",
		});
	});

	it.each([
		"codex",
		"cursor",
		"opencode",
	] as const)("never raises the latest querySeq from %s command_lifecycle, which is Rejected (D46, L1)", (provider) => {
		const fake = new FakeProvider(provider);
		started(fake);
		fake.observe(
			{
				verb: "observe",
				observation: {
					tag: "Unsolicited",
					label: "host-0:2",
					eventId: "e1",
					kind: "command_lifecycle",
					commandId: "c1",
					state: "started",
				},
			},
			emptyView(),
		);
		expect(fake.label).toBe("host-0:1");
	});

	it.each([
		"codex",
		"cursor",
		"opencode",
	] as const)("never ends a %s native command's send by a command_lifecycle Answer, which is Rejected (D46, 8.5)", (provider) => {
		const fake = new FakeProvider(provider);
		const command: IssuedEffect = {
			tag: "Tokened",
			token: token("command"),
			effect: {
				kind: "send_native_command",
				commandId: "c1",
				text: "/compact",
			},
		};
		started(fake, "host-0:1", [command]);
		fake.issued([command]);
		expect(fake.groundTruth().unfinished).toContain(command.token);
		answer(fake, command, {
			kind: "command_lifecycle",
			commandId: "c1",
			state: "completed",
		});
		expect(fake.groundTruth().unfinished).toContain(command.token);
	});

	it.each([
		"cursor",
		"opencode",
	] as const)("never raises the latest querySeq from %s task evidence, which is Rejected (L1, 3.4)", (provider) => {
		const fake = new FakeProvider(provider);
		started(fake);
		fake.observe(
			{
				verb: "observe",
				observation: {
					tag: "Unsolicited",
					label: "host-0:2",
					eventId: "e1",
					kind: "task_event",
					key: { taskId: "t", runId: "r" },
					event: "started",
				},
			},
			emptyView(),
		);
		expect(fake.label).toBe("host-0:1");
	});

	it("treats a start at the latest querySeq as an older label (L1)", () => {
		const fake = new FakeProvider("claude");
		started(fake);
		fake.observe(
			{
				verb: "observe",
				observation: {
					tag: "Unsolicited",
					label: "host-0:2",
					eventId: "e1",
					kind: "tasks_snapshot",
					tasks: [],
				},
			},
			emptyView(),
		);
		reattached(fake, "host-0:2");
		expect(fake.groundTruth().tasks).toEqual([]);
	});

	it("lets an older wake label's Run end release the fence for a queued Run, never end a Run (8.3, D18, LI7)", () => {
		const run = {
			runId: "R2",
			origin: "input",
			inputs: [],
		} as const;
		const view = (active: NonNullable<LedgerView["active"]>): LedgerView => ({
			...emptyView(),
			anythingMayAct: true,
			active,
		});
		const start = (commandId: string) =>
			({
				tag: "Held",
				commandId,
				effect: {
					kind: "start",
					runId: "R2",
					inputId: "input:0",
					mode: "resume",
				},
			}) as const;
		const fake = new FakeProvider("claude");
		started(fake);
		fake.observe(frame("host-0:1", "turn_started", "e1"), emptyView());
		reattached(fake, "host-0:3");
		fake.assertStep(
			frame("host-0:1", "query_ended", "e2"),
			view({
				...run,
				tag: "Queued",
				deadline: { owner: "Stop", at: 500 },
			}),
			view({
				...run,
				tag: "Starting",
				deadline: { owner: "Stop", at: 900 },
			}),
			[start("c1")],
			[],
		);
		// A queued Run already Interrupting by run_now waits on the same fence (seed claude-82103203, long run).
		const interrupting = new FakeProvider("claude");
		started(interrupting);
		interrupting.observe(frame("host-0:1", "turn_started", "e1"), emptyView());
		reattached(interrupting, "host-0:3");
		const deadline = { owner: "Stop", at: 400 } as const;
		interrupting.assertStep(
			frame("host-0:1", "query_ended", "e2"),
			view({ ...run, tag: "Interrupting", by: "run_now", deadline }),
			view({
				...run,
				tag: "Interrupting",
				by: "run_now",
				deadline,
				inputs: [{ inputId: "input:0", state: { tag: "Dispatching" } }],
			}),
			[start("c2")],
			[],
		);
		const ending = new FakeProvider("claude");
		started(ending);
		ending.observe(frame("host-0:1", "turn_started", "e1"), emptyView());
		reattached(ending, "host-0:3");
		expect(() =>
			ending.assertStep(
				frame("host-0:1", "query_ended", "e2"),
				view({
					...run,
					tag: "Running",
					deadline: { owner: "Stop", at: 500 },
				}),
				{ ...emptyView(), anythingMayAct: true },
				[],
				[],
			),
		).toThrow(/LI7: older-label evidence changed Run authority or liveness/);
	});

	it("clears an older wake execution by its own Run end (8.3)", () => {
		const fake = new FakeProvider("claude");
		started(fake);
		fake.observe(frame("host-0:1", "turn_started", "e1"), emptyView());
		fake.observe(frame("host-0:2", "activity", "e2"), emptyView());
		fake.observe(frame("host-0:1", "result", "e3"), emptyView());
		expect(fake.groundTruth().runningTurn).toBe(false);
	});

	it.each([
		"cursor",
		"opencode",
	] as const)("requires %s task evidence to be Rejected (3.4, 8.1)", (provider) => {
		const fake = new FakeProvider(provider);
		expect(() =>
			fake.assertVerdict(
				{
					verb: "observe",
					observation: {
						tag: "Unsolicited",
						label: "host-0:1",
						eventId: "e1",
						kind: "tasks_snapshot",
						tasks: [],
					},
				},
				"Accepted",
			),
		).toThrow(/3\.4: task evidence from Cursor or OpenCode is not Rejected/);
	});

	it.each([
		"codex",
		"cursor",
		"opencode",
	] as const)("requires %s command_lifecycle to be Rejected, Answer or Unsolicited, known token or not (D46, 3.4)", (provider) => {
		const fake = new FakeProvider(provider);
		const lifecycle = {
			kind: "command_lifecycle",
			commandId: "c1",
			state: "cancelled",
		} as const;
		for (const observation of [
			{ tag: "Unsolicited", label: "host-0:1", eventId: "e1", ...lifecycle },
			{ tag: "Answer", token: token("never-issued"), ...lifecycle },
		] as const)
			expect(() =>
				fake.assertVerdict({ verb: "observe", observation }, "Accepted"),
			).toThrow(
				/D46: command_lifecycle from a provider but Claude is not Rejected/,
			);
		expect(() =>
			new FakeProvider("claude").assertVerdict(
				{
					verb: "observe",
					observation: {
						tag: "Unsolicited",
						label: "host-0:1",
						eventId: "e1",
						...lifecycle,
					},
				},
				"Accepted",
			),
		).not.toThrow();
	});
});

describe("fake provider round 11: joined executions (D47)", () => {
	const startA: IssuedEffect = {
		tag: "Tokened",
		token: token("start:A"),
		effect: { kind: "start", runId: "R", inputId: "A", mode: "resume" },
	};
	const starting: LedgerView = {
		...emptyView(),
		anythingMayAct: true,
		active: {
			runId: "R",
			origin: "input",
			tag: "Running",
			inputs: [],
			deadline: { owner: "Stop", at: 500 },
		},
	};
	let event = 0;
	const background = (
		fake: FakeProvider,
		evidence: Evidence,
		before = emptyView(),
	): void =>
		fake.observe(
			{
				verb: "observe",
				observation: {
					tag: "Unsolicited",
					label: "host-0:1",
					eventId: `d47-${event++}`,
					...evidence,
				} as Observation,
			},
			before,
		);
	const joinedThenDeclined = (provider: ProviderKind): FakeProvider => {
		const fake = new FakeProvider(provider);
		started(fake, "host-0:1", [startA]);
		fake.issued([startA]);
		background(fake, { kind: "turn_started" }, starting);
		answer(fake, startA, { kind: "input_declined", reason: "busy" });
		expect(fake.groundTruth().runningTurn).toBe(true);
		return fake;
	};

	it.each([
		["claude", "result"],
		["codex", "result"],
		["cursor", "result"],
		["opencode", "query_ended"],
	] as const)("keeps a %s turn joined to a declined start running until that label's %s (D47, 8.3)", (provider, kind) => {
		const fake = joinedThenDeclined(provider);
		background(
			fake,
			kind === "result" ? { kind, outcome: "completed" } : { kind },
		);
		expect(fake.groundTruth().runningTurn).toBe(false);
	});

	it("ends a joined turn at its runner's retirement (D47, L1)", () => {
		const fake = joinedThenDeclined("claude");
		fake.observe(
			{
				verb: "settle",
				settlement: { kind: "process_lost", runnerId: "host-0", retiredAt: 0 },
			},
			emptyView(),
		);
		expect(fake.groundTruth().runningTurn).toBe(false);
	});

	it("ends a joined turn at its start's own Run-end answer under that label (D47, oracle round 10)", () => {
		const fake = new FakeProvider("codex");
		started(fake, "host-0:1", [startA]);
		fake.issued([startA]);
		background(fake, { kind: "turn_started" }, starting);
		answer(fake, startA, { kind: "started" });
		answer(fake, startA, { kind: "result", outcome: "completed" });
		expect(fake.groundTruth().runningTurn).toBe(false);
	});

	it("clears every execution under a label with one Run-end evidence (D47, oracle round 10)", () => {
		const fake = joinedThenDeclined("claude");
		background(fake, { kind: "turn_started" });
		background(fake, { kind: "result", outcome: "completed" });
		expect(fake.groundTruth().runningTurn).toBe(false);
	});
});

describe("fake provider round 12: executions per (Run, label), as the oracle (D47)", () => {
	const label = "host-0:1";
	const start = (run: string, input: string): IssuedEffect => ({
		tag: "Tokened",
		token: token(`start:${input}`),
		effect: { kind: "start", runId: run, inputId: input, mode: "resume" },
	});
	const running = (runId: string): LedgerView => ({
		...emptyView(),
		anythingMayAct: true,
		active: {
			runId,
			origin: "input",
			tag: "Running",
			inputs: [],
			deadline: { owner: "Stop", at: 500 },
		},
	});
	let event = 0;
	const background = (
		fake: FakeProvider,
		evidence: Evidence,
		view = emptyView(),
	): void =>
		fake.observe(
			{
				verb: "observe",
				observation: {
					tag: "Unsolicited",
					label,
					eventId: `r12-${event++}`,
					...evidence,
				} as Observation,
			},
			view,
			view,
		);
	/** Run R's start is declined under a joined turn, so execution (R, label) stays live (D47). */
	const declinedUnderJoinedTurn = (provider: ProviderKind): FakeProvider => {
		const fake = new FakeProvider(provider);
		started(fake, label, [start("R", "A")]);
		const [first] = fake.issued([start("R", "A")]);
		assert(first);
		background(fake, { kind: "turn_started" }, running("R"));
		answer(fake, first, { kind: "input_declined", reason: "busy" });
		expect(fake.groundTruth().runningTurn).toBe(true);
		return fake;
	};

	it.each([
		["claude", "result"],
		["codex", "result"],
		["cursor", "result"],
		["opencode", "query_ended"],
	] as const)("a %s start's own Run-end answer (%s) clears only its Run's execution under the label", (provider, kind) => {
		const fake = declinedUnderJoinedTurn(provider);
		const [second] = fake.issued([start("S", "B")]);
		assert(second);
		background(fake, { kind: "turn_started" }, running("S"));
		answer(fake, second, { kind: "input_accepted" });
		answer(
			fake,
			second,
			kind === "result" ? { kind, outcome: "completed" } : { kind },
		);
		// (R, label) has seen no Run-end evidence of its own: the oracle keeps it live.
		expect(fake.groundTruth().runningTurn).toBe(true);
		background(
			fake,
			kind === "result" ? { kind, outcome: "completed" } : { kind },
		);
		expect(fake.groundTruth().runningTurn).toBe(false);
	});

	it.each([
		"claude",
		"codex",
		"cursor",
	] as const)("a %s query_ended without a result leaves the joined execution live until its result (endExecution)", (provider) => {
		const fake = declinedUnderJoinedTurn(provider);
		background(fake, { kind: "query_ended" });
		expect(fake.groundTruth().runningTurn).toBe(true);
		background(fake, { kind: "result", outcome: "completed" });
		expect(fake.groundTruth().runningTurn).toBe(false);
	});

	it("an OpenCode idle probe clears only the executions armed before it was issued", () => {
		const fake = declinedUnderJoinedTurn("opencode");
		const [probe] = fake.issued([
			{
				tag: "Tokened",
				token: token("r12-idle"),
				effect: {
					kind: "probe",
					runId: "R",
					target: { tag: "native_session" },
				},
			},
		]);
		assert(probe);
		const [second] = fake.issued([start("S", "B")]);
		assert(second);
		background(fake, { kind: "turn_started" }, running("S"));
		answer(fake, probe, {
			kind: "probe_result",
			finding: { tag: "native_idle" },
		});
		expect(fake.groundTruth().runningTurn).toBe(true);
	});
});

// Round 13 (contract 199cadcd, D48): the ledger has no project state. The host's registry
// gate (H4, 3.11, 4.4) answers a send before any hold, spawn or adapter call.
describe("fake provider round 13: the H4 project gate (3.11, 4.4, D48)", () => {
	const snapshot = (issued: readonly IssuedEffect[] = []) => ({
		issued,
		view: emptyView(),
		now: 100,
	});
	/** Operation 9 with variant 0 delivers a queued gate answer before any notification. */
	const gateAnswer = (fake: FakeProvider): LedgerCommand =>
		fake.next({ ...action, operation: 9, variant: 0 }, snapshot()).command;
	const tokenedEffect = (
		effect: Send["effect"],
		value = `${effect.kind}:1`,
	): IssuedEffect =>
		({ tag: "Tokened", token: token(value), effect }) as IssuedEffect;
	const probe = tokenedEffect({
		kind: "probe",
		runId: "R",
		target: { tag: "native_session" },
	});
	const interrupt = tokenedEffect({
		kind: "interrupt",
		runId: "R",
		runIds: ["R"],
	});
	const nativeCommand = tokenedEffect({
		kind: "send_native_command",
		commandId: "command",
		text: "/clear",
	});
	const gatedHold = (commandId: string, outcome: GateOutcome) => ({
		verb: "settle",
		settlement: { kind: "unheld_outcome", runId: "R", commandId, outcome },
	});
	const gatedAnswer = (value: string, outcome: GateOutcome) => ({
		verb: "observe",
		observation: {
			tag: "Answer",
			token: value,
			kind: "effect_outcome",
			outcome,
		},
	});
	const notSent = { tag: "not_sent", retryAt: 100 } as const;
	const refused = { tag: "permanent", code: "project_inactive" } as const;

	it.each([
		["not_served", notSent],
		["removed", refused],
	] as const)("answers a Held start %s before any hold, with no transmission (H4, 4.4)", (gate, outcome) => {
		const fake = new FakeProvider("claude");
		started(fake);
		fake.setGate(gate);
		const start = held("start");
		fake.issued([start]);
		expect(fake.bindingsFor("start")).toEqual([]);
		expect(fake.pendingObservations()).toEqual([]);
		expect(gateAnswer(fake)).toEqual(gatedHold("start", outcome));
	});

	it.each([
		["probe", probe],
		["interrupt", interrupt],
		["native command", nativeCommand],
	] as const)("answers a %s not_sent before any adapter call and keeps it unfinished nowhere (H4, 4.4, 8.5)", (_, effect) => {
		const fake = new FakeProvider("claude");
		started(fake);
		fake.setGate("not_served");
		const [send] = fake.issued([effect]);
		assert(send);
		expect(gateAnswer(fake)).toEqual(gatedAnswer(send.token, notSent));
		expect(fake.groundTruth().unfinished).toEqual([]);
		expect(fake.groundTruth().queuedCommands).toEqual([]);
	});

	it("never refuses a send already transmitted (H4)", () => {
		const fake = new FakeProvider("claude");
		started(fake);
		const [send] = fake.issued([held("start"), probe]);
		assert(send);
		fake.setGate("removed");
		expect(fake.bindingsFor("start")).toHaveLength(1);
		const delivered = fake.pendingObservations();
		expect(delivered).toHaveLength(1);
		// 3.13 has no resume control: with nothing to deliver, time passes.
		expect(gateAnswer(fake)).toEqual({
			verb: "settle",
			settlement: { kind: "alarm_fired" },
		});
	});

	it("gates an untransmitted pending start without counting its transmission, then delivers its re-issue (H4, 4.8)", () => {
		const fake = new FakeProvider("claude");
		const start = held("start");
		fake.issued([start]);
		fake.setGate("not_served");
		expect(gateAnswer(fake)).toEqual(gatedHold("start", notSent));
		started(fake, "host-0:1", [start]);
		expect(fake.pendingObservations()).toEqual([]);
		fake.setGate("served");
		const retry = held("start");
		const [send] = fake.issued([retry]);
		assert(send);
		expect(fake.dispatch(send).transmission).toBe(1);
	});

	it.each([
		[0, refused],
		[7, notSent],
	] as const)("removal with variant %s emits process_lost for the session's runner, then gates later sends (H4, 6.3)", (variant, outcome) => {
		const fake = new FakeProvider("claude");
		started(fake);
		const [transmitted] = fake.issued([probe]);
		assert(transmitted);
		const removal = fake.next(
			{ ...action, operation: 8, variant },
			snapshot([probe]),
		).command;
		expect(removal).toEqual({
			verb: "settle",
			settlement: { kind: "process_lost", runnerId: "host-0", retiredAt: 100 },
		});
		fake.observe(removal, emptyView());
		const [steer] = fake.issued([held("steer")]);
		assert(steer);
		expect(gateAnswer(fake)).toEqual(gatedHold("steer", outcome));
		// 3.13 has no resume control: with nothing to deliver, time passes.
		expect(gateAnswer(fake)).toEqual({
			verb: "settle",
			settlement: { kind: "alarm_fired" },
		});
	});

	// Round 13's open generator gap: a daemon killed mid-removal after a config save restarts with the
	// project removed and the runner whose Stop never committed left alive (4.4, Q28).
	it("leaves a runner alive and silent under a removed gate after a mid-removal daemon death (4.4, Q28)", () => {
		const fake = new FakeProvider("claude");
		started(fake);
		const [transmitted] = fake.issued([probe]);
		assert(transmitted);
		const removal = fake.next(
			{ ...action, operation: 8, variant: 42 },
			snapshot([probe]),
		).command;
		expect(removal).toEqual({
			verb: "settle",
			settlement: { kind: "alarm_fired" },
		});
		fake.observe(removal, emptyView());
		const [steer] = fake.issued([held("steer")]);
		assert(steer);
		expect(gateAnswer(fake)).toEqual(gatedHold("steer", refused));
		for (const operation of [26, 7])
			expect(
				fake.next({ ...action, operation, selection: 0 }, snapshot()).command,
			).toEqual({
				verb: "settle",
				settlement: { kind: "alarm_fired" },
			});
	});
	it("gives no OpenCode evidence while removed (H4)", () => {
		const fake = new FakeProvider("opencode");
		started(fake);
		fake.setGate("removed");
		expect(fake.next({ ...action, operation: 26 }, snapshot()).command).toEqual(
			{ verb: "settle", settlement: { kind: "alarm_fired" } },
		);
	});

	it("restarts Registering with an adopted runner starting a turn of its own (H4, 6.1, 8.3)", () => {
		const fake = new FakeProvider("claude");
		started(fake);
		const restart = fake.next(
			{ ...action, operation: 8, variant: 4 },
			snapshot(),
		).command;
		expect(restart).toEqual({
			verb: "settle",
			settlement: {
				kind: "process_started",
				label: "host-0:2",
				reattached: true,
			},
		});
		fake.observe(restart, emptyView());
		expect(fake.pendingObservations()).toEqual([
			expect.objectContaining({
				tag: "Unsolicited",
				label: "host-0:2",
				kind: "turn_started",
			}),
		]);
		fake.issued([held("start")]);
		expect(gateAnswer(fake)).toEqual(gatedHold("start", notSent));
	});

	it.each([
		["not_served", "Queued", undefined],
		[
			"not_served",
			"Sent",
			/LI6: a native command whose latest try got not_sent is not Queued/,
		],
		["removed", "Failed", undefined],
		[
			"removed",
			"Sent",
			/LI6: refused native command is not Failed with the outcome's code/,
		],
	] as const)("checks a gated native command's view: %s showing %s (8.5, H4, D34, LI6)", (gate, tag, error) => {
		const fake = new FakeProvider("claude");
		started(fake);
		fake.setGate(gate);
		fake.issued([nativeCommand]);
		const answer = gateAnswer(fake);
		const view: LedgerView = {
			...emptyView(),
			nativeCommands: [
				tag === "Failed"
					? { commandId: "command", tag, code: "project_inactive" }
					: tag === "Sent"
						? {
								commandId: "command",
								tag,
								deadline: {
									owner: "NativeCommand",
									commandId: "command",
									at: 900,
								},
							}
						: { commandId: "command", tag },
			],
		};
		const step = () => fake.assertStep(answer, emptyView(), view, [], []);
		if (error) expect(step).toThrow(error);
		else expect(step).not.toThrow();
	});

	// Default run claude and opencode-82103301 (phase 2): its runner's process_lost covers a gated
	// native command before the gate answer arrives; a late answer for a covered send changes nothing
	// (3.4, 8.5), so the command stays Failed process_lost.
	it.each([
		["not_served", true],
		["removed", true],
		["not_served", false],
	] as const)("keeps a gated native command %s covered by process_lost before its answer: lost=%s (3.4, 8.5, LI6)", (gate, lost) => {
		const fake = new FakeProvider("claude");
		started(fake);
		fake.setGate(gate);
		fake.issued([nativeCommand]);
		if (lost)
			fake.observe(
				{
					verb: "settle",
					settlement: {
						kind: "process_lost",
						runnerId: "host-0",
						retiredAt: 0,
					},
				},
				emptyView(),
			);
		const answer = gateAnswer(fake);
		const view: LedgerView = {
			...emptyView(),
			nativeCommands: [
				{ commandId: "command", tag: "Failed", code: "process_lost" },
			],
		};
		const step = () => fake.assertStep(answer, emptyView(), view, [], []);
		if (lost) expect(step).not.toThrow();
		else expect(step).toThrow(/LI6/);
	});

	// Round 13 d3 opencode-82103301: a gated native command waiting for a process is addressed to the
	// process that starts next (4.4, 6.1); that runner's process_lost covers it, so a late answer changes
	// nothing (3.4, 8.5).
	it.each([
		true,
		false,
	])("keeps a gated native command addressed to the next process covered by its loss: lost=%s (3.4, 8.5, LI6)", (wasLost) => {
		const fake = new FakeProvider("opencode");
		started(fake, "opencode:a1:0");
		lost(fake, "opencode:a1");
		fake.setGate("not_served");
		fake.issued([nativeCommand]);
		reattached(fake, "opencode:b2:0");
		if (wasLost) lost(fake, "opencode:b2");
		const answer = gateAnswer(fake);
		const view: LedgerView = {
			...emptyView(),
			nativeCommands: [
				{ commandId: "command", tag: "Failed", code: "process_lost" },
			],
		};
		const step = () => fake.assertStep(answer, emptyView(), view, [], []);
		if (wasLost) expect(step).not.toThrow();
		else expect(step).toThrow(/LI6/);
	});
	it("exempts from LI8 a stop_task whose task is gone, not one whose task is live (3.4, 3.5)", () => {
		const task = {
			key: { taskId: "t" },
			taskType: "local_bash",
			description: "t",
			ambient: false,
		};
		const tasks = (fake: FakeProvider, list: readonly (typeof task)[]) =>
			fake.observe(
				{
					verb: "observe",
					observation: {
						tag: "Unsolicited",
						label: fake.label,
						eventId: `tasks:${list.length}`,
						kind: "tasks_snapshot",
						tasks: list,
					},
				},
				emptyView(),
			);
		const stop = tokenedEffect({ kind: "stop_task", key: task.key });
		const alarm: LedgerCommand = {
			verb: "settle",
			settlement: { kind: "alarm_fired" },
		};
		const gone = new FakeProvider("claude");
		started(gone);
		tasks(gone, [task]);
		gone.issued([stop]);
		tasks(gone, []);
		expect(() =>
			gone.assertStep(alarm, emptyView(), emptyView(), [], []),
		).not.toThrow();
		const live = new FakeProvider("claude");
		started(live);
		tasks(live, [task]);
		live.issued([stop]);
		expect(() =>
			live.assertStep(alarm, emptyView(), emptyView(), [], []),
		).toThrow(/LI8/);
	});
	// Host facts, seed 82103302 after the round 13 generator shift: a hold covered at issue (its start
	// went to a runner since lost, L2 case 2) is never transmitted, so no run_dispatched names it (H3).
	it("reports no run_dispatched for a hold covered at issue (L2 case 2, H3)", () => {
		const fake = new FakeProvider("claude");
		started(fake);
		const start = held("start");
		fake.issued([start]);
		fake.pendingObservations();
		fake.observe(
			{
				verb: "settle",
				settlement: { kind: "process_lost", runnerId: "host-0", retiredAt: 0 },
			},
			emptyView(),
		);
		const steer = held("steer");
		const [send] = fake.issued([steer]);
		assert(send);
		const view = { ...emptyView(), live: [start, steer] };
		const generated = fake.next(
			{ ...action, operation: 3, selection: 0, index: 1, variant: 34 },
			{ issued: [start, steer], view, now: 101 },
		);
		expect(generated.command).not.toMatchObject({
			observation: { token: send.token, kind: "run_dispatched" },
		});
	});
	// Default run d2, cursor-82103302: a start sent on a label a reattach has since replaced runs and
	// ends on that label; the current query's turn flag follows only the current label (3.3, LI8).
	it.each([
		["a replaced label", true],
		["the current label", false],
	] as const)("ends a start's turn by its result on %s (3.3, LI8)", (_name, replaced) => {
		const fake = new FakeProvider("cursor");
		started(fake);
		const issue = held("start");
		fake.issued([issue]);
		const send = fake.bound(issue);
		if (replaced) reattached(fake, "host-0:2");
		answer(fake, send, { kind: "started" });
		expect(fake.groundTruth().runningTurn).toBe(!replaced);
		answer(fake, send, { kind: "result", outcome: "completed" });
		expect(fake.groundTruth().runningTurn).toBe(false);
	});
	// Default run d2, codex-82103302 and -82103303: a late result for an Ended Run's start that releases
	// the fence starts the Queued Run in the same decision; 12A forbids changes to the Ended Run only (3.8).
	it.each([
		["accepts the next Run's start", true],
		["still rejects any other change", false],
	] as const)("%s from late evidence that releases the fence (3.8, LI3)", (_name, launches) => {
		const fake = new FakeProvider("opencode");
		started(fake);
		const start: IssuedEffect = {
			tag: "Tokened",
			token: token("start:R"),
			effect: { kind: "start", runId: "R", inputId: "A", mode: "resume" },
		};
		fake.issued([start]);
		fake.assertStep(
			{ verb: "settle", settlement: { kind: "alarm_fired" } },
			{ ...emptyView(), anythingMayAct: true, live: [start] },
			{ ...emptyView(), anythingMayAct: true, live: [start] },
			[],
			[
				{
					runId: "R",
					// 3.13 has no start deadline: the stop alarm forces the end (3.8, L6).
					outcome: "interrupted",
					reason: { tag: "interrupted", forced: true },
				},
			],
		);
		const next: IssuedEffect = {
			tag: "Tokened",
			token: token("start:R2"),
			effect: { kind: "start", runId: "R2", inputId: "B", mode: "resume" },
		};
		const queuedRun = {
			runId: "R2",
			origin: "input",
			inputs: [{ inputId: "B", state: { tag: "Queued" } }],
			tag: "Queued",
			deadline: { owner: "Stop", at: 1601 },
		} as const;
		const before: LedgerView = {
			...emptyView(),
			anythingMayAct: true,
			live: [start],
			active: queuedRun,
		};
		const after: LedgerView = {
			...emptyView(),
			anythingMayAct: true,
			live: [next],
			active: launches
				? {
						...queuedRun,
						inputs: [{ inputId: "B", state: { tag: "Dispatching" } }],
						tag: "Starting",
						deadline: { owner: "Stop", at: 2101 },
					}
				: { ...queuedRun, deadline: { ...queuedRun.deadline, at: 2101 } },
		};
		const step = () =>
			fake.assertStep(
				{
					verb: "observe",
					observation: {
						tag: "Answer",
						token: token("start:R"),
						kind: "result",
						outcome: "completed",
					} as Observation,
				},
				before,
				after,
				launches ? [next] : [],
				[],
			);
		if (launches) expect(step).not.toThrow();
		else expect(step).toThrow(/LI3: late Ended lifecycle/);
	});
	// Default run d2, opencode-82103201: a native command waiting for a process was never transmitted,
	// so no adapter answers it; the gate answers it once the registry stops serving (H4, 4.4).
	it.each([
		["does not answer one waiting for a process", true],
		["answers one sent to a live process", false],
	] as const)("%s native command (H4, 4.4)", (_name, waiting) => {
		const fake = new FakeProvider("opencode");
		started(fake);
		if (waiting) lost(fake, "host-0");
		fake.issued([nativeCommand]);
		const generated = fake.next(
			{ ...action, operation: 3, selection: 0, variant: 2 },
			{
				issued: [nativeCommand],
				view: { ...emptyView(), live: [nativeCommand] },
				now: 100,
			},
		).command;
		const answered =
			generated.verb === "observe" &&
			generated.observation.tag === "Answer" &&
			nativeCommand.tag === "Tokened" &&
			generated.observation.token === nativeCommand.token;
		expect(answered).toBe(!waiting);
	});
});

describe("fake provider round 14: D49, D50 and a stop commit's releases (3.6, 3.13, 4.5)", () => {
	const starting: LedgerView = {
		...emptyView(),
		anythingMayAct: true,
		active: {
			runId: "R",
			inputs: [],
			origin: "input",
			tag: "Starting",
			deadline: { owner: "Stop", at: 100 },
		},
	};
	const loss = {
		verb: "settle",
		settlement: { kind: "process_lost", runnerId: "host-0", retiredAt: 0 },
	} as const;
	it("reads a pending run.dispatched before its runner's stop commit, then releases the hold (4.5, 3.13)", () => {
		const fake = new FakeProvider("claude");
		started(fake);
		const start = held("start");
		const [send] = fake.issued([start]);
		assert(send);
		const snapshot = {
			issued: [start],
			view: { ...emptyView(), live: [start] },
			now: 1,
		};
		const lossAction = { ...action, operation: 7, selection: 0, variant: 1 };
		expect(fake.next(lossAction, snapshot).command).toMatchObject({
			verb: "observe",
			observation: { token: send.token, kind: "run_dispatched" },
		});
		// No interrupt and no kill: the runner refused it while exiting (4.6), then its process_lost (3.13).
		expect(fake.next(lossAction, snapshot).command).toEqual({
			verb: "observe",
			observation: {
				tag: "Answer",
				token: send.token,
				kind: "run_released",
				reason: { tag: "Refused", why: "exiting" },
			},
		});
		expect(fake.next(lossAction, snapshot).command).toMatchObject({
			verb: "settle",
			settlement: { kind: "process_lost", runnerId: "host-0" },
		});
	});
	it.each([
		[
			false,
			[
				{
					runId: "R",
					outcome: "interrupted",
					reason: { tag: "process_lost" },
				},
			],
			/retirement ended not-yet-delivered R process_lost/,
		],
		[true, [], /retirement left reached R unended/],
	] as const)("unlaunches a not-yet-delivered Run at its runner's retirement and ends a reached one: reached=%s (3.6 D50)", (reached, ended, error) => {
		const fake = new FakeProvider("claude");
		started(fake);
		fake.issued([held("start")]);
		if (reached) readNotifications(fake);
		expect(() =>
			fake.assertStep(loss, starting, emptyView(), [], ended),
		).toThrow(error);
	});
	it("does not count an answer on a hold before its run.dispatched as reached, so retirement unlaunches it (3.4, 3.6 D50)", () => {
		const fake = new FakeProvider("claude");
		started(fake);
		const [send] = fake.issued([held("start")]);
		assert(send);
		fake.observe(
			{
				verb: "observe",
				observation: {
					tag: "Answer",
					token: token(send.token),
					kind: "started",
				},
			},
			emptyView(),
		);
		expect(() =>
			fake.assertStep(loss, starting, emptyView(), [], []),
		).not.toThrow();
	});
	it("drops a not-yet-delivered Run's execution at its runner's retirement, so its destruction is pending (3.6 D50, L2 case 3)", () => {
		const fake = new FakeProvider("claude");
		started(fake);
		fake.issued([held("start")]);
		lost(fake, "host-0");
		const close: IssuedEffect = {
			tag: "Tokened",
			token: token("close"),
			effect: { kind: "end_session", runId: "R", label: null },
		};
		expect(() =>
			fake.assertStep(
				{ verb: "settle", settlement: { kind: "alarm_fired" } },
				starting,
				starting,
				[close],
				[],
			),
		).not.toThrow();
	});
	it.each([
		"stop",
		"end",
	] as const)("ends a not-yet-delivered Run at once on %s (3.6 D50, 5.1)", (kind) => {
		const fake = new FakeProvider("claude");
		started(fake);
		fake.issued([held("start")]);
		const interrupt: IssuedEffect = {
			tag: "Tokened",
			token: token("interrupt"),
			effect: { kind: "interrupt", runId: "R", runIds: ["R"] },
		};
		const step = () =>
			fake.assertStep(
				{ verb: "control", control: { kind, deadlineAt: null } },
				starting,
				emptyView(),
				[interrupt],
				[],
			);
		// 3.6 names Stop and Run now; End is the oracle's pick (ambiguity 11), not checked here.
		if (kind === "stop")
			expect(step).toThrow(/Stop or Run now left not-yet-delivered R unended/);
		else expect(step).not.toThrow(/D50/);
	});
	it("counts a gated OpenCode start whose not_sent the ledger has not read as possibly reached (3.6)", () => {
		const fake = new FakeProvider("opencode");
		started(fake);
		fake.setGate("not_served");
		const start: IssuedEffect = {
			tag: "Tokened",
			token: token("start:R"),
			effect: { kind: "start", runId: "R", inputId: "A", mode: "resume" },
		};
		fake.issued([start]);
		expect(fake.reached("R")).toBe(true);
	});
	it("settles a start failing before holdRun by its queue key (4.4, D49)", () => {
		const fake = new FakeProvider("claude");
		started(fake);
		lost(fake, "host-0");
		const start = held("start");
		fake.issued([start]);
		const view = { ...emptyView(), live: [start] };
		expect(
			fake.next(
				{ ...action, operation: 12, variant: 14 },
				{ issued: [start], view, now: 1 },
			).command,
		).toEqual({
			verb: "settle",
			settlement: {
				kind: "unheld_outcome",
				runId: "R",
				commandId: "start",
				outcome: { tag: "retryable", retryAt: 2 },
			},
		});
	});
	it("releases NotSent what an adopted runner's hello reports not_received (Q28, 7.2)", () => {
		const fake = new FakeProvider("claude");
		started(fake);
		const start = held("start");
		const [send] = fake.issued([start]);
		assert(send);
		fake.pendingObservations();
		const view = { ...emptyView(), live: [start] };
		expect(
			fake.next(
				{ ...action, operation: 8, variant: 13 },
				{ issued: [start], view, now: 1 },
			).command,
		).toEqual({
			verb: "settle",
			settlement: {
				kind: "process_started",
				label: "host-0:1",
				reattached: true,
			},
		});
		expect(fake.q28).toBe("adopt");
		expect(fake.pendingObservations()).toEqual([
			{
				tag: "Answer",
				token: send.token,
				kind: "run_released",
				reason: "NotSent",
			},
		]);
	});
	it.each([
		[0, { kind: "run_released", reason: "ResumeRejected" }],
		[
			1,
			{
				kind: "effect_outcome",
				outcome: { tag: "permanent", code: "native_resume_rejected" },
			},
		],
	] as const)("answers a runner-held resume the provider rejected as released ResumeRejected: input %i (4.5, 4.11)", (input, evidence) => {
		const fake = new FakeProvider("claude");
		started(fake);
		const start = held("start");
		const [send] = fake.issued([start]);
		assert(send);
		fake.pendingObservations();
		const view = { ...emptyView(), live: [start] };
		expect(
			fake.next(
				{ ...action, operation: 3, selection: 0, variant: 14, input },
				{ issued: [start], view, now: 1 },
			).command,
		).toMatchObject({
			verb: "observe",
			observation: { token: send.token, ...evidence },
		});
	});
	// Default run round 14: no Answer-form ResumeRejected reached a Starting Run, because a generated hold is
	// transmitted by the re-step, not answered. A rejected resume fails at query start, so it follows run.dispatched.
	it.each([
		[6, [{ kind: "run_released", reason: "ResumeRejected" }]],
		[2, []],
	] as const)("releases a runner-held resume ResumeRejected right after the re-step's run.dispatched: variant %i (4.5, 4.11)", (variant, releases) => {
		const fake = new FakeProvider("claude");
		started(fake);
		const start = held("start");
		const snapshot = {
			issued: [start],
			view: { ...emptyView(), live: [start] },
			now: 1,
		};
		const command = fake.next(
			{ ...action, operation: 24, index: 0, variant },
			snapshot,
		).command;
		assert(command.verb === "observe" && command.observation.tag === "Answer");
		const { token } = command.observation;
		expect(command.observation.kind).toBe("run_dispatched");
		expect(
			fake.pendingObservations().filter((o) => o.kind === "run_released"),
		).toEqual(
			releases.map((release) => ({
				tag: "Answer",
				token,
				...release,
			})),
		);
	});
	it.each([
		[1, [{ kind: "run_released", reason: "ResumeRejected" }]],
		[2, []],
	] as const)("releases a runner-held resume ResumeRejected after the run.dispatched an answer reads first: input %i (4.5, 4.11)", (input, releases) => {
		const fake = new FakeProvider("claude");
		started(fake);
		const start = held("start");
		const [send] = fake.issued([start]);
		assert(send);
		const snapshot = {
			issued: [start],
			view: { ...emptyView(), live: [start] },
			now: 1,
		};
		expect(
			fake.next(
				{ ...action, operation: 3, selection: 0, variant: 3, input },
				snapshot,
			).command,
		).toMatchObject({
			verb: "observe",
			observation: { token: send.token, kind: "run_dispatched" },
		});
		expect(fake.pendingObservations()).toEqual(
			releases.map((release) => ({
				tag: "Answer",
				token: send.token,
				...release,
			})),
		);
	});
	// A delayed answer (operation 5) holds back the run.dispatched, so no release may overtake it (3.4).
	it("does not release a resume whose run.dispatched an answer delays (4.5, 3.4)", () => {
		const fake = new FakeProvider("claude");
		started(fake);
		const start = held("start");
		fake.issued([start]);
		const snapshot = {
			issued: [start],
			view: { ...emptyView(), live: [start] },
			now: 1,
		};
		fake.next(
			{ ...action, operation: 5, selection: 0, variant: 3, input: 1 },
			snapshot,
		);
		expect(fake.pendingObservations()).toEqual([]);
	});
	// Default run claude-82103200: a Held start's permanent outcome read before its run.dispatched is an
	// unknown token to the ledger (3.4), so the fake counted a Failed try the ledger never saw.
	it.each([
		3, 14, 1,
	])("reads a pending run.dispatched before any answer on its hold: variant %i (4.5, 3.4)", (variant) => {
		const fake = new FakeProvider("claude");
		started(fake);
		const start = held("start");
		const [send] = fake.issued([start]);
		assert(send);
		const view = { ...emptyView(), live: [start] };
		expect(
			fake.next(
				{ ...action, operation: 3, selection: 0, variant, input: 1 },
				{ issued: [start], view, now: 1 },
			).command,
		).toMatchObject({
			verb: "observe",
			observation: { token: send.token, kind: "run_dispatched" },
		});
	});
	it("names a Run that never issued the queue key in an unheld_outcome (D49)", () => {
		const fake = new FakeProvider("claude");
		started(fake);
		const start = held("start");
		fake.issued([start]);
		const view = { ...emptyView(), live: [start] };
		expect(
			fake.next(
				{ ...action, operation: 25, selection: 4, input: 3 },
				{ issued: [start], view, now: 1 },
			).command,
		).toMatchObject({
			verb: "settle",
			settlement: {
				kind: "unheld_outcome",
				runId: "never-issued-run:3",
				commandId: "start",
			},
		});
	});
	// Long run cursor-82103203: a steer's run.dispatched still unread when the ledger reissued its commandId as
	// a fresh Run's start. The hold is the run.dispatched event, so it follows that issue and binds to it (3.4,
	// 4.3): holdRun under the old key returns Ended and the feeder holds the latest issue.
	it("holds only the latest issue of a commandId whose earlier hold the ledger has not read (3.4, 4.3)", () => {
		const fake = new FakeProvider("claude");
		started(fake);
		fake.pendingObservations();
		fake.issued([held("steer", "C")]);
		const [send] = fake.issued([
			{
				tag: "Held",
				commandId: "C",
				effect: { kind: "start", runId: "R2", inputId: "C", mode: "resume" },
			},
		]);
		assert(send);
		expect(fake.pendingObservations()).toEqual([
			{
				tag: "Answer",
				token: send.token,
				kind: "run_dispatched",
				runId: "R2",
				runnerId: "host-0",
				commandId: "C",
				transmission: 1,
			},
		]);
	});
	// Long run claude-82103200: a second host of the trace read an unheld retryable start it did not answer
	// itself, so its Run's pending start and steer stayed pending, and the steer went to the next process; the
	// fake then expected the Run's close to name that process (LI5). Unlaunch drops the execution and returns
	// the steers as next messages, so the feeder holds none of its pending tries (3.6 D50, 4.4 H3).
	it("holds no pending try of a Run an unheld outcome unlaunched (3.6 D50, 4.4)", () => {
		const fake = new FakeProvider("claude");
		started(fake);
		lost(fake, "host-0");
		const start = held("start");
		const steer = held("steer");
		fake.issued([start, steer]);
		const view = { ...emptyView(), live: [start, steer] };
		const unheld = {
			verb: "settle",
			settlement: {
				kind: "unheld_outcome",
				runId: "R",
				commandId: "start",
				outcome: { tag: "retryable", retryAt: 2 },
			},
		} as const;
		fake.observe(unheld, view);
		fake.assertStep(unheld, view, emptyView(), [], []);
		// The ledger's view still lists the dropped steer as live; the feeder drops it, as holdRun returns Ended (H3).
		fake.observe(
			{
				verb: "settle",
				settlement: {
					kind: "process_started",
					label: "legacy-2",
					reattached: true,
				},
			},
			{ ...emptyView(), live: [steer] },
		);
		const exhausted = {
			verb: "settle",
			settlement: { kind: "hold_exhausted", commandId: "start" },
		} as const;
		const ledger = { ...emptyView(), anythingMayAct: true, live: [steer] };
		fake.observe(exhausted, ledger);
		fake.assertStep(
			exhausted,
			ledger,
			ledger,
			[],
			[
				{
					runId: "R",
					outcome: "error",
					reason: {
						tag: "provider_error",
						code: "provider_send_attempts_exhausted",
						retryable: false,
					},
				},
			],
		);
		lost(fake, "legacy-2");
		const alarm = {
			verb: "settle",
			settlement: { kind: "alarm_fired" },
		} as const;
		const close: IssuedEffect = {
			tag: "Tokened",
			token: token("close:R"),
			effect: { kind: "end_session", runId: "R", label: null },
		};
		expect(() =>
			fake.assertStep(
				alarm,
				emptyView(),
				{ ...emptyView(), anythingMayAct: true },
				[close],
				[],
			),
		).not.toThrow();
	});
	// Long run cursor-82103203: operation 5 delayed a held steer's pending run.dispatched past the issue that
	// reissued its commandId. The run.dispatched is a stream event read in order, never a delayed answer (4.5, 3.4).
	it("never delays a pending run.dispatched (4.5, 3.4)", () => {
		const fake = new FakeProvider("claude");
		started(fake);
		const steer = held("steer", "C");
		const [send] = fake.issued([steer]);
		assert(send);
		const snapshot = {
			issued: [steer],
			view: { ...emptyView(), live: [steer] },
			now: 1,
		};
		expect(
			fake.next(
				{ ...action, operation: 5, selection: 0, variant: 3, input: 1 },
				snapshot,
			).command,
		).toMatchObject({
			verb: "observe",
			observation: { token: send.token, kind: "run_dispatched" },
		});
	});
	// The same retirement by totality: another runner's process_started retires the current one (L1).
	it("keeps the relaunch of a not-yet-delivered Run whose runner another runner's start retires (L1, 3.6 D50)", () => {
		const fake = new FakeProvider("claude");
		started(fake);
		const start = held("start");
		fake.issued([start]);
		started(fake, "host-1:1", [start]);
		const relaunch = held("start");
		fake.issued([relaunch]);
		expect(fake.pendingObservations()).toMatchObject([
			{ kind: "run_dispatched", runnerId: "host-1", commandId: "start" },
		]);
	});
	// The harness binds an observe step's new issues before the step's effects reach the host, so the rule
	// above holds when the reissue is bound first too (3.4, 4.3).
	it("holds only the latest issue of a commandId when the reissue is bound before it is issued (3.4, 4.3)", () => {
		const fake = new FakeProvider("claude");
		started(fake);
		fake.pendingObservations();
		fake.issued([held("steer", "C")]);
		const start: IssuedEffect = {
			tag: "Held",
			commandId: "C",
			effect: { kind: "start", runId: "R2", inputId: "C", mode: "resume" },
		};
		const send = fake.bound(start);
		fake.issued([start]);
		expect(fake.pendingObservations()).toEqual([
			{
				tag: "Answer",
				token: send.token,
				kind: "run_dispatched",
				runId: "R2",
				runnerId: "host-0",
				commandId: "C",
				transmission: 1,
			},
		]);
	});
});
