import { describe, expect, it } from "vitest";
import { CanonicalEventTranslator } from "../../../src/lib/persistence/canonical-event-translator.js";
import type { CanonicalEvent } from "../../../src/lib/persistence/events.js";
import { OpenCodeRuntimeEventTranslator } from "../../../src/lib/provider/opencode/opencode-runtime-event-translator.js";
import {
	emptyProviderRuntimeDomainMapperState,
	translateProviderRuntimeEventToDomain,
} from "../../../src/lib/provider/provider-runtime-event-to-domain.js";
import type { SSEEvent } from "../../../src/lib/relay/opencode-events.js";
import { makeSSEEvent } from "../../helpers/sse-factories.js";

function runtimeToDomain(
	translator: OpenCodeRuntimeEventTranslator,
	event: SSEEvent,
	sessionId: string,
): CanonicalEvent[] {
	const runtimeEvents = translator.translate(event, sessionId) ?? [];
	let state = emptyProviderRuntimeDomainMapperState;
	const domainEvents: CanonicalEvent[] = [];
	for (const runtimeEvent of runtimeEvents) {
		const result = translateProviderRuntimeEventToDomain(runtimeEvent, state);
		domainEvents.push(...result.events);
		state = result.state;
	}
	return domainEvents;
}

function comparable(events: readonly CanonicalEvent[]) {
	return events.map((event) => ({
		type: event.type,
		sessionId: event.sessionId,
		provider: event.provider,
		data: event.data,
	}));
}

describe("OpenCodeRuntimeEventTranslator", () => {
	it("matches legacy OpenCode SSE domain translation for message and text deltas", () => {
		const legacy = new CanonicalEventTranslator();
		const runtime = new OpenCodeRuntimeEventTranslator();
		const sessionId = "ses-opencode";
		const events = [
			makeSSEEvent("message.created", {
				sessionID: sessionId,
				messageID: "msg-1",
				info: { role: "assistant" },
			}),
			makeSSEEvent("message.part.delta", {
				sessionID: sessionId,
				messageID: "msg-1",
				partID: "part-1",
				field: "text",
				delta: "hello",
			}),
		];

		expect(
			comparable(
				events.flatMap((event) => legacy.translate(event, sessionId) ?? []),
			),
		).toEqual(
			comparable(
				events.flatMap((event) => runtimeToDomain(runtime, event, sessionId)),
			),
		);
	});

	it("matches legacy OpenCode SSE domain translation for tool lifecycle and keeps provider refs", () => {
		const legacy = new CanonicalEventTranslator();
		const runtime = new OpenCodeRuntimeEventTranslator();
		const sessionId = "ses-opencode";
		const event = makeSSEEvent("message.part.updated", {
			sessionID: sessionId,
			messageID: "msg-1",
			partID: "part-1",
			part: {
				type: "tool",
				id: "part-1",
				tool: "read",
				callID: "call-1",
				state: {
					status: "pending",
					input: { filePath: "/src/main.ts", offset: 5 },
				},
			},
		});

		expect(comparable(runtimeToDomain(runtime, event, sessionId))).toEqual(
			comparable(legacy.translate(event, sessionId) ?? []),
		);
		const runtimeEvent = runtime.translate(event, sessionId)?.[0];
		expect(runtimeEvent?.providerRefs).toEqual({
			providerSessionId: sessionId,
			providerMessageId: "msg-1",
			providerToolUseId: "call-1",
		});
	});

	it("matches legacy translation for session.error and strips the 'undefined: ' artifact", () => {
		const legacy = new CanonicalEventTranslator();
		const runtime = new OpenCodeRuntimeEventTranslator();
		const sessionId = "ses-opencode";
		const event = makeSSEEvent("session.error", {
			sessionID: sessionId,
			error: {
				name: "APIError",
				data: {
					message: "undefined: The provided model identifier is invalid.",
				},
			},
		});

		const domainEvents = runtimeToDomain(runtime, event, sessionId);
		const legacyEvents = legacy.translate(event, sessionId) ?? [];
		// messageId provenance differs between the pipelines (the runtime→domain
		// mapper stamps the envelope id); compare the error payload fields.
		const expected = {
			error: "The provided model identifier is invalid.",
			code: "APIError",
		};
		expect(domainEvents[0]?.type).toBe("turn.error");
		expect(domainEvents[0]?.data).toMatchObject(expected);
		expect(legacyEvents[0]?.data).toMatchObject(expected);
	});

	it("emits message.created once for a user message.updated event", () => {
		const translator = new OpenCodeRuntimeEventTranslator();
		const sessionId = "ses-opencode";
		const event = makeSSEEvent("message.updated", {
			sessionID: sessionId,
			info: {
				id: "msg-user-1",
				role: "user",
				time: { created: 1000 },
			},
		});

		expect(translator.translate(event, sessionId)).toMatchObject([
			{
				type: "message.created",
				data: {
					messageId: "msg-user-1",
					role: "user",
					sessionId,
				},
			},
		]);
		expect(translator.translate(event, sessionId)).toBeNull();
	});

	it("emits a text.delta for unseen text in a final text part", () => {
		const translator = new OpenCodeRuntimeEventTranslator();
		const sessionId = "ses-opencode";
		const event = makeSSEEvent("message.part.updated", {
			sessionID: sessionId,
			part: {
				id: "part-text-1",
				messageID: "msg-user-1",
				type: "text",
				text: "hello",
			},
		});

		expect(translator.translate(event, sessionId)).toMatchObject([
			{
				type: "text.delta",
				data: {
					messageId: "msg-user-1",
					partId: "part-text-1",
					text: "hello",
				},
			},
		]);
		expect(translator.translate(event, sessionId)).toBeNull();
	});

	it("emits only the unseen suffix when a text final follows deltas", () => {
		const translator = new OpenCodeRuntimeEventTranslator();
		const sessionId = "ses-opencode";
		translator.translate(
			makeSSEEvent("message.part.delta", {
				sessionID: sessionId,
				messageID: "msg-assistant-1",
				partID: "part-text-1",
				field: "text",
				delta: "hel",
			}),
			sessionId,
		);

		const result = translator.translate(
			makeSSEEvent("message.part.updated", {
				sessionID: sessionId,
				part: {
					id: "part-text-1",
					messageID: "msg-assistant-1",
					type: "text",
					text: "hello",
				},
			}),
			sessionId,
		);

		expect(result).toMatchObject([
			{
				type: "text.delta",
				data: { text: "lo" },
			},
		]);
	});

	it("emits a thinking.delta for the unseen suffix in a reasoning final", () => {
		const translator = new OpenCodeRuntimeEventTranslator();
		const sessionId = "ses-opencode";
		translator.translate(
			makeSSEEvent("message.part.updated", {
				sessionID: sessionId,
				part: {
					id: "part-reasoning-1",
					messageID: "msg-assistant-1",
					type: "reasoning",
					text: "",
					time: { start: 1000 },
				},
			}),
			sessionId,
		);
		translator.translate(
			makeSSEEvent("message.part.delta", {
				sessionID: sessionId,
				messageID: "msg-assistant-1",
				partID: "part-reasoning-1",
				field: "text",
				delta: "thin",
			}),
			sessionId,
		);

		const result = translator.translate(
			makeSSEEvent("message.part.updated", {
				sessionID: sessionId,
				part: {
					id: "part-reasoning-1",
					messageID: "msg-assistant-1",
					type: "reasoning",
					text: "thinking",
					time: { start: 1000, end: 1100 },
				},
			}),
			sessionId,
		);

		expect(result).toMatchObject([
			{
				type: "thinking.delta",
				data: { text: "king" },
			},
			{ type: "thinking.end" },
		]);
	});

	it("does not complete a turn for an incomplete assistant message.updated", () => {
		const translator = new OpenCodeRuntimeEventTranslator();
		const sessionId = "ses-opencode";
		const result = translator.translate(
			makeSSEEvent("message.updated", {
				sessionID: sessionId,
				info: {
					id: "msg-assistant-1",
					role: "assistant",
					time: { created: 1000 },
				},
			}),
			sessionId,
		);

		expect(result?.map((event) => event.type)).toEqual(["message.created"]);
	});

	it("attaches plain-object tool metadata to running and completed events", () => {
		const translator = new OpenCodeRuntimeEventTranslator();
		const sessionId = "ses-opencode";
		const part = {
			id: "part-tool-1",
			messageID: "msg-assistant-1",
			type: "tool" as const,
			tool: "task",
			callID: "call-1",
		};

		translator.translate(
			makeSSEEvent("message.part.updated", {
				sessionID: sessionId,
				part: { ...part, state: { status: "pending", input: {} } },
			}),
			sessionId,
		);
		const running = translator.translate(
			makeSSEEvent("message.part.updated", {
				sessionID: sessionId,
				part: {
					...part,
					state: {
						status: "running",
						input: {},
						metadata: { sessionId: "ses_child_differential" },
					},
				},
			}),
			sessionId,
		);
		const completed = translator.translate(
			makeSSEEvent("message.part.updated", {
				sessionID: sessionId,
				part: {
					...part,
					state: {
						status: "completed",
						input: {},
						output: "done",
						metadata: { sessionId: "ses_child_differential" },
					},
				},
			}),
			sessionId,
		);

		expect(running).toMatchObject([
			{
				type: "tool.running",
				data: { metadata: { sessionId: "ses_child_differential" } },
			},
		]);
		expect(completed).toMatchObject([
			{
				type: "tool.completed",
				data: { metadata: { sessionId: "ses_child_differential" } },
			},
		]);
	});

	it("emits one file.attached event per file part for user and assistant messages", () => {
		const translator = new OpenCodeRuntimeEventTranslator();
		const sessionId = "ses-opencode";
		const fileEvent = (partId: string, messageId: string) =>
			makeSSEEvent("message.part.updated", {
				sessionID: sessionId,
				part: {
					id: partId,
					sessionID: sessionId,
					messageID: messageId,
					type: "file",
					mime: "image/png",
					filename: "screenshot.png",
					url: "data:image/png;base64,AAAA",
				},
			});

		for (const [partId, messageId] of [
			["part-user-file", "msg-user-1"],
			["part-assistant-file", "msg-assistant-1"],
		] as const) {
			const event = fileEvent(partId, messageId);
			expect(translator.translate(event, sessionId)).toMatchObject([
				{
					type: "file.attached",
					data: {
						messageId,
						partId,
						mime: "image/png",
						filename: "screenshot.png",
						url: "data:image/png;base64,AAAA",
					},
				},
			]);
			expect(translator.translate(event, sessionId)).toBeNull();
		}
	});
});
