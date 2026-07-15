import { describe, expect, it } from "vitest";
import {
	decodeProviderRuntimeEvent,
	type ProviderRuntimeEvent,
} from "../../../src/lib/contracts/providers/provider-runtime-event.js";
import type { CanonicalEvent } from "../../../src/lib/persistence/events.js";
import type { ProviderRuntimeDomainMapperState } from "../../../src/lib/provider/provider-runtime-event-to-domain.js";
import {
	emptyProviderRuntimeDomainMapperState,
	translateProviderRuntimeEventToDomain,
} from "../../../src/lib/provider/provider-runtime-event-to-domain.js";

const BASE_EVENT = {
	providerId: "claude",
	sessionId: "session-123",
	createdAt: "2026-05-19T00:00:00.000Z",
	rawSource: {
		kind: "claude.sdk.message",
		providerMessageType: "assistant",
	},
	providerRefs: {
		providerSessionId: "provider-session-123",
		providerMessageId: "provider-message-123",
		providerTurnId: "provider-turn-123",
		providerToolUseId: "provider-tool-123",
		providerRequestId: "provider-request-123",
		providerTaskId: "provider-task-123",
		parentProviderTaskId: "parent-provider-task-123",
	},
} as const;

function runtimeEvent(event: Record<string, unknown>): ProviderRuntimeEvent {
	return decodeProviderRuntimeEvent({
		...BASE_EVENT,
		...event,
	});
}

function foldRuntimeEvents(
	events: readonly ProviderRuntimeEvent[],
	initialState: ProviderRuntimeDomainMapperState = emptyProviderRuntimeDomainMapperState,
): {
	readonly events: readonly CanonicalEvent[];
	readonly state: ProviderRuntimeDomainMapperState;
} {
	let state = initialState;
	const mappedEvents: CanonicalEvent[] = [];
	for (const event of events) {
		const result = translateProviderRuntimeEventToDomain(event, state);
		mappedEvents.push(...result.events);
		state = result.state;
	}
	return { events: mappedEvents, state };
}

function stateEntries(state: ProviderRuntimeDomainMapperState) {
	return {
		currentAssistantMessageIds: [...state.currentAssistantMessageIds.entries()],
		itemMessageIds: [...state.itemMessageIds.entries()],
		startedToolPartIds: [...state.startedToolPartIds.values()],
	};
}

describe("translateProviderRuntimeEventToDomain", () => {
	it("maps runtime message.created to durable message.created with runtime metadata", () => {
		const { events, state } = translateProviderRuntimeEventToDomain(
			runtimeEvent({
				eventId: "runtime-event-1",
				type: "message.created",
				turnId: "turn-1",
				data: {
					messageId: "message-1",
					role: "assistant",
				},
			}),
		);

		expect(events).toEqual([
			expect.objectContaining({
				eventId: "runtime-event-1",
				sessionId: "session-123",
				type: "message.created",
				provider: "claude",
				createdAt: Date.parse("2026-05-19T00:00:00.000Z"),
				data: {
					messageId: "message-1",
					role: "assistant",
					sessionId: "session-123",
					turnId: "turn-1",
				},
				metadata: {
					providerRuntimeEventId: "runtime-event-1",
					rawSource: "claude.sdk.message",
					providerRefs: BASE_EVENT.providerRefs,
				},
			}),
		]);
		expect(state.currentAssistantMessageIds.get("session-123:turn-1")).toBe(
			"message-1",
		);
	});

	it("derives assistant message id from provider refs when data omits it", () => {
		const { events, state } = translateProviderRuntimeEventToDomain(
			runtimeEvent({
				eventId: "assistant-without-message-id",
				type: "message.created",
				turnId: "turn-1",
				providerRefs: {
					providerMessageId: "provider-message-1",
				},
				data: {
					role: "assistant",
				},
			}),
		);

		expect(events).toEqual([
			expect.objectContaining({
				type: "message.created",
				data: expect.objectContaining({
					messageId: "provider-message-1",
				}),
			}),
		]);
		expect(state.currentAssistantMessageIds.get("session-123:turn-1")).toBe(
			"provider-message-1",
		);
	});

	it("maps assistant text deltas to durable text.delta", () => {
		const { events } = translateProviderRuntimeEventToDomain(
			runtimeEvent({
				eventId: "runtime-event-2",
				type: "text.delta",
				data: {
					messageId: "message-1",
					text: "hello",
				},
			}),
		);

		expect(events).toEqual([
			expect.objectContaining({
				eventId: "runtime-event-2",
				sessionId: "session-123",
				type: "text.delta",
				provider: "claude",
				data: {
					messageId: "message-1",
					partId: "message-1:text",
					text: "hello",
				},
				metadata: expect.objectContaining({
					providerRuntimeEventId: "runtime-event-2",
				}),
			}),
		]);
	});

	it("maps reasoning lifecycle to thinking start, delta, and end", () => {
		const sequence = [
			runtimeEvent({
				eventId: "message-start",
				type: "message.created",
				turnId: "turn-1",
				data: {
					messageId: "message-1",
					role: "assistant",
				},
			}),
			runtimeEvent({
				eventId: "reasoning-start",
				type: "thinking.start",
				turnId: "turn-1",
				data: {
					partId: "reasoning-1",
				},
			}),
			runtimeEvent({
				eventId: "reasoning-delta",
				type: "thinking.delta",
				turnId: "turn-1",
				data: {
					partId: "reasoning-1",
					text: "thinking",
				},
			}),
			runtimeEvent({
				eventId: "reasoning-end",
				type: "thinking.end",
				turnId: "turn-1",
				data: {
					partId: "reasoning-1",
				},
			}),
		];
		const result = foldRuntimeEvents(sequence);
		const replay = foldRuntimeEvents(sequence);

		expect(result.events).toEqual(replay.events);
		expect(stateEntries(result.state)).toEqual(stateEntries(replay.state));
		expect(result.events.map((event) => event.type)).toEqual([
			"message.created",
			"thinking.start",
			"thinking.delta",
			"thinking.end",
		]);
		expect(result.events.slice(1).map((event) => event.data)).toEqual([
			{
				messageId: "message-1",
				partId: "reasoning-1",
			},
			{
				messageId: "message-1",
				partId: "reasoning-1",
				text: "thinking",
			},
			{
				messageId: "message-1",
				partId: "reasoning-1",
			},
		]);
	});

	it("maps tool lifecycle to tool started, running, and completed", () => {
		const sequence = [
			runtimeEvent({
				eventId: "message-start",
				type: "message.created",
				turnId: "turn-1",
				data: {
					messageId: "message-1",
					role: "assistant",
				},
			}),
			runtimeEvent({
				eventId: "tool-start",
				type: "tool.started",
				turnId: "turn-1",
				data: {
					messageId: "message-1",
					partId: "tool-1",
					toolName: "Bash",
					callId: "provider-tool-123",
					input: { command: "pnpm test" },
				},
			}),
			runtimeEvent({
				eventId: "tool-update",
				type: "tool.running",
				turnId: "turn-1",
				data: {
					messageId: "message-1",
					partId: "tool-1",
					metadata: {
						status: "inProgress",
						input: { command: "pnpm test" },
					},
				},
			}),
			runtimeEvent({
				eventId: "tool-complete",
				type: "tool.completed",
				turnId: "turn-1",
				data: {
					messageId: "message-1",
					partId: "tool-1",
					result: { exitCode: 0, text: "ok" },
					duration: 12,
					metadata: { sessionId: "ses-child" },
				},
			}),
		];
		const result = foldRuntimeEvents(sequence);
		const replay = foldRuntimeEvents(sequence);
		const [, started, running, completed] = result.events;

		expect(result.events).toEqual(replay.events);
		expect(stateEntries(result.state)).toEqual(stateEntries(replay.state));
		expect(started).toEqual(
			expect.objectContaining({
				eventId: "tool-start",
				type: "tool.started",
				data: {
					messageId: "message-1",
					partId: "tool-1",
					toolName: "Bash",
					callId: "provider-tool-123",
					input: { tool: "Bash", command: "pnpm test" },
				},
				metadata: expect.objectContaining({ schemaVersion: 2 }),
			}),
		);
		expect(running).toEqual(
			expect.objectContaining({
				eventId: "tool-update",
				type: "tool.running",
				data: {
					messageId: "message-1",
					partId: "tool-1",
					metadata: {
						status: "inProgress",
						input: { command: "pnpm test" },
					},
				},
			}),
		);
		expect(completed).toEqual(
			expect.objectContaining({
				eventId: "tool-complete",
				type: "tool.completed",
				data: {
					messageId: "message-1",
					partId: "tool-1",
					result: { exitCode: 0, text: "ok" },
					duration: 12,
					metadata: { sessionId: "ses-child" },
				},
			}),
		);
	});

	it("maps runtime file.attached to durable file.attached", () => {
		const { events } = translateProviderRuntimeEventToDomain(
			runtimeEvent({
				eventId: "file-attached",
				type: "file.attached",
				data: {
					messageId: "message-1",
					partId: "file-1",
					mime: "image/png",
					filename: "screenshot.png",
					url: "data:image/png;base64,AAAA",
				},
			}),
		);

		expect(events).toEqual([
			expect.objectContaining({
				eventId: "file-attached",
				type: "file.attached",
				data: {
					messageId: "message-1",
					partId: "file-1",
					mime: "image/png",
					filename: "screenshot.png",
					url: "data:image/png;base64,AAAA",
				},
			}),
		]);
	});

	it("synthesizes tool.started before tool.completed when completion arrives without prior tool start", () => {
		const sequence = [
			runtimeEvent({
				eventId: "message-start",
				type: "message.created",
				turnId: "turn-1",
				data: {
					messageId: "message-1",
					role: "assistant",
				},
			}),
			runtimeEvent({
				eventId: "tool-complete-without-start",
				type: "tool.completed",
				turnId: "turn-1",
				data: {
					messageId: "message-1",
					partId: "tool-1",
					toolName: "Bash",
					callId: "provider-tool-1",
					input: { command: "pnpm test" },
					result: { exitCode: 0, text: "ok" },
					duration: 0,
				},
			}),
		];

		const result = foldRuntimeEvents(sequence);
		const replay = foldRuntimeEvents(sequence);
		const [, started, completed] = result.events;

		expect(result.events).toEqual(replay.events);
		expect(started).toEqual(
			expect.objectContaining({
				eventId: "tool-complete-without-start:tool.started",
				type: "tool.started",
				data: {
					messageId: "message-1",
					partId: "tool-1",
					toolName: "Bash",
					callId: "provider-tool-1",
					input: { tool: "Bash", command: "pnpm test" },
				},
			}),
		);
		expect(completed).toEqual(
			expect.objectContaining({
				eventId: "tool-complete-without-start",
				type: "tool.completed",
				data: {
					messageId: "message-1",
					partId: "tool-1",
					result: { exitCode: 0, text: "ok" },
					duration: 0,
				},
			}),
		);
	});

	it("maps terminal turn events using the current assistant message when needed", () => {
		const sequence = [
			runtimeEvent({
				eventId: "message-start",
				type: "message.created",
				turnId: "turn-1",
				data: {
					messageId: "message-1",
					role: "assistant",
				},
			}),
			runtimeEvent({
				eventId: "turn-complete",
				type: "turn.completed",
				turnId: "turn-1",
				data: {
					durationMs: 1250,
					cost: 0.42,
					tokens: {
						input: 10,
						output: 20,
						cacheRead: 3,
						cacheWrite: 4,
					},
				},
			}),
			runtimeEvent({
				eventId: "runtime-error",
				type: "turn.error",
				turnId: "turn-1",
				data: {
					message: "Rate limit exceeded",
					code: "rate_limit",
				},
			}),
		];
		const result = foldRuntimeEvents(sequence);
		const replay = foldRuntimeEvents(sequence);
		const [, completed, error] = result.events;

		expect(result.events).toEqual(replay.events);
		expect(completed).toEqual(
			expect.objectContaining({
				eventId: "turn-complete",
				type: "turn.completed",
				data: {
					messageId: "message-1",
					cost: 0.42,
					tokens: {
						input: 10,
						output: 20,
						cacheRead: 3,
						cacheWrite: 4,
					},
					duration: 1250,
				},
			}),
		);
		expect(error).toEqual(
			expect.objectContaining({
				eventId: "runtime-error",
				type: "turn.error",
				data: {
					messageId: "message-1",
					error: "Rate limit exceeded",
					code: "rate_limit",
				},
			}),
		);
	});

	it("maps session, permission, and question events without provider-specific payload fields", () => {
		const sequence = [
			runtimeEvent({
				eventId: "title-update",
				type: "session.renamed",
				data: {
					title: "New session title",
				},
			}),
			runtimeEvent({
				eventId: "permission-opened",
				type: "permission.asked",
				data: {
					id: "permission-1",
					toolName: "Bash",
					input: { command: "pnpm test" },
				},
			}),
			runtimeEvent({
				eventId: "permission-resolved",
				type: "permission.resolved",
				data: {
					id: "permission-1",
					decision: "always",
				},
			}),
			runtimeEvent({
				eventId: "question-opened",
				type: "question.asked",
				data: {
					id: "question-1",
					questions: [{ id: "target", question: "Which target?" }],
				},
			}),
			runtimeEvent({
				eventId: "question-resolved",
				type: "question.resolved",
				data: {
					id: "question-1",
					answers: {
						target: "unit",
					},
				},
			}),
		];

		const result = foldRuntimeEvents(sequence);

		expect(result.events.map((event) => event.type)).toEqual([
			"session.renamed",
			"permission.asked",
			"permission.resolved",
			"question.asked",
			"question.resolved",
		]);
		expect(result.events.map((event) => event.data)).toEqual([
			{
				sessionId: "session-123",
				title: "New session title",
			},
			{
				id: "permission-1",
				sessionId: "session-123",
				toolName: "Bash",
				input: { command: "pnpm test" },
			},
			{
				id: "permission-1",
				decision: "always",
			},
			{
				id: "question-1",
				sessionId: "session-123",
				questions: [{ id: "target", question: "Which target?" }],
			},
			{
				id: "question-1",
				answers: { target: "unit" },
			},
		]);
	});

	it.each([
		["unknown-value", "reject"],
		["deny", "reject"],
		["denied", "reject"],
		["declined", "reject"],
		["cancelled", "reject"],
		["canceled", "reject"],
		["no", "reject"],
		["false", "reject"],
		["allow", "once"],
		["allowed", "once"],
		["once", "once"],
		["always", "always"],
	] as const)("maps permission decision %s to %s", (providerDecision, expectedDecision) => {
		const { events } = translateProviderRuntimeEventToDomain(
			runtimeEvent({
				eventId: `permission-${providerDecision}`,
				type: "permission.resolved",
				data: {
					id: "permission-1",
					decision: providerDecision,
				},
			}),
		);

		expect(events).toEqual([
			expect.objectContaining({
				type: "permission.resolved",
				data: {
					id: "permission-1",
					decision: expectedDecision,
				},
			}),
		]);
	});

	it("uses a deterministic zero timestamp for invalid createdAt strings", () => {
		const { events } = translateProviderRuntimeEventToDomain(
			runtimeEvent({
				eventId: "runtime-event-invalid-date",
				type: "message.created",
				createdAt: "not-a-date",
				data: {
					messageId: "message-1",
					role: "assistant",
				},
			}),
		);

		expect(events[0]?.createdAt).toBe(0);
	});
});
