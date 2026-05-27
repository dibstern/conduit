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
});
