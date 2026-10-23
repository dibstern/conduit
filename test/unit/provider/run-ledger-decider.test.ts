import { describe, expect, it } from "vitest";
import type { CanonicalEvent } from "../../../src/lib/contracts/stored-event.js";
import type { ProviderKind } from "../../../src/lib/provider/run-ledger/run-ledger-model.js";
import { classifyRunTerminal } from "../../../src/lib/provider/run-ledger/run-ledger-policy.js";
import {
	generatedOutcome,
	ledger,
	missing,
	token,
	variants,
} from "./run-ledger-scenarios.js";

describe("Adapter-declared Run end", () => {
	it.each([
		"query_ended",
		"process_lost",
	] as const)("HL-K audit: retained %s retires exactly the native work it proves ended", (kind) => {
		const l = ledger("opencode");
		const a = l.start();
		l.observe({ kind: "input_accepted", token: a.token });
		const b = l.admit("B").effects[0]?.token ?? missing;
		const d = l.admit("D").effects[0]?.token ?? missing;
		l.observe({ kind: "input_accepted", token: b });
		l.observe({ kind: "input_accepted", token: d });
		const interrupt = l.control({ kind: "run_now", inputId: "C" }).effects[0];
		l.observe({
			kind: "effect_outcome",
			token: interrupt?.token ?? missing,
			outcome: { tag: "succeeded" },
		});
		l.observe({ kind: "result", token: a.token, outcome: "completed" });
		l.observe({ kind: "query_ended", token: a.token });
		const reserved = l.state.active;
		expect(reserved?.tag).toBe("Queued");
		const ended =
			kind === "process_lost"
				? l.send({ verb: "settle", settlement: { kind, token: b } })
				: l.observe({ kind, token: b });
		expect(ended.ended).toEqual([]);
		expect(l.work.some(({ token }) => token === b)).toBe(false);
		if (kind === "query_ended") {
			expect(ended.effects).toEqual([]);
			expect(l.work.some(({ token }) => token === d)).toBe(true);
			expect(l.state.active).toEqual(reserved);
			l.observe({ kind: "query_ended", token: d });
		} else {
			expect(l.work.some(({ token }) => token === d)).toBe(false);
			expect(ended.effects.map(({ effect }) => effect)).toEqual([
				{ kind: "start", runId: reserved?.runId, inputId: "C" },
			]);
		}
		expect(l.state.active?.tag).toBe("Starting");
		expect(l.ended).toEqual([
			{ runId: a.runId, outcome: "completed", reason: { kind: "completed" } },
		]);
	});
	it.each([
		"before",
		"after",
	] as const)("HL-K audit: acceptance %s a retryable outcome preserves native work at Run end", (when) => {
		const l = ledger("opencode");
		const a = l.start();
		l.observe({ kind: "input_accepted", token: a.token });
		const steer = l.admit("B").effects[0]?.token ?? missing;
		if (when === "before") l.observe({ kind: "input_accepted", token: steer });
		l.observe({
			kind: "effect_outcome",
			token: steer,
			outcome: { tag: "retryable", retryAt: 110 },
		});
		if (when === "after") l.observe({ kind: "input_accepted", token: steer });
		const interrupt = l.control({ kind: "run_now", inputId: "C" }).effects[0];
		l.observe({
			kind: "effect_outcome",
			token: interrupt?.token ?? missing,
			outcome: { tag: "succeeded" },
		});
		l.observe({ kind: "result", token: a.token, outcome: "completed" });
		l.observe({ kind: "query_ended", token: a.token });
		expect(l.work.some(({ token }) => token === steer)).toBe(true);
		const reserved = l.state.active;
		const probe =
			l.work.find(
				({ effect }) =>
					effect.kind === "probe" && effect.target.tag === "native_session",
			)?.token ?? missing;
		expect(
			l.observe({
				kind: "probe_result",
				token: probe,
				finding: { tag: "native_idle" },
			}).effects,
		).toEqual([]);
		expect(l.state.active).toEqual(reserved);
		l.observe({
			kind: "effect_outcome",
			token: steer,
			outcome: { tag: "succeeded" },
		});
		const covered = l.observe({
			kind: "probe_result",
			token: probe,
			finding: { tag: "native_idle" },
		});
		expect(covered.effects.map(({ effect }) => effect)).toEqual([
			{ kind: "start", runId: reserved?.runId, inputId: "C" },
		]);
		expect(l.ended).toHaveLength(1);
	});
	it("HL-K round 2 P2: process loss releases a retained query before its cleanup deadline", () => {
		const l = ledger();
		const a = l.start();
		l.observe({ kind: "input_accepted", token: a.token });
		l.observe({ kind: "result", token: a.token, outcome: "completed" });
		l.admit("B");
		const reserved = l.state.active;
		expect(reserved?.tag).toBe("Queued");
		const lost = l.send({
			verb: "settle",
			settlement: { kind: "process_lost", token: a.token },
		});
		expect(lost.ended).toEqual([]);
		expect(lost.effects.map(({ effect }) => effect)).toEqual([
			{ kind: "start", runId: reserved?.runId, inputId: "B" },
		]);
		expect(l.work.some(({ token }) => token === a.token)).toBe(false);
		expect(l.ended).toEqual([
			{ runId: a.runId, outcome: "completed", reason: { kind: "completed" } },
		]);
		const duplicate = l.send({
			verb: "settle",
			settlement: { kind: "process_lost", token: a.token },
		});
		expect(duplicate.events).toEqual([]);
		expect(duplicate.effects).toEqual([]);
		expect(l.state.active?.tag).toBe("Starting");
	});
	it("HL-K round 2 P2: process loss preserves independent failed-kill quarantine", () => {
		const l = ledger();
		const a = l.start();
		l.observe({ kind: "input_accepted", token: a.token });
		l.observe({ kind: "result", token: a.token, outcome: "completed" });
		const close = l.fire().effects[0];
		const kill = l.observe({
			kind: "effect_outcome",
			token: close?.token ?? missing,
			outcome: { tag: "permanent", code: "close_failed" },
		}).effects[0];
		l.observe({
			kind: "effect_outcome",
			token: kill?.token ?? missing,
			outcome: { tag: "permanent", code: "kill_failed" },
		});
		l.admit("B");
		const reserved = l.state.active;
		const cleanup = l.work.filter(({ effect }) =>
			["kill_and_respawn", "quarantine", "probe"].includes(effect.kind),
		);
		expect(cleanup.map(({ effect }) => effect.kind)).toEqual([
			"kill_and_respawn",
			"quarantine",
			"probe",
			"probe",
		]);
		const alarmAt = l.alarmAt;
		const lost = l.send({
			verb: "settle",
			settlement: { kind: "process_lost", token: a.token },
		});
		expect(lost.ended).toEqual([]);
		expect(lost.effects).toEqual([]);
		expect(l.state.active).toEqual(reserved);
		expect(l.work).toEqual(cleanup);
		expect(lost.alarmAt).toBe(alarmAt);
		expect(l.ended).toHaveLength(1);
	});
	it.each([
		"before",
		"after",
	] as const)("HL-K round 2 P1: acceptance %s Run end survives a retained retryable outcome", (when) => {
		const l = ledger("opencode");
		const a = l.start();
		l.observe({ kind: "input_accepted", token: a.token });
		const steer = l.admit("B").effects[0]?.token ?? missing;
		const interrupt = l.control({ kind: "run_now", inputId: "C" }).effects[0];
		l.observe({
			kind: "effect_outcome",
			token: interrupt?.token ?? missing,
			outcome: { tag: "succeeded" },
		});
		if (when === "before") l.observe({ kind: "input_accepted", token: steer });
		l.observe({ kind: "result", token: a.token, outcome: "completed" });
		l.observe({ kind: "query_ended", token: a.token });
		if (when === "after") l.observe({ kind: "input_accepted", token: steer });
		const reserved = l.state.active;
		const retry = l.observe({
			kind: "effect_outcome",
			token: steer,
			outcome: { tag: "retryable", retryAt: 110 },
		});
		expect(retry.ended).toEqual([]);
		const probe =
			l.work.find(
				({ effect }) =>
					effect.kind === "probe" && effect.target.tag === "native_session",
			)?.token ?? missing;
		const idle = l.observe({
			kind: "probe_result",
			token: probe,
			finding: { tag: "native_idle" },
		});
		expect(idle.effects).toEqual([]);
		expect(l.state.active).toEqual(reserved);
		expect(l.work.some(({ token }) => token === steer)).toBe(true);
		l.observe({
			kind: "effect_outcome",
			token: steer,
			outcome: { tag: "succeeded" },
		});
		const covered = l.observe({
			kind: "probe_result",
			token: probe,
			finding: { tag: "native_idle" },
		});
		expect(covered.effects.map(({ effect }) => effect)).toEqual([
			{ kind: "start", runId: reserved?.runId, inputId: "C" },
		]);
		expect(l.ended).toEqual([
			{ runId: a.runId, outcome: "completed", reason: { kind: "completed" } },
		]);
	});
	it.each([
		"started",
		"activity",
	] as const)("HL-K review 3: late %s cannot downgrade a retained send's delivery proof", (kind) => {
		const l = ledger("opencode");
		const a = l.start();
		l.observe({ kind: "input_accepted", token: a.token });
		const steer = l.admit("B").effects[0]?.token ?? missing;
		l.observe({
			kind: "effect_outcome",
			token: steer,
			outcome: { tag: "delivery_unknown" },
		});
		const interrupt = l.control({ kind: "run_now", inputId: "C" }).effects[0];
		l.observe({
			kind: "effect_outcome",
			token: interrupt?.token ?? missing,
			outcome: { tag: "succeeded" },
		});
		l.observe({ kind: "result", token: a.token, outcome: "completed" });
		l.observe({ kind: "query_ended", token: a.token });
		l.observe({
			kind: "effect_outcome",
			token: steer,
			outcome: { tag: "succeeded" },
		});
		const reserved = l.state.active;
		const late = l.observe({ kind, token: steer });
		expect(late.ended).toEqual([]);
		expect(late.effects).toEqual([]);
		expect(l.state.active).toEqual(reserved);
		const probe = l.work.find(
			({ effect }) =>
				effect.kind === "probe" && effect.target.tag === "native_session",
		);
		const idle = l.observe({
			kind: "probe_result",
			token: probe?.token ?? missing,
			finding: { tag: "native_idle" },
		});
		expect(idle.effects.map(({ effect }) => effect)).toEqual([
			{ kind: "start", runId: reserved?.runId, inputId: "C" },
		]);
		expect(idle.ended).toEqual([]);
		expect(l.ended).toEqual([
			{ runId: a.runId, outcome: "completed", reason: { kind: "completed" } },
		]);
	});
	it.each([
		"before",
		"after",
	] as const)("HL-K review 4: retryable OpenCode work %s Run end can retire and release the fence", (when) => {
		const l = ledger("opencode");
		const a = l.start();
		l.observe({ kind: "input_accepted", token: a.token });
		const steer = l.admit("B").effects[0]?.token ?? missing;
		if (when === "before")
			l.observe({
				kind: "effect_outcome",
				token: steer,
				outcome: { tag: "retryable", retryAt: 110 },
			});
		l.control({ kind: "run_now", inputId: "C" });
		l.observe({ kind: "result", token: a.token, outcome: "completed" });
		l.observe({ kind: "query_ended", token: a.token });
		const reserved = l.state.active;
		if (when === "after") {
			const retry = l.observe({
				kind: "effect_outcome",
				token: steer,
				outcome: { tag: "retryable", retryAt: 110 },
			});
			expect(retry.ended).toEqual([]);
			expect(l.state.active).toEqual(reserved);
		}
		expect(l.work.some(({ token }) => token === steer)).toBe(false);
		const probe = l.work.find(
			({ effect }) =>
				effect.kind === "probe" && effect.target.tag === "native_session",
		);
		const idle = l.observe({
			kind: "probe_result",
			token: probe?.token ?? missing,
			finding: { tag: "native_idle" },
		});
		expect(idle.ended).toEqual([]);
		expect(idle.effects.map(({ effect }) => effect)).toEqual([
			{ kind: "start", runId: reserved?.runId, inputId: "C" },
		]);
		const c = l.inputToken("C");
		l.observe({ kind: "started", token: c });
		l.control({ kind: "cancel_input", inputId: "B" });
		l.observe({ kind: "result", token: c, outcome: "completed" });
		l.observe({ kind: "query_ended", token: c });
		expect(l.ended).toHaveLength(2);
		expect(l.state.active).toBeUndefined();
		expect(l.work).toEqual([]);
		expect(l.alarmAt).toBeUndefined();
	});
	it.each([
		"before",
		"after",
	] as const)("HL-K review 3: a retained OpenCode result %s execution end proves delivery for idle", (when) => {
		const l = ledger("opencode");
		const a = l.start();
		l.observe({ kind: "input_accepted", token: a.token });
		const steer = l.admit("B").effects[0]?.token ?? missing;
		l.observe({
			kind: "effect_outcome",
			token: steer,
			outcome: { tag: "delivery_unknown" },
		});
		const interrupt = l.control({ kind: "run_now", inputId: "C" }).effects[0];
		l.observe({
			kind: "effect_outcome",
			token: interrupt?.token ?? missing,
			outcome: { tag: "succeeded" },
		});
		if (when === "before")
			l.observe({ kind: "result", token: steer, outcome: "completed" });
		l.observe({ kind: "result", token: a.token, outcome: "completed" });
		const closed = l.observe({ kind: "query_ended", token: a.token });
		if (when === "before") {
			expect(closed.effects.map(({ effect }) => effect)).toEqual([
				{ kind: "start", runId: l.state.active?.runId, inputId: "C" },
			]);
			expect(l.ended).toEqual([
				{ runId: a.runId, outcome: "completed", reason: { kind: "completed" } },
			]);
			return;
		}
		expect(l.state.active?.tag).toBe("Queued");
		if (when === "after") {
			const alarmAt = l.alarmAt;
			const late = l.observe({
				kind: "result",
				token: steer,
				outcome: "error",
				error: { code: "LateFailure", retryable: false },
			});
			expect(late.ended).toEqual([]);
			expect(late.effects).toEqual([]);
			expect(late.alarmAt).toBe(alarmAt);
		}
		const probe = l.work.find(
			({ effect }) =>
				effect.kind === "probe" && effect.target.tag === "native_session",
		);
		const idle = l.observe({
			kind: "probe_result",
			token: probe?.token ?? missing,
			finding: { tag: "native_idle" },
		});
		expect(idle.ended).toEqual([]);
		expect(idle.effects.map(({ effect }) => effect)).toEqual([
			{ kind: "start", runId: l.state.active?.runId, inputId: "C" },
		]);
		expect(l.work.some(({ token }) => token === steer)).toBe(false);
		expect(l.ended).toEqual([
			{ runId: a.runId, outcome: "completed", reason: { kind: "completed" } },
		]);
	});
	it("HL-K review 2: retained failures cannot rehome a reserved admission or extend its fence", () => {
		const l = ledger("opencode");
		const a = l.start();
		l.observe({ kind: "input_accepted", token: a.token });
		const steer = l.admit("B").effects[0]?.token ?? missing;
		l.observe({
			kind: "effect_outcome",
			token: steer,
			outcome: { tag: "delivery_unknown" },
		});
		l.observe({ kind: "result", token: a.token, outcome: "completed" });
		l.observe({ kind: "query_ended", token: a.token });
		const reserved = l.state.active;
		expect(reserved).toMatchObject({
			tag: "Queued",
			deadline: { kind: "fence", at: 140 },
			inputs: [{ inputId: "B" }],
		});
		for (const now of [110, 130]) {
			l.ctx.now = now;
			const failed = l.observe({
				kind: "effect_outcome",
				token: steer,
				outcome: { tag: "permanent", code: "late_failure" },
			});
			expect(failed.ended).toEqual([]);
			expect(failed.effects).toEqual([]);
			expect(l.state.active).toEqual(reserved);
			expect(l.ended).toHaveLength(1);
			const alarm = l.fire();
			if (l.ctx.now < 140) {
				expect(alarm.ended).toEqual([]);
				expect(l.state.active).toEqual(reserved);
			} else {
				expect(l.ctx.now).toBe(140);
				expect(alarm.ended).toEqual([
					{
						runId: reserved?.runId,
						outcome: "error",
						reason: { kind: "fence_unconfirmed" },
					},
				]);
			}
		}
		const alarmAt = l.alarmAt;
		expect(alarmAt).toBe(160);
		for (const now of [150, 155]) {
			l.ctx.now = now;
			const duplicate = l.observe({
				kind: "effect_outcome",
				token: steer,
				outcome: { tag: "permanent", code: "late_failure" },
			});
			expect(duplicate.ended).toEqual([]);
			expect(duplicate.effects).toEqual([]);
			expect(duplicate.alarmAt).toBe(alarmAt);
			expect(l.state.active).toBeUndefined();
		}
		expect(l.ended).toHaveLength(2);
	});
	it("HL-K review 1: query end preserves failed-kill quarantine and its probes", () => {
		const l = ledger();
		const a = l.start();
		l.observe({ kind: "input_accepted", token: a.token });
		l.observe({ kind: "result", token: a.token, outcome: "completed" });
		const close = l.fire().effects[0];
		expect(close?.effect.kind).toBe("close");
		const kill = l.observe({
			kind: "effect_outcome",
			token: close?.token ?? missing,
			outcome: { tag: "permanent", code: "close_failed" },
		}).effects[0];
		expect(kill?.effect.kind).toBe("kill_and_respawn");
		l.observe({
			kind: "effect_outcome",
			token: kill?.token ?? missing,
			outcome: { tag: "permanent", code: "kill_failed" },
		});
		l.admit("B");
		const reserved = l.state.active;
		const cleanup = l.work.filter(({ effect }) =>
			["kill_and_respawn", "quarantine", "probe"].includes(effect.kind),
		);
		expect(cleanup.map(({ effect }) => effect.kind)).toEqual([
			"kill_and_respawn",
			"quarantine",
			"probe",
			"probe",
		]);
		const alarmAt = l.alarmAt;
		const ended = l.observe({ kind: "query_ended", token: a.token });
		expect(ended.ended).toEqual([]);
		expect(ended.effects).toEqual([]);
		expect(l.state.active).toEqual(reserved);
		expect(l.work).toEqual(cleanup);
		expect(ended.alarmAt).toBe(alarmAt);
		expect(l.ended).toHaveLength(1);
	});
	it.each([
		"transport_and_idle",
		"native_end",
	] as const)("OpenCode keeps an unrelated unknown HTTP steer fenced until %s", (release) => {
		const l = ledger("opencode");
		const a = l.start();
		l.observe({
			kind: "effect_outcome",
			token: a.token,
			outcome: { tag: "succeeded" },
		});
		l.observe({ kind: "input_accepted", token: a.token });
		const steer = l.admit("B").effects[0]?.token ?? missing;
		l.observe({
			kind: "effect_outcome",
			token: steer,
			outcome: { tag: "delivery_unknown" },
		});
		const stopped = l.control({ kind: "run_now", inputId: "C" });
		l.observe({
			kind: "effect_outcome",
			token: stopped.effects[0]?.token ?? missing,
			outcome: { tag: "succeeded" },
		});
		l.observe({ kind: "result", token: a.token, outcome: "completed" });
		const closed = l.observe({ kind: "query_ended", token: a.token });
		expect(closed.ended).toEqual([
			{ runId: a.runId, outcome: "completed", reason: { kind: "completed" } },
		]);
		expect(closed.effects.some(({ effect }) => effect.kind === "start")).toBe(
			false,
		);
		expect(l.state.active?.tag).toBe("Queued");
		const probe =
			l.work
				.filter(
					({ effect }) =>
						effect.kind === "probe" && effect.target.tag === "native_session",
				)
				.at(-1)?.token ?? missing;
		expect(
			l.observe({
				kind: "probe_result",
				token: probe,
				finding: { tag: "native_idle" },
			}).effects,
		).toEqual([]);
		expect(l.state.active?.tag).toBe("Queued");
		if (release === "native_end") {
			l.observe({ kind: "started", token: steer });
			const result = l.observe({
				kind: "result",
				token: steer,
				outcome: "error",
				error: { code: "LateFailure", retryable: false },
			});
			expect(result.ended).toEqual([]);
			expect(l.state.active?.tag).toBe("Queued");
			const ended = l.observe({ kind: "query_ended", token: steer });
			expect(ended.ended).toEqual([]);
			expect(ended.effects.map(({ effect }) => effect)).toEqual([
				{ kind: "start", runId: l.state.active?.runId, inputId: "C" },
			]);
			expect(l.ended).toHaveLength(1);
			return;
		}
		const delivered = l.observe({
			kind: "effect_outcome",
			token: steer,
			outcome: { tag: "succeeded" },
		});
		expect(delivered.effects).toEqual([]);
		const idle = l.observe({
			kind: "probe_result",
			token: probe,
			finding: { tag: "native_idle" },
		});
		expect(idle.ended).toEqual([]);
		expect(idle.effects.map(({ effect }) => effect)).toEqual([
			{ kind: "start", runId: l.state.active?.runId, inputId: "C" },
		]);
		expect(l.ended).toHaveLength(1);
	});
	it.each([
		"claude",
		"cursor",
		"opencode",
	] as const)("%s uses the same result boundary before intake, while running and during Stop", (provider) => {
		for (const phase of ["Starting", "Running", "Interrupting"]) {
			const l = ledger(provider);
			l.admit("A");
			const query = l.queryToken();
			const runId = l.state.active?.runId;
			if (phase !== "Starting") l.observe({ kind: "started", token: query });
			if (phase === "Interrupting") {
				const stopped = l.control({ kind: "stop" });
				l.observe({
					kind: "effect_outcome",
					token: stopped.effects[0]?.token ?? missing,
					outcome: { tag: "succeeded" },
				});
			}
			const result = l.observe({
				kind: "result",
				token: query,
				outcome: "interrupted",
			});
			if (provider === "opencode") {
				expect(result.ended, phase).toEqual([]);
				expect(l.state.active?.runId).toBe(runId);
				const closed = l.observe({ kind: "query_ended", token: query });
				expect(closed.ended).toMatchObject([{ runId, outcome: "interrupted" }]);
			} else {
				expect(result.ended, phase).toMatchObject([
					{ runId, outcome: "interrupted" },
				]);
				expect(l.state.active).toBeUndefined();
				expect(result.alarmAt).toBe(provider === "claude" ? 130 : undefined);
				expect(l.observe({ kind: "query_ended", token: query }).ended).toEqual(
					[],
				);
			}
			expect(l.alarmAt).toBeUndefined();
			expect(l.ended).toHaveLength(1);
		}
	});
	it("Claude keeps the next start fenced after its Run ends, until the query closes", () => {
		const l = ledger();
		const a = l.start();
		l.observe({ kind: "input_accepted", token: a.token });
		const result = l.observe({
			kind: "result",
			token: a.token,
			outcome: "completed",
		});
		expect(result.ended).toEqual([
			{ runId: a.runId, outcome: "completed", reason: { kind: "completed" } },
		]);
		const queued = l.admit("B");
		expect(queued.effects.map(({ effect }) => effect.kind)).toEqual(["probe"]);
		expect(l.state.active?.tag).toBe("Queued");
		const closed = l.observe({ kind: "query_ended", token: a.token });
		expect(closed.ended).toEqual([]);
		expect(closed.effects.map(({ effect }) => effect)).toEqual([
			{ kind: "start", runId: l.state.active?.runId, inputId: "B" },
		]);
		expect(closed.alarmAt).toBe(110);
	});
	it.each([
		"claude",
		"opencode",
	] as const)("%s keeps result outcome identical during Stop and natural completion", (provider) => {
		for (const stopping of [false, true]) {
			const l = ledger(provider);
			const a = l.start();
			if (stopping) l.control({ kind: "stop" });
			const result = l.observe({
				kind: "result",
				token: a.token,
				outcome: "error",
				error: { code: "ActualFailure", retryable: false },
			});
			const closed = l.observe({ kind: "query_ended", token: a.token });
			expect([...result.ended, ...closed.ended]).toEqual([
				{
					runId: a.runId,
					outcome: "error",
					reason: {
						kind: "provider_error",
						code: "ActualFailure",
						retryable: false,
					},
				},
			]);
			expect(provider === "claude" ? result.ended : closed.ended).toHaveLength(
				1,
			);
		}
	});
	it("Claude's fence owns its original deadline after the Tombstone and late receipts", () => {
		const l = ledger();
		const a = l.start();
		const result = l.observe({
			kind: "result",
			token: a.token,
			outcome: "completed",
		});
		expect(result.ended).toHaveLength(1);
		expect(result.alarmAt).toBe(130);
		l.ctx.now = 115;
		const receipt = l.observe({ kind: "input_accepted", token: a.token });
		expect(receipt.alarmAt).toBe(130);
		expect(l.state.active).toBeUndefined();
		const expired = l.fire();
		expect(expired.ended).toEqual([]);
		expect(expired.effects.map(({ effect }) => effect)).toEqual([
			{ kind: "close", runId: a.runId },
		]);
		expect(expired.alarmAt).toBe(150);
		const confirmed = l.observe({
			kind: "effect_outcome",
			token: expired.effects[0]?.token ?? missing,
			outcome: { tag: "succeeded" },
		});
		expect(confirmed.ended).toEqual([]);
		expect(confirmed.alarmAt).toBeUndefined();
		expect(l.ended).toHaveLength(1);
	});
});

describe("Obligation-owned deadlines", () => {
	it.each([
		[0, 1],
		[1, 0],
	])("concurrent native probes do not invalidate idle samples in order %j", (first, second) => {
		const l = ledger("opencode");
		l.admit("A");
		const lost = l.send({
			verb: "settle",
			settlement: { kind: "process_lost", token: l.queryToken() },
		});
		const queued = l.admit("B");
		const probes = [lost.effects[0], queued.effects[0]];
		expect(probes.map((send) => send?.effect)).toEqual([
			expect.objectContaining({
				kind: "probe",
				target: { tag: "native_session" },
			}),
			expect.objectContaining({
				kind: "probe",
				target: { tag: "native_session" },
			}),
		]);
		const starts = [];
		for (const index of [first, first, second, second]) {
			const idle = l.observe({
				kind: "probe_result",
				token: probes[index]?.token ?? missing,
				finding: { tag: "native_idle" },
			});
			expect(idle.effects.every(({ effect }) => effect.kind === "start")).toBe(
				true,
			);
			expect(idle.ended).toEqual([]);
			starts.push(...idle.effects);
		}
		expect(starts.map(({ effect }) => effect)).toEqual([
			expect.objectContaining({ kind: "start", inputId: "B" }),
		]);
		expect(l.state.active?.tag).toBe("Starting");
		expect(l.alarmAt).toBe(110);
	});
	it("an answered native probe leaves no retry behind a later read-only probe", () => {
		const l = ledger("opencode");
		l.admit("A");
		const lost = l.send({
			verb: "settle",
			settlement: { kind: "process_lost", token: l.queryToken() },
		});
		l.admit("B");
		const idle = l.observe({
			kind: "probe_result",
			token: lost.effects[0]?.token ?? missing,
			finding: { tag: "native_idle" },
		});
		expect(idle.effects.map(({ effect }) => effect)).toEqual([
			expect.objectContaining({ kind: "start", inputId: "B" }),
		]);
		l.observe({ kind: "started", token: l.inputToken("B") });
		l.ctx.now = 120;
		expect(
			l.send({ verb: "settle", settlement: { kind: "alarm_fired" } }),
		).toMatchObject({
			events: [],
			effects: [],
			ended: [],
			alarmAt: 200,
		});
	});
	it("concurrent native probe retries ignore stale tokens and release three queued waiters", () => {
		const l = ledger("opencode");
		l.admit("A");
		const lost = l.send({
			verb: "settle",
			settlement: { kind: "process_lost", token: l.queryToken() },
		});
		const queued = l.admit("B");
		l.admit("C");
		l.admit("D");
		const retried = l.fire();
		expect(retried.effects).toHaveLength(2);
		for (const probe of [lost.effects[0], queued.effects[0]]) {
			const stale = l.observe({
				kind: "probe_result",
				token: probe?.token ?? missing,
				finding: { tag: "native_idle" },
			});
			expect(stale).toMatchObject({
				events: [],
				effects: [],
				ended: [],
				alarmAt: 140,
			});
		}
		const starts = [];
		for (const probe of retried.effects) {
			const idle = l.observe({
				kind: "probe_result",
				token: probe.token,
				finding: { tag: "native_idle" },
			});
			expect(idle.effects.every(({ effect }) => effect.kind === "start")).toBe(
				true,
			);
			starts.push(...idle.effects);
		}
		expect(starts.map(({ effect }) => effect)).toEqual([
			expect.objectContaining({ kind: "start", inputId: "B" }),
		]);
		for (const inputId of ["B", "C", "D"]) {
			expect(l.state.active?.inputs[0]?.inputId).toBe(inputId);
			const query = l.inputToken(inputId);
			l.observe({ kind: "started", token: query });
			l.observe({ kind: "query_ended", token: query });
		}
		expect(l.state.active).toBeUndefined();
		expect(l.alarmAt).toBeUndefined();
		expect(l.ended).toHaveLength(4);
	});
	it.each([
		false,
		true,
	])("a declined input leaves its unanswered probe open, declined first=%s", (declinedFirst) => {
		const l = ledger();
		l.start();
		l.admit("B");
		const steer = l.inputToken("B");
		if (declinedFirst)
			l.observe({
				kind: "input_declined",
				token: steer,
				reason: "not_accepted",
			});
		const unknown = l.observe({
			kind: "effect_outcome",
			token: steer,
			outcome: { tag: "delivery_unknown" },
		});
		if (!declinedFirst)
			l.observe({
				kind: "input_declined",
				token: steer,
				reason: "not_accepted",
			});
		expect(l.alarmAt).toBe(120);
		const retry = l.fire();
		expect(retry.effects.map(({ effect }) => effect)).toEqual(
			unknown.effects.map(({ effect }) => effect),
		);
		expect(retry.effects[0]?.token).not.toBe(unknown.effects[0]?.token);
		expect(retry.alarmAt).toBe(140);
		expect(retry.ended).toEqual([]);
	});
	it.each([
		false,
		true,
	])("recalling again cannot revive a fulfilled input probe, retried=%s", (retried) => {
		const l = ledger();
		l.start();
		l.admit("B");
		const unknown = l.observe({
			kind: "effect_outcome",
			token: l.inputToken("B"),
			outcome: { tag: "delivery_unknown" },
		});
		const original = unknown.effects[0];
		l.control({ kind: "cancel_input", inputId: "B" });
		const current = retried ? l.fire().effects[0] : original;
		for (let answer = 0; answer < 2; answer++) {
			const absent = l.observe({
				kind: "probe_result",
				token: original?.token ?? missing,
				finding: { tag: "input_absent" },
			});
			expect(absent).toMatchObject({ effects: [], ended: [], alarmAt: 200 });
			const recalled = l.control({ kind: "cancel_input", inputId: "B" });
			expect(recalled).toMatchObject({ effects: [], ended: [], alarmAt: 200 });
		}
		for (const probe of [original, current]) {
			const late = l.observe({
				kind: "effect_outcome",
				token: probe?.token ?? missing,
				outcome: { tag: "retryable", retryAt: l.ctx.now + 1 },
			});
			expect(late).toMatchObject({
				events: [],
				effects: [],
				ended: [],
				alarmAt: 200,
			});
		}
		l.ctx.now = 160;
		expect(
			l.send({ verb: "settle", settlement: { kind: "alarm_fired" } }),
		).toMatchObject({
			events: [],
			effects: [],
			ended: [],
			alarmAt: 200,
		});
	});
	it("three uncertain steers keep independent probe fulfilment across cancellation and retries", () => {
		const l = ledger();
		l.start();
		const probes = ["B", "C", "D"].map((inputId) => {
			l.admit(inputId);
			const unknown = l.observe({
				kind: "effect_outcome",
				token: l.inputToken(inputId),
				outcome: { tag: "delivery_unknown" },
			});
			l.control({ kind: "cancel_input", inputId });
			return unknown.effects[0];
		});
		l.observe({
			kind: "probe_result",
			token: probes[0]?.token ?? missing,
			finding: { tag: "input_absent" },
		});
		const retry = l.fire();
		expect(retry.effects.map(({ effect }) => effect)).toEqual(
			probes.slice(1).map((probe) => probe?.effect),
		);
		l.control({ kind: "cancel_input", inputId: "B" });
		expect(l.alarmAt).toBe(140);
		for (const probe of probes.slice(1))
			l.observe({
				kind: "probe_result",
				token: probe?.token ?? missing,
				finding: { tag: "input_present" },
			});
		expect(l.alarmAt).toBe(200);
		for (const probe of retry.effects)
			expect(
				l.observe({
					kind: "effect_outcome",
					token: probe.token,
					outcome: { tag: "retryable", retryAt: 121 },
				}),
			).toMatchObject({ events: [], effects: [], ended: [], alarmAt: 200 });
	});
	it("recalling an uncertain steer preserves its unanswered input probe deadline", () => {
		const l = ledger();
		l.start();
		l.admit("B");
		const unknown = l.observe({
			kind: "effect_outcome",
			token: l.inputToken("B"),
			outcome: { tag: "delivery_unknown" },
		});
		const probe = unknown.effects[0];
		const alarmAt = unknown.alarmAt;
		expect(probe?.effect).toMatchObject({
			kind: "probe",
			target: { tag: "input", inputId: "B" },
		});
		expect(alarmAt).toBe(120);
		l.ctx.now = 105;
		const recalled = l.control({ kind: "cancel_input", inputId: "B" });
		expect(recalled).toMatchObject({ effects: [], ended: [], alarmAt });
		expect(l.state.active?.tag).toBe("Running");
		expect(l.input("B")?.uncertain).toBe(true);
		const retried = l.fire();
		expect(retried.ended).toEqual([]);
		expect(retried.effects.map(({ effect }) => effect)).toEqual([
			probe?.effect,
		]);
		expect(retried.effects[0]?.token).not.toBe(probe?.token);
		expect(retried.alarmAt).toBe(140);
		const fulfilled = l.observe({
			kind: "probe_result",
			token: retried.effects[0]?.token ?? missing,
			finding: { tag: "input_present", nativeMessageId: "native-B" },
		});
		expect(fulfilled).toMatchObject({ effects: [], ended: [], alarmAt: 200 });
		expect(l.input("B")).toMatchObject({
			state: { tag: "Accepted", cancelled: true },
			uncertain: false,
		});
	});
	it.each(
		variants.probeTargets,
	)("delivery_unknown preserves a %s probe's target and existing retry deadline", (target) => {
		const { l, probe } = preparedProbe(target);
		let current = probe;
		for (let retry = 0; retry < 2; retry++) {
			const alarmAt = l.alarmAt;
			l.ctx.now++;
			const unknown = l.observe({
				kind: "effect_outcome",
				token: current?.token ?? missing,
				outcome: { tag: "delivery_unknown" },
			});
			expect(unknown).toMatchObject({ effects: [], ended: [], alarmAt });
			if (retry === 0) {
				const fired = l.fire();
				expect(fired.effects.map(({ effect }) => effect)).toEqual([
					probe?.effect,
				]);
				current = fired.effects[0];
			}
		}
	});
	it.each(
		variants.probeTargets,
	)("every %s probe owns its retry from issue, including retries of retries", (target) => {
		const { l, probe, finding } = preparedProbe(target);
		expect(l.alarmAt).toBe(l.ctx.now + l.ctx.policy.closeMs);
		let current = probe;
		for (
			let retry = 0;
			retry < (target === "native_session" ? 1 : 2);
			retry++
		) {
			const fired = l.fire();
			expect(fired.effects.map(({ effect }) => effect)).toEqual([
				probe?.effect,
			]);
			expect(fired.effects[0]?.token).not.toBe(current?.token);
			current = fired.effects[0];
			expect(fired.alarmAt).toBe(l.ctx.now + l.ctx.policy.closeMs);
		}
		const answered = l.observe({
			kind: "probe_result",
			token: probe?.token ?? missing,
			finding,
		});
		if (target === "native_session") {
			// Retired lifecycle evidence cannot answer a newer native sample.
			expect(answered.events).toEqual([]);
			expect(answered.alarmAt).toBe(l.ctx.now + l.ctx.policy.closeMs);
			const fulfilled = l.observe({
				kind: "probe_result",
				token: current?.token ?? missing,
				finding,
			});
			expect(fulfilled.alarmAt).toBeUndefined();
		} else {
			expect(answered.alarmAt).toBe(200);
			l.ctx.now += l.ctx.policy.closeMs;
			expect(
				l.send({ verb: "settle", settlement: { kind: "alarm_fired" } }),
			).toMatchObject({ events: [], effects: [], ended: [], alarmAt: 200 });
		}
	});
	it("OpenCode process loss leaves a post-Tombstone native probe with a retry deadline", () => {
		const l = ledger("opencode");
		l.admit("A");
		const lost = l.send({
			verb: "settle",
			settlement: { kind: "process_lost", token: l.queryToken() },
		});
		expect(l.state.active).toBeUndefined();
		expect(lost.effects.map(({ effect }) => effect)).toEqual([
			{
				kind: "probe",
				runId: lost.ended[0]?.runId,
				target: { tag: "native_session" },
			},
		]);
		expect(lost.alarmAt).toBe(120);
		for (let retry = 0; retry < 2; retry++) {
			const fired = l.fire();
			expect(fired.effects.map(({ effect }) => effect)).toEqual(
				lost.effects.map(({ effect }) => effect),
			);
			expect(fired.alarmAt).toBe(l.ctx.now + l.ctx.policy.closeMs);
		}
	});
	it.each(
		variants.probeTargets,
	)("session end and project inactivity clear every %s probe deadline", (target) => {
		for (const settlement of [
			{ kind: "session_ended", cause: "native_session_vanished" },
			{ kind: "project_inactive" },
		] as const) {
			const { l } = preparedProbe(target);
			const ended = l.send({ verb: "settle", settlement });
			expect(ended.alarmAt).toBeUndefined();
			expect(l.state.live).toEqual([]);
			l.ctx.now += 1000;
			expect(
				l.send({ verb: "settle", settlement: { kind: "alarm_fired" } }),
			).toMatchObject({ events: [], effects: [], ended: [] });
			expect(l.alarmAt).toBeUndefined();
		}
	});
	it.each<ProviderKind>([
		"claude",
		"cursor",
		"opencode",
	])("%s: native idle discharges only cleanup covered by native policy", (provider) => {
		const l = ledger(provider);
		l.admit("A");
		l.control({ kind: "stop" });
		const expired = l.fire();
		const cleanup = expired.effects.find(({ effect }) =>
			["close", "cancel_request"].includes(effect.kind),
		);
		expect(cleanup).toBeDefined();
		const cleanupAt = l.ctx.now + l.ctx.policy.closeMs;
		const queued = l.control({ kind: "run_now", inputId: "B" });
		const probe = queued.effects.find(({ effect }) => effect.kind === "probe");
		const idle = l.observe({
			kind: "probe_result",
			token: probe?.token ?? missing,
			finding: { tag: "native_idle" },
		});
		if (provider === "opencode") {
			expect(idle.effects).toEqual([]);
			expect(l.state.live).toContainEqual(probe);
			expect(l.state.active?.tag).toBe("Queued");
			expect(l.state.live).toContainEqual(cleanup);
			expect(idle.alarmAt).toBe(cleanupAt);
			const cancelled = l.fire();
			expect(cancelled.effects.map(({ effect }) => effect.kind)).toEqual(
				expect.arrayContaining(["interrupt", "probe"]),
			);
			expect(l.state.active?.tag).toBe("Queued");
			const abortProbe = cancelled.effects.find(
				({ effect }) => effect.kind === "probe",
			);
			const stillHeld = l.observe({
				kind: "probe_result",
				token: abortProbe?.token ?? missing,
				finding: { tag: "native_idle" },
			});
			expect(
				stillHeld.effects.some(({ effect }) => effect.kind === "start"),
			).toBe(false);
			expect(stillHeld.alarmAt).toBe(l.ctx.now + l.ctx.policy.closeMs);
			expect(l.state.live.map(({ effect }) => effect.kind)).toContain(
				"interrupt",
			);
		} else {
			expect(idle.effects.map(({ effect }) => effect.kind)).toEqual(["start"]);
			expect(l.state.live.map(({ effect }) => effect.kind)).toEqual(["start"]);
			expect(idle.alarmAt).toBe(l.ctx.now + l.ctx.policy.startMs);
		}
	});
	it.each([
		false,
		true,
	])("OpenCode idle requires resolved request delivery, confirmed=%s", (confirmed) => {
		const l = ledger("opencode");
		const a = l.start();
		if (confirmed)
			l.observe({
				kind: "effect_outcome",
				token: a.token,
				outcome: { tag: "succeeded" },
			});
		const probe = l.fire().effects[0];
		const idle = l.observe({
			kind: "probe_result",
			token: probe?.token ?? missing,
			finding: { tag: "native_idle" },
		});
		if (confirmed) {
			expect(idle.ended).toHaveLength(1);
			expect(idle.alarmAt).toBeUndefined();
		} else {
			expect(idle.ended).toEqual([]);
			expect(l.state.live).toContainEqual(a.admitted.effects[0]);
			expect(idle.alarmAt).toBe(220);
		}
	});
	it.each([
		false,
		true,
	])("an interaction request preserves the Run deadline, started=%s", (started) => {
		const l = ledger();
		l.admit("A");
		const query = l.queryToken();
		if (started) l.observe({ kind: "started", token: query });
		const deadline = l.state.active?.deadline;
		l.ctx.now = 101;
		const requested = l.observe({
			kind: "interaction_requested",
			token: query,
			interactionId: "q",
			interactionKind: "question",
		});
		expect(l.state.active?.deadline).toEqual(deadline);
		expect(requested.alarmAt).toBe(deadline?.at);
	});
	it("input presence fulfills a newer probe retry as well as the answered probe", () => {
		const l = ledger("opencode");
		l.admit("A");
		const unknown = l.observe({
			kind: "effect_outcome",
			token: l.queryToken(),
			outcome: { tag: "delivery_unknown" },
		});
		const probe = unknown.effects[0]?.token ?? missing;
		l.observe({
			kind: "effect_outcome",
			token: probe,
			outcome: { tag: "retryable", retryAt: 105 },
		});
		const retried = l.fire().effects[0]?.token ?? missing;
		l.observe({
			kind: "effect_outcome",
			token: retried,
			outcome: { tag: "retryable", retryAt: 108 },
		});
		const fulfilled = l.observe({
			kind: "probe_result",
			token: probe,
			finding: { tag: "input_present", nativeMessageId: "native-A" },
		});
		expect(fulfilled.alarmAt).toBe(110);
		l.ctx.now = 108;
		expect(
			l.send({ verb: "settle", settlement: { kind: "alarm_fired" } }),
		).toMatchObject({ events: [], effects: [], ended: [], alarmAt: 110 });
	});
	it("zero-duration interaction retries fire each owner only once per alarm", () => {
		const l = ledger();
		const a = l.start();
		l.ctx.policy.closeMs = 0;
		for (const interactionId of ["q1", "q2"]) {
			l.observe({
				kind: "interaction_requested",
				token: a.token,
				interactionId,
				interactionKind: "question",
			});
			const answered = l.control({
				kind: "answer",
				interactionId,
				answer: "yes",
			});
			l.observe({
				kind: "effect_outcome",
				token: answered.effects[0]?.token ?? missing,
				outcome: { tag: "delivery_unknown" },
			});
		}
		const newId = l.ctx.newId;
		let issued = 0;
		l.ctx.newId = () => {
			expect(
				++issued,
				"an alarm must bound zero-duration retries",
			).toBeLessThan(10);
			return newId();
		};
		for (let alarm = 0; alarm < 2; alarm++) {
			const fired = l.send({
				verb: "settle",
				settlement: { kind: "alarm_fired" },
			});
			expect(fired.effects.map(({ effect }) => effect)).toEqual(
				["q1", "q2"].map((interactionId) => ({
					kind: "probe",
					runId: a.runId,
					target: { tag: "interaction", interactionId },
				})),
			);
			expect(fired.alarmAt).toBe(l.ctx.now);
		}
	});
	it("a zero-duration Run deadline cannot fire its owner twice in one alarm", () => {
		const l = ledger();
		l.ctx.policy.livenessMs = 0;
		l.ctx.policy.fenceMs = 0;
		l.start();
		const fired = l.fire();
		expect(fired.ended).toEqual([]);
		expect(fired.effects.map(({ effect }) => effect.kind)).toEqual(["probe"]);
		expect(fired.alarmAt).toBe(l.ctx.now);
		expect(l.state.active?.deadline).toEqual({ kind: "fence", at: l.ctx.now });
	});
	it("projects only the final start deadline on first admission", () => {
		const l = ledger();
		const admitted = l.admit("A");
		expect(admitted.effects.map(({ effect }) => effect.kind)).toEqual([
			"start",
		]);
		expect(admitted.alarmAt).toBe(110);
		expect(l.state.live).toEqual(admitted.effects);
	});
	it("a late alarm after its obligation finished does nothing", () => {
		const l = ledger();
		const a = l.start();
		l.observe({ kind: "query_ended", token: a.token });
		l.ctx.now = 1000;
		const before = l.state;
		const late = l.send({
			verb: "settle",
			settlement: { kind: "alarm_fired" },
		});
		expect(late).toMatchObject({ events: [], effects: [], ended: [] });
		expect(late.alarmAt).toBeUndefined();
		expect(l.state).toEqual(before);
	});
	it("an alarm before alarmAt does nothing and preserves the alarm", () => {
		const l = ledger();
		l.admit("A");
		l.ctx.now = 109;
		const early = l.send({
			verb: "settle",
			settlement: { kind: "alarm_fired" },
		});
		expect(early).toMatchObject({ events: [], effects: [], ended: [] });
		expect(early.alarmAt).toBe(110);
	});
	it.each([
		120, 125,
	])("fires both due permission deadlines in deadline order at %s", (laterAt) => {
		const l = ledger();
		const a = l.start();
		for (const [interactionId, timeoutAt] of [
			["second", laterAt],
			["first", 120],
		] as const) {
			l.observe({
				kind: "interaction_requested",
				token: a.token,
				interactionId,
				interactionKind: "permission",
				timeoutAt,
			});
		}
		l.ctx.now = laterAt;
		const fired = l.send({
			verb: "settle",
			settlement: { kind: "alarm_fired" },
		});
		expect(fired.effects.map(({ effect }) => effect)).toEqual(
			(laterAt === 120 ? ["second", "first"] : ["first", "second"]).map(
				(interactionId) => ({
					kind: "deliver_answer",
					runId: a.runId,
					interactionId,
					answer: { decision: "reject", reason: "timeout" },
				}),
			),
		);
		expect(fired.alarmAt).toBe(200);
	});
	it("alarmAt after every decision is the earliest open deadline", () => {
		const l = ledger();
		expect(l.admit("A").alarmAt).toBe(110);
		const query = l.queryToken();
		expect(l.observe({ kind: "started", token: query }).alarmAt).toBe(200);
		expect(
			l.observe({
				kind: "interaction_requested",
				token: query,
				interactionId: "p",
				interactionKind: "permission",
				timeoutAt: 150,
			}).alarmAt,
		).toBe(150);
		const answer = l.control({
			kind: "answer",
			interactionId: "p",
			answer: "yes",
		});
		expect(answer.alarmAt).toBe(200);
		const answerToken = answer.effects[0]?.token ?? missing;
		expect(
			l.observe({
				kind: "effect_outcome",
				token: answerToken,
				outcome: { tag: "retryable", retryAt: 120 },
			}).alarmAt,
		).toBe(120);
		expect(l.observe({ kind: "activity", token: missing }).alarmAt).toBe(120);
		l.ctx.now = 120;
		const retry = l.send({
			verb: "settle",
			settlement: { kind: "alarm_fired" },
		});
		expect(retry.alarmAt).toBe(200);
		expect(
			l.observe({
				kind: "effect_outcome",
				token: retry.effects[0]?.token ?? missing,
				outcome: { tag: "succeeded" },
			}).alarmAt,
		).toBe(200);
		const result = l.observe({
			kind: "result",
			token: query,
			outcome: "completed",
		});
		expect(result.alarmAt).toBe(150);
		expect(result.ended).toHaveLength(1);
		l.ctx.now = 150;
		const ended = l.send({
			verb: "settle",
			settlement: { kind: "alarm_fired" },
		});
		expect(ended.alarmAt).toBe(170);
		expect(ended.ended).toEqual([]);
		expect(
			l.observe({
				kind: "effect_outcome",
				token: ended.effects[0]?.token ?? missing,
				outcome: { tag: "succeeded" },
			}).alarmAt,
		).toBeUndefined();
		expect(
			l.send({ verb: "settle", settlement: { kind: "alarm_fired" } }).alarmAt,
		).toBeUndefined();
	});
	it("native idle removes the covered cleanup deadline before starting a successor", () => {
		const l = ledger();
		l.admit("A");
		expect(l.fire().alarmAt).toBe(130);
		const queued = l.control({ kind: "run_now", inputId: "B" });
		const probe = queued.effects.find(({ effect }) => effect.kind === "probe");
		l.ctx.now = 115;
		const idle = l.observe({
			kind: "probe_result",
			token: probe?.token ?? missing,
			finding: { tag: "native_idle" },
		});
		expect(idle.alarmAt).toBe(125);
		expect(l.state.live.map(({ effect }) => effect.kind)).toEqual(["start"]);
		l.observe({ kind: "started", token: l.queryToken() });
		l.ctx.now = 130;
		const late = l.send({
			verb: "settle",
			settlement: { kind: "alarm_fired" },
		});
		expect(late).toMatchObject({
			events: [],
			effects: [],
			ended: [],
			alarmAt: 215,
		});
	});
});

describe("Rebuild contract round-10 findings", () => {
	it("contract R10.1: a retained close from the old attempt cannot release the replacement fence", () => {
		const l = ledger();
		l.admit("A");
		const old = l.fire().effects.find(({ effect }) => effect.kind === "close");
		l.observe({
			kind: "effect_outcome",
			token: old?.token ?? missing,
			outcome: { tag: "retryable", retryAt: l.ctx.now + 1 },
		});
		l.ctx.now++;
		const retried = l.send({
			verb: "settle",
			settlement: {
				kind: "alarm_fired",
			},
		});
		const fresh = retried.effects.find(({ effect }) => effect.kind === "close");
		expect(fresh?.token).toBeDefined();
		expect(fresh?.token).not.toBe(old?.token);
		l.admit("B");
		const late = l.observe({
			kind: "effect_outcome",
			token: old?.token ?? missing,
			outcome: { tag: "succeeded" },
		});
		expect(late.effects).toEqual([]);
		expect(l.state.active?.tag).toBe("Queued");
		l.observe({
			kind: "effect_outcome",
			token: fresh?.token ?? missing,
			outcome: { tag: "succeeded" },
		});
		expect(l.state.active?.inputs[0]?.inputId).toBe("B");
	});
	it("contract R10.2: receipt after project removal cannot start the queued successor", () => {
		const l = ledger();
		const a = l.start();
		l.control({ kind: "run_now", inputId: "B" });
		l.send({ verb: "settle", settlement: { kind: "project_inactive" } });
		const receipt = l.observe({
			kind: "input_accepted",
			...a,
			token: l.inputToken("A", a.runId),
		});
		expect(receipt.effects.some(({ effect }) => effect.kind === "start")).toBe(
			false,
		);
		expect(l.state.active).toBeUndefined();
	});
	it("contract R10.3: old answer confirmation cannot replace a later ActualFailure", () => {
		const l = ledger("opencode");
		const a = l.start();
		l.observe({
			kind: "interaction_requested",
			...a,
			interactionId: "q",
			interactionKind: "question",
			token: l.queryToken(a.runId),
		});
		const answer = l.control({
			kind: "answer",
			interactionId: "q",
			answer: "yes",
		}).effects[0];
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "retryable", retryAt: 101 },
			token: answer?.token ?? missing,
		});
		l.observe({
			kind: "result",
			...a,
			outcome: "error",
			error: { code: "ActualFailure", retryable: false },
			token: l.queryToken(a.runId),
		});
		l.ctx.now = 101;
		l.send({
			verb: "settle",
			settlement: {
				kind: "alarm_fired",
			},
		});
		l.observe({
			kind: "interaction_resolved",
			...a,
			interactionId: "q",
			token: answer?.token ?? missing,
		});
		const ended = l.observe({
			kind: "query_ended",
			...a,
			token: l.queryToken(a.runId),
		});
		expect(ended.ended).toContainEqual(
			expect.objectContaining({
				outcome: "error",
				reason: {
					kind: "provider_error",
					code: "ActualFailure",
					retryable: false,
				},
			}),
		);
	});
	it("contract R10.4: project removal retires an interaction probe retry timer", () => {
		const { l, probe } = preparedProbe("interaction");
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "retryable", retryAt: 101 },
			token: probe?.token ?? missing,
		});
		l.send({ verb: "settle", settlement: { kind: "project_inactive" } });
		l.ctx.now = 101;
		const fired = l.send({
			verb: "settle",
			settlement: {
				kind: "alarm_fired",
			},
		});
		expect(fired.effects).toEqual([]);
	});
	it("contract R10.5: later answer receipt does not extend the result settlement deadline", () => {
		const l = ledger();
		const a = l.start();
		l.observe({
			kind: "interaction_requested",
			...a,
			interactionId: "q",
			interactionKind: "question",
			token: l.queryToken(a.runId),
		});
		const answer = l.control({
			kind: "answer",
			interactionId: "q",
			answer: "yes",
		}).effects[0];
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "retryable", retryAt: 105 },
			token: answer?.token ?? missing,
		});
		l.observe({
			kind: "result",
			...a,
			outcome: "completed",
			token: l.queryToken(a.runId),
		});
		const deadline = l.alarmAt;
		expect(deadline).toBe(130);
		l.ctx.now += 5;
		const expired = l.send({
			verb: "settle",
			settlement: {
				kind: "alarm_fired",
			},
		});
		expect(expired.effects).toEqual([]);
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: answer?.token ?? missing,
		});
		expect(l.alarmAt).toBe(deadline);
	});
});
function preparedProbe(target: "input" | "interaction" | "native_session") {
	const l = ledger();
	const a = l.start();
	if (target === "native_session") {
		const probe = l.fire().effects[0];
		expect(probe?.effect).toMatchObject({
			kind: "probe",
			target: { tag: target },
		});
		return {
			l,
			a,
			probe,
			finding: { tag: "native_idle" as const },
		};
	}
	if (target === "input") {
		const steer = l.admit("B").effects[0];
		const unknown = l.observe({
			kind: "effect_outcome",
			outcome: { tag: "delivery_unknown" },
			token: steer?.token ?? missing,
		});
		expect(unknown.effects[0]?.effect).toMatchObject({
			kind: "probe",
			target: { tag: target },
		});
		return {
			l,
			a,
			probe: unknown.effects[0],
			finding: {
				tag: "input_present" as const,
				nativeMessageId: "native-B",
			},
		};
	}
	l.observe({
		kind: "interaction_requested",
		...a,
		interactionId: "q",
		interactionKind: "question",
		token: l.queryToken(a.runId),
	});
	const answer = l.control({
		kind: "answer",
		interactionId: "q",
		answer: "yes",
	}).effects[0];
	const unknown = l.observe({
		kind: "effect_outcome",
		outcome: { tag: "delivery_unknown" },
		token: answer?.token ?? missing,
	});
	expect(unknown.effects[0]?.effect).toMatchObject({
		kind: "probe",
		target: { tag: target },
	});
	return {
		l,
		a,
		probe: unknown.effects[0],
		finding: { tag: "answer_consumed" as const },
	};
}
function questionWithAnswerInFlight() {
	const l = ledger("opencode");
	const a = l.start();
	l.observe({
		kind: "interaction_requested",
		interactionId: "q",
		interactionKind: "question",
		token: a.token,
	});
	const answer = l.control({
		kind: "answer",
		interactionId: "q",
		answer: "yes",
	}).effects[0];
	return { l, a, answer };
}
// Cases and source evidence: docs/plans/2026-10-22-run-ledger-failure-catalogue.md.
// RL-049, RL-050 and RL-107 are pure source-contract exceptions, not decide/evolve cases.
describe("Run Ledger decider regressions", () => {
	it("RL-003: Keep exact ownership on answer and continuation deadlines", () => {
		const l = ledger();
		const admitted = l.admit("A");
		expect(l.state.active).toMatchObject({
			tag: "Starting",
			deadline: { kind: "start", at: 110 },
		});
		const runId = l.state.active?.runId ?? missing;
		expect(admitted.effects[0]?.effect).toEqual({
			kind: "start",
			runId,
			inputId: "A",
		});
		const stale = l.send({
			verb: "settle",
			settlement: {
				kind: "alarm_fired",
			},
		});
		expect(stale).toMatchObject({
			tag: "Accepted",
			events: [],
			effects: [],
			ended: [],
			allEffects: [],
		});
		expect(l.state.active?.runId).toBe(runId);
	});
	it("RL-019: Own Claude iterator failures before intake", () => {
		const l = ledger();
		const start = l.admit("A").effects[0];
		const result = l.observe({
			kind: "effect_outcome",
			outcome: { tag: "permanent", code: "iterator_failed" },
			token: start?.token ?? missing,
		});
		expect(l.state.active).toBeUndefined();
		expect(result.ended).toContainEqual(
			expect.objectContaining({
				outcome: "error",
				reason: { kind: "refused", code: "iterator_failed" },
			}),
		);
	});
	it("RL-028: Keep delayed timeout controls from interrupting a successor", () => {
		const l = ledger();
		const a = l.start();
		l.observe({ kind: "query_ended", token: l.queryToken(a.runId) });
		const b = l.start("B");
		// The old liveness deadline passes before the successor's extended one.
		l.ctx.now = 150;
		l.observe({ kind: "activity", token: b.token });
		l.ctx.now = 200;
		expect(
			l.send({
				verb: "settle",
				settlement: {
					kind: "alarm_fired",
				},
			}).ended,
		).toEqual([]);
		expect(l.state.active?.runId).toBe(b.runId);
	});
	it("RL-034: Own exact Claude native results received before intake", () => {
		const l = ledger();
		l.admit("A");
		const runId = l.state.active?.runId ?? missing;
		const result = l.observe({
			kind: "result",
			outcome: "completed",
			token: l.queryToken(runId),
		});
		expect(result.alarmAt).toBe(130);
		expect(l.state.active).toBeUndefined();
		expect(result.ended).toContainEqual(
			expect.objectContaining({ runId, outcome: "completed" }),
		);
		const ended = l.observe({
			kind: "query_ended",
			token: l.queryToken(runId),
		});
		expect(ended.ended).toEqual([]);
		expect(ended.effects).toEqual([]);
		expect(l.ended.some((ended) => ended.runId === runId)).toBe(true);
		expect(
			l.observe({ kind: "started", token: l.queryToken(runId) }).ended,
		).toEqual([]);
	});
	it("RL-036: Settle usage-limit failover with an explicit session reason", () => {
		const l = ledger();
		l.start();
		const result = l.send({
			verb: "settle",
			settlement: { kind: "session_ended", cause: "usage_limit_failover" },
		});
		expect(result.ended).toContainEqual(
			expect.objectContaining({
				reason: { kind: "session_ended", cause: "usage_limit_failover" },
			}),
		);
		expect(l.state.active).toBeUndefined();
	});
	it.each([
		"claude",
		"cursor",
		"opencode",
	] as const)("G6: %s session end permits a later explicit fresh admission", (provider) => {
		const l = ledger(provider);
		const ended = l.send({
			verb: "settle",
			settlement: { kind: "session_ended", cause: "native_session_vanished" },
		});
		expect(ended.allEffects).toEqual([]);
		expect(l.state).toMatchObject({ paused: true, live: [] });
		const fresh = l.send({ verb: "admit", inputId: "B", runNow: true });
		expect(fresh.effects.map(({ effect }) => effect.kind)).toEqual(["start"]);
		expect(l.state.active).toMatchObject({
			tag: "Starting",
			inputs: [{ inputId: "B" }],
		});
	});
	it("G6: session end retires every send without draining queued Run now work", () => {
		const { l, probe } = preparedProbe("interaction");
		l.control({ kind: "run_now", inputId: "B" });
		expect(l.alarmAt).toBeDefined();
		const ended = l.send({
			verb: "settle",
			settlement: { kind: "session_ended", cause: "usage_limit_failover" },
		});
		expect(ended.ended).toHaveLength(1);
		expect(ended.allEffects).toEqual([]);
		expect(l.state.active).toBeUndefined();
		expect(l.state.live).toEqual([]);
		l.ctx.now += 100_000;
		expect(
			l.send({ verb: "settle", settlement: { kind: "alarm_fired" } }),
		).toMatchObject({ events: [], allEffects: [], ended: [] });
		expect(l.alarmAt).toBeUndefined();
		expect(
			l.observe({
				kind: "effect_outcome",
				token: probe?.token ?? missing,
				outcome: { tag: "retryable", retryAt: l.ctx.now + 1 },
			}),
		).toMatchObject({ events: [], allEffects: [], ended: [] });
		const fresh = l.control({ kind: "run_now", inputId: "B" });
		expect(fresh.effects.map(({ effect }) => effect.kind)).toEqual(["start"]);
		expect(l.state.active?.inputs[0]?.inputId).toBe("B");
	});
	it("G6: session end preserves an existing project-inactive admission gate", () => {
		const l = ledger();
		l.start();
		l.send({ verb: "settle", settlement: { kind: "project_inactive" } });
		l.send({
			verb: "settle",
			settlement: { kind: "session_ended", cause: "native_session_vanished" },
		});
		expect(
			l.send({ verb: "admit", inputId: "B", runNow: true }).allEffects,
		).toEqual([]);
		expect(l.state.active).toBeUndefined();
		expect(l.state.inbox[0]?.inputId).toBe("B");
	});
	it("RL-041: Stop returns only unaccepted steers to the front and preserves the pause", () => {
		const l = ledger();
		const a = l.start();
		l.admit("accepted");
		l.observe({
			kind: "input_accepted",
			...a,
			nativeMessageId: "native-accepted",
			token: l.inputToken("accepted", a.runId),
		});
		l.admit("uncertain");
		l.control({ kind: "stop" });
		l.admit("later");
		const stopped = l.observe({
			kind: "result",
			...a,
			outcome: "interrupted",
			token: l.queryToken(a.runId),
		});
		expect(stopped.ended).toContainEqual(
			expect.objectContaining({ outcome: "interrupted" }),
		);
		expect(l.state.inbox.map((input) => input.inputId)).toEqual([
			"uncertain",
			"later",
		]);
		expect(l.state.inbox[0]?.state).toEqual({
			tag: "Queued",
		});
		expect(l.state.paused).toBe(true);
		expect(stopped.effects).toEqual([]);
	});
	it("RL-056: A declined steer returns without pausing or ending its run", () => {
		const l = ledger("cursor");
		const a = l.start();
		const steer = l.admit("B");
		expect(steer.effects[0]?.effect).toMatchObject({
			kind: "steer",
			runId: a.runId,
			inputId: "B",
		});
		l.observe({
			kind: "input_declined",
			...a,
			reason: "not_steerable",
			token: l.inputToken("B", a.runId),
		});
		expect(l.state.active).toMatchObject({ tag: "Running", runId: a.runId });
		expect(l.state.paused).toBe(false);
		expect(l.state.inbox[0]).toMatchObject({
			inputId: "B",
			state: { tag: "Queued" },
			uncertain: false,
		});
	});
	it("RL-045: Run now joins Stop without resetting its bound and bypasses pause", () => {
		const l = ledger();
		const a = l.start();
		l.control({ kind: "stop" });
		const original = l.state.active?.deadline;
		l.control({ kind: "run_now", inputId: "B" });
		expect(l.state.active?.deadline).toEqual(original);
		l.observe({
			kind: "result",
			...a,
			outcome: "interrupted",
			token: l.queryToken(a.runId),
		});
		expect(l.state.active).toMatchObject({ tag: "Queued" });
		l.observe({ kind: "query_ended", token: l.queryToken(a.runId) });
		expect(l.state.active).toMatchObject({
			tag: "Starting",
			inputs: [{ inputId: "B" }],
		});
		expect(l.state.active?.runId).not.toBe(a.runId);
	});
	it.each([
		"RL-079",
		"RL-082",
	])("%s: Idle Stop creates no effect that could reach later input", () => {
		const l = ledger();
		const stop = l.control({ kind: "stop" });
		expect(stop.effects).toEqual([]);
		l.control({ kind: "run_now", inputId: "B" });
		expect(l.state.active?.tag).toBe("Starting");
		const before = l.state;
		expect(
			l.observe({
				kind: "effect_outcome",
				outcome: { tag: "succeeded" },
				token: token("empty-stop"),
			}).ended,
		).toEqual([]);
		expect(l.state).toEqual(before);
	});
	it.each([
		"RL-039",
		"RL-080",
		"RL-083",
		"RL-089",
		"RL-090",
	])("%s: A native query end releases obsolete scoped controls before the successor", () => {
		const l = ledger();
		const a = l.start();
		const interrupt = l.control({ kind: "stop" }).effects[0];
		l.control({ kind: "run_now", inputId: "B" });
		l.observe({ kind: "query_ended", ...a, token: l.queryToken(a.runId) });
		const successor = l.state.active?.runId;
		expect(l.state.active?.tag).toBe("Starting");
		expect(l.work.some((effect) => effect.token === interrupt?.token)).toBe(
			false,
		);
		expect(
			l.observe({
				kind: "effect_outcome",
				outcome: { tag: "succeeded" },
				token: interrupt?.token ?? missing,
			}).ended,
		).toEqual([]);
		expect(l.state.active?.runId).toBe(successor);
	});
	it.each([
		"RL-025",
		"RL-027",
		"RL-030",
	])("%s: Unknown steer delivery is probed while the active run and further admission survive", () => {
		const l = ledger();
		const a = l.start();
		const steer = l.admit("B").effects[0];
		const outcome = l.observe({
			kind: "effect_outcome",
			outcome: { tag: "delivery_unknown" },
			token: steer?.token ?? missing,
		});
		expect(l.state.active).toMatchObject({ tag: "Running", runId: a.runId });
		expect(
			l.state.active?.inputs.find((input) => input.inputId === "B")?.state,
		).toEqual({ tag: "Delivered", certainty: "unknown" });
		expect(outcome.effects.map((effect) => effect.effect.kind)).toEqual([
			"probe",
		]);
		l.admit("C");
		expect(l.state.active?.inputs.some((input) => input.inputId === "C")).toBe(
			true,
		);
		expect(l.state.active?.deadline).toBeDefined();
	});
	it("RL-010: An owned idle cannot accept an unresolved steer", () => {
		const l = ledger("opencode");
		const a = l.start();
		const steer = l.admit("B").effects[0];
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: steer?.token ?? missing,
		});
		l.control({ kind: "stop" });
		l.observe({ kind: "query_ended", ...a, token: l.queryToken(a.runId) });
		expect(l.state.inbox[0]).toMatchObject({
			inputId: "B",
			state: { tag: "Queued" },
			uncertain: true,
		});
		expect(l.state.active).toBeUndefined();
	});
	it("RL-021: Unknown start delivery retains a deadline after uncorrelated idle", () => {
		const l = ledger("opencode");
		const effect = l.admit("A").effects[0];
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "delivery_unknown" },
			token: effect?.token ?? missing,
		});
		const before = l.state;
		l.observe({ kind: "query_ended", token: l.queryToken("unrelated") });
		expect(l.state).toEqual(before);
		expect(l.state.active).toMatchObject({
			tag: "Starting",
			deadline: { kind: "start", at: 110 },
		});
	});
	it("RL-031: Unrelated input identity cannot consume acceptance, nor replace a bound native id", () => {
		const l = ledger("opencode");
		const a = l.start();
		l.observe({
			kind: "input_accepted",
			...a,
			nativeMessageId: "TUI",
			token: l.inputToken("external", a.runId),
		});
		expect(l.state.active?.inputs[0]?.state.tag).toBe("Queued");
		l.observe({
			kind: "input_accepted",
			...a,
			nativeMessageId: "exact",
			token: l.inputToken("A", a.runId),
		});
		const mismatch = l.inspect({
			verb: "observe",
			observation: {
				kind: "input_accepted",
				...a,
				nativeMessageId: "wrong",
				token: l.inputToken("A", a.runId),
			},
		});
		expect(mismatch.tag).toBe("Rejected");
		expect(l.state.active?.inputs[0]?.state).toEqual({
			tag: "Accepted",
			nativeMessageId: "exact",
		});
	});
	it("RL-033: Stop deadline tombstones the run and holds its successor until close resolves", () => {
		const l = ledger();
		const a = l.start();
		l.control({ kind: "run_now", inputId: "B" });
		const expired = l.fire();
		expect(expired.ended).toContainEqual(
			expect.objectContaining({
				runId: a.runId,
				reason: { kind: "interrupted", by: "run_now", forced: true },
			}),
		);
		const close = expired.effects.find((item) => item.effect.kind === "close");
		expect(close).toBeDefined();
		expect(l.state.active).toMatchObject({
			tag: "Queued",
			deadline: { kind: "fence" },
		});
		expect(expired.effects.some((item) => item.effect.kind === "start")).toBe(
			false,
		);
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: close?.token ?? missing,
		});
		expect(l.state.active).toMatchObject({
			tag: "Starting",
			inputs: [{ inputId: "B" }],
		});
		l.observe({
			kind: "input_accepted",
			...a,
			token: l.inputToken("B", a.runId),
		});
		expect(l.state.active?.inputs[0]?.state.tag).toBe("Queued");
	});
	it("Native-session fence requires resolved effects or an idle probe and fails closed", () => {
		const l = ledger("opencode");
		const a = l.start();
		l.control({ kind: "run_now", inputId: "B" });
		const ended = l.observe({
			kind: "query_ended",
			...a,
			token: l.queryToken(a.runId),
		});
		expect(l.state.active?.tag).toBe("Queued");
		const probe = ended.effects.find((item) => item.effect.kind === "probe");
		expect(probe?.effect).toMatchObject({ target: { tag: "native_session" } });
		l.observe({
			kind: "probe_result",
			finding: { tag: "native_busy" },
			token: probe?.token ?? missing,
		});
		l.ctx.now = l.state.active?.deadline.at ?? l.ctx.now;
		const expired = l.fire();
		expect(expired.ended).toContainEqual(
			expect.objectContaining({
				reason: { kind: "fence_unconfirmed" },
			}),
		);
		expect(expired.effects.some((item) => item.effect.kind === "start")).toBe(
			false,
		);
	});
	it("A matching native idle probe releases a held start", () => {
		const l = ledger("opencode");
		const a = l.start();
		l.observe({ kind: "input_accepted", token: a.token });
		l.observe({
			kind: "effect_outcome",
			token: a.token,
			outcome: { tag: "succeeded" },
		});
		l.control({ kind: "run_now", inputId: "B" });
		const ended = l.observe({
			kind: "query_ended",
			...a,
			token: l.queryToken(a.runId),
		});
		const probe = ended.effects
			.filter((item) => item.effect.kind === "probe")
			.at(-1);
		const released = l.observe({
			kind: "probe_result",
			finding: { tag: "native_idle" },
			token: probe?.token ?? missing,
		});
		expect(released.effects.map((item) => item.effect.kind)).toEqual(["start"]);
		expect(l.state.active?.tag).toBe("Starting");
	});
	it("Delivered unknown input is never resent even when a probe proves absence", () => {
		const l = ledger();
		const initial = l.admit("A").effects[0];
		const unknown = l.observe({
			kind: "effect_outcome",
			outcome: { tag: "delivery_unknown" },
			token: initial?.token ?? missing,
		});
		const absent = l.observe({
			kind: "probe_result",
			finding: { tag: "input_absent" },
			token: unknown.effects[0]?.token ?? missing,
		});
		expect(
			absent.effects.filter(
				(item) => item.effect.kind === "start" || item.effect.kind === "steer",
			),
		).toEqual([]);
		expect(l.state.active?.tag).toBe("Starting");
		expect(l.input("A")?.state).toEqual({
			tag: "Declined",
			reason: "input_absent",
		});
		expect(absent.ended).toEqual([]);
	});
	it("Running activity extends liveness, a stale timer is harmless, and liveness expiry probes", () => {
		const l = ledger();
		const a = l.start();
		l.ctx.now = 150;
		l.observe({ kind: "activity", ...a, token: l.queryToken(a.runId) });
		expect(l.state.active?.deadline).toEqual({ kind: "liveness", at: 250 });
		l.ctx.now = 200;
		expect(
			l.send({
				verb: "settle",
				settlement: {
					kind: "alarm_fired",
				},
			}).ended,
		).toEqual([]);
		const expired = l.fire();
		expect(expired.effects[0]?.effect).toMatchObject({
			kind: "probe",
			runId: a.runId,
			target: { tag: "native_session" },
		});
		expect(l.state.active).toMatchObject({
			tag: "Running",
			deadline: { kind: "fence", at: 290 },
		});
	});
	it.each([
		"answer_pending",
		"answer_consumed",
	] as const)("RL-072: permanent answer failure stays Pending until %s reconciliation", (finding) => {
		const { l, a, answer } = questionWithAnswerInFlight();
		l.observe({
			kind: "effect_outcome",
			token: answer?.token ?? missing,
			outcome: { tag: "retryable", retryAt: 101 },
		});
		expect(l.alarmAt).toBe(101);
		const deadline = l.state.active?.deadline;
		const failed = l.observe({
			kind: "effect_outcome",
			outcome: { tag: "permanent", code: "HTTP400" },
			token: answer?.token ?? missing,
		});
		expect(l.state.active?.interactions).toEqual([
			{ tag: "Pending", interactionId: "q", kind: "question" },
		]);
		expect(failed.ended).toEqual([]);
		expect(l.state.active?.deadline).toEqual(deadline);
		expect(failed.effects.map(({ effect }) => effect)).toEqual([
			{
				kind: "probe",
				runId: a.runId,
				target: { tag: "interaction", interactionId: "q" },
			},
		]);
		expect(l.state.live.some(({ token }) => token === answer?.token)).toBe(
			false,
		);
		l.ctx.now = 101;
		expect(
			l.send({
				verb: "settle",
				settlement: { kind: "alarm_fired" },
			}),
		).toMatchObject({ events: [], allEffects: [], ended: [] });
		const reconciled = l.observe({
			kind: "probe_result",
			token: failed.effects[0]?.token ?? missing,
			finding: { tag: finding },
		});
		expect(reconciled.allEffects).toEqual([]);
		const repair = l.control({
			kind: "answer",
			interactionId: "q",
			answer: "corrected",
		});
		expect(repair.effects.map(({ effect }) => effect.kind)).toEqual(
			finding === "answer_pending" ? ["deliver_answer"] : [],
		);
	});
	it.each([
		"stop",
		"end",
	] as const)("G7: permanent answer refusal does not block %s while reconciliation is pending", (kind) => {
		const { l, answer } = questionWithAnswerInFlight();
		const failed = l.observe({
			kind: "effect_outcome",
			token: answer?.token ?? missing,
			outcome: { tag: "permanent", code: "HTTP400" },
		});
		expect(l.state.active?.interactions[0]?.tag).toBe("Pending");
		expect(failed.effects[0]?.effect.kind).toBe("probe");
		const controlled = l.control({ kind });
		expect(controlled.effects.map(({ effect }) => effect.kind)).toEqual([
			kind === "end" ? "end_session" : "interrupt",
		]);
		expect(l.state.active).toMatchObject({ tag: "Interrupting", by: kind });
	});
	it("RL-075: Throttled answer retains its identity and retries only after persisted backoff", () => {
		const l = ledger("opencode");
		const a = l.start();
		l.observe({
			kind: "interaction_requested",
			...a,
			interactionId: "question",
			interactionKind: "question",
			token: l.queryToken(a.runId),
		});
		const answer = l.control({
			kind: "answer",
			interactionId: "question",
			answer: "42",
		}).effects[0];
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "retryable", retryAt: 150 },
			token: answer?.token ?? missing,
		});
		expect(
			l.send({
				verb: "settle",
				settlement: {
					kind: "alarm_fired",
				},
			}).effects,
		).toEqual([]);
		l.ctx.now = 150;
		const retry = l.send({
			verb: "settle",
			settlement: {
				kind: "alarm_fired",
			},
		});
		expect(retry.effects).toEqual([
			expect.objectContaining({ effect: answer?.effect }),
		]);
		expect(retry.effects[0]?.token).not.toBe(answer?.token);
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: retry.effects[0]?.token ?? missing,
		});
		expect(l.state.active?.interactions[0]).toMatchObject({
			delivery: "sent",
		});
	});
	it("Answered interactions are delivered or explicitly settled before Ended", () => {
		const l = ledger();
		const a = l.start();
		l.observe({
			kind: "interaction_requested",
			...a,
			interactionId: "q",
			interactionKind: "question",
			token: l.queryToken(a.runId),
		});
		l.control({ kind: "answer", interactionId: "q", answer: "kept" });
		const ended = l.observe({
			kind: "query_ended",
			...a,
			token: l.queryToken(a.runId),
		});
		expect(ended.ended).toEqual([
			{ runId: a.runId, outcome: "completed", reason: { kind: "completed" } },
		]);
		expect(l.work.some(({ effect }) => effect.kind === "deliver_answer")).toBe(
			false,
		);
	});
	it("Permission timeout records a rejection answer and its effect in one decision", () => {
		const l = ledger();
		const a = l.start();
		l.observe({
			kind: "interaction_requested",
			...a,
			interactionId: "p",
			interactionKind: "permission",
			timeoutAt: 120,
			token: l.queryToken(a.runId),
		});
		l.ctx.now = 120;
		const timedOut = l.send({
			verb: "settle",
			settlement: {
				kind: "alarm_fired",
			},
		});
		expect(l.state.active?.interactions[0]).toMatchObject({
			tag: "Answered",
			delivery: "queued",
		});
		expect(timedOut.effects[0]?.effect).toMatchObject({
			kind: "deliver_answer",
			runId: a.runId,
			interactionId: "p",
		});
		expect(
			l.send({
				verb: "settle",
				settlement: {
					kind: "alarm_fired",
				},
			}).effects,
		).toEqual([]);
	});
	it("Unknown answer delivery probes consumption without reopening or resending", () => {
		const l = ledger();
		const a = l.start();
		l.observe({
			kind: "interaction_requested",
			...a,
			interactionId: "q",
			interactionKind: "question",
			token: l.queryToken(a.runId),
		});
		const answer = l.control({
			kind: "answer",
			interactionId: "q",
			answer: "kept",
		}).effects[0];
		const unknown = l.observe({
			kind: "effect_outcome",
			outcome: { tag: "delivery_unknown" },
			token: answer?.token ?? missing,
		});
		expect(unknown.effects[0]?.effect).toMatchObject({
			kind: "probe",
			target: { tag: "interaction", interactionId: "q" },
		});
		expect(
			l.control({ kind: "answer", interactionId: "q", answer: "kept" }).effects,
		).toEqual([]);
		l.observe({
			kind: "probe_result",
			finding: { tag: "answer_consumed" },
			token: unknown.effects[0]?.token ?? missing,
		});
		expect(l.state.active?.interactions[0]).toMatchObject({
			delivery: "sent",
		});
	});
	it("Close deadline survives its Tombstone and escalates to kill and respawn", () => {
		const l = ledger();
		const a = l.start();
		l.control({ kind: "stop" });
		const expired = l.fire();
		expect(expired.effects.some(({ effect }) => effect.kind === "close")).toBe(
			true,
		);
		expect(l.ended.some((ended) => ended.runId === a.runId)).toBe(true);
		expect(expired.alarmAt).toBe(30120);
		l.ctx.now = 30120;
		const escalation = l.send({
			verb: "settle",
			settlement: {
				kind: "alarm_fired",
			},
		});
		expect(escalation.effects[0]?.effect).toMatchObject({
			kind: "kill_and_respawn",
			runId: a.runId,
		});
		expect(escalation.ended.some(() => true)).toBe(false);
	});
	it("OpenCode Stop escalates through request cancellation then native abort while fencing", () => {
		const l = ledger("opencode");
		const a = l.start();
		l.control({ kind: "run_now", inputId: "B" });
		const expired = l.fire();
		const cancel = expired.effects.find(
			(effect) => effect.effect.kind === "cancel_request",
		);
		expect(cancel?.effect).toMatchObject({ runId: a.runId });
		const cancelled = l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: cancel?.token ?? missing,
		});
		expect(
			cancelled.effects.some(
				(effect) =>
					effect.effect.kind === "interrupt" && effect.effect.runId === a.runId,
			),
		).toBe(true);
		expect(l.state.active?.tag).toBe("Queued");
	});
	it("RL-013: An authorized retry uses a fresh run instead of reopening a tombstone", () => {
		const l = ledger("cursor");
		const a = l.start();
		l.observe({ kind: "input_accepted", token: a.token });
		l.observe({
			kind: "result",
			...a,
			outcome: "error",
			error: { code: "temporarily_unavailable", retryable: true },
			token: l.queryToken(a.runId),
		});
		l.observe({ kind: "query_ended", ...a, token: l.queryToken(a.runId) });
		const retry = l.admit("A");
		expect(l.state.active?.runId).not.toBe(a.runId);
		expect(l.state.active).toMatchObject({ tag: "Starting" });
		expect(retry.effects[0]?.effect.kind).toBe("start");
		expect(
			l.observe({
				kind: "result",
				...a,
				outcome: "completed",
				token: l.queryToken(a.runId),
			}).ended,
		).toEqual([]);
	});
	it.each([
		"RL-038",
		"RL-040",
	])("%s: An unresolved message owner cannot fail the active run", () => {
		const l = ledger("opencode");
		l.start();
		const before = l.state;
		expect(
			l.observe({
				kind: "result",
				outcome: "error",
				error: { code: "blocking_limit", retryable: false },
				token: l.queryToken("unknown"),
			}).ended,
		).toEqual([]);
		expect(l.state).toEqual(before);
	});
	it("RL-014: Tool-step completion leaves Running and its deadline intact", () => {
		const l = ledger("opencode");
		const a = l.start();
		const before = l.state;
		const event = canonical("opencode", a.runId, "turn.completed");
		expect(classifyRunTerminal(event, "opencode", false, a)).toBeUndefined();
		expect(l.state).toEqual(before);
	});
	it("RL-017: Final OpenCode error and owned query end prevail over an earlier tool step", () => {
		const l = ledger("opencode");
		const a = l.start();
		expect(
			classifyRunTerminal(
				canonical("opencode", a.runId, "turn.completed"),
				"opencode",
				false,
				a,
			),
		).toBeUndefined();
		const error = classifyRunTerminal(
			canonical("opencode", a.runId, "turn.error"),
			"opencode",
			false,
			a,
		);
		if (!error) expect.fail("Expected terminal error");
		l.observe(error);
		const ended = l.observe({
			kind: "query_ended",
			...a,
			token: l.queryToken(a.runId),
		});
		expect(ended.ended).toContainEqual(
			expect.objectContaining({
				outcome: "error",
				reason: {
					kind: "provider_error",
					code: "MessageAbortedError",
					retryable: false,
				},
			}),
		);
	});
	it.each([
		"RL-037",
		"RL-054",
	])("%s: Delivery acknowledgement is not a result, while Claude result ends the Run", () => {
		const l = ledger("claude");
		const a = l.start();
		const delivery: CanonicalEvent = {
			eventId: "e",
			sessionId: "session",
			provider: "cursor",
			createdAt: 100,
			metadata: { runId: a.runId },
			type: "input.sent",
			data: { sessionId: "session", inputId: "B", steer: true },
		};
		expect(classifyRunTerminal(delivery, "cursor", true, a)).toBeUndefined();
		const result = classifyRunTerminal(
			canonical("claude", a.runId, "turn.completed"),
			"claude",
			true,
			a,
		);
		if (!result) expect.fail("Expected result");
		const ended = l.observe(result);
		expect(ended.ended).toContainEqual(
			expect.objectContaining({ runId: a.runId, outcome: "completed" }),
		);
		expect(l.state.active).toBeUndefined();
		expect(l.observe({ kind: "query_ended", token: a.token }).ended).toEqual(
			[],
		);
		expect(l.ended.some((ended) => ended.runId === a.runId)).toBe(true);
	});
	it("RL-055: A provider-handled retry cannot create another start", () => {
		const l = ledger("cursor");
		const a = l.start();
		const errorEvent = canonical("cursor", a.runId, "turn.error");
		if (errorEvent.type !== "turn.error") expect.fail("Expected error");
		const result = classifyRunTerminal(
			{
				...errorEvent,
				data: { ...errorEvent.data, retryable: true, retryHandled: true },
			},
			"cursor",
			true,
			a,
		);
		expect(result).toMatchObject({
			kind: "result",
			error: { retryable: false },
		});
		if (!result) expect.fail("Expected error result");
		expect(l.observe(result).effects).toEqual([]);
		expect(
			l.observe({ kind: "query_ended", ...a, token: l.queryToken(a.runId) })
				.effects,
		).toEqual([]);
	});
	it("Uncertain input cannot be sent again after its original run is tombstoned", () => {
		const l = ledger();
		const start = l.admit("A").effects[0];
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "delivery_unknown" },
			token: start?.token ?? missing,
		});
		l.fire();
		const again = l.admit("A");
		expect(
			again.effects.some(
				(effect) =>
					effect.effect.kind === "start" || effect.effect.kind === "steer",
			),
		).toBe(false);
	});
	it("A failed close escalates without opening the native-session fence", () => {
		const l = ledger();
		l.start();
		l.control({ kind: "run_now", inputId: "B" });
		const close = l.fire().effects.find((item) => item.effect.kind === "close");
		const failed = l.observe({
			kind: "effect_outcome",
			outcome: { tag: "permanent", code: "close_failed" },
			token: close?.token ?? missing,
		});
		expect(failed.effects.map((item) => item.effect.kind)).toEqual([
			"kill_and_respawn",
		]);
		expect(l.state.active?.tag).toBe("Queued");
		const kill = failed.effects[0];
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "permanent", code: "kill_failed" },
			token: kill?.token ?? missing,
		});
		expect(l.state.active?.tag).toBe("Queued");
	});
	it("Failed runner retirement emits quarantine and keeps its fence", () => {
		const l = ledger();
		l.start();
		l.control({ kind: "stop" });
		const close = l.fire().effects.find((item) => item.effect.kind === "close");
		const kill = l.observe({
			kind: "effect_outcome",
			outcome: { tag: "permanent", code: "close_failed" },
			token: close?.token ?? missing,
		}).effects[0];
		const failed = l.observe({
			kind: "effect_outcome",
			outcome: { tag: "permanent", code: "kill_failed" },
			token: kill?.token ?? missing,
		});
		expect(failed.effects[0]?.effect).toMatchObject({ kind: "quarantine" });
	});
	it("A local Starting deadline closes the old native context before replacement", () => {
		const l = ledger();
		l.admit("A");
		const expired = l.fire();
		expect(expired.effects[0]?.effect.kind).toBe("close");
		const replacement = l.admit("B");
		expect(
			replacement.effects.some((item) => item.effect.kind === "start"),
		).toBe(false);
		expect(l.state.active?.tag).toBe("Queued");
	});
	it("A local settle deadline closes the query without losing the observed outcome", () => {
		const l = ledger();
		const a = l.start();
		const result = l.observe({
			kind: "result",
			...a,
			outcome: "completed",
			token: l.queryToken(a.runId),
		});
		const expired = l.fire();
		expect(expired.effects[0]?.effect.kind).toBe("close");
		expect(result.ended).toContainEqual(
			expect.objectContaining({ outcome: "completed" }),
		);
		expect(expired.ended).toEqual([]);
	});
	it("A tombstoned OpenCode start cannot be retried at a later effect deadline", () => {
		const l = ledger("opencode");
		const a = l.start();
		const start = a.admitted.effects[0];
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "retryable", retryAt: 150 },
			token: start?.token ?? missing,
		});
		l.observe({ kind: "query_ended", ...a, token: l.queryToken(a.runId) });
		l.ctx.now = 150;
		expect(
			l.send({
				verb: "settle",
				settlement: {
					kind: "alarm_fired",
				},
			}).effects,
		).toEqual([]);
	});
	it.each([
		"start",
		"steer",
	])("Native acceptance of a %s outranks a late permanent transport failure", (role) => {
		const l = ledger();
		const a = l.start();
		const inputId = role === "start" ? "A" : "B";
		const effect =
			role === "start" ? a.admitted.effects[0] : l.admit("B").effects[0];
		l.observe({
			kind: "input_accepted",
			...a,
			nativeMessageId: "native",
			token: l.inputToken(inputId, a.runId),
		});
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "permanent", code: "transport_failed" },
			token: effect?.token ?? missing,
		});
		expect(l.state.active).toMatchObject({ tag: "Running", runId: a.runId });
		expect(
			l.state.active?.inputs.find((input) => input.inputId === inputId)?.state
				.tag,
		).toBe("Accepted");
		expect(l.state.inbox).toEqual([]);
	});
	it("A duplicate result cannot keep extending the settle deadline", () => {
		const l = ledger();
		const a = l.start();
		const result = l.observe({
			kind: "result",
			...a,
			outcome: "completed",
			token: l.queryToken(a.runId),
		});
		expect(result.ended).toHaveLength(1);
		expect(l.alarmAt).toBe(130);
		expect(l.state.active).toBeUndefined();
		l.ctx.now = 120;
		const duplicate = l.observe({
			kind: "result",
			...a,
			outcome: "completed",
			token: l.queryToken(a.runId),
		});
		expect(duplicate.alarmAt).toBe(130);
		expect(duplicate.ended).toEqual([]);
		expect(l.alarmAt).toBe(130);
		expect(l.state.active).toBeUndefined();
		expect(l.ended).toHaveLength(1);
	});
	it("Late accounting cannot change a Tombstone or its successor lifecycle", () => {
		const l = ledger();
		const a = l.start();
		l.observe({ kind: "query_ended", ...a, token: l.queryToken(a.runId) });
		l.start("B");
		const before = l.state;
		const accounting = l.observe({
			kind: "accounting",
			token: l.queryToken(a.runId),
		});
		expect(accounting.events).toHaveLength(1);
		expect(accounting.ended).toEqual([]);
		expect(accounting.effects).toEqual([]);
		expect(l.state.active).toEqual(before.active);
	});
	it("Native interaction consumption cancels answer retries and stale consumption probes", () => {
		const l = ledger();
		const a = l.start();
		l.observe({
			kind: "interaction_requested",
			...a,
			interactionId: "p",
			interactionKind: "permission",
			token: l.queryToken(a.runId),
		});
		const answer = l.control({
			kind: "answer",
			interactionId: "p",
			answer: "yes",
		}).effects[0];
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "retryable", retryAt: 150 },
			token: answer?.token ?? missing,
		});
		l.observe({
			kind: "interaction_resolved",
			...a,
			interactionId: "p",
			token: l.answerToken("p", a.runId),
		});
		l.ctx.now = 150;
		expect(
			l.send({
				verb: "settle",
				settlement: {
					kind: "alarm_fired",
				},
			}).effects,
		).toEqual([]);
		expect(
			l.observe({
				kind: "effect_outcome",
				outcome: { tag: "delivery_unknown" },
				token: answer?.token ?? missing,
			}).ended,
		).toEqual([]);
		expect(l.state.active?.interactions[0]).toMatchObject({
			delivery: "sent",
		});
	});
	it("An unconsumed uncertain answer remains durable and schedules another probe, never a resend", () => {
		const l = ledger();
		const a = l.start();
		l.observe({
			kind: "interaction_requested",
			...a,
			interactionId: "q",
			interactionKind: "question",
			token: l.queryToken(a.runId),
		});
		const answer = l.control({
			kind: "answer",
			interactionId: "q",
			answer: "kept",
		}).effects[0];
		const probe = l.observe({
			kind: "effect_outcome",
			outcome: { tag: "delivery_unknown" },
			token: answer?.token ?? missing,
		}).effects[0];
		const liveBefore = l.state.live;
		const deadlineBefore = l.state.active?.deadline;
		const retryAt = l.alarmAt;
		expect(retryAt).toBe(l.ctx.now + l.ctx.policy.closeMs);
		const pending = l.observe({
			kind: "probe_result",
			finding: { tag: "answer_pending" },
			token: probe?.token ?? missing,
		});
		expect(l.state.active?.interactions[0]).toMatchObject({
			tag: "Answered",
			delivery: "unknown",
		});
		expect(pending.effects).toEqual([]);
		expect(pending.allEffects).toEqual([]);
		expect(pending.ended).toEqual([]);
		expect(pending.alarmAt).toBe(retryAt);
		expect(l.state.live).toEqual(liveBefore);
		expect(l.state.active?.deadline).toEqual(deadlineBefore);
		l.ctx.now += l.ctx.policy.closeMs;
		const retried = l.send({
			verb: "settle",
			settlement: { kind: "alarm_fired" },
		});
		expect(retried.effects.map(({ effect }) => effect.kind)).toEqual(["probe"]);
		expect(retried.effects[0]?.token).not.toBe(probe?.token);
	});
	it("A failed OpenCode native abort cannot release its successor's start", () => {
		const l = ledger("opencode");
		const a = l.start();
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: a.admitted.effects[0]?.token ?? missing,
		});
		const firstInterrupt = l.control({ kind: "run_now", inputId: "B" })
			.effects[0];
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: firstInterrupt?.token ?? missing,
		});
		const cancel = l
			.fire()
			.effects.find((item) => item.effect.kind === "cancel_request");
		const abort = l
			.observe({
				kind: "effect_outcome",
				outcome: { tag: "succeeded" },
				token: cancel?.token ?? missing,
			})
			.effects.find((item) => item.effect.kind === "interrupt");
		const failed = l.observe({
			kind: "effect_outcome",
			outcome: { tag: "permanent", code: "abort_failed" },
			token: abort?.token ?? missing,
		});
		expect(failed.effects.some((item) => item.effect.kind === "start")).toBe(
			false,
		);
		expect(l.state.active?.tag).toBe("Queued");
	});
	it("Native idle confirms cleanup for a Tombstone even without a successor", () => {
		const l = ledger("opencode");
		l.start();
		l.control({ kind: "stop" });
		const cancel = l
			.fire()
			.effects.find((item) => item.effect.kind === "cancel_request");
		const cancelled = l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: cancel?.token ?? missing,
		});
		const probe = cancelled.effects.find(
			(item) => item.effect.kind === "probe",
		);
		l.observe({
			kind: "probe_result",
			finding: { tag: "native_idle" },
			token: probe?.token ?? missing,
		});
	});
	it("A hung runner kill is quarantined on its cleanup deadline", () => {
		const l = ledger();
		l.start();
		l.control({ kind: "stop" });
		const close = l.fire().effects.find((item) => item.effect.kind === "close");
		expect(close).toBeDefined();
		l.ctx.now += 20;
		const kill = l.send({
			verb: "settle",
			settlement: {
				kind: "alarm_fired",
			},
		}).effects[0];
		expect(kill?.effect.kind).toBe("kill_and_respawn");
		expect(l.alarmAt).toBe(l.ctx.now + l.ctx.policy.closeMs);
		l.ctx.now += 20;
		const quarantined = l.send({
			verb: "settle",
			settlement: {
				kind: "alarm_fired",
			},
		});
		expect(quarantined.effects[0]?.effect.kind).toBe("quarantine");
	});
	it("Project inactivity settles the run and cancels pending deliveries", () => {
		const l = ledger();
		l.start();
		const result = l.send({
			verb: "settle",
			settlement: { kind: "project_inactive" },
		});
		expect(l.state.active).toBeUndefined();
		expect(l.work).toEqual([]);
		expect(result.ended).toContainEqual(
			expect.objectContaining({
				reason: { kind: "project_inactive" },
			}),
		);
	});
	it("Late input presence confirms delivery without discarding an already observed result", () => {
		const l = ledger("opencode");
		const a = l.start();
		const steer = l.admit("B").effects[0];
		const probe = l.observe({
			kind: "effect_outcome",
			outcome: { tag: "delivery_unknown" },
			token: steer?.token ?? missing,
		}).effects[0];
		l.observe({
			kind: "result",
			...a,
			outcome: "completed",
			token: l.queryToken(a.runId),
		});
		l.observe({
			kind: "probe_result",
			finding: { tag: "input_present" },
			token: probe?.token ?? missing,
		});
		expect(l.state.active).toMatchObject({
			tag: "Settling",
		});
	});
	it("A stale fence probe cannot end a successor after confirmed close starts it", () => {
		const l = ledger();
		l.start();
		l.control({ kind: "run_now", inputId: "B" });
		const expired = l.fire();
		const close = expired.effects.find((item) => item.effect.kind === "close");
		const probe = expired.effects.find((item) => item.effect.kind === "probe");
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: close?.token ?? missing,
		});
		const before = l.state;
		expect(
			l.observe({
				kind: "probe_result",
				finding: { tag: "native_idle" },
				token: probe?.token ?? missing,
			}).ended,
		).toEqual([]);
		expect(l.state).toEqual(before);
	});
	it("Stop retains its interrupt deadline across ordinary results and activity", () => {
		const l = ledger("opencode");
		const a = l.start();
		l.control({ kind: "stop" });
		const deadline = l.state.active?.deadline;
		l.observe({
			kind: "result",
			...a,
			outcome: "completed",
			token: l.queryToken(a.runId),
		});
		l.observe({ kind: "activity", ...a, token: l.queryToken(a.runId) });
		expect(l.state.active).toMatchObject({ tag: "Interrupting", deadline });
		l.fire();
		expect(l.ended.some((ended) => ended.runId === a.runId)).toBe(true);
	});
	it.each([
		"cancel",
		"accept",
	])("A scheduled steer retry is retired when the input is %s", (action) => {
		const l = ledger();
		const a = l.start();
		const steer = l.admit("B").effects[0];
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "retryable", retryAt: 105 },
			token: steer?.token ?? missing,
		});
		if (action === "cancel") l.control({ kind: "cancel_input", inputId: "B" });
		else
			l.observe({
				kind: "input_accepted",
				...a,
				token: l.inputToken("B", a.runId),
			});
		l.ctx.now = 105;
		expect(
			l.send({
				verb: "settle",
				settlement: {
					kind: "alarm_fired",
				},
			}).effects,
		).toEqual([]);
	});
});
function canonical(
	provider: ProviderKind,
	runId: string,
	kind: "turn.completed" | "turn.error",
): CanonicalEvent {
	const base = {
		eventId: "e",
		sessionId: "session",
		provider,
		createdAt: 100,
		metadata: { runId },
	};
	return kind === "turn.completed"
		? { ...base, type: kind, data: { messageId: "assistant" } }
		: {
				...base,
				type: kind,
				data: {
					messageId: "assistant",
					error: "aborted",
					code: "MessageAbortedError",
				},
			};
}
describe("Run Ledger late effect outcomes", () => {
	it("Acceptance replays preserve known native identity and can fill an identity previously unknown", () => {
		const l = ledger();
		const a = l.start();
		l.observe({
			kind: "input_accepted",
			...a,
			token: l.inputToken("A", a.runId),
		});
		l.observe({
			kind: "input_accepted",
			...a,
			nativeMessageId: "native-A",
			token: l.inputToken("A", a.runId),
		});
		expect(l.state.active?.inputs[0]?.state).toEqual({
			tag: "Accepted",
			nativeMessageId: "native-A",
		});
		expect(
			l.observe({
				kind: "input_accepted",
				...a,
				token: l.inputToken("A", a.runId),
			}).ended,
		).toEqual([]);
	});
	it.each([
		"input_probe",
		"input_accepted",
	])("New native acceptance through %s invalidates an older liveness idle sample", (path) => {
		const l = ledger();
		const a = l.start();
		const idleProbe = l.fire().effects[0];
		const steer = l.admit("B").effects[0];
		const inputProbe = l.observe({
			kind: "effect_outcome",
			outcome: { tag: "delivery_unknown" },
			token: steer?.token ?? missing,
		}).effects[0];
		const deadline = l.state.active?.deadline;
		if (path === "input_accepted")
			l.observe({
				kind: "input_accepted",
				...a,
				token: l.inputToken("B", a.runId),
			});
		else
			l.observe({
				kind: "probe_result",
				finding: { tag: "input_present" },
				token: inputProbe?.token ?? missing,
			});
		expect(l.state.active).toMatchObject({
			tag: "Running",
			runId: a.runId,
			deadline,
		});
		expect(
			l.observe({
				kind: "probe_result",
				finding: { tag: "native_idle" },
				token: idleProbe?.token ?? missing,
			}).ended,
		).toEqual([]);
	});
	it("A late transport failure cannot schedule a start for an already Tombstoned run", () => {
		const l = ledger("opencode");
		const a = l.start();
		l.observe({ kind: "query_ended", ...a, token: l.queryToken(a.runId) });
		const effectId = a.admitted.effects[0]?.token ?? missing;
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "retryable", retryAt: 150 },
			token: effectId,
		});
		l.ctx.now = 150;
		expect(
			l.send({
				verb: "settle",
				settlement: {
					kind: "alarm_fired",
				},
			}).effects,
		).toEqual([]);
	});
});
describe("Run Ledger round 5 regressions", () => {
	it("Round 5 / finding 3 sibling: native acceptance cannot turn a retryable report into an idle proof", () => {
		const l = ledger("opencode");
		const a = l.start();
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: a.admitted.effects[0]?.token ?? missing,
		});
		const steer = l.admit("B").effects[0];
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "delivery_unknown" },
			token: steer?.token ?? missing,
		});
		l.observe({
			kind: "input_accepted",
			...a,
			nativeMessageId: "native-B",
			token: l.inputToken("B", a.runId),
		});
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "retryable", retryAt: l.ctx.now + 1 },
			token: steer?.token ?? missing,
		});
		const interrupt = l.control({ kind: "run_now", inputId: "C" }).effects[0];
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: interrupt?.token ?? missing,
		});
		l.ctx.now = l.state.active?.deadline.at ?? l.ctx.now;
		const ended = l.fire();
		expect(ended.effects.some((item) => item.effect.kind === "start")).toBe(
			false,
		);
		expect(l.state.active?.tag).toBe("Queued");
	});
	it.each([
		"run_now",
		"native_declined",
	] as const)("Round 5 / finding 5: a permanent start failure ends its run despite %s", (disposition) => {
		const l = ledger();
		const admitted = l.admit("A");
		const runId = l.state.active?.runId ?? missing;
		if (disposition === "run_now") l.control({ kind: "run_now", inputId: "A" });
		else {
			l.observe({
				kind: "input_declined",
				reason: disposition,
				token: l.inputToken("A", runId),
			});
		}

		const failed = l.observe({
			kind: "effect_outcome",
			outcome: { tag: "permanent", code: "refused" },
			token: admitted.effects[0]?.token ?? missing,
		});
		expect(l.ended.some((ended) => ended.runId === runId)).toBe(true);
		expect(failed.ended).toContainEqual(
			expect.objectContaining({
				runId,
				reason: { kind: "refused", code: "refused" },
			}),
		);

		expect(
			failed.effects.some(
				(item) =>
					item.effect.kind === "close" ||
					item.effect.kind === "kill_and_respawn",
			),
		).toBe(false);
	});
	it.each([
		"input",
		"interaction",
		"native_session",
	] as const)("Round 5 / finding 4: %s transport success retains correlation for its finding", (target) => {
		const { l, a, probe, finding } = preparedProbe(target);
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: probe?.token ?? missing,
		});
		l.observe({
			kind: "probe_result",
			finding,
			token: probe?.token ?? missing,
		});
		if (target === "native_session")
			expect(l.ended.some((ended) => ended.runId === a.runId)).toBe(true);
		else if (target === "input")
			expect(
				l.state.active?.inputs.find((input) => input.inputId === "B")?.state,
			).toEqual({ tag: "Accepted", nativeMessageId: "native-B" });
		else
			expect(l.state.active?.interactions[0]).toMatchObject({
				tag: "Answered",
				delivery: "sent",
			});
	});
	it.each([
		"input",
		"interaction",
		"native_session",
	] as const)("Round 5 / finding 4 sibling: a failed %s probe retains the evidence allowed by its class", (target) => {
		const { l, probe, finding } = preparedProbe(target);
		l.observe({
			kind: "effect_outcome",
			token: probe?.token ?? missing,
			outcome: { tag: "permanent", code: "probe_failed" },
		});
		const before = l.state.active;
		const late = l.observe({
			kind: "probe_result",
			token: probe?.token ?? missing,
			finding,
		});
		expect(late.effects.some(({ effect }) => effect.kind === "start")).toBe(
			false,
		);
		if (target === "native_session")
			expect(late.ended[0]).toMatchObject({ outcome: "completed" });
		else {
			expect(late.ended).toEqual([]);
			expect(l.state.active?.tag).toBe(before?.tag);
			expect(l.state.active?.deadline).toEqual(before?.deadline);
			if (target === "input")
				expect(l.input("B")?.state).toEqual({
					tag: "Accepted",
					nativeMessageId: "native-B",
				});
			else
				expect(l.state.active?.interactions[0]).toMatchObject({
					tag: "Answered",
					delivery: "sent",
				});
		}
	});
	it.each([
		"start",
		"steer",
	] as const)("Round 5 / finding 3: tombstoned delivery-unknown %s work remains fenced after a retryable report", (kind) => {
		const l = ledger("opencode");
		const a = l.start();
		const work =
			kind === "start" ? a.admitted.effects[0] : l.admit("B").effects[0];
		if (kind === "steer")
			l.observe({
				kind: "effect_outcome",
				outcome: { tag: "succeeded" },
				token: a.admitted.effects[0]?.token ?? missing,
			});
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "delivery_unknown" },
			token: work?.token ?? missing,
		});
		const interrupt = l.control({ kind: "run_now", inputId: "C" }).effects[0];
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: interrupt?.token ?? missing,
		});
		l.ctx.now = l.state.active?.deadline.at ?? l.ctx.now;
		const expired = l.fire();
		const late = l.observe({
			kind: "effect_outcome",
			outcome: { tag: "retryable", retryAt: l.ctx.now + 1 },
			token: work?.token ?? missing,
		});
		expect(late.effects.some((item) => item.effect.kind === "start")).toBe(
			false,
		);
		expect(l.state.active?.tag).toBe("Queued");
		const cancel = expired.effects.find(
			({ effect }) => effect.kind === "cancel_request",
		);
		const cancelled = l.observe({
			kind: "effect_outcome",
			token: cancel?.token ?? missing,
			outcome: { tag: "succeeded" },
		});
		const abort = cancelled.effects.find(
			({ effect }) => effect.kind === "interrupt",
		);
		l.observe({
			kind: "effect_outcome",
			token: abort?.token ?? missing,
			outcome: { tag: "succeeded" },
		});
		const probe = l.work
			.filter(
				(item) =>
					item.effect.kind === "probe" &&
					item.effect.target.tag === "native_session",
			)
			.at(-1);
		const idle = l.observe({
			kind: "probe_result",
			finding: { tag: "native_idle" },
			token: probe?.token ?? missing,
		});
		expect(
			idle.effects.some(
				(item) => item.effect.kind === "start" && item.effect.inputId === "C",
			),
		).toBe(true);
	});
	it("Round 5 / finding 2: decline before delivery_unknown never resends the declined steer", () => {
		const l = ledger();
		const a = l.start();
		const steer = l.admit("B").effects[0];
		l.observe({
			kind: "input_declined",
			...a,
			reason: "declined",
			token: l.inputToken("B", a.runId),
		});
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "delivery_unknown" },
			token: steer?.token ?? missing,
		});
		const ended = l.observe({
			kind: "query_ended",
			...a,
			token: l.queryToken(a.runId),
		});
		expect(
			ended.effects.some(
				(item) => item.effect.kind === "start" && item.effect.inputId === "B",
			),
		).toBe(false);
		expect(l.state.active?.tag).toBe("Queued");
		expect(
			ended.effects.some(
				(item) =>
					item.effect.kind === "probe" && item.effect.target.tag === "input",
			),
		).toBe(true);
	});
	it.each([
		false,
		true,
	])("Round 5 / finding 1: retrying a native probe retires its old reply identity (runNow=%s)", (runNow) => {
		const l = ledger("opencode");
		const a = l.start();
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: a.admitted.effects[0]?.token ?? missing,
		});
		const probe = l.fire().effects.find((item) => item.effect.kind === "probe");
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "retryable", retryAt: l.ctx.now + 1 },
			token: probe?.token ?? missing,
		});
		l.admit("B");
		if (runNow) l.control({ kind: "run_now", inputId: "C" });
		l.ctx.now++;
		const retried = l.send({
			verb: "settle",
			settlement: {
				kind: "alarm_fired",
			},
		});
		const before = l.state;
		const oldReply = l.observe({
			kind: "probe_result",
			finding: { tag: "native_idle" },
			token: probe?.token ?? missing,
		});
		expect(oldReply).toMatchObject({
			tag: "Accepted",
			events: [],
			effects: [],
			ended: [],
			allEffects: [],
		});
		expect(l.state).toEqual(before);
		expect(
			retried.effects.find((item) => item.effect.kind === "probe")?.token,
		).not.toBe(probe?.token);
		expect(l.state.active?.runId).toBe(a.runId);
	});
});
describe("Run Ledger independent review regressions", () => {
	it.each([
		false,
		true,
	])("Review 4 sibling: Run now preserves an unsent Queued input's certainty and priority (paused=%s)", (paused) => {
		const l = ledger();
		l.admit("A");
		const close = l.fire().effects.find((item) => item.effect.kind === "close");
		if (paused) l.control({ kind: "stop" });
		l.send({ verb: "admit", inputId: "B", runNow: paused });
		l.control({ kind: "run_now", inputId: "B" });
		const queued = l.state.active?.inputs[0];
		const released = l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: close?.token ?? missing,
		});
		expect(
			released.effects.some(
				(item) => item.effect.kind === "start" && item.effect.inputId === "B",
			),
		).toBe(true);
		expect(queued).toMatchObject({
			inputId: "B",
			state: { tag: "Queued" },
			uncertain: false,
		});
		expect(l.state.paused).toBe(paused);
	});
	it("Review 1 sibling: a newer interaction request supersedes an older idle sample", () => {
		const l = ledger();
		const a = l.start();
		const probe = l.fire().effects.find((item) => item.effect.kind === "probe");
		l.observe({
			kind: "interaction_requested",
			...a,
			interactionId: "q",
			interactionKind: "question",
			token: l.queryToken(a.runId),
		});
		const idle = l.observe({
			kind: "probe_result",
			finding: { tag: "native_idle" },
			token: probe?.token ?? missing,
		});
		expect(idle.ended.some(() => true)).toBe(false);
		expect(l.state.active).toMatchObject({
			runId: a.runId,
			interactions: [{ tag: "Pending", interactionId: "q" }],
		});
	});
	it.each([
		"stop",
		"end",
		"run_now",
	] as const)("Review 4 / RL-035: %s preserves an unsent Queued start behind cleanup", (kind) => {
		const l = ledger();
		l.admit("A");
		const close = l.fire().effects.find((item) => item.effect.kind === "close");
		l.admit("B");
		expect(l.state.active).toMatchObject({
			tag: "Queued",
			inputs: [{ inputId: "B" }],
		});
		l.control(kind === "run_now" ? { kind, inputId: "C" } : { kind });
		expect(l.state.inbox[0]).toMatchObject({
			inputId: "B",
			state: { tag: "Queued" },
			uncertain: false,
		});
		const cleanup = l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: close?.token ?? missing,
		});
		if (kind === "run_now") {
			expect(
				cleanup.effects.some(
					(item) => item.effect.kind === "start" && item.effect.inputId === "C",
				),
			).toBe(true);
			const runId = l.state.active?.runId ?? missing;
			const next = l.observe({
				kind: "query_ended",
				token: l.queryToken(runId),
			});
			expect(
				next.effects.some(
					(item) => item.effect.kind === "start" && item.effect.inputId === "B",
				),
			).toBe(true);
		} else {
			expect(cleanup.effects.some((item) => item.effect.kind === "start")).toBe(
				false,
			);
			const resumed = l.control({ kind: "resume" });
			expect(
				resumed.effects.some(
					(item) => item.effect.kind === "start" && item.effect.inputId === "B",
				),
			).toBe(true);
		}
	});
	it("Review 4 sibling: Stop preserves a Queued input's possiblySeen disposition", () => {
		const l = ledger();
		l.start();
		const steer = l.admit("B").effects[0];
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "delivery_unknown" },
			token: steer?.token ?? missing,
		});
		l.control({ kind: "stop" });
		l.ctx.now = l.state.active?.deadline.at ?? l.ctx.now;
		const close = l.fire().effects.find((item) => item.effect.kind === "close");
		l.control({ kind: "resume" });
		expect(l.state.active?.tag).toBe("Queued");
		l.control({ kind: "stop" });
		expect(l.state.inbox[0]).toMatchObject({
			inputId: "B",
			state: { tag: "Queued" },
			uncertain: true,
		});
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: close?.token ?? missing,
		});
		const resumed = l.control({ kind: "resume" });
		expect(
			resumed.effects.some(
				(item) => item.effect.kind === "start" || item.effect.kind === "steer",
			),
		).toBe(false);
		expect(
			resumed.effects.some(
				(item) =>
					item.effect.kind === "probe" && item.effect.target.tag === "input",
			),
		).toBe(true);
	});
	it.each([
		"cancelled",
		"native_declined",
		"run_now",
	])("Review 3: late permanent steer failure preserves %s", (disposition) => {
		const l = ledger();
		const a = l.start();
		const steer = l.admit("B").effects[0];
		if (disposition === "cancelled")
			l.control({ kind: "cancel_input", inputId: "B" });
		else if (disposition === "run_now")
			l.control({ kind: "run_now", inputId: "B" });
		else {
			l.observe({
				kind: "effect_outcome",
				outcome: { tag: "delivery_unknown" },
				token: steer?.token ?? missing,
			});
			l.observe({
				kind: "input_declined",
				...a,
				reason: "native_declined",
				token: l.inputToken("B", a.runId),
			});
		}
		const inbox = l.state.inbox;
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "permanent", code: "late_failure" },
			token: steer?.token ?? missing,
		});

		expect(l.state.inbox).toEqual(inbox);
		const ended = l.observe({
			kind: "query_ended",
			...a,
			token: l.queryToken(a.runId),
		});
		expect(
			ended.effects.some(
				(item) => item.effect.kind === "start" && item.effect.inputId === "B",
			),
		).toBe(false);
	});
	it("Review 1 sibling: an idle sample cannot clear a later retried transmission", () => {
		const l = ledger("opencode");
		const a = l.start();
		const steer = l.admit("B").effects[0];
		const probe = l.fire().effects.find((item) => item.effect.kind === "probe");
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "retryable", retryAt: l.ctx.now + 5 },
			token: steer?.token ?? missing,
		});
		l.ctx.now += 5;
		const retried = l.send({
			verb: "settle",
			settlement: {
				kind: "alarm_fired",
			},
		});
		const idle = l.observe({
			kind: "probe_result",
			finding: { tag: "native_idle" },
			token: probe?.token ?? missing,
		});
		expect(idle.ended.some(() => true)).toBe(false);
		expect(l.state.active?.runId).toBe(a.runId);
		expect(
			l.work.some((item) => item.token === retried.effects[0]?.token),
		).toBe(true);
	});
	it.each([
		"succeeded",
		"permanent",
		"native_busy",
	])("Review 2 sibling: %s does not discharge the idle-confirmation fence", (reply) => {
		const l = ledger("opencode");
		const a = l.start();
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: a.admitted.effects[0]?.token ?? missing,
		});
		const initial = l.control({ kind: "run_now", inputId: "B" }).effects[0];
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: initial?.token ?? missing,
		});
		const cancel = l
			.fire()
			.effects.find((item) => item.effect.kind === "cancel_request");
		const fallback = l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: cancel?.token ?? missing,
		});
		const abort = fallback.effects.find(
			(item) => item.effect.kind === "interrupt",
		);
		const probe = fallback.effects.find((item) => item.effect.kind === "probe");
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: abort?.token ?? missing,
		});
		const outcome =
			reply === "native_busy"
				? l.observe({
						kind: "probe_result",
						finding: { tag: "native_busy" },
						token: probe?.token ?? missing,
					})
				: l.observe({
						kind: "effect_outcome",
						outcome:
							reply === "permanent"
								? { tag: "permanent", code: "probe_failed" }
								: { tag: "succeeded" },
						token: probe?.token ?? missing,
					});
		expect(outcome.effects.some((item) => item.effect.kind === "start")).toBe(
			false,
		);
		expect(l.state.active?.tag).toBe("Queued");
		l.ctx.now = l.state.active?.deadline.at ?? l.ctx.now;
		expect(l.fire().ended).toContainEqual(
			expect.objectContaining({
				reason: { kind: "fence_unconfirmed" },
			}),
		);
	});
	it.each([
		"idle",
		"deadline",
	])("Review 2: acknowledged OpenCode fallback stays fenced until %s", (resolution) => {
		const l = ledger("opencode");
		const a = l.start();
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: a.admitted.effects[0]?.token ?? missing,
		});
		const initial = l
			.control({ kind: "run_now", inputId: "B" })
			.effects.find((item) => item.effect.kind === "interrupt");
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: initial?.token ?? missing,
		});
		const cancel = l
			.fire()
			.effects.find((item) => item.effect.kind === "cancel_request");
		const cancelled = l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: cancel?.token ?? missing,
		});
		const abort = cancelled.effects.find(
			(item) => item.effect.kind === "interrupt",
		);
		const acknowledged = l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: abort?.token ?? missing,
		});
		expect(
			acknowledged.effects.some((item) => item.effect.kind === "start"),
		).toBe(false);
		expect(l.state.active?.tag).toBe("Queued");
		if (resolution === "idle") {
			const probe = cancelled.effects.find(
				(item) => item.effect.kind === "probe",
			);
			const idle = l.observe({
				kind: "probe_result",
				finding: { tag: "native_idle" },
				token: probe?.token ?? missing,
			});
			expect(
				idle.effects.some(
					(item) => item.effect.kind === "start" && item.effect.inputId === "B",
				),
			).toBe(true);
		} else {
			l.ctx.now = l.state.active?.deadline.at ?? l.ctx.now;
			expect(l.fire().ended).toContainEqual(
				expect.objectContaining({
					reason: { kind: "fence_unconfirmed" },
				}),
			);
			expect(l.state.active).toBeUndefined();
		}
	});
	it.each([
		false,
		true,
	])("Review 1: an old idle probe cannot clear a newer steer and Run now interrupt (acknowledged=%s)", (acknowledged) => {
		const l = ledger("opencode");
		const a = l.start();
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: a.admitted.effects[0]?.token ?? missing,
		});
		const probe = l.fire().effects.find((item) => item.effect.kind === "probe");
		const steer = l
			.admit("B")
			.effects.find((item) => item.effect.kind === "steer");
		const interrupt = l
			.control({ kind: "run_now", inputId: "C" })
			.effects.find((item) => item.effect.kind === "interrupt");
		if (acknowledged)
			for (const effect of [steer, interrupt])
				l.observe({
					kind: "effect_outcome",
					outcome: { tag: "succeeded" },
					token: effect?.token ?? missing,
				});
		const idle = l.observe({
			kind: "probe_result",
			finding: { tag: "native_idle" },
			token: probe?.token ?? missing,
		});
		expect(idle.effects.some((item) => item.effect.kind === "start")).toBe(
			false,
		);
		expect(l.state.active).toMatchObject({
			tag: "Interrupting",
			runId: a.runId,
		});
		if (!acknowledged)
			for (const effect of [steer, interrupt])
				expect(l.work.some((item) => item.token === effect?.token)).toBe(true);
	});
});
describe("Run Ledger round 6 regressions", () => {
	it("Round 6 uncertainty sibling: cancelling a requeued failed steer resolves its retained disposition too", () => {
		const l = ledger();
		const a = l.start();
		const steer = l.admit("B").effects[0];
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "delivery_unknown" },
			token: steer?.token ?? missing,
		});
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "permanent", code: "failed" },
			token: steer?.token ?? missing,
		});
		l.control({ kind: "cancel_input", inputId: "B" });
		expect(l.state.inbox.some((input) => input.inputId === "B")).toBe(false);

		const readmitted = l.admit("B");
		expect(
			readmitted.effects.some(
				({ effect }) => effect.kind === "steer" || effect.kind === "start",
			),
		).toBe(false);
		expect(l.input("B")?.uncertain).toBe(true);
		expect(l.state.active?.runId).toBe(a.runId);
	});
	it("Round 6 activity sibling: resolving an unanswered interaction records a receipt without refreshing its deadline", () => {
		const l = ledger();
		const a = l.start();
		l.observe({
			kind: "interaction_requested",
			...a,
			interactionId: "q",
			interactionKind: "question",
			token: l.queryToken(a.runId),
		});
		l.admit("B");
		l.observe({
			kind: "input_declined",
			...a,
			reason: "declined",
			token: l.inputToken("B", a.runId),
		});
		const probe = l.fire().effects[0];
		const deadline = l.state.active?.deadline;
		const before = l.state.active;
		l.observe({
			kind: "interaction_resolved",
			...a,
			interactionId: "q",
			token: l.answerToken("q", a.runId),
		});
		l.observe({
			kind: "probe_result",
			finding: { tag: "native_idle" },
			token: probe?.token ?? missing,
		});
		expect(l.ended.some((ended) => ended.runId === a.runId)).toBe(true);
		expect(deadline).toEqual(before?.deadline);
	});
	it("Round 6 activity sibling: session-wide native_busy voids idle proofs and retains the Stop fence", () => {
		const l = ledger("opencode");
		const a = l.start();
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: a.admitted.effects[0]?.token ?? missing,
		});
		const interrupt = l.control({ kind: "run_now", inputId: "B" }).effects[0];
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: interrupt?.token ?? missing,
		});
		const cancel = l
			.fire()
			.effects.find(({ effect }) => effect.kind === "cancel_request");
		const fallback = l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: cancel?.token ?? missing,
		});
		const probe = fallback.effects.find(
			({ effect }) => effect.kind === "probe",
		);
		l.observe({
			kind: "probe_result",
			finding: { tag: "native_busy" },
			token: probe?.token ?? missing,
		});
		expect(l.state.active?.tag).toBe("Queued");
	});
	it("Round 6 activity sibling: an obsolete Stop-fence sample cannot discharge later abort work", () => {
		const l = ledger("opencode");
		const a = l.start();
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: a.admitted.effects[0]?.token ?? missing,
		});
		const interrupt = l.control({ kind: "run_now", inputId: "B" }).effects[0];
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: interrupt?.token ?? missing,
		});
		const cancel = l
			.fire()
			.effects.find(({ effect }) => effect.kind === "cancel_request");
		const fallback = l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: cancel?.token ?? missing,
		});
		const abort = fallback.effects.find(
			({ effect }) => effect.kind === "interrupt",
		);
		const probe = fallback.effects.find(
			({ effect }) => effect.kind === "probe",
		);
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "retryable", retryAt: l.ctx.now + 1 },
			token: abort?.token ?? missing,
		});
		l.ctx.now++;
		l.send({
			verb: "settle",
			settlement: {
				kind: "alarm_fired",
			},
		});
		l.observe({
			kind: "probe_result",
			finding: { tag: "native_idle" },
			token: probe?.token ?? missing,
		});
		const acknowledged = l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: abort?.token ?? missing,
		});
		expect(
			acknowledged.effects.some(({ effect }) => effect.kind === "start"),
		).toBe(false);
		expect(l.state.active?.tag).toBe("Queued");
	});
	it.each([
		"observation",
		"probe",
	] as const)("Round 6 / finding 1: %s answer consumption preserves the issued idle sample and its deadline", (path) => {
		const l = ledger();
		const a = l.start();
		l.observe({
			kind: "interaction_requested",
			...a,
			interactionId: "q",
			interactionKind: "question",
			token: l.queryToken(a.runId),
		});
		const answer = l.control({
			kind: "answer",
			interactionId: "q",
			answer: "yes",
		}).effects[0];
		const consumption =
			path === "probe"
				? l.observe({
						kind: "effect_outcome",
						outcome: { tag: "delivery_unknown" },
						token: answer?.token ?? missing,
					}).effects[0]
				: undefined;
		l.admit("B");
		l.observe({
			kind: "input_declined",
			...a,
			reason: "declined",
			token: l.inputToken("B", a.runId),
		});
		l.ctx.now = l.state.active?.deadline.at ?? l.ctx.now;
		const idle = l
			.fire()
			.effects.find(
				({ effect }) =>
					effect.kind === "probe" && effect.target.tag === "native_session",
			);
		const before = l.state.active;
		if (consumption)
			l.observe({
				kind: "probe_result",
				finding: { tag: "answer_consumed" },
				token: consumption.token,
			});
		else
			l.observe({
				kind: "interaction_resolved",
				...a,
				interactionId: "q",
				token: l.answerToken("q", a.runId),
			});
		expect(l.state.active?.tag).toBe(before?.tag);
		expect(l.state.active?.deadline).toEqual(before?.deadline);
		const late = l.observe({
			kind: "probe_result",
			token: idle?.token ?? missing,
			finding: { tag: "native_idle" },
		});
		expect(late.ended).toContainEqual({
			runId: a.runId,
			outcome: "completed",
			reason: { kind: "completed" },
		});
		expect(
			late.effects.some(
				({ effect }) => effect.kind === "start" && effect.inputId === "A",
			),
		).toBe(false);
	});
	it.each([
		"fence",
		"settle",
		"interrupt",
	] as const)("Round 6 / finding 2: interaction arrival restores liveness from %s and preserves Stop", (phase) => {
		const l = ledger("opencode");
		const a = l.start();
		if (phase === "fence") l.fire();
		if (phase === "settle")
			l.observe({
				kind: "result",
				...a,
				outcome: "completed",
				token: l.queryToken(a.runId),
			});
		if (phase === "interrupt") l.control({ kind: "stop" });
		const previous = l.state.active?.deadline;
		l.ctx.now += 1;
		l.observe({
			kind: "interaction_requested",
			...a,
			interactionId: "permission",
			interactionKind: "permission",
			timeoutAt: l.ctx.now + 10000,
			token: l.queryToken(a.runId),
		});
		expect(l.state.active).toMatchObject({
			tag:
				phase === "interrupt"
					? "Interrupting"
					: phase === "settle"
						? "Settling"
						: "Running",
			deadline:
				phase === "interrupt" || phase === "settle"
					? previous
					: { kind: "liveness", at: l.ctx.now + 100 },
		});
		if (phase === "fence" && previous) {
			l.ctx.now = previous.at;
			l.send({
				verb: "settle",
				settlement: {
					kind: "alarm_fired",
				},
			});
			expect(l.state.active?.interactions[0]?.interactionId).toBe("permission");
		}
	});
	it("Round 6 / finding 3: resolved uncertain start can be admitted again after a retryable error (RL-013)", () => {
		const l = ledger();
		const a = l.start();
		const effectId = a.admitted.effects[0]?.token ?? missing;
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "delivery_unknown" },
			token: effectId,
		});
		l.observe({
			kind: "input_accepted",
			...a,
			token: l.inputToken("A", a.runId),
		});
		expect(l.uncertain("A")).toBe(false);
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: effectId,
		});
		const resolvedUncertainty = l.uncertain("A");
		l.observe({
			kind: "result",
			...a,
			outcome: "error",
			error: { code: "retry", retryable: true },
			token: l.queryToken(a.runId),
		});
		l.observe({ kind: "query_ended", ...a, token: l.queryToken(a.runId) });
		const retried = l.admit("A");
		expect(resolvedUncertainty).toBe(false);
		expect(retried.effects[0]?.effect.kind).toBe("start");
	});
	it("Round 6 / finding 3 sibling: cancelled uncertain steer remains uncertain when its query closes", () => {
		const l = ledger();
		const a = l.start();
		const steer = l.admit("B").effects[0];
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "delivery_unknown" },
			token: steer?.token ?? missing,
		});
		l.control({ kind: "cancel_input", inputId: "B" });
		expect(
			l
				.admit("B")
				.effects.some(
					({ effect }) => effect.kind === "start" || effect.kind === "steer",
				),
		).toBe(false);
		expect(l.input("B")?.uncertain).toBe(true);
		l.observe({ kind: "query_ended", ...a, token: l.queryToken(a.runId) });
		expect(
			l
				.admit("B")
				.effects.some(
					({ effect }) => effect.kind === "start" || effect.kind === "steer",
				),
		).toBe(false);
		expect(l.input("B")?.uncertain).toBe(true);
	});
});
describe("Run Ledger round 7 regressions", () => {
	it.each([
		"started",
		"native_busy",
	] as const)("Round 7 freshness sibling: old %s evidence preserves the newer provider error", (path) => {
		const l = ledger("opencode");
		const a = l.start();
		const probe = path === "native_busy" ? l.fire().effects[0] : undefined;
		l.observe({
			kind: "result",
			...a,
			outcome: "error",
			error: { code: "prior-error", retryable: false },
			token: l.queryToken(a.runId),
		});
		if (probe)
			l.observe({
				kind: "probe_result",
				finding: { tag: "native_busy" },
				token: probe.token,
			});
		else l.observe({ kind: "started", ...a, token: l.queryToken(a.runId) });
		const ended = l.observe({
			kind: "query_ended",
			...a,
			token: l.queryToken(a.runId),
		});
		expect(ended.ended).toContainEqual(
			expect.objectContaining({
				outcome: "error",
				reason: {
					kind: "provider_error",
					code: "prior-error",
					retryable: false,
				},
			}),
		);
	});
	it("Round 7 freshness sibling: a duplicate interaction request does not become post-result activity", () => {
		const l = ledger("opencode");
		const a = l.start();
		const request = {
			kind: "interaction_requested" as const,
			...a,
			interactionId: "q",
			interactionKind: "question" as const,
		};
		l.observe(request);
		l.observe({
			kind: "result",
			...a,
			outcome: "error",
			error: { code: "prior-error", retryable: false },
			token: l.queryToken(a.runId),
		});
		expect(l.observe(request)).toEqual({
			tag: "Accepted",
			alarmAt: 130,
			events: [],
			ended: [],
			effects: [],
			allEffects: [],
		});
		expect(l.state.active?.tag).toBe("Settling");
	});
	it.each([
		"observation",
		"probe",
	] as const)("Round 7 / finding 1: %s acceptance after cancellation preserves lifecycle and cannot resend the cancelled input", (path) => {
		const l = ledger("opencode");
		const a = l.start();
		const steer = l.admit("B").effects[0];
		const presence =
			path === "probe"
				? l.observe({
						kind: "effect_outcome",
						outcome: { tag: "delivery_unknown" },
						token: steer?.token ?? missing,
					}).effects[0]
				: undefined;
		l.control({ kind: "cancel_input", inputId: "B" });
		l.admit("C");
		l.observe({
			kind: "input_declined",
			...a,
			reason: "declined",
			token: l.inputToken("C", a.runId),
		});
		l.ctx.now = l.state.active?.deadline.at ?? l.ctx.now;
		const idle = l
			.fire()
			.effects.find(
				({ effect }) =>
					effect.kind === "probe" && effect.target.tag === "native_session",
			);
		expect(idle).toBeDefined();
		const before = l.state.active;
		if (presence)
			l.observe({
				kind: "probe_result",
				finding: { tag: "input_present" },
				token: presence.token,
			});
		else
			l.observe({
				kind: "input_accepted",
				...a,
				token: l.inputToken("B", a.runId),
			});
		expect(l.state.active?.tag).toBe(before?.tag);
		expect(l.state.active?.deadline).toEqual(before?.deadline);
		const late = l.observe({
			kind: "probe_result",
			token: idle?.token ?? missing,
			finding: { tag: "native_idle" },
		});
		expect(
			late.effects.some(
				({ effect }) => effect.kind === "start" && effect.inputId === "B",
			),
		).toBe(false);
		expect(l.state.inbox.some((input) => input.inputId === "B")).toBe(false);
	});
	it.each([
		"acknowledgement",
		"duplicate_resolution",
		"consumption_probe",
	] as const)("Round 7 / finding 2: delayed %s preserves the provider error", (path) => {
		const l = ledger("opencode");
		const a = l.start();
		l.observe({
			kind: "interaction_requested",
			...a,
			interactionId: "q",
			interactionKind: "question",
			token: l.queryToken(a.runId),
		});
		const answer = l.control({
			kind: "answer",
			interactionId: "q",
			answer: "yes",
		}).effects[0];
		const probe =
			path === "consumption_probe"
				? l.observe({
						kind: "effect_outcome",
						outcome: { tag: "delivery_unknown" },
						token: answer?.token ?? missing,
					}).effects[0]
				: undefined;
		if (path === "duplicate_resolution")
			l.observe({
				kind: "interaction_resolved",
				...a,
				interactionId: "q",
				token: l.answerToken("q", a.runId),
			});
		l.observe({
			kind: "result",
			...a,
			outcome: "error",
			error: { code: "real-error", retryable: false },
			token: l.queryToken(a.runId),
		});
		const confirmation =
			path === "acknowledgement"
				? l.observe({
						kind: "effect_outcome",
						outcome: { tag: "succeeded" },
						token: answer?.token ?? missing,
					})
				: probe
					? l.observe({
							kind: "probe_result",
							finding: { tag: "answer_consumed" },
							token: probe.token,
						})
					: l.observe({
							kind: "interaction_resolved",
							...a,
							interactionId: "q",
							token: l.answerToken("q", a.runId),
						});
		const after = l.state.active;
		const ended = l.observe({
			kind: "query_ended",
			...a,
			token: l.queryToken(a.runId),
		});
		expect(ended.ended).toContainEqual(
			expect.objectContaining({
				outcome: "error",
				reason: {
					kind: "provider_error",
					code: "real-error",
					retryable: false,
				},
			}),
		);
		expect(after?.tag).toBe("Settling");
		if (path === "duplicate_resolution")
			expect(confirmation).toMatchObject({
				tag: "Accepted",
				events: [],
				effects: [],
				ended: [],
				allEffects: [],
			});
	});
	it("Round 7 / finding 3: a stale native_busy sample cannot supersede a newer error result", () => {
		const l = ledger("opencode");
		const a = l.start();
		const probe = l
			.fire()
			.effects.find(({ effect }) => effect.kind === "probe");
		l.admit("B");
		l.observe({
			kind: "result",
			...a,
			outcome: "error",
			error: { code: "real-error", retryable: false },
			token: l.queryToken(a.runId),
		});
		l.observe({
			kind: "probe_result",
			finding: { tag: "native_busy" },
			token: probe?.token ?? missing,
		});
		const after = l.state.active;
		const ended = l.observe({
			kind: "query_ended",
			...a,
			token: l.queryToken(a.runId),
		});
		expect(ended.ended).toContainEqual(
			expect.objectContaining({
				outcome: "error",
				reason: {
					kind: "provider_error",
					code: "real-error",
					retryable: false,
				},
			}),
		);
		expect(after?.tag).toBe("Settling");
	});
});
describe("Run Ledger round 8 regressions", () => {
	it.each([
		"admit",
		"run_now",
	] as const)("Round 8 acceptance sibling: cancellation belongs to its admission across later %s", (verb) => {
		const l = ledger();
		const a = l.start();
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: a.admitted.effects[0]?.token ?? missing,
		});
		const steer = l.admit("B").effects[0];
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: steer?.token ?? missing,
		});
		l.control({ kind: "cancel_input", inputId: "B" });
		l.observe({
			kind: "input_accepted",
			...a,
			nativeMessageId: "native-B",
			token: l.inputToken("B", a.runId),
		});
		expect(l.state.inbox.some((input) => input.inputId === "B")).toBe(false);
		l.observe({ kind: "query_ended", ...a, token: l.queryToken(a.runId) });
		const again =
			verb === "admit"
				? l.admit("B")
				: l.control({ kind: "run_now", inputId: "B" });
		// Round 10 ruling 1: a new admission does not inherit the old admission's cancellation.
		expect(
			again.effects.some(
				({ effect }) =>
					(effect.kind === "start" || effect.kind === "steer") &&
					effect.inputId === "B",
			),
		).toBe(true);
	});
	it("Round 8 acceptance sibling: input_present reconciles a returned Declined input through the shared acceptance path", () => {
		const l = ledger();
		const a = l.start();
		const steer = l.admit("B").effects[0];
		const probe = l.observe({
			kind: "effect_outcome",
			outcome: { tag: "delivery_unknown" },
			token: steer?.token ?? missing,
		}).effects[0];
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "permanent", code: "transport-failed" },
			token: steer?.token ?? missing,
		});
		l.observe({
			kind: "probe_result",
			finding: {
				tag: "input_present",
				nativeMessageId: "native-B",
			},
			token: probe?.token ?? missing,
		});
		expect(l.state.inbox.some((input) => input.inputId === "B")).toBe(false);
		const ended = l.observe({
			kind: "query_ended",
			...a,
			token: l.queryToken(a.runId),
		});
		expect(
			ended.effects.some(
				({ effect }) => effect.kind === "start" && effect.inputId === "B",
			),
		).toBe(false);
	});
	it("Round 8 terminal sibling: retryability refines the same code and later generic evidence cannot erase it", () => {
		const l = ledger("opencode");
		const a = l.start();
		l.observe({
			kind: "result",
			...a,
			outcome: "error",
			error: { code: "KnownFailure", retryable: false },
			token: l.queryToken(a.runId),
		});
		const deadline = l.state.active?.deadline;
		l.ctx.now += 3;
		l.observe({
			kind: "result",
			...a,
			outcome: "error",
			error: { code: "KnownFailure", retryable: true },
			token: l.queryToken(a.runId),
		});
		l.observe({
			kind: "result",
			...a,
			outcome: "error",
			error: { code: "provider_error", retryable: false },
			token: l.queryToken(a.runId),
		});
		const refined = l.state.active;
		const ended = l.observe({
			kind: "query_ended",
			...a,
			token: l.queryToken(a.runId),
		});
		expect(refined?.deadline).toEqual(deadline);
		expect(ended.ended).toContainEqual(
			expect.objectContaining({
				reason: {
					kind: "provider_error",
					code: "KnownFailure",
					retryable: true,
				},
			}),
		);
	});
	it.each<ProviderKind>([
		"claude",
		"cursor",
		"opencode",
	])("Round 8 / finding 1: %s late acceptance consumes the returned input instead of starting it twice", (provider) => {
		const l = ledger(provider);
		const a = l.start();
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: a.admitted.effects[0]?.token ?? missing,
		});
		const steer = l.admit("B").effects[0];
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "permanent", code: "transport-failed" },
			token: steer?.token ?? missing,
		});
		l.observe({
			kind: "input_accepted",
			...a,
			nativeMessageId: "native-B",
			token: l.inputToken("B", a.runId),
		});

		const inbox = l.state.inbox;
		const ended = l.observe({
			kind: "query_ended",
			...a,
			token: l.queryToken(a.runId),
		});
		expect(
			ended.effects.some(
				({ effect }) => effect.kind === "start" && effect.inputId === "B",
			),
		).toBe(false);
		expect(inbox.some((input) => input.inputId === "B")).toBe(false);
	});
	it("Round 8 / finding 2: a resolved pending interaction retains its dedup identity until the run ends", () => {
		const l = ledger("opencode");
		const a = l.start();
		const request = {
			kind: "interaction_requested" as const,
			...a,
			interactionId: "q",
			interactionKind: "question" as const,
		};
		l.observe(request);
		l.observe({
			kind: "interaction_resolved",
			...a,
			interactionId: "q",
			token: l.answerToken("q", a.runId),
		});
		l.observe({
			kind: "result",
			...a,
			outcome: "error",
			error: { code: "ActualFailure", retryable: true },
			token: l.queryToken(a.runId),
		});
		const replay = l.observe(request);
		const ended = l.observe({
			kind: "query_ended",
			...a,
			token: l.queryToken(a.runId),
		});
		expect(ended.ended).toContainEqual(
			expect.objectContaining({
				outcome: "error",
				reason: {
					kind: "provider_error",
					code: "ActualFailure",
					retryable: true,
				},
			}),
		);
		expect(replay).toMatchObject({
			tag: "Accepted",
			events: [],
			effects: [],
			ended: [],
			allEffects: [],
		});
	});
	it("Round 8 / finding 3: stale cleanup busy evidence cannot retire a newer successor idle sample", () => {
		const l = ledger("opencode");
		const a = l.start();
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: a.admitted.effects[0]?.token ?? missing,
		});
		const interrupt = l.control({ kind: "stop" }).effects[0];
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: interrupt?.token ?? missing,
		});
		const cancel = l
			.fire()
			.effects.find(({ effect }) => effect.kind === "cancel_request");
		const fallback = l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: cancel?.token ?? missing,
		});
		const abort = fallback.effects.find(
			({ effect }) => effect.kind === "interrupt",
		);
		const oldProbe = fallback.effects.find(
			({ effect }) => effect.kind === "probe",
		);
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "retryable", retryAt: l.ctx.now + 1 },
			token: abort?.token ?? missing,
		});
		l.ctx.now++;
		const retried = l.send({
			verb: "settle",
			settlement: {
				kind: "alarm_fired",
			},
		});
		const successor = l.send({ verb: "admit", inputId: "B", runNow: true });
		const newProbe = successor.effects.find(
			({ effect }) => effect.kind === "probe",
		);
		l.observe({
			kind: "probe_result",
			finding: { tag: "native_busy" },
			token: oldProbe?.token ?? missing,
		});
		expect(l.state.live).toContainEqual(newProbe);
		l.observe({
			kind: "effect_outcome",
			token:
				retried.effects.find(({ effect }) => effect.kind === "interrupt")
					?.token ?? missing,
			outcome: { tag: "succeeded" },
		});
		const released = l.observe({
			kind: "probe_result",
			finding: { tag: "native_idle" },
			token: newProbe?.token ?? missing,
		});
		expect(
			released.effects.some(
				({ effect }) => effect.kind === "start" && effect.inputId === "B",
			),
		).toBe(true);
	});
	it("Round 8 / finding 4: detailed terminal evidence refines a generic error without extending settlement", () => {
		const l = ledger("opencode");
		const a = l.start();
		const base = {
			eventId: "e",
			sessionId: "session",
			provider: "opencode" as const,
			createdAt: l.ctx.now,
			metadata: { runId: a.runId },
		};
		const error = {
			...base,
			type: "session.status",
			data: { sessionId: "session", status: "error" },
		} satisfies CanonicalEvent;
		const detailed = {
			...base,
			type: "turn.error",
			data: {
				messageId: "assistant",
				error: "failed",
				code: "ActualFailure",
				retryable: true,
			},
		} satisfies CanonicalEvent;
		const idle = {
			...base,
			type: "session.status",
			data: { sessionId: "session", status: "idle" },
		} satisfies CanonicalEvent;
		const observe = (event: CanonicalEvent) => {
			const observation = classifyRunTerminal(event, "opencode", true, a);
			if (!observation) expect.fail("Expected terminal");
			return l.observe(observation);
		};
		observe(error);
		const deadline = l.state.active?.deadline;
		l.ctx.now += 3;
		observe(detailed);
		const refined = l.state.active;
		const duplicate = observe(detailed);
		const ended = observe(idle);
		expect(ended.ended).toContainEqual(
			expect.objectContaining({
				outcome: "error",
				reason: {
					kind: "provider_error",
					code: "ActualFailure",
					retryable: true,
				},
			}),
		);
		expect(refined?.deadline).toEqual(deadline);
		expect(duplicate).toMatchObject({
			tag: "Accepted",
			events: [],
			effects: [],
			ended: [],
			allEffects: [],
		});
	});
});
describe("Run Ledger round 9 review regressions", () => {
	it.each<ProviderKind>([
		"claude",
		"cursor",
	])("Round 9 / finding 1: %s closure cannot erase ambiguous start delivery", (provider) => {
		const l = ledger(provider);
		const admitted = l.admit("A");
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "delivery_unknown" },
			token: admitted.effects[0]?.token ?? missing,
		});
		const closed = l.fire();
		const close = closed.effects.find(({ effect }) => effect.kind === "close");
		l.admit("A");
		const acknowledged = l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: close?.token ?? missing,
		});
		expect(
			acknowledged.effects.some(
				({ effect }) => effect.kind === "start" && effect.inputId === "A",
			),
		).toBe(false);
		expect(l.uncertain("A")).toBe(true);
		expect(
			l.work.some(
				({ effect }) =>
					effect.kind === "probe" &&
					effect.target.tag === "input" &&
					effect.target.inputId === "A",
			),
		).toBe(true);
	});
	it.each<ProviderKind>([
		"claude",
		"cursor",
		"opencode",
	])("Round 9 / finding 2: %s failed steer reconciles acceptance after its run ended", (provider) => {
		const l = ledger(provider);
		const a = l.start();
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: a.admitted.effects[0]?.token ?? missing,
		});
		const steer = l.admit("B").effects[0];
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "permanent", code: "failed" },
			token: steer?.token ?? missing,
		});
		const ended = l.observe({
			kind: "query_ended",
			...a,
			token: l.queryToken(a.runId),
		});
		const accepted = l.observe({
			kind: "input_accepted",
			...a,
			nativeMessageId: "native-B",
			token: l.inputToken("B", a.runId),
		});
		expect(
			[...ended.effects, ...accepted.effects].some(
				({ effect }) =>
					(effect.kind === "start" || effect.kind === "steer") &&
					effect.inputId === "B",
			),
		).toBe(false);

		expect(l.state.inbox.some((input) => input.inputId === "B")).toBe(false);
	});
	it("Round 9 / finding 3: late provider-handled retry evidence cannot mutate a Cursor Tombstone", () => {
		const l = ledger("cursor");
		const a = l.start();
		for (const retryHandled of [false, true]) {
			const event: CanonicalEvent = {
				eventId: "error",
				sessionId: "session",
				provider: "cursor",
				createdAt: l.ctx.now,
				metadata: { runId: a.runId },
				type: "turn.error",
				data: {
					messageId: "assistant",
					error: "failed",
					code: "SameFailure",
					retryable: true,
					retryHandled,
				},
			};
			const observation = classifyRunTerminal(event, "cursor", true, a);
			if (!observation) expect.fail("Expected terminal");
			l.observe(observation);
		}
		const ended = l.observe({
			kind: "query_ended",
			...a,
			token: l.queryToken(a.runId),
		});
		expect(ended.ended).toEqual([]);
		expect(l.ended).toHaveLength(1);
		expect(l.ended).toContainEqual(
			expect.objectContaining({
				outcome: "error",
				reason: {
					kind: "provider_error",
					code: "SameFailure",
					retryable: true,
				},
			}),
		);
	});
	it.each<ProviderKind>([
		"claude",
		"cursor",
		"opencode",
	])("Round 9 / finding 4: %s Stop confirmed by query closure remains interrupted", (provider) => {
		const l = ledger(provider);
		const a = l.start();
		l.control({ kind: "stop" });
		const ended = l.observe({
			kind: "query_ended",
			...a,
			token: l.queryToken(a.runId),
		});
		expect(ended.ended).toContainEqual(
			expect.objectContaining({
				outcome: "interrupted",
				reason: { kind: "interrupted", by: "stop", forced: false },
			}),
		);
	});
	it("Round 9 / finding 5: an owned resolution preceding its request cannot resurrect the interaction", () => {
		const l = ledger("opencode");
		const a = l.start();
		l.observe({
			kind: "interaction_resolved",
			...a,
			interactionId: "q",
			token: l.answerToken("q", a.runId),
		});
		l.observe({
			kind: "result",
			...a,
			outcome: "error",
			error: { code: "ActualFailure", retryable: true },
			token: l.queryToken(a.runId),
		});
		const request = l.observe({
			kind: "interaction_requested",
			...a,
			interactionId: "q",
			interactionKind: "question",
			token: l.queryToken(a.runId),
		});
		const ended = l.observe({
			kind: "query_ended",
			...a,
			token: l.queryToken(a.runId),
		});
		expect(request).toMatchObject({
			tag: "Accepted",
			events: [],
			effects: [],
			ended: [],
			allEffects: [],
		});
		expect(ended.ended).toContainEqual(
			expect.objectContaining({
				outcome: "error",
				reason: {
					kind: "provider_error",
					code: "ActualFailure",
					retryable: true,
				},
			}),
		);
	});
});
describe("Round 9 knowledge siblings", () => {
	it("Round 9 sibling: an input probe finding still reconciles delivery after its owner is tombstoned", () => {
		const { l, a, probe } = preparedProbe("input");
		l.observe({ kind: "query_ended", ...a, token: l.queryToken(a.runId) });
		l.observe({
			kind: "probe_result",
			finding: {
				tag: "input_present",
				nativeMessageId: "native-B",
			},
			token: probe?.token ?? missing,
		});
		expect(l.input("B")?.state).toMatchObject({
			tag: "Accepted",
			nativeMessageId: "native-B",
		});
	});
});
it("Round 9 delayed-trace sibling: a permanent delivery report after effect retirement still prevents resend", () => {
	const l = ledger("opencode");
	const a = l.start();
	l.send({ verb: "settle", settlement: { kind: "project_inactive" } });
	l.observe({
		kind: "effect_outcome",
		outcome: { tag: "permanent", code: "transport_failed" },
		token: a.admitted.effects[0]?.token ?? missing,
	});
	l.control({ kind: "resume" });
	const again = l.admit("A");
	expect(
		again.effects.some(
			({ effect }) =>
				(effect.kind === "start" || effect.kind === "steer") &&
				effect.inputId === "A",
		),
	).toBe(false);
	expect(l.uncertain("A")).toBe(true);
});
it("Round 9 cancellation sibling: local cancellation and closure do not prove uncertain native delivery absent", () => {
	const l = ledger();
	const a = l.start();
	const steer = l.admit("B").effects[0];
	l.observe({
		kind: "effect_outcome",
		outcome: { tag: "delivery_unknown" },
		token: steer?.token ?? missing,
	});
	l.control({ kind: "cancel_input", inputId: "B" });
	l.observe({ kind: "query_ended", ...a, token: l.queryToken(a.runId) });
	l.admit("B");
	expect(l.input("B")?.uncertain).toBe(true);
});
it("Round 9 refinement sibling: an answer issued before refined terminal evidence cannot supersede that evidence", () => {
	const l = ledger("opencode");
	const a = l.start();
	l.observe({
		kind: "interaction_requested",
		...a,
		interactionId: "q",
		interactionKind: "question",
		token: l.queryToken(a.runId),
	});
	l.observe({
		kind: "result",
		...a,
		outcome: "error",
		token: l.queryToken(a.runId),
	});
	const answer = l.control({
		kind: "answer",
		interactionId: "q",
		answer: "yes",
	}).effects[0];
	l.observe({
		kind: "result",
		...a,
		outcome: "error",
		error: { code: "ActualFailure", retryable: true },
		token: l.queryToken(a.runId),
	});
	l.observe({
		kind: "effect_outcome",
		outcome: { tag: "succeeded" },
		token: answer?.token ?? missing,
	});
	const ended = l.observe({
		kind: "query_ended",
		...a,
		token: l.queryToken(a.runId),
	});
	expect(ended.ended).toContainEqual(
		expect.objectContaining({
			outcome: "error",
			reason: {
				kind: "provider_error",
				code: "ActualFailure",
				retryable: true,
			},
		}),
	);
});
it("Round 9 cleanup sibling: close acknowledgement preserves an outstanding input probe finding", () => {
	const { l, probe } = preparedProbe("input");
	l.fire();
	const close = l.fire().effects.find(({ effect }) => effect.kind === "close");
	l.observe({
		kind: "effect_outcome",
		outcome: { tag: "succeeded" },
		token: close?.token ?? missing,
	});
	l.observe({
		kind: "probe_result",
		finding: {
			tag: "input_present",
			nativeMessageId: "native-B",
		},
		token: probe?.token ?? missing,
	});
	expect(l.input("B")?.state).toMatchObject({
		tag: "Accepted",
		nativeMessageId: "native-B",
	});
});
it.each([
	"input",
	"interaction",
] as const)("Round 9 probe sibling: terminal failure retires a %s probe correlation", (target) => {
	const { l, probe } = preparedProbe(target);
	l.observe({
		kind: "effect_outcome",
		outcome: { tag: "permanent", code: "failed" },
		token: probe?.token ?? missing,
	});
	expect(l.work.some((item) => item.token === probe?.token)).toBe(false);
});
it("Round 9 bounded-evidence sibling: explicit failure evidence after Stop survives terminal history eviction", () => {
	const l = ledger("opencode");
	const a = l.start();
	l.control({ kind: "stop" });
	for (let i = 0; i < 130; i++)
		l.observe({
			kind: "result",
			...a,
			outcome: "error",
			error: { code: "Failure", retryable: i % 2 === 0 },
			token: l.queryToken(a.runId),
		});
	const ended = l.observe({
		kind: "query_ended",
		...a,
		token: l.queryToken(a.runId),
	});
	expect(ended.ended).toContainEqual(
		expect.objectContaining({
			outcome: "error",
			reason: { kind: "provider_error", code: "Failure", retryable: false },
		}),
	);
});
describe("Round 10 admission provenance", () => {
	it.each<ProviderKind>([
		"claude",
		"cursor",
		"opencode",
	])("Round 10 / finding 1: %s old acceptance cannot consume a re-admission", (provider) => {
		const l = ledger(provider);
		const a = l.start();
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: a.admitted.effects[0]?.token ?? missing,
		});
		l.observe({
			kind: "input_accepted",
			...a,
			nativeMessageId: "old-A",
			token: l.inputToken("A", a.runId),
		});
		l.observe({
			kind: "result",
			...a,
			outcome: "error",
			error: { code: "Retry", retryable: true },
			token: l.queryToken(a.runId),
		});
		l.observe({ kind: "query_ended", ...a, token: l.queryToken(a.runId) });
		l.control({ kind: "stop" });
		l.admit("A");
		l.observe({
			kind: "input_accepted",
			...a,
			nativeMessageId: "old-A",
			token: l.inputToken("A", a.runId),
		});
		expect(l.state.inbox.map((input) => input.inputId)).toEqual(["A"]);
		const resumed = l.control({ kind: "resume" });
		expect(
			resumed.effects.some(
				({ effect }) => effect.kind === "start" && effect.inputId === "A",
			),
		).toBe(true);
	});
});
it.each<ProviderKind>([
	"claude",
	"cursor",
	"opencode",
])("Round 10 / finding 2: %s explicit failures after Stop retain their cause", (provider) => {
	const l = ledger(provider);
	const first = l.admit("A").effects[0];
	l.control({ kind: "run_now", inputId: "A" });
	const refused = l.observe({
		kind: "effect_outcome",
		outcome: { tag: "permanent", code: "StartRefused" },
		token: first?.token ?? missing,
	});
	expect(refused.ended).toContainEqual(
		expect.objectContaining({
			outcome: "error",
			reason: { kind: "refused", code: "StartRefused" },
		}),
	);
	const crashed = ledger(provider);
	const a = crashed.start();
	crashed.control({ kind: "stop" });
	const lost = crashed.send({
		verb: "settle",
		settlement: {
			kind: "process_lost",
			...a,
			token: crashed.queryToken(a.runId),
		},
	});
	expect(lost.ended).toContainEqual(
		expect.objectContaining({
			outcome: "error",
			reason: { kind: "process_lost" },
		}),
	);
});
it.each<ProviderKind>([
	"claude",
	"cursor",
	"opencode",
])("Round 10 / finding 3: %s late acceptance retires the fulfilled queued reservation", (provider) => {
	const l = ledger(provider);
	const a = l.start();
	l.observe({
		kind: "effect_outcome",
		outcome: { tag: "succeeded" },
		token: a.admitted.effects[0]?.token ?? missing,
	});
	const steer = l.admit("B").effects[0];
	l.observe({
		kind: "effect_outcome",
		outcome: { tag: "permanent", code: "Failed" },
		token: steer?.token ?? missing,
	});
	l.observe({ kind: "query_ended", ...a, token: l.queryToken(a.runId) });
	const reservation = l.state.active?.runId;
	expect(l.state.active?.tag).toBe("Queued");
	const accepted = l.observe({
		kind: "input_accepted",
		...a,
		nativeMessageId: "native-B",
		token: l.inputToken("B", a.runId),
	});
	expect(l.state.active?.tag).toBe("Queued");
	expect(l.ended.some((ended) => ended.runId === reservation)).toBe(false);
	expect(
		accepted.effects.some(
			({ effect }) => effect.kind === "start" && effect.inputId === "B",
		),
	).toBe(false);
	l.admit("C");
	expect(l.state.active?.inputs[0]?.inputId).toBe("C");
});
it.each<ProviderKind>([
	"claude",
	"cursor",
	"opencode",
])("Round 10 / finding 4: %s specific failure survives 128 changing generic reports", (provider) => {
	const l = ledger(provider);
	const a = l.start();
	l.observe({
		kind: "result",
		...a,
		outcome: "error",
		error: { code: "ActualFailure", retryable: true },
		token: l.queryToken(a.runId),
	});
	for (let i = 0; i < 128; i++)
		l.observe({
			kind: "result",
			...a,
			outcome: "error",
			error: { code: "provider_error", retryable: i % 2 === 0 },
			token: l.queryToken(a.runId),
		});
	const ended = l.observe({
		kind: "query_ended",
		...a,
		token: l.queryToken(a.runId),
	});
	if (provider !== "opencode") expect(ended.ended).toEqual([]);
	expect(l.ended).toHaveLength(1);
	expect(l.ended).toContainEqual(
		expect.objectContaining({
			outcome: "error",
			reason: {
				kind: "provider_error",
				code: "ActualFailure",
				retryable: true,
			},
		}),
	);
});
it("Round 10 / finding 4 sibling: native completion during Stop survives more than 128 reports", () => {
	const l = ledger();
	const a = l.start();
	l.control({ kind: "stop" });
	l.observe({
		kind: "result",
		...a,
		outcome: "completed",
		token: l.queryToken(a.runId),
	});
	for (let i = 0; i < 130; i++)
		l.observe({
			kind: "result",
			...a,
			outcome: "error",
			error: { code: "provider_error", retryable: i % 2 === 0 },
			token: l.queryToken(a.runId),
		});
	const ended = l.observe({
		kind: "query_ended",
		...a,
		token: l.queryToken(a.runId),
	});
	expect(ended.ended).toEqual([]);
	expect(l.ended).toHaveLength(1);
	expect(l.ended).toContainEqual(
		expect.objectContaining({
			outcome: "completed",
			reason: { kind: "completed" },
		}),
	);
});
it.each<ProviderKind>([
	"claude",
	"cursor",
	"opencode",
])("Round 10 sibling: %s an old input probe resolves only its delivering admission", (provider) => {
	const l = ledger(provider);
	const a = l.start();
	const unknown = l.observe({
		kind: "effect_outcome",
		outcome: { tag: "delivery_unknown" },
		token: a.admitted.effects[0]?.token ?? missing,
	});
	const probe = unknown.effects.find(({ effect }) => effect.kind === "probe");
	l.observe({
		kind: "input_accepted",
		...a,
		nativeMessageId: "old-A",
		token: l.inputToken("A", a.runId),
	});
	l.observe({
		kind: "effect_outcome",
		outcome: { tag: "succeeded" },
		token: a.admitted.effects[0]?.token ?? missing,
	});
	l.observe({ kind: "query_ended", ...a, token: l.queryToken(a.runId) });
	l.control({ kind: "stop" });
	l.admit("A");
	const next = l.input("A");
	l.observe({
		kind: "probe_result",
		finding: { tag: "input_present", nativeMessageId: "old-A" },
		token: probe?.token ?? missing,
	});
	expect(l.input("A")).toEqual(next);
	expect(l.state.inbox.map(({ inputId }) => inputId)).toEqual(["A"]);
});
it("Round 10 sibling: interaction identities are scoped to their run across re-admissions", () => {
	const l = ledger();
	const a = l.start();
	l.observe({
		kind: "interaction_resolved",
		...a,
		interactionId: "q",
		token: l.answerToken("q", a.runId),
	});
	l.observe({ kind: "query_ended", ...a, token: l.queryToken(a.runId) });
	const b = l.start("B");
	l.observe({
		kind: "interaction_requested",
		...b,
		interactionId: "q",
		interactionKind: "question",
		token: l.queryToken(b.runId),
	});
	l.observe({
		kind: "interaction_resolved",
		...a,
		interactionId: "q",
		token: l.answerToken("q", a.runId),
	});
	expect(l.state.active?.interactions).toEqual([
		{ tag: "Pending", interactionId: "q", kind: "question" },
	]);
});
it.each([
	"input_absent",
	"input_present",
] as const)("Round 10 provenance sibling: %s for an older admission cannot end its queued replacement", (tag) => {
	const l = ledger();
	const a = l.start();
	l.observe({
		kind: "effect_outcome",
		outcome: { tag: "delivery_unknown" },
		token: a.admitted.effects[0]?.token ?? missing,
	});
	l.observe({ kind: "query_ended", ...a, token: l.queryToken(a.runId) });
	const queued = l.admit("A");
	const replacement = l.state.active?.runId;
	const probe = queued.effects.find(
		({ effect }) => effect.kind === "probe" && effect.target.tag === "input",
	);
	expect(probe).toBeDefined();
	const proof = l.observe({
		kind: "probe_result",
		finding: { tag },
		token: probe?.token ?? missing,
	});
	expect(l.state.active?.runId).toBe(replacement);
	expect(proof.ended.some((ended) => ended.runId === replacement)).toBe(false);
	expect(proof.effects.some(({ effect }) => effect.kind === "start")).toBe(
		false,
	);
});
it("Round 10 Stop sibling: a native completion observed before cleanup failure still wins", () => {
	const l = ledger();
	const a = l.start();
	l.control({ kind: "stop" });
	l.observe({
		kind: "result",
		...a,
		outcome: "completed",
		token: l.queryToken(a.runId),
	});
	const ended = l.send({
		verb: "settle",
		settlement: { kind: "process_lost", ...a, token: l.queryToken(a.runId) },
	});
	expect(ended.ended).toEqual([]);
	expect(l.ended).toHaveLength(1);
	expect(l.ended).toContainEqual(
		expect.objectContaining({
			outcome: "completed",
			reason: { kind: "completed" },
		}),
	);
});
it("Round 10 admission sibling: cancellation of an older accepted admission cannot block a new explicit admission", () => {
	const l = ledger();
	const a = l.start();
	l.admit("B");
	l.control({ kind: "cancel_input", inputId: "B" });
	l.observe({
		kind: "input_accepted",
		...a,
		nativeMessageId: "cancelled-old-B",
		token: l.inputToken("B", a.runId),
	});
	l.observe({ kind: "query_ended", ...a, token: l.queryToken(a.runId) });
	const next = l.admit("B");
	expect(
		next.effects.some(
			({ effect }) => effect.kind === "start" && effect.inputId === "B",
		),
	).toBe(true);
});
it.each<ProviderKind>([
	"claude",
	"cursor",
	"opencode",
])("Round 10 ownership sibling: %s an unsent queued reservation cannot own a native receipt", (provider) => {
	const l = ledger(provider);
	l.start();
	l.control({ kind: "stop" });
	l.fire();
	l.control({ kind: "run_now", inputId: "B" });
	const reservation = l.state.active?.runId ?? missing;
	expect(l.state.active?.tag).toBe("Queued");
	l.control({ kind: "stop" });
	const receipt = l.observe({
		kind: "input_accepted",
		token: l.inputToken("B", reservation),
	});
	expect(receipt).toMatchObject({
		tag: "Accepted",
		events: [],
		effects: [],
		ended: [],
		allEffects: [],
	});
	expect(l.state.inbox.map((input) => input.inputId)).toEqual(["B"]);
});
it.each<ProviderKind>([
	"claude",
	"cursor",
	"opencode",
])("Round 10 reservation sibling: %s non-delivery proof releases the unsent queued admission", (provider) => {
	const l = ledger(provider);
	const start = l.admit("A").effects[0];
	const a = {
		runId: l.state.active?.runId ?? missing,
		token: start?.token ?? missing,
	};
	l.observe({
		kind: "effect_outcome",
		outcome: { tag: "succeeded" },
		token: start?.token ?? missing,
	});
	const steer = l.admit("B").effects[0];
	l.observe({
		kind: "effect_outcome",
		outcome: { tag: "permanent", code: "failed" },
		token: steer?.token ?? missing,
	});
	const closed = l.observe({
		kind: "query_ended",
		...a,
		token: l.queryToken(a.runId),
	});
	const reservation = l.state.active?.runId;
	const probe = closed.effects.find(
		({ effect }) => effect.kind === "probe" && effect.target.tag === "input",
	);
	const finding = l.observe({
		kind: "probe_result",
		finding: { tag: "input_absent" },
		token: probe?.token ?? missing,
	});
	expect(l.state.active?.runId).toBe(reservation);
	expect(l.state.active?.tag).toBe("Queued");
	expect(finding.effects.some(({ effect }) => effect.kind === "start")).toBe(
		false,
	);
});
describe("Run Ledger round 11 review regressions", () => {
	it.each<ProviderKind>([
		"claude",
		"cursor",
	])("Round 11 / finding 1: %s retires pre-transmission input probes before reusing an admission", (provider) => {
		const l = ledger(provider);
		const a = l.start();
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: a.admitted.effects[0]?.token ?? missing,
		});
		const steer = l.admit("B").effects[0];
		const unknown = l.observe({
			kind: "effect_outcome",
			outcome: { tag: "delivery_unknown" },
			token: steer?.token ?? missing,
		});
		const p = unknown.effects.find(({ effect }) => effect.kind === "probe");
		const ended = l.observe({
			kind: "query_ended",
			...a,
			token: l.queryToken(a.runId),
		});
		const q = ended.effects.find(
			({ effect }) => effect.kind === "probe" && effect.target.tag === "input",
		);
		expect(q).toBeDefined();
		const released = l.observe({
			kind: "probe_result",
			finding: { tag: "input_absent" },
			token: p?.token ?? missing,
		});
		expect(released.effects.some(({ effect }) => effect.kind === "start")).toBe(
			false,
		);
		const releasedByControl = l.control({ kind: "resume" });
		const start = releasedByControl.effects.find(
			({ effect }) => effect.kind === "start",
		);
		expect(start).toBeDefined();
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "delivery_unknown" },
			token: start?.token ?? missing,
		});
		const before = l.state;
		const stale = l.observe({
			kind: "probe_result",
			finding: { tag: "input_absent" },
			token: q?.token ?? missing,
		});
		expect(stale.effects).toEqual([]);
		expect(stale.ended).toEqual([]);
		expect(l.state).toEqual(before);
		expect(l.uncertain("B")).toBe(true);
		expect(
			l.admit("B").effects.some(({ effect }) => effect.kind === "start"),
		).toBe(false);
	});
});
describe("Run Ledger round 12 review regressions", () => {
	it("Round 12 / finding 1: replayed pre-retry steer receipt cannot release the OpenCode fence", () => {
		const l = ledger("opencode");
		const a = l.start();
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: a.admitted.effects[0]?.token ?? missing,
		});
		const e = l.admit("B").effects[0];
		const receipt = {
			kind: "effect_outcome" as const,
			token: e?.token ?? missing,
			outcome: { tag: "retryable" as const, retryAt: l.ctx.now + 1 },
		};
		l.observe(receipt);
		l.ctx.now++;
		const retried = l.send({
			verb: "settle",
			settlement: {
				kind: "alarm_fired",
			},
		});
		const stopped = l.control({ kind: "run_now", inputId: "C" });
		const interrupt = stopped.effects.find(
			({ effect }) => effect.kind === "interrupt",
		);
		l.observe({
			kind: "effect_outcome",
			outcome: { tag: "succeeded" },
			token: interrupt?.token ?? missing,
		});
		l.ctx.now = l.state.active?.deadline.at ?? l.ctx.now;
		l.fire();
		const replay = l.observe(receipt);
		expect(replay).toMatchObject({
			tag: "Accepted",
			events: [],
			effects: [],
			ended: [],
			allEffects: [],
		});
		expect(l.state.active?.tag).toBe("Queued");
		expect(retried.effects[0]?.token).not.toBe(e?.token);
	});
	it("Round 12 / finding 2: conflicting terminal reports keep the original settlement deadline", () => {
		const l = ledger("opencode");
		l.ctx.now = 0;
		const a = l.start();
		l.observe({
			kind: "result",
			...a,
			outcome: "error",
			error: { code: "ActualFailure", retryable: false },
			token: l.queryToken(a.runId),
		});
		const deadline = l.state.active?.deadline;
		l.ctx.now = 30;
		l.observe({
			kind: "result",
			...a,
			outcome: "completed",
			token: l.queryToken(a.runId),
		});
		expect(l.state.active?.deadline).toEqual(deadline);
		expect(l.state.active).toMatchObject({
			tag: "Settling",
		});
		const ended = l.send({
			verb: "settle",
			settlement: {
				kind: "alarm_fired",
			},
		});
		expect(ended.ended).toContainEqual(
			expect.objectContaining({ runId: a.runId }),
		);
	});
	it.each<ProviderKind>([
		"claude",
		"cursor",
		"opencode",
	])("Round 12 / finding 3: %s cancels an unsent Queued reservation without transmitting it", (provider) => {
		const l = ledger(provider);
		l.admit("A");
		const cleanup = l.fire();
		l.admit("B");
		const reservation = l.state.active?.runId;
		expect(l.state.active?.tag).toBe("Queued");
		const cancelled = l.control({ kind: "cancel_input", inputId: "B" });
		expect(l.state.active).toBeUndefined();

		expect(
			cancelled.effects.every(({ effect }) => effect.kind === "probe"),
		).toBe(true);
		expect(cancelled.ended[0]).toMatchObject({
			runId: reservation,
			outcome: "interrupted",
		});
		expect(l.ended.some((ended) => ended.runId === reservation)).toBe(true);
		l.admit("C");
		for (const issued of cleanup.effects)
			l.observe({
				kind: "effect_outcome",
				outcome: { tag: "succeeded" },
				token: issued.token,
			});
		for (const pending of [...l.work])
			if (
				pending.effect.kind === "probe" &&
				pending.effect.target.tag === "native_session"
			)
				l.observe({
					kind: "probe_result",
					finding: { tag: "native_idle" },
					token: pending.token,
				});

		expect(l.state.active?.inputs[0]?.inputId).toBe("C");
	});
});
function retryableTransmission(kind: (typeof variants.effects)[number]) {
	if (kind === "probe") {
		const { l, probe } = preparedProbe("native_session");
		return { l, issued: probe };
	}
	if (kind === "start") {
		const l = ledger();
		return { l, issued: l.admit("A").effects[0] };
	}
	const l = ledger(kind === "cancel_request" ? "opencode" : "claude");
	const a = l.start();
	let issued = a.admitted.effects.find(({ effect }) => effect.kind === kind);
	switch (kind) {
		case "steer":
			issued = l.admit("B").effects[0];
			break;
		case "deliver_answer":
			l.observe({
				kind: "interaction_requested",
				...a,
				interactionId: "q",
				interactionKind: "question",
				token: l.queryToken(a.runId),
			});
			issued = l.control({ kind: "answer", interactionId: "q", answer: "yes" })
				.effects[0];
			break;
		case "interrupt":
			issued = l.control({ kind: "stop" }).effects[0];
			break;
		case "end_session":
			issued = l.control({ kind: "end" }).effects[0];
			break;
		case "close":
		case "cancel_request":
		case "kill_and_respawn":
		case "quarantine": {
			l.control({ kind: "stop" });
			const close = l
				.fire()
				.effects.find(
					({ effect }) =>
						effect.kind === "close" || effect.kind === "cancel_request",
				);
			issued = close;
			if (kind === "kill_and_respawn" || kind === "quarantine") {
				const kill = l
					.observe({
						kind: "effect_outcome",
						outcome: { tag: "permanent", code: "close_failed" },
						token: close?.token ?? missing,
					})
					.effects.find(({ effect }) => effect.kind === "kill_and_respawn");
				issued = kill;
				if (kind === "quarantine")
					issued = l
						.observe({
							kind: "effect_outcome",
							outcome: { tag: "permanent", code: "kill_failed" },
							token: kill?.token ?? missing,
						})
						.effects.find(({ effect }) => effect.kind === "quarantine");
			}
			break;
		}
		default:
			kind satisfies never;
	}
	return { l, issued };
}
it.each(
	variants.effects.flatMap((kind) =>
		variants.outcomes.map((outcome) => ({ kind, outcome })),
	),
)("Round 12 receipt audit: retired $kind transmission ignores $outcome", ({
	kind,
	outcome,
}) => {
	const { l, issued } = retryableTransmission(kind);
	expect(issued?.effect.kind).toBe(kind);
	const oldId = issued?.token ?? missing;
	l.observe({
		kind: "effect_outcome",
		outcome: { tag: "retryable", retryAt: l.ctx.now + 1 },
		token: oldId,
	});
	l.ctx.now++;
	const retry = l.send({
		verb: "settle",
		settlement: { kind: "alarm_fired" },
	});
	expect(retry.effects[0]?.token).toBeDefined();
	expect(retry.effects[0]?.token).not.toBe(oldId);
	const before = l.state;
	expect(
		l.observe({
			kind: "effect_outcome",
			outcome: generatedOutcome(outcome, l.ctx.now),
			token: oldId,
		}),
	).toMatchObject({
		tag: "Accepted",
		events: [],
		effects: [],
		ended: [],
		allEffects: [],
	});
	expect(l.state).toEqual(before);
});
it.each(
	variants.probeTargets,
)("Round 12 probe audit: retired %s findings cannot change the fresh lifecycle sample", (target) => {
	const { l, probe, finding } = preparedProbe(target);
	const oldId = probe?.token ?? missing;
	l.observe({
		kind: "effect_outcome",
		outcome: { tag: "retryable", retryAt: l.ctx.now + 1 },
		token: oldId,
	});
	l.ctx.now++;
	const retry = l.send({
		verb: "settle",
		settlement: { kind: "alarm_fired" },
	});
	expect(retry.effects[0]?.token).not.toBe(oldId);
	const before = l.state;
	const replay = l.observe({ kind: "probe_result", finding, token: oldId });
	expect(replay.effects).toEqual([]);
	expect(replay.ended).toEqual([]);
	expect(l.state.active?.tag).toBe(before.active?.tag);
	expect(l.state.active?.deadline).toEqual(before.active?.deadline);
	if (target === "native_session") expect(replay.events).toEqual([]);
});
describe("Deterministic public replacements for former oracle cases", () => {
	const providers: readonly ProviderKind[] = ["claude", "cursor", "opencode"];
	it.each(
		providers,
	)("Round 5 / finding 2 property: %s decline and delivery_unknown commute", (provider) => {
		const run = (unknownFirst: boolean) => {
			const l = ledger(provider);
			const a = l.start();
			l.observe({
				kind: "effect_outcome",
				token: a.token,
				outcome: { tag: "succeeded" },
			});
			const steer = l.admit("B").effects[0];
			const decline = () =>
				l.observe({
					kind: "input_declined",
					token: steer?.token ?? missing,
					reason: "declined",
				});
			const unknown = () =>
				l.observe({
					kind: "effect_outcome",
					token: steer?.token ?? missing,
					outcome: { tag: "delivery_unknown" },
				});
			(unknownFirst ? unknown : decline)();
			(unknownFirst ? decline : unknown)();
			const ended = l.observe({ kind: "query_ended", token: a.token });
			return {
				active: l.state.active?.tag,
				inbox: l.state.inbox,
				effects: ended.effects.map((send) => send.effect),
			};
		};
		expect(run(true)).toEqual(run(false));
	});
	it.each(
		providers,
	)("Round 6 / finding 3 property: %s uncertainty survives ambiguity in either receipt order", (provider) => {
		for (const nativeFirst of [false, true])
			for (const cancel of [false, true])
				for (const permanent of [false, true]) {
					const l = ledger(provider);
					const initial = l.admit("A");
					if (cancel)
						l.observe({
							kind: "started",
							token: initial.effects[0]?.token ?? missing,
						});
					const inputId = cancel ? "B" : "A";
					const send = cancel
						? l.admit(inputId).effects[0]
						: initial.effects[0];
					const token = send?.token ?? missing;
					l.observe({
						kind: "effect_outcome",
						token,
						outcome: { tag: "delivery_unknown" },
					});
					const native = () =>
						cancel
							? l.control({ kind: "cancel_input", inputId })
							: l.observe({ kind: "input_accepted", token });
					const transport = () =>
						l.observe({
							kind: "effect_outcome",
							token,
							outcome:
								cancel && permanent
									? { tag: "permanent", code: "failed" }
									: { tag: "succeeded" },
						});
					(nativeFirst ? native : transport)();
					if (!cancel) expect(l.uncertain(inputId)).toBe(!nativeFirst);
					(nativeFirst ? transport : native)();
					if (cancel) l.admit(inputId);
					expect(l.uncertain(inputId)).toBe(cancel);
				}
	});
	it.each(
		providers,
	)("Round 7 freshness property: %s answer receipts preserve terminal evidence at every issue order", (provider) => {
		for (const afterResult of [false, true])
			for (const path of ["ack", "resolution", "probe"] as const) {
				const l = ledger(provider);
				const a = l.start();
				l.observe({
					kind: "interaction_requested",
					token: a.token,
					interactionId: "q",
					interactionKind: "question",
				});
				const result = () =>
					l.observe({
						kind: "result",
						token: a.token,
						outcome: "error",
						error: { code: "prior-error", retryable: false },
					});
				if (afterResult) result();
				if (afterResult && provider !== "opencode") {
					expect(
						l.inspect({
							verb: "control",
							control: { kind: "answer", interactionId: "q", answer: "yes" },
						}),
					).toMatchObject({ tag: "Rejected" });
					expect(l.ended).toMatchObject([
						{
							runId: a.runId,
							outcome: "error",
							reason: { code: "prior-error" },
						},
					]);
					continue;
				}
				const answer = l.control({
					kind: "answer",
					interactionId: "q",
					answer: "yes",
				}).effects[0];
				const probe =
					path === "probe"
						? l.observe({
								kind: "effect_outcome",
								token: answer?.token ?? missing,
								outcome: { tag: "delivery_unknown" },
							}).effects[0]
						: undefined;
				if (!afterResult) result();
				const deadline = l.state.active?.deadline;
				if (provider !== "opencode")
					expect(l.alarmAt).toBe(provider === "claude" ? 130 : undefined);
				if (probe)
					l.observe({
						kind: "probe_result",
						token: probe.token,
						finding: { tag: "answer_consumed" },
					});
				else if (path === "ack")
					l.observe({
						kind: "effect_outcome",
						token: answer?.token ?? missing,
						outcome: { tag: "succeeded" },
					});
				else
					l.observe({
						kind: "interaction_resolved",
						token: answer?.token ?? missing,
						interactionId: "q",
					});
				if (provider === "opencode")
					expect(l.state.active?.deadline).toEqual(deadline);
				else expect(l.alarmAt).toBe(provider === "claude" ? 130 : undefined);
				expect(l.state.active?.tag).toBe(
					provider === "opencode" ? "Settling" : undefined,
				);
				const ended = l.observe({ kind: "query_ended", token: a.token });
				if (provider !== "opencode") expect(ended.ended).toEqual([]);
				expect(l.ended).toHaveLength(1);
				expect(l.ended[0]).toMatchObject({
					outcome: "error",
					reason: {
						kind: "provider_error",
						code: "prior-error",
						retryable: false,
					},
				});
			}
	});
	it("Round 6 / finding 4: renewed admissions cannot inherit the earlier obligation's settlement", () => {
		const l = ledger();
		const first = l.start();
		l.observe({ kind: "input_accepted", token: first.token });
		l.observe({ kind: "query_ended", token: first.token });
		const next = l.admit("A");
		expect(
			next.effects.some(
				({ effect }) => effect.kind === "start" && effect.inputId === "A",
			),
		).toBe(true);
		expect(l.state.active?.runId).not.toBe(first.runId);
	});
	it.each(
		providers,
	)("Round 7 / finding 4: %s retains the Delivered/sent steer obligation through Stop", (provider) => {
		const l = ledger(provider);
		const a = l.start();
		const steer = l.admit("B").effects[0];
		l.observe({
			kind: "effect_outcome",
			token: steer?.token ?? missing,
			outcome: { tag: "succeeded" },
		});
		l.control({ kind: "stop" });
		l.observe({ kind: "result", token: a.token, outcome: "interrupted" });
		if (provider === "opencode")
			l.observe({ kind: "query_ended", token: a.token });
		expect(l.state.inbox).toContainEqual({
			inputId: "B",
			state: { tag: "Queued" },
			uncertain: true,
		});
		expect(l.state.paused).toBe(true);
	});
	it("Round 9 oracle sibling: non-delivery proof releases a protected input without receipt-driven lifecycle", () => {
		const l = ledger();
		const a = l.start();
		const steer = l.admit("B").effects[0];
		const probe = l.observe({
			kind: "effect_outcome",
			token: steer?.token ?? missing,
			outcome: { tag: "delivery_unknown" },
		}).effects[0];
		l.observe({ kind: "query_ended", token: a.token });
		const before = l.state.active?.tag;
		const liveBefore = l.state.live;
		const deadlineBefore = l.state.active?.deadline;
		const receipt = l.observe({
			kind: "probe_result",
			token: probe?.token ?? missing,
			finding: { tag: "input_absent" },
		});
		expect(receipt.effects).toEqual([]);
		expect(receipt.allEffects).toEqual([]);
		expect(receipt.ended).toEqual([]);
		expect(l.state.live).toEqual(liveBefore);
		expect(l.state.active?.deadline).toEqual(deadlineBefore);
		expect(l.state.active?.tag).toBe(before);
		expect(l.input("B")?.uncertain).toBe(false);
	});
	it("Round 10 stress sibling: native idle can settle an accepted old transmission and release a new admission", () => {
		const l = ledger("opencode");
		const first = l.start();
		const steer = l.admit("B").effects[0];
		l.control({ kind: "cancel_input", inputId: "B" });
		l.observe({ kind: "input_accepted", token: steer?.token ?? missing });
		l.observe({ kind: "query_ended", token: first.token });
		l.admit("B");
		const probe = l.work.find(
			({ effect }) =>
				effect.kind === "probe" && effect.target.tag === "native_session",
		);
		l.observe({
			kind: "effect_outcome",
			token: steer?.token ?? missing,
			outcome: { tag: "delivery_unknown" },
		});
		l.observe({
			kind: "probe_result",
			token: probe?.token ?? missing,
			finding: { tag: "native_idle" },
		});
		expect(l.state.active?.tag).toBe("Queued");
		l.observe({
			kind: "effect_outcome",
			token: steer?.token ?? missing,
			outcome: { tag: "succeeded" },
		});
		const retry = l
			.fire()
			.effects.find(
				({ effect }) =>
					effect.kind === "probe" && effect.target.tag === "native_session",
			);
		l.observe({
			kind: "probe_result",
			token: retry?.token ?? missing,
			finding: { tag: "native_idle" },
		});
		expect(l.state.active?.inputs[0]?.inputId).toBe("B");
		expect(l.state.active?.tag).toBe("Starting");
	});
	it.each(
		providers,
	)("Round 11 stress sibling: %s retired transport receipts cannot recreate ambiguity after history expires", (provider) => {
		const l = ledger(provider);
		const first = l.start();
		l.observe({ kind: "input_accepted", token: first.token });
		l.observe({
			kind: "effect_outcome",
			token: first.token,
			outcome: { tag: "succeeded" },
		});
		l.observe({ kind: "query_ended", token: first.token });
		const second = l.start("A");
		l.observe({ kind: "input_accepted", token: second.token });
		l.observe({
			kind: "effect_outcome",
			token: second.token,
			outcome: { tag: "succeeded" },
		});
		const before = l.state;
		l.observe({
			kind: "effect_outcome",
			token: first.token,
			outcome: { tag: "delivery_unknown" },
		});
		expect(l.state).toEqual(before);
		l.observe({ kind: "query_ended", token: second.token });
		expect(
			l.admit("A").effects.some(({ effect }) => effect.kind === "start"),
		).toBe(true);
	});
	it("Round 11 / finding 2: 2000 paused admit/cancel cycles leave the public inbox empty", () => {
		const l = ledger();
		l.control({ kind: "stop" });
		for (let index = 0; index < 2000; index++) {
			l.admit(`input-${index}`);
			l.control({ kind: "cancel_input", inputId: `input-${index}` });
		}
		expect(l.state).toMatchObject({ paused: true, inbox: [], live: [] });
		expect(l.state.active).toBeUndefined();
	});
	it.each(
		providers,
	)("Round 12 oracle sibling: %s a prior steer transmission does not make its successor reservation started", (provider) => {
		const l = ledger(provider);
		const a = l.start();
		l.observe({
			kind: "effect_outcome",
			token: a.token,
			outcome: { tag: "succeeded" },
		});
		const steer = l.admit("B").effects[0];
		l.observe({
			kind: "effect_outcome",
			token: steer?.token ?? missing,
			outcome: { tag: "delivery_unknown" },
		});
		l.observe({ kind: "query_ended", token: a.token });
		expect(l.state.active?.tag).toBe("Queued");
		l.control({ kind: "cancel_input", inputId: "B" });
		expect(l.state.active).toBeUndefined();
		expect(
			l
				.admit("C")
				.effects.some(
					({ effect }) => effect.kind === "start" && effect.inputId === "B",
				),
		).toBe(false);
	});
	it("evidence for an incompatible known send is rejected without changing the view", () => {
		const l = ledger();
		const a = l.start();
		const interrupt = l.control({ kind: "stop" }).effects[0];
		const before = l.state;
		const result = l.inspect({
			verb: "observe",
			observation: { kind: "started", token: interrupt?.token ?? a.token },
		});
		expect(result.tag).toBe("Rejected");
		expect(l.state).toEqual(before);
	});
});

it.each([
	"stop",
	"result",
] as const)("pending start retry cannot replace the %s lifecycle", (boundary) => {
	const l = ledger();
	const start = l.admit("A").effects[0];
	l.observe({
		kind: "effect_outcome",
		token: start?.token ?? missing,
		outcome: { tag: "retryable", retryAt: 105 },
	});
	if (boundary === "stop") l.control({ kind: "stop" });
	else
		l.observe({
			kind: "result",
			token: start?.token ?? missing,
			outcome: "error",
			error: { code: "ActualFailure", retryable: false },
		});
	const before = l.state.active;
	l.ctx.now = 105;
	const retry = l.send({
		verb: "settle",
		settlement: {
			kind: "alarm_fired",
		},
	});
	expect(retry.effects.some(({ effect }) => effect.kind === "start")).toBe(
		false,
	);
	expect(l.state.active?.tag).toBe(before?.tag);
	expect(l.state.active?.deadline).toEqual(before?.deadline);
});

it("successful End retains a live completion path until the Run terminates", () => {
	const l = ledger();
	const a = l.start();
	const end = l
		.control({ kind: "end" })
		.effects.find(({ effect }) => effect.kind === "end_session");
	const acknowledged = l.observe({
		kind: "effect_outcome",
		token: end?.token ?? missing,
		outcome: { tag: "succeeded" },
	});
	const active = l.state.active;
	expect(
		acknowledged.ended.some((ended) => ended.runId === a.runId) ||
			(!!active && acknowledged.alarmAt === active.deadline.at),
	).toBe(true);
	if (l.state.active) l.fire();
	expect(l.ended.some((ended) => ended.runId === a.runId)).toBe(true);
});

it("idle sample preceding renewed activity cannot retire the query's later ActualFailure", () => {
	const l = ledger("opencode");
	const a = l.start();
	const probe = l.fire().effects.find(({ effect }) => effect.kind === "probe");
	l.ctx.now++;
	l.observe({ kind: "activity", token: a.token });
	const active = l.state.active;
	l.observe({
		kind: "probe_result",
		token: probe?.token ?? missing,
		finding: { tag: "native_idle" },
	});
	expect(l.state.active?.runId).toBe(active?.runId);
	l.observe({
		kind: "result",
		token: a.token,
		outcome: "error",
		error: { code: "ActualFailure", retryable: false },
	});
	const ended = l.observe({ kind: "query_ended", token: a.token });
	expect(ended.ended[0]).toMatchObject({
		outcome: "error",
		reason: { kind: "provider_error", code: "ActualFailure", retryable: false },
	});
});

it("retried close retains its original cleanup deadline and escalates when it fires", () => {
	const l = ledger();
	l.start();
	l.control({ kind: "stop" });
	const expired = l.fire();
	const close = expired.effects.find(({ effect }) => effect.kind === "close");
	if (expired.alarmAt === undefined) expect.fail("Expected a cleanup deadline");
	const cleanupAt = expired.alarmAt;
	l.observe({
		kind: "effect_outcome",
		token: close?.token ?? missing,
		outcome: { tag: "retryable", retryAt: l.ctx.now + 5 },
	});
	l.ctx.now += 5;
	const retry = l.send({
		verb: "settle",
		settlement: {
			kind: "alarm_fired",
		},
	});
	const retried = retry.effects.find(({ effect }) => effect.kind === "close");
	expect(retried?.token).toBeDefined();
	expect(retried?.token).not.toBe(close?.token);
	expect(retry.alarmAt).toBe(cleanupAt);
	l.ctx.now = cleanupAt;
	const escalated = l.send({
		verb: "settle",
		settlement: { kind: "alarm_fired" },
	});
	expect(
		escalated.effects.some(({ effect }) => effect.kind === "kill_and_respawn"),
	).toBe(true);
});

it("native ActualFailure without input acceptance survives a contradictory late start transport failure", () => {
	const l = ledger("opencode");
	const a = l.start();
	l.observe({
		kind: "result",
		token: a.token,
		outcome: "error",
		error: { code: "ActualFailure", retryable: false },
	});
	const deadline = l.state.active?.deadline;
	const late = l.observe({
		kind: "effect_outcome",
		token: a.token,
		outcome: { tag: "permanent", code: "late_transport_failure" },
	});
	expect(late.ended).toEqual([]);
	expect(l.state.active?.tag).toBe("Settling");
	expect(l.state.active?.deadline).toEqual(deadline);
	const ended = l.observe({ kind: "query_ended", token: a.token });
	expect(ended.ended[0]).toMatchObject({
		outcome: "error",
		reason: { kind: "provider_error", code: "ActualFailure", retryable: false },
	});
});
