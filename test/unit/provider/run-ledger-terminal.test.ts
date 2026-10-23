import { describe, expect, it } from "vitest";
import type { CanonicalEvent } from "../../../src/lib/contracts/stored-event.js";
import type {
	ProviderKind,
	SendToken,
} from "../../../src/lib/provider/run-ledger/run-ledger-model.js";
import { classifyRunTerminal } from "../../../src/lib/provider/run-ledger/run-ledger-policy.js";
import { ledger } from "./run-ledger-scenarios.js";

const identity = { runId: "run-1", token: "query-send" as SendToken };

const envelope = (provider: ProviderKind) => ({
	eventId: "event-1",
	sessionId: "session-1",
	metadata: { runId: identity.runId },
	provider,
	createdAt: 100,
});

describe("classifyRunTerminal", () => {
	it.each<ProviderKind>([
		"claude",
		"cursor",
		"opencode",
	])("RL-014 RL-037 RL-054: %s delivery acknowledgements and activity are nonterminal", (provider) => {
		const base = envelope(provider);
		const events = [
			{
				...base,
				type: "input.sent",
				data: { sessionId: "session-1", inputId: "steer-1", steer: true },
			},
			{
				...base,
				type: "run.started",
				data: { inputId: "start-1", requestedRunId: identity.runId },
			},
			{ ...base, type: "turn.notice", data: { text: "Still working" } },
		] satisfies readonly CanonicalEvent[];

		for (const event of events) {
			expect(
				classifyRunTerminal(event, provider, true, identity),
			).toBeUndefined();
		}
	});

	it("RL-037 RL-054: Claude result-bound joined differs from Cursor delivery-only joined", () => {
		const claudeResult = {
			...envelope("claude"),
			type: "turn.completed",
			data: { messageId: "assistant-1", userMessageId: "steer-1" },
		} satisfies CanonicalEvent;
		const cursorDelivery = {
			...envelope("cursor"),
			type: "input.sent",
			data: { sessionId: "session-1", inputId: "steer-1", steer: true },
		} satisfies CanonicalEvent;

		expect(classifyRunTerminal(claudeResult, "claude", true, identity)).toEqual(
			{
				kind: "result",
				token: identity.token,
				outcome: "completed",
			},
		);
		expect(
			classifyRunTerminal(cursorDelivery, "cursor", true, identity),
		).toBeUndefined();
	});

	it.each<ProviderKind>([
		"claude",
		"cursor",
		"opencode",
	])("RL-034 RL-037: %s cannot classify a different run's terminal", (provider) => {
		const base = { ...envelope(provider), metadata: { runId: "old-run" } };
		const events = [
			{ ...base, type: "turn.completed", data: { messageId: "assistant-1" } },
			{ ...base, type: "turn.interrupted", data: { messageId: "assistant-1" } },
			{
				...base,
				type: "turn.error",
				data: { messageId: "assistant-1", error: "Failed" },
			},
			{
				...base,
				type: "session.status",
				data: { sessionId: "session-1", status: "idle" },
			},
			{
				...base,
				type: "session.status",
				data: { sessionId: "session-1", status: "error" },
			},
		] satisfies readonly CanonicalEvent[];

		for (const event of events) {
			expect(
				classifyRunTerminal(event, provider, true, identity),
			).toBeUndefined();
		}
	});

	it.each<"idle" | "error">([
		"idle",
		"error",
	])("RL-014 RL-017: unowned OpenCode %s cannot terminate a run", (status) => {
		const event = {
			...envelope("opencode"),
			metadata: {},
			type: "session.status",
			data: { sessionId: "session-1", status },
		} satisfies CanonicalEvent;

		expect(
			classifyRunTerminal(event, "opencode", false, identity),
		).toBeUndefined();
	});

	it("RL-034: caller-resolved exact Claude result needs no fabricated acceptance", () => {
		const event = {
			...envelope("claude"),
			metadata: {},
			type: "turn.completed",
			data: { messageId: "", userMessageId: "exact-native-user-message" },
		} satisfies CanonicalEvent;

		expect(classifyRunTerminal(event, "claude", true, identity)).toEqual({
			kind: "result",
			token: identity.token,
			outcome: "completed",
		});
	});

	it.each<
		[
			ProviderKind,
			"idle" | "error" | "busy" | "retry",
			"ended" | "error" | undefined,
		]
	>([
		["opencode", "idle", "ended"],
		["opencode", "error", "error"],
		["opencode", "busy", undefined],
		["opencode", "retry", undefined],
		["claude", "idle", undefined],
		["claude", "error", undefined],
		["claude", "busy", undefined],
		["claude", "retry", undefined],
		["cursor", "idle", undefined],
		["cursor", "error", undefined],
		["cursor", "busy", undefined],
		["cursor", "retry", undefined],
	])("RL-017 RL-037: %s session %s yields %s", (provider, status, expected) => {
		const event = {
			...envelope(provider),
			type: "session.status",
			data: { sessionId: "session-1", status },
		} satisfies CanonicalEvent;

		expect(
			classifyRunTerminal(event, provider, provider !== "opencode", identity),
		).toEqual(
			expected === "ended"
				? { kind: "query_ended", token: identity.token }
				: expected === "error"
					? {
							kind: "result",
							token: identity.token,
							outcome: "error",
							error: { code: "provider_error", retryable: false },
						}
					: undefined,
		);
	});

	it.each<ProviderKind>([
		"claude",
		"cursor",
		"opencode",
	])("RL-037: %s native interruption is an interrupted result", (provider) => {
		const event = {
			...envelope(provider),
			type: "turn.interrupted",
			data: { messageId: "assistant-1" },
		} satisfies CanonicalEvent;

		expect(classifyRunTerminal(event, provider, false, identity)).toEqual({
			kind: "result",
			token: identity.token,
			outcome: "interrupted",
		});
	});

	it.each<[ProviderKind, boolean, boolean]>([
		["claude", true, true],
		["cursor", true, true],
		["opencode", false, false],
		["claude", false, false],
		["cursor", false, false],
		["opencode", true, false],
	])("RL-014 RL-037: %s turn.completed with lifecycle=%s is result=%s", (provider, streamsSessionLifecycle, terminal) => {
		const event = {
			...envelope(provider),
			type: "turn.completed",
			data: { messageId: "assistant-1" },
		} satisfies CanonicalEvent;

		expect(
			classifyRunTerminal(event, provider, streamsSessionLifecycle, identity),
		).toEqual(
			terminal
				? { kind: "result", token: identity.token, outcome: "completed" }
				: undefined,
		);
	});

	it.each<ProviderKind>([
		"claude",
		"cursor",
		"opencode",
	])("RL-017 RL-034 RL-037: %s errors retain the actual failure", (provider) => {
		const event = {
			...envelope(provider),
			type: "turn.error",
			data: {
				messageId: "assistant-1",
				error: "Native reply failed",
				code: "MessageAbortedError",
				retryable: true,
			},
		} satisfies CanonicalEvent;

		expect(classifyRunTerminal(event, provider, false, identity)).toEqual({
			kind: "result",
			token: identity.token,
			outcome: "error",
			error: { code: "MessageAbortedError", retryable: true },
		});
	});

	it.each<[boolean | undefined, boolean | undefined, boolean]>([
		[true, true, false],
		[false, true, false],
		[undefined, true, false],
		[true, false, true],
		[true, undefined, true],
		[undefined, undefined, false],
	])("RL-055: retryable=%s retryHandled=%s permits ledger retry=%s", (retryable, retryHandled, expectedRetryable) => {
		const event = {
			...envelope("cursor"),
			type: "turn.error",
			data: {
				messageId: "assistant-1",
				error: "Native reply failed",
				...(retryable === undefined ? {} : { retryable }),
				...(retryHandled === undefined ? {} : { retryHandled }),
			},
		} satisfies CanonicalEvent;

		expect(classifyRunTerminal(event, "cursor", true, identity)).toEqual({
			kind: "result",
			token: identity.token,
			outcome: "error",
			error: { code: "provider_error", retryable: expectedRetryable },
		});
	});
});

it("Round 9 terminal sibling: conflicting native results have one answer regardless of the closure fallback", () => {
	for (const stop of [false, true]) {
		const l = ledger("opencode");
		const a = l.start();
		if (stop) l.control({ kind: "stop" });
		const result = l.observe({
			kind: "result",
			token: a.token,
			outcome: "completed",
		});
		expect(result.alarmAt).toBe(l.state.active?.deadline.at);
		const interrupted = l.observe({
			kind: "result",
			token: a.token,
			outcome: "interrupted",
		});
		const ended = l.observe({ kind: "query_ended", token: a.token });
		expect(ended.alarmAt).toBe(stop ? 120 : undefined);
		expect([...interrupted.ended, ...ended.ended]).toEqual([
			{
				runId: a.runId,
				outcome: stop ? "completed" : "interrupted",
				reason: stop
					? { kind: "completed" }
					: { kind: "interrupted", by: "stop", forced: false },
			},
		]);
	}
});
it("Round 10 supersession: new native work clears both completion and failure evidence", () => {
	for (const before of [true, false]) {
		const l = ledger("opencode");
		const a = l.start();
		const failure = {
			kind: "result",
			token: a.token,
			outcome: "error",
			error: { code: "ActualFailure", retryable: true },
		} as const;
		const steer = l
			.admit("B")
			.effects.find((send) => send.effect.kind === "steer");
		expect(steer).toBeDefined();
		if (!steer) continue;
		if (before) l.observe(failure);
		l.observe({ kind: "activity", token: steer.token });
		if (!before) l.observe({ ...failure, token: steer.token });
		const ended = l.observe({ kind: "query_ended", token: steer.token });
		expect(ended.ended[0]).toMatchObject(
			before
				? { outcome: "completed", reason: { kind: "completed" } }
				: {
						outcome: "error",
						reason: {
							kind: "provider_error",
							code: "ActualFailure",
							retryable: true,
						},
					},
		);
	}
});
