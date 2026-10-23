import { describe, expect, it } from "vitest";
import type { Logger } from "../../../src/lib/logger.js";
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
	it("emits the first empty text delta to open its part and drops later empty deltas", () => {
		const translator = new OpenCodeRuntimeEventTranslator();
		const sessionId = "ses-opencode";
		const event = makeSSEEvent("message.part.delta", {
			sessionID: sessionId,
			messageID: "msg-1",
			partID: "part-1",
			field: "text",
			delta: "",
		});
		expect(translator.translate(event, sessionId)).toMatchObject([
			{
				type: "text.delta",
				data: { messageId: "msg-1", partId: "part-1", text: "" },
			},
		]);
		expect(translator.translate(event, sessionId)).toBeNull();
	});

	it.each([
		{ partType: "text", eventType: "text.delta" },
		{ partType: "reasoning", eventType: "thinking.delta" },
	])("skips empty $partType deltas without losing later text", ({
		partType,
		eventType,
	}) => {
		const translator = new OpenCodeRuntimeEventTranslator();
		const sessionId = "ses-opencode";
		const opening = translator.translate(
			makeSSEEvent("message.part.updated", {
				sessionID: sessionId,
				part: {
					id: "part-1",
					messageID: "msg-1",
					type: partType,
					text: "",
				},
			}),
			sessionId,
		);
		expect(opening).toMatchObject([
			{
				type: partType === "text" ? "text.delta" : "thinking.start",
				data: { messageId: "msg-1", partId: "part-1" },
			},
		]);
		expect(
			translator.translate(
				makeSSEEvent("message.part.delta", {
					sessionID: sessionId,
					messageID: "msg-1",
					partID: "part-1",
					field: "text",
					delta: "",
				}),
				sessionId,
			),
		).toBeNull();
		expect(
			translator.translate(
				makeSSEEvent("message.part.delta", {
					sessionID: sessionId,
					messageID: "msg-1",
					partID: "part-1",
					field: "text",
					delta: " ",
				}),
				sessionId,
			),
		).toMatchObject([{ type: eventType, data: { text: " " } }]);
		expect(
			translator.translate(
				makeSSEEvent("message.part.updated", {
					sessionID: sessionId,
					part: {
						id: "part-1",
						messageID: "msg-1",
						type: partType,
						text: " Ready",
					},
				}),
				sessionId,
			),
		).toMatchObject([{ type: eventType, data: { text: "Ready" } }]);
	});

	it("translates removals and permits the same message id to be announced again", () => {
		const translator = new OpenCodeRuntimeEventTranslator();
		const sessionId = "ses-opencode";
		const created = makeSSEEvent("message.created", {
			sessionID: sessionId,
			messageID: "m1",
			info: { role: "assistant" },
		});
		expect(runtimeToDomain(translator, created, sessionId)).toHaveLength(1);
		expect(
			comparable(
				runtimeToDomain(
					translator,
					makeSSEEvent("message.part.removed", {
						sessionID: sessionId,
						messageID: "m1",
						partID: "p1",
					}),
					sessionId,
				),
			),
		).toMatchObject([
			{ type: "message.part.removed", data: { messageId: "m1", partId: "p1" } },
		]);
		expect(
			comparable(
				runtimeToDomain(
					translator,
					makeSSEEvent("message.removed", {
						sessionID: sessionId,
						messageID: "m1",
					}),
					sessionId,
				),
			),
		).toMatchObject([{ type: "message.removed", data: { messageId: "m1" } }]);
		expect(runtimeToDomain(translator, created, sessionId)).toHaveLength(1);
	});
	it("carries assistant parentID from message.created into the canonical event", () => {
		const translator = new OpenCodeRuntimeEventTranslator();
		const event = makeSSEEvent("message.created", {
			sessionID: "ses-opencode",
			messageID: "msg-assistant-1",
			info: { role: "assistant", parentID: "msg-user-1" },
		});
		expect(
			runtimeToDomain(translator, event, "ses-opencode")[0]?.data,
		).toMatchObject({ parentID: "msg-user-1" });
	});

	it("strips the 'undefined: ' artifact from session.error", () => {
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
		const expected = {
			error: "The provided model identifier is invalid.",
			code: "APIError",
		};
		expect(domainEvents[0]?.type).toBe("turn.error");
		expect(domainEvents[0]?.data).toMatchObject(expected);
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

	it("emits nothing when a refreshed text part no longer extends what was sent", () => {
		const warnings: unknown[][] = [];
		const log: Logger = {
			debug: () => {},
			verbose: () => {},
			info: () => {},
			warn: (...args: unknown[]) => {
				warnings.push(args);
			},
			error: () => {},
			child: () => log,
		};
		const translator = new OpenCodeRuntimeEventTranslator(log);
		const sessionId = "ses-opencode";
		translator.translate(
			makeSSEEvent("message.part.delta", {
				sessionID: sessionId,
				messageID: "msg-assistant-1",
				partID: "part-text-1",
				field: "text",
				delta: "hello world",
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
					// A rewritten text: slicing it at 11 characters would have
					// spliced "ld, again" onto the tail of "hello world".
					text: "[12:00] hello world, again",
				},
			}),
			sessionId,
		);

		expect(result).toBeNull();
		expect(warnings).toHaveLength(1);
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
					parentID: "msg-user-1",
					time: { created: 1000 },
				},
			}),
			sessionId,
		);

		expect(result?.map((event) => event.type)).toEqual(["message.created"]);
		expect(result?.[0]?.data).toMatchObject({ parentID: "msg-user-1" });
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

	it("attaches refreshed input once when skill args stream after the part is first seen", () => {
		const translator = new OpenCodeRuntimeEventTranslator();
		const sessionId = "ses-opencode";
		const part = {
			id: "part-skill-1",
			messageID: "msg-assistant-1",
			type: "tool" as const,
			tool: "skill",
			callID: "call-skill-1",
		};

		// Args stream late: pending arrives with empty input
		const started = translator.translate(
			makeSSEEvent("message.part.updated", {
				sessionID: sessionId,
				part: { ...part, state: { status: "pending", input: {} } },
			}),
			sessionId,
		);
		expect(started).toMatchObject([
			{
				type: "tool.started",
				data: { input: { tool: "Skill", name: "" } },
			},
		]);

		const running = translator.translate(
			makeSSEEvent("message.part.updated", {
				sessionID: sessionId,
				part: {
					...part,
					state: { status: "running", input: { name: "commit" } },
				},
			}),
			sessionId,
		);
		expect(running).toMatchObject([
			{
				type: "tool.running",
				data: {
					input: { tool: "Skill", name: "commit" },
					callId: "call-skill-1",
					toolName: "Skill",
				},
			},
		]);

		// running already delivered the refresh — completed must not duplicate it
		const completed = translator.translate(
			makeSSEEvent("message.part.updated", {
				sessionID: sessionId,
				part: {
					...part,
					state: {
						status: "completed",
						input: { name: "commit" },
						output: "done",
					},
					time: { start: 1000, end: 2000 },
				},
			}),
			sessionId,
		);
		expect(completed?.[0]?.type).toBe("tool.completed");
		expect(completed?.[0]?.data).not.toHaveProperty("input");
	});

	it("attaches refreshed input to tool.completed when args arrive only at completion", () => {
		const translator = new OpenCodeRuntimeEventTranslator();
		const sessionId = "ses-opencode";
		const part = {
			id: "part-skill-2",
			messageID: "msg-assistant-1",
			type: "tool" as const,
			tool: "skill",
			callID: "call-skill-2",
		};

		translator.translate(
			makeSSEEvent("message.part.updated", {
				sessionID: sessionId,
				part: { ...part, state: { status: "pending", input: {} } },
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
						input: { name: "commit" },
						output: "done",
					},
					time: { start: 1000, end: 2000 },
				},
			}),
			sessionId,
		);
		expect(completed).toMatchObject([
			{
				type: "tool.completed",
				data: { input: { tool: "Skill", name: "commit" } },
			},
		]);
	});

	it("does not attach input to running or completed when it was complete at start", () => {
		const translator = new OpenCodeRuntimeEventTranslator();
		const sessionId = "ses-opencode";
		const part = {
			id: "part-bash-1",
			messageID: "msg-assistant-1",
			type: "tool" as const,
			tool: "bash",
			callID: "call-bash-1",
		};

		translator.translate(
			makeSSEEvent("message.part.updated", {
				sessionID: sessionId,
				part: {
					...part,
					state: { status: "pending", input: { command: "ls" } },
				},
			}),
			sessionId,
		);
		const running = translator.translate(
			makeSSEEvent("message.part.updated", {
				sessionID: sessionId,
				part: {
					...part,
					state: { status: "running", input: { command: "ls" } },
				},
			}),
			sessionId,
		);
		const completed = translator.translate(
			makeSSEEvent("message.part.updated", {
				sessionID: sessionId,
				part: {
					...part,
					state: { status: "completed", input: { command: "ls" }, output: "" },
					time: { start: 1000, end: 1100 },
				},
			}),
			sessionId,
		);
		expect(running?.[0]?.data).not.toHaveProperty("input");
		expect(completed?.[0]?.data).not.toHaveProperty("input");
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
					source: { url: "file:///screenshot.png" },
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
						source: { url: "file:///screenshot.png" },
					},
				},
			]);
			expect(translator.translate(event, sessionId)).toBeNull();
		}
	});

	describe("a turn that ends while OpenCode is retrying", () => {
		const sessionId = "ses-retry";
		const reason = "Upstream request failed: Model is unavailable.";
		const busy = makeSSEEvent("session.status", {
			sessionID: sessionId,
			status: { type: "busy" },
		});
		const retry = (attempt: number) =>
			makeSSEEvent("session.status", {
				sessionID: sessionId,
				status: { type: "retry", attempt, message: reason, next: 0 },
			});
		// OpenCode 1.18.34 sends a snapshot patch part when a turn is aborted.
		const patch = makeSSEEvent("message.part.updated", {
			part: {
				id: "part-patch",
				messageID: "msg-a1",
				sessionID: sessionId,
				type: "patch",
				hash: "h",
				files: [],
			},
		});
		const completed = (messageId: string) =>
			makeSSEEvent("message.updated", {
				sessionID: sessionId,
				info: {
					id: messageId,
					role: "assistant",
					sessionID: sessionId,
					time: { created: 1, completed: 2 },
				},
			});
		const textDelta = makeSSEEvent("message.part.delta", {
			sessionID: sessionId,
			messageID: "msg-a1",
			partID: "part-text",
			field: "text",
			delta: "Pong",
		});
		const types = (
			translator: OpenCodeRuntimeEventTranslator,
			events: readonly SSEEvent[],
		) =>
			events.flatMap(
				(event) =>
					translator.translate(event, sessionId)?.map((e) => ({
						type: e.type,
						error: (e.data as { error?: string }).error,
					})) ?? [],
			);

		it("records the last retry reason as the turn's error when it is stopped", () => {
			const translator = new OpenCodeRuntimeEventTranslator();
			const out = types(translator, [
				busy,
				retry(1),
				busy,
				retry(2),
				patch,
				completed("msg-a1"),
			]);
			const errors = out.filter((e) => e.type === "turn.error");
			expect(errors).toEqual([
				{ type: "turn.error", error: `Stopped while retrying: ${reason}` },
			]);
			expect(out.findIndex((e) => e.type === "turn.error")).toBeLessThan(
				out.findIndex((e) => e.type === "turn.completed"),
			);
		});

		it("records nothing once the retry recovers and the model replies", () => {
			const translator = new OpenCodeRuntimeEventTranslator();
			const out = types(translator, [
				busy,
				retry(1),
				busy,
				textDelta,
				completed("msg-a1"),
			]);
			expect(out.some((e) => e.type === "turn.error")).toBe(false);
		});

		it("does not add a second error when OpenCode reports one itself", () => {
			const translator = new OpenCodeRuntimeEventTranslator();
			const out = types(translator, [
				busy,
				retry(1),
				makeSSEEvent("session.error", {
					sessionID: sessionId,
					error: { name: "APIError", data: { message: "Gave up" } },
				}),
				completed("msg-a1"),
			]);
			expect(out.filter((e) => e.type === "turn.error")).toHaveLength(1);
		});

		it("does not carry the reason into the next turn", () => {
			const translator = new OpenCodeRuntimeEventTranslator();
			types(translator, [busy, retry(1), completed("msg-a1")]);
			const next = types(translator, [busy, textDelta, completed("msg-a2")]);
			expect(next.some((e) => e.type === "turn.error")).toBe(false);
		});

		it("keeps the reason across committed forks and a reconnect", () => {
			const translator = new OpenCodeRuntimeEventTranslator();
			const step = (event: SSEEvent) => {
				const working = translator.forkSession(sessionId);
				const events = translator.translateInto(event, sessionId, working);
				translator.commitSession(sessionId, working);
				return events ?? [];
			};
			step(busy);
			step(retry(1));
			translator.resetAnnouncements();
			const out = step(completed("msg-a1"));
			expect(out.map((e) => e.type)).toContain("turn.error");
		});
	});
});
