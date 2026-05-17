import { readFileSync } from "node:fs";

import { Either, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
	decodeProviderRuntimeEvent,
	decodeProviderRuntimeEvents,
	isProviderRuntimeEvent,
	ProviderRuntimeEventSchema,
} from "../../../../src/lib/contracts/providers/provider-runtime-event.js";

const sourcePath = "src/lib/contracts/providers/provider-runtime-event.ts";

const baseEvent = {
	eventId: "evt_1",
	provider: "claude",
	threadId: "thread_1",
	createdAt: "2026-05-17T00:00:00.000Z",
};

const decodeEither = (value: unknown) =>
	Schema.decodeUnknownEither(ProviderRuntimeEventSchema)(value);

describe("ProviderRuntimeEvent contracts", () => {
	it("decodes a minimal session.started event", () => {
		const event = decodeProviderRuntimeEvent({
			...baseEvent,
			type: "session.started",
		});

		expect(event).toEqual({ ...baseEvent, type: "session.started" });
		expect(isProviderRuntimeEvent(event)).toBe(true);
	});

	it("keeps provider labels open when they are non-empty", () => {
		for (const provider of ["claude", "opencode", "localFork"]) {
			expect(
				Either.isRight(
					decodeEither({ ...baseEvent, provider, type: "session.started" }),
				),
			).toBe(true);
		}
	});

	it("rejects whitespace-only eventId, threadId, and provider", () => {
		for (const field of ["eventId", "threadId", "provider"] as const) {
			expect(
				Either.isLeft(
					decodeEither({
						...baseEvent,
						[field]: " \t\n ",
						type: "session.started",
					}),
				),
			).toBe(true);
		}
	});

	it("rejects eventId, threadId, and provider with leading or trailing whitespace", () => {
		for (const [field, value] of [
			["eventId", " evt_1 "],
			["threadId", " thread_1 "],
			["provider", " claude "],
		] as const) {
			expect(
				Either.isLeft(
					decodeEither({
						...baseEvent,
						[field]: value,
						type: "session.started",
					}),
				),
			).toBe(true);
		}
	});

	it("rejects unknown event types", () => {
		expect(
			Either.isLeft(decodeEither({ ...baseEvent, type: "message.created" })),
		).toBe(true);
	});

	it("decodes every supported raw-source label", () => {
		for (const source of [
			"claude.sdk.message",
			"claude.sdk.result",
			"claude.sdk.permission",
			"opencode.sdk.event",
			"opencode.sdk.response",
			"opencode.gap.response",
			"conduit.provider.request",
			"conduit.provider.translator",
			"conduit.provider.runtime",
		]) {
			expect(
				Either.isRight(
					decodeEither({
						...baseEvent,
						type: "session.started",
						raw: { source, payload: { ok: true } },
					}),
				),
			).toBe(true);
		}
	});

	it("preserves arbitrary nested raw payloads unchanged", () => {
		const payload = {
			arr: [1, "two", null, { nested: true }],
			obj: { child: { enabled: false } },
			nil: null,
		};

		const event = decodeProviderRuntimeEvent({
			...baseEvent,
			type: "session.started",
			raw: {
				source: "claude.sdk.message",
				method: "query",
				messageType: "assistant",
				payload,
			},
		});

		expect(event.raw?.payload).toEqual(payload);
	});

	it("decodes provider-native refs", () => {
		const providerRefs = {
			providerTurnId: "sdk-turn-1",
			providerItemId: "sdk-item-1",
			providerRequestId: "sdk-request-1",
			providerSessionId: "sdk-session-1",
		};

		const event = decodeProviderRuntimeEvent({
			...baseEvent,
			type: "session.started",
			providerRefs,
		});

		expect(event.providerRefs).toEqual(providerRefs);
	});

	it("decodes representative runtime event families", () => {
		const examples = [
			{
				...baseEvent,
				eventId: "evt_content_assistant",
				type: "content.delta",
				turnId: "turn_1",
				itemId: "item_1",
				payload: { streamKind: "assistant_text", text: "hello" },
			},
			{
				...baseEvent,
				eventId: "evt_content_reasoning",
				type: "content.delta",
				turnId: "turn_1",
				itemId: "item_2",
				payload: { streamKind: "reasoning_text", text: "thinking" },
			},
			{
				...baseEvent,
				eventId: "evt_item_started",
				type: "item.started",
				itemId: "item_3",
				payload: { itemType: "tool_call", status: "inProgress" },
			},
			{
				...baseEvent,
				eventId: "evt_item_completed",
				type: "item.completed",
				itemId: "item_4",
				payload: { itemType: "assistant_message", status: "completed" },
			},
			{
				...baseEvent,
				eventId: "evt_request_opened",
				type: "request.opened",
				requestId: "request_1",
				payload: {
					requestType: "tool_permission",
					title: "Run command",
					description: "Allow Bash",
					toolName: "Bash",
					input: { command: "pnpm check", providerShape: ["survives"] },
				},
			},
			{
				...baseEvent,
				eventId: "evt_request_resolved",
				type: "request.resolved",
				requestId: "request_1",
				payload: { requestType: "tool_permission", decision: "approved" },
			},
			{
				...baseEvent,
				eventId: "evt_user_input_requested",
				type: "user-input.requested",
				requestId: "request_2",
				payload: {
					questions: [
						{
							id: "q1",
							header: "Confirm",
							question: "Which files?",
							options: ["src", "test"],
							multiSelect: true,
						},
					],
				},
			},
			{
				...baseEvent,
				eventId: "evt_user_input_resolved",
				type: "user-input.resolved",
				requestId: "request_2",
				payload: { answers: { q1: ["src", "test"] } },
			},
			{
				...baseEvent,
				eventId: "evt_turn_completed",
				type: "turn.completed",
				turnId: "turn_1",
				payload: {
					state: "completed",
					durationMs: 123,
					cost: { usd: 0.01 },
					tokens: { input: 10, output: 20 },
				},
			},
			{
				...baseEvent,
				eventId: "evt_runtime_error",
				type: "runtime.error",
				payload: {
					errorClass: "validation",
					message: "Malformed provider event",
					code: "BAD_PROVIDER_EVENT",
					retryable: false,
				},
			},
		];

		const decoded = decodeProviderRuntimeEvents(examples);

		expect(decoded).toHaveLength(examples.length);
		expect(decoded[4]?.type).toBe("request.opened");
		if (decoded[4]?.type === "request.opened") {
			expect(decoded[4].payload.input).toEqual(examples[4]?.payload.input);
		}
	});

	it("rejects unsupported current canonical event names until translators exist", () => {
		// Expected future mapping:
		// message.created -> item.started/item.completed
		// text.delta -> content.delta(streamKind: assistant_text)
		// thinking.delta -> content.delta(streamKind: reasoning_text)
		// tool.started -> item.started(itemType: tool_call)
		// permission.asked -> request.opened(requestType: *_permission)
		// question.asked -> user-input.requested
		for (const type of [
			"message.created",
			"text.delta",
			"thinking.delta",
			"tool.started",
			"permission.asked",
			"question.asked",
		]) {
			expect(Either.isLeft(decodeEither({ ...baseEvent, type }))).toBe(true);
		}
	});

	it("decodes unknown provider driver labels", () => {
		for (const provider of [
			"claudeAgentNext",
			"opencode_work",
			"local-provider",
		]) {
			expect(
				Either.isRight(
					decodeEither({ ...baseEvent, provider, type: "session.started" }),
				),
			).toBe(true);
		}
	});

	it("keeps provider-looking raw fields opaque", () => {
		const payload = {
			type: "message.created",
			provider: "claude",
			tool: { name: "Bash", input: { command: "echo test" } },
		};

		const event = decodeProviderRuntimeEvent({
			...baseEvent,
			type: "runtime.warning",
			payload: {
				errorClass: "provider",
				message: "Provider sent an unmapped event",
			},
			raw: { source: "conduit.provider.translator", payload },
		});

		expect(event.raw?.payload).toEqual(payload);
	});

	it("stays import-pure and independent of runtime modules", () => {
		const source = readFileSync(sourcePath, "utf8");

		expect(source).not.toMatch(
			/from ['"].*..\/.*(provider|persistence|relay|frontend)/,
		);
		expect(source).not.toMatch(/@anthropic-ai\/claude-agent-sdk/);
		expect(source).not.toMatch(/@opencode-ai\/sdk/);
		expect(source).not.toMatch(
			/createLogger|EventSink|CanonicalEvent|RelayMessage|sqlite|fetch\(/,
		);
	});

	it("uses module-scope decoder construction for exported decode helpers", () => {
		const source = readFileSync(sourcePath, "utf8");

		expect(source).toMatch(
			/const decodeProviderRuntimeEventEnvelope = Schema\.decodeUnknownSync\(\s*ProviderRuntimeEventSchema,\s*\)/,
		);
		expect(source).toMatch(
			/const decodeProviderRuntimeEventsEnvelope = Schema\.decodeUnknownSync\(\s*ProviderRuntimeEventsSchema,\s*\)/,
		);
		expect(source).toMatch(
			/export function decodeProviderRuntimeEvent\(raw: unknown\): ProviderRuntimeEvent \{\s*return decodeProviderRuntimeEventEnvelope\(raw\);\s*\}/s,
		);
	});
});
