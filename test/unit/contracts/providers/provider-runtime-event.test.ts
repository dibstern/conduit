import { Exit, Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
	type ProviderRuntimeEventPayloadMap,
	ProviderRuntimeEventSchema,
	type ProviderRuntimeEventType,
	ProviderRuntimeEventTypeSchema,
	ProviderRuntimeProviderRefsSchema,
	ProviderRuntimeRawSourceSchema,
} from "../../../../src/lib/contracts/providers/provider-runtime-event.js";
import type {
	CanonicalEventType,
	EventPayloadMap,
} from "../../../../src/lib/persistence/events.js";
import { claudeRuntimeEvent } from "../../../../src/lib/provider/claude/claude-runtime-event.js";

const baseEvent = {
	eventId: "evt_1",
	type: "message.created",
	providerId: "claude",
	sessionId: "session_1",
	providerRefs: {},
	rawSource: { kind: "claude-sdk" },
	createdAt: "2026-05-18T00:00:00.000Z",
	data: { messageId: "msg_1", role: "assistant", sessionId: "session_1" },
};

const decodeEither = (value: unknown) =>
	Schema.decodeUnknownExit(ProviderRuntimeEventSchema)(value);

describe("ProviderRuntimeEvent contracts", () => {
	it("keeps canonical and provider-runtime payload vocabularies separate", () => {
		expectTypeOf<keyof EventPayloadMap>().toEqualTypeOf<CanonicalEventType>();
		expectTypeOf<
			keyof ProviderRuntimeEventPayloadMap
		>().toEqualTypeOf<ProviderRuntimeEventType>();
	});

	it("type-checks workspace-change payloads in the runtime constructor", () => {
		const makeEvent = claudeRuntimeEvent;
		const event = makeEvent("workspace.changed", "session_1", {
			path: "/repo",
			source: "tool",
		});
		expect(event.data).toEqual({ path: "/repo", source: "tool" });

		// @ts-expect-error Workspace paths must be strings.
		makeEvent("workspace.changed", "s", { path: 123, source: "tool" });
		// @ts-expect-error Workspace changes require their source.
		makeEvent("workspace.changed", "s", { path: "/repo" });
		// @ts-expect-error Workspace changes only come from tools or startup.
		makeEvent("workspace.changed", "s", { path: "/repo", source: "other" });
	});

	it("accepts a content-addressed OpenCode REST snapshot envelope", () => {
		expect(
			Exit.isSuccess(
				decodeEither({
					...baseEvent,
					eventId: "evt_opencode_snapshot_msg_1_digest",
					type: "message.snapshot",
					providerId: "opencode",
					rawSource: { kind: "opencode.rest", endpoint: "session.messages" },
					data: {
						messageId: "msg_1",
						digest: "digest",
						message: {
							id: "msg_1",
							sessionID: "session_1",
							role: "user",
							parts: [{ id: "part_1", type: "step-start" }],
						},
					},
				}),
			),
		).toBe(true);
	});

	it("rejects missing base envelope identity", () => {
		expect(Exit.isSuccess(decodeEither(baseEvent))).toBe(true);

		for (const field of [
			"eventId",
			"type",
			"providerId",
			"sessionId",
			"providerRefs",
			"rawSource",
			"createdAt",
			"data",
		] as const) {
			const { [field]: _removed, ...eventWithoutRequiredField } = baseEvent;

			expect(Exit.isFailure(decodeEither(eventWithoutRequiredField))).toBe(
				true,
			);
		}
	});

	it("rejects inherited base envelope identity", () => {
		const inheritedEnvelope = Object.create(baseEvent);

		expect(Exit.isFailure(decodeEither(inheritedEnvelope))).toBe(true);
	});

	it("decodes turn.model_resolved evidence without changing its ids", () => {
		const event = Schema.decodeUnknownSync(ProviderRuntimeEventSchema)({
			...baseEvent,
			type: "turn.model_resolved",
			data: {
				requestedModel: "sonnet",
				expectedModel: "claude-sonnet-5[1m]",
				actualModel: "claude-sonnet-5[1m]",
			},
		});

		expect(event.data).toEqual({
			requestedModel: "sonnet",
			expectedModel: "claude-sonnet-5[1m]",
			actualModel: "claude-sonnet-5[1m]",
		});
	});

	it("decodes raw-source metadata fields", () => {
		const rawSource = {
			kind: "claude-sdk",
			providerMessageType: "assistant",
			providerMessageSubtype: "content_block_delta",
			sdkVariant: "typescript-v2-preview",
			streamEventType: "message_delta",
			endpoint: "/v1/messages",
			sourceSchema: "ClaudeAgentSdkStreamMessageSchema",
		};

		const event = Schema.decodeUnknownSync(ProviderRuntimeEventSchema)({
			...baseEvent,
			rawSource,
		});

		expect(
			Exit.isSuccess(
				Schema.decodeUnknownExit(ProviderRuntimeRawSourceSchema)(rawSource),
			),
		).toBe(true);
		expect(event.rawSource).toEqual(rawSource);
	});

	it("decodes Claude refs", () => {
		const providerRefs = {
			providerSessionId: "claude-session-1",
			providerMessageId: "msg_1",
			providerToolUseId: "toolu_1",
			providerTaskId: "task_1",
		};

		const event = Schema.decodeUnknownSync(ProviderRuntimeEventSchema)({
			...baseEvent,
			type: "tool.started",
			providerRefs,
			data: {
				messageId: "msg_1",
				partId: "part_1",
				toolName: "Bash",
				callId: "toolu_1",
				input: { command: "pnpm check" },
			},
		});

		expect(
			Exit.isSuccess(
				Schema.decodeUnknownExit(ProviderRuntimeProviderRefsSchema)(
					providerRefs,
				),
			),
		).toBe(true);
		expect(event.providerRefs).toEqual(providerRefs);
		expect(event.rawSource).not.toHaveProperty("raw");
	});

	it("rejects the retired tool.input_updated runtime event", () => {
		expect(
			Exit.isFailure(
				Schema.decodeUnknownExit(ProviderRuntimeEventTypeSchema)(
					"tool.input_updated",
				),
			),
		).toBe(true);
		expect(
			Exit.isFailure(
				decodeEither({ ...baseEvent, type: "tool.input_updated" }),
			),
		).toBe(true);
	});

	it("rejects unknown runtime event type", () => {
		expect(
			Exit.isFailure(decodeEither({ ...baseEvent, type: "made.up" })),
		).toBe(true);
	});

	it("rejects raw payload fields in rawSource", () => {
		for (const field of [
			"raw",
			"rawPayload",
			"sdkPayload",
			"providerPayload",
		] as const) {
			expect(
				Exit.isFailure(
					decodeEither({
						...baseEvent,
						rawSource: { kind: "claude-sdk", [field]: { type: "assistant" } },
					}),
				),
			).toBe(true);
		}
	});

	it("rejects top-level raw payload fields", () => {
		for (const field of ["raw", "payload", "rawPayload"] as const) {
			expect(
				Exit.isFailure(
					decodeEither({
						...baseEvent,
						[field]: { type: "provider-message", content: [] },
					}),
				),
			).toBe(true);
		}
	});

	it("rejects arbitrary unknown top-level fields", () => {
		expect(Exit.isFailure(decodeEither({ ...baseEvent, extra: true }))).toBe(
			true,
		);
	});

	it("decodes OpenCode refs", () => {
		const providerRefs = {
			providerSessionId: "opencode-session-1",
			providerMessageId: "msg_1",
			providerRequestId: "req_1",
		};

		const event = Schema.decodeUnknownSync(ProviderRuntimeEventSchema)({
			...baseEvent,
			providerId: "opencode",
			type: "permission.asked",
			providerRefs,
			rawSource: {
				kind: "opencode-sdk",
				streamEventType: "permission.asked",
				endpoint: "/event",
			},
			data: {
				id: "req_1",
				sessionId: "session_1",
				toolName: "Bash",
				input: { command: "pnpm check", cwd: "/repo" },
			},
		});

		expect(
			Exit.isSuccess(
				Schema.decodeUnknownExit(ProviderRuntimeProviderRefsSchema)(
					providerRefs,
				),
			),
		).toBe(true);
		expect(event.providerId).toBe("opencode");
		expect(event.providerRefs).toEqual(providerRefs);
		expect(event.data).toEqual({
			id: "req_1",
			sessionId: "session_1",
			toolName: "Bash",
			input: { command: "pnpm check", cwd: "/repo" },
		});
	});

	it("preserves opaque provider-owned payloads", () => {
		const data = {
			messageId: "msg_1",
			partId: "part_1",
			toolName: "AskUserQuestion",
			callId: "toolu_question_1",
			input: {
				questions: [
					{
						id: "q1",
						header: "Confirm",
						question: "Which paths should be changed?",
						options: ["src", "test"],
					},
				],
				nested: { resultShape: [{ ok: true }, null] },
			},
			result: {
				answers: { q1: ["src", "test"] },
				rawProviderResult: { status: "ok", values: [1, "two"] },
			},
		};

		const event = Schema.decodeUnknownSync(ProviderRuntimeEventSchema)({
			...baseEvent,
			type: "tool.completed",
			providerRefs: {
				providerSessionId: "claude-session-1",
				providerMessageId: "msg_1",
				providerToolUseId: "toolu_question_1",
			},
			data,
		});

		expect(event.data).toEqual(data);
	});

	it("rejects unknown providerRefs keys", () => {
		for (const providerRefs of [
			{ providerSessionId: "session_1", providerMessageID: "msg_1" },
			{ providerSessionId: "session_1", providerItemId: "item_1" },
		]) {
			expect(
				Exit.isFailure(
					Schema.decodeUnknownExit(ProviderRuntimeProviderRefsSchema)(
						providerRefs,
					),
				),
			).toBe(true);
			expect(Exit.isFailure(decodeEither({ ...baseEvent, providerRefs }))).toBe(
				true,
			);
		}
	});

	it("rejects non-plain providerRefs objects", () => {
		for (const providerRefs of [
			new Date("2026-05-18T00:00:00.000Z"),
			new Map([["providerSessionId", "session_1"]]),
		]) {
			expect(
				Exit.isFailure(
					Schema.decodeUnknownExit(ProviderRuntimeProviderRefsSchema)(
						providerRefs,
					),
				),
			).toBe(true);
			expect(Exit.isFailure(decodeEither({ ...baseEvent, providerRefs }))).toBe(
				true,
			);
		}
	});
});
