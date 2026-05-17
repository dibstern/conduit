import { Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
	CanonicalEventSchema,
	canonicalEvent,
	EventMetadataSchema,
	StoredEventSchema,
} from "../../../src/lib/persistence/events.js";

describe("Canonical event schemas", () => {
	const validMetadata = {
		commandId: "cmd_1",
		source: "test",
	};

	describe("CanonicalEventSchema", () => {
		it("decodes message.created event", () => {
			const raw = {
				eventId: "evt_1",
				sessionId: "s1",
				type: "message.created",
				data: { messageId: "m1", role: "user", sessionId: "s1" },
				metadata: validMetadata,
				provider: "opencode",
				createdAt: Date.now(),
			};
			const result = Schema.decodeUnknownEither(CanonicalEventSchema)(raw);
			expect(Either.isRight(result)).toBe(true);
		});

		it("decodes text.delta event", () => {
			const raw = {
				eventId: "evt_2",
				sessionId: "s1",
				type: "text.delta",
				data: { messageId: "m1", partId: "p1", text: "hello" },
				metadata: {},
				provider: "opencode",
				createdAt: Date.now(),
			};
			const result = Schema.decodeUnknownEither(CanonicalEventSchema)(raw);
			expect(Either.isRight(result)).toBe(true);
		});

		it("decodes thinking.start event", () => {
			const raw = {
				eventId: "evt_3",
				sessionId: "s1",
				type: "thinking.start",
				data: { messageId: "m1", partId: "p1" },
				metadata: {},
				provider: "opencode",
				createdAt: Date.now(),
			};
			const result = Schema.decodeUnknownEither(CanonicalEventSchema)(raw);
			expect(Either.isRight(result)).toBe(true);
		});

		it("decodes thinking.delta event", () => {
			const raw = {
				eventId: "evt_4",
				sessionId: "s1",
				type: "thinking.delta",
				data: { messageId: "m1", partId: "p1", text: "thinking..." },
				metadata: {},
				provider: "opencode",
				createdAt: Date.now(),
			};
			const result = Schema.decodeUnknownEither(CanonicalEventSchema)(raw);
			expect(Either.isRight(result)).toBe(true);
		});

		it("decodes thinking.end event", () => {
			const raw = {
				eventId: "evt_5",
				sessionId: "s1",
				type: "thinking.end",
				data: { messageId: "m1", partId: "p1" },
				metadata: {},
				provider: "opencode",
				createdAt: Date.now(),
			};
			const result = Schema.decodeUnknownEither(CanonicalEventSchema)(raw);
			expect(Either.isRight(result)).toBe(true);
		});

		it("decodes tool.started event", () => {
			const raw = {
				eventId: "evt_6",
				sessionId: "s1",
				type: "tool.started",
				data: {
					messageId: "m1",
					partId: "p1",
					toolName: "Read",
					callId: "c1",
					input: { tool: "Read", filePath: "/tmp/test" },
				},
				metadata: {},
				provider: "opencode",
				createdAt: Date.now(),
			};
			const result = Schema.decodeUnknownEither(CanonicalEventSchema)(raw);
			expect(Either.isRight(result)).toBe(true);
		});

		it("rejects non-canonical tool.started input", () => {
			const raw = {
				eventId: "evt_6b",
				sessionId: "s1",
				type: "tool.started",
				data: {
					messageId: "m1",
					partId: "p1",
					toolName: "Read",
					callId: "c1",
					input: { file_path: "/tmp/test" },
				},
				metadata: {},
				provider: "opencode",
				createdAt: Date.now(),
			};
			const result = Schema.decodeUnknownEither(CanonicalEventSchema)(raw);
			expect(Either.isLeft(result)).toBe(true);
		});

		it("decodes tool.running event", () => {
			const raw = {
				eventId: "evt_7",
				sessionId: "s1",
				type: "tool.running",
				data: { messageId: "m1", partId: "p1" },
				metadata: {},
				provider: "opencode",
				createdAt: Date.now(),
			};
			const result = Schema.decodeUnknownEither(CanonicalEventSchema)(raw);
			expect(Either.isRight(result)).toBe(true);
		});

		it("decodes tool.completed event", () => {
			const raw = {
				eventId: "evt_8",
				sessionId: "s1",
				type: "tool.completed",
				data: {
					messageId: "m1",
					partId: "p1",
					result: { output: "done" },
					duration: 100,
				},
				metadata: {},
				provider: "opencode",
				createdAt: Date.now(),
			};
			const result = Schema.decodeUnknownEither(CanonicalEventSchema)(raw);
			expect(Either.isRight(result)).toBe(true);
		});

		it("decodes tool.input_updated event", () => {
			const raw = {
				eventId: "evt_9",
				sessionId: "s1",
				type: "tool.input_updated",
				data: { messageId: "m1", partId: "p1", extra: "value" },
				metadata: {},
				provider: "opencode",
				createdAt: Date.now(),
			};
			const result = Schema.decodeUnknownEither(CanonicalEventSchema)(raw);
			expect(Either.isRight(result)).toBe(true);
		});

		it("decodes turn.completed event", () => {
			const raw = {
				eventId: "evt_10",
				sessionId: "s1",
				type: "turn.completed",
				data: {
					messageId: "m1",
					cost: 0.01,
					tokens: { input: 100, output: 50 },
					duration: 1000,
				},
				metadata: {},
				provider: "opencode",
				createdAt: Date.now(),
			};
			const result = Schema.decodeUnknownEither(CanonicalEventSchema)(raw);
			expect(Either.isRight(result)).toBe(true);
		});

		it("decodes turn.error event", () => {
			const raw = {
				eventId: "evt_11",
				sessionId: "s1",
				type: "turn.error",
				data: { messageId: "m1", error: "something failed", code: "ERR" },
				metadata: {},
				provider: "opencode",
				createdAt: Date.now(),
			};
			const result = Schema.decodeUnknownEither(CanonicalEventSchema)(raw);
			expect(Either.isRight(result)).toBe(true);
		});

		it("decodes turn.interrupted event", () => {
			const raw = {
				eventId: "evt_12",
				sessionId: "s1",
				type: "turn.interrupted",
				data: { messageId: "m1" },
				metadata: {},
				provider: "opencode",
				createdAt: Date.now(),
			};
			const result = Schema.decodeUnknownEither(CanonicalEventSchema)(raw);
			expect(Either.isRight(result)).toBe(true);
		});

		it("decodes session.created event", () => {
			const raw = {
				eventId: "evt_13",
				sessionId: "s1",
				type: "session.created",
				data: {
					sessionId: "s1",
					title: "Test",
					provider: "opencode",
					parentId: "parent-session",
					providerSessionId: "claude-sdk-session",
				},
				metadata: {},
				provider: "opencode",
				createdAt: Date.now(),
			};
			const result = Schema.decodeUnknownEither(CanonicalEventSchema)(raw);
			expect(Either.isRight(result)).toBe(true);
		});

		it("decodes session.renamed event", () => {
			const raw = {
				eventId: "evt_14",
				sessionId: "s1",
				type: "session.renamed",
				data: { sessionId: "s1", title: "New Title" },
				metadata: {},
				provider: "opencode",
				createdAt: Date.now(),
			};
			const result = Schema.decodeUnknownEither(CanonicalEventSchema)(raw);
			expect(Either.isRight(result)).toBe(true);
		});

		it("decodes session.status event", () => {
			const raw = {
				eventId: "evt_15",
				sessionId: "s1",
				type: "session.status",
				data: { sessionId: "s1", status: "idle" },
				metadata: {},
				provider: "opencode",
				createdAt: Date.now(),
			};
			const result = Schema.decodeUnknownEither(CanonicalEventSchema)(raw);
			expect(Either.isRight(result)).toBe(true);
		});

		it("decodes session.provider_changed event", () => {
			const raw = {
				eventId: "evt_16",
				sessionId: "s1",
				type: "session.provider_changed",
				data: {
					sessionId: "s1",
					oldProvider: "opencode",
					newProvider: "claude",
				},
				metadata: {},
				provider: "opencode",
				createdAt: Date.now(),
			};
			const result = Schema.decodeUnknownEither(CanonicalEventSchema)(raw);
			expect(Either.isRight(result)).toBe(true);
		});

		it("decodes permission.asked event", () => {
			const raw = {
				eventId: "evt_17",
				sessionId: "s1",
				type: "permission.asked",
				data: {
					id: "perm_1",
					sessionId: "s1",
					toolName: "Bash",
					input: { command: "ls" },
				},
				metadata: {},
				provider: "opencode",
				createdAt: Date.now(),
			};
			const result = Schema.decodeUnknownEither(CanonicalEventSchema)(raw);
			expect(Either.isRight(result)).toBe(true);
		});

		it("decodes permission.resolved event", () => {
			const raw = {
				eventId: "evt_18",
				sessionId: "s1",
				type: "permission.resolved",
				data: { id: "perm_1", decision: "once" },
				metadata: {},
				provider: "opencode",
				createdAt: Date.now(),
			};
			const result = Schema.decodeUnknownEither(CanonicalEventSchema)(raw);
			expect(Either.isRight(result)).toBe(true);
		});

		it("decodes question.asked event", () => {
			const raw = {
				eventId: "evt_19",
				sessionId: "s1",
				type: "question.asked",
				data: {
					id: "q_1",
					sessionId: "s1",
					questions: [{ text: "What?" }],
				},
				metadata: {},
				provider: "opencode",
				createdAt: Date.now(),
			};
			const result = Schema.decodeUnknownEither(CanonicalEventSchema)(raw);
			expect(Either.isRight(result)).toBe(true);
		});

		it("decodes question.resolved event", () => {
			const raw = {
				eventId: "evt_20",
				sessionId: "s1",
				type: "question.resolved",
				data: { id: "q_1", answers: { q1: "answer" } },
				metadata: {},
				provider: "opencode",
				createdAt: Date.now(),
			};
			const result = Schema.decodeUnknownEither(CanonicalEventSchema)(raw);
			expect(Either.isRight(result)).toBe(true);
		});

		it("rejects unknown event type", () => {
			const raw = {
				eventId: "evt_bad",
				sessionId: "s1",
				type: "not.a.real.event",
				data: {},
				metadata: {},
				provider: "opencode",
				createdAt: Date.now(),
			};
			const result = Schema.decodeUnknownEither(CanonicalEventSchema)(raw);
			expect(Either.isLeft(result)).toBe(true);
		});

		it("rejects event with missing required data fields", () => {
			const raw = {
				eventId: "evt_bad2",
				sessionId: "s1",
				type: "message.created",
				data: { messageId: "m1" }, // missing role and sessionId
				metadata: {},
				provider: "opencode",
				createdAt: Date.now(),
			};
			const result = Schema.decodeUnknownEither(CanonicalEventSchema)(raw);
			expect(Either.isLeft(result)).toBe(true);
		});

		it("accepts event with optional metadata fields", () => {
			const raw = {
				eventId: "evt_meta",
				sessionId: "s1",
				type: "message.created",
				data: { messageId: "m1", role: "user", sessionId: "s1" },
				metadata: {
					commandId: "cmd_1",
					causationEventId: "evt_0",
					correlationId: "corr_1",
					adapterKey: "test",
					providerTurnId: "t1",
					synthetic: true,
					source: "test",
					sseBatchId: "batch_1",
					sseBatchSize: 5,
					schemaVersion: 2,
				},
				provider: "opencode",
				createdAt: Date.now(),
			};
			const result = Schema.decodeUnknownEither(CanonicalEventSchema)(raw);
			expect(Either.isRight(result)).toBe(true);
		});

		it("accepts event with empty metadata", () => {
			const raw = {
				eventId: "evt_empty_meta",
				sessionId: "s1",
				type: "turn.interrupted",
				data: { messageId: "m1" },
				metadata: {},
				provider: "opencode",
				createdAt: Date.now(),
			};
			const result = Schema.decodeUnknownEither(CanonicalEventSchema)(raw);
			expect(Either.isRight(result)).toBe(true);
		});
	});

	describe("StoredEventSchema", () => {
		it("decodes a stored event with sequence and streamVersion", () => {
			const raw = {
				eventId: "evt_stored",
				sessionId: "s1",
				type: "message.created",
				data: { messageId: "m1", role: "user", sessionId: "s1" },
				metadata: {},
				provider: "opencode",
				createdAt: Date.now(),
				sequence: 1,
				streamVersion: 0,
			};
			const result = Schema.decodeUnknownEither(StoredEventSchema)(raw);
			expect(Either.isRight(result)).toBe(true);
		});

		it("rejects stored event missing sequence", () => {
			const raw = {
				eventId: "evt_no_seq",
				sessionId: "s1",
				type: "message.created",
				data: { messageId: "m1", role: "user", sessionId: "s1" },
				metadata: {},
				provider: "opencode",
				createdAt: Date.now(),
				streamVersion: 0,
			};
			const result = Schema.decodeUnknownEither(StoredEventSchema)(raw);
			expect(Either.isLeft(result)).toBe(true);
		});
	});

	describe("EventMetadataSchema", () => {
		it("decodes full metadata", () => {
			const raw = {
				commandId: "cmd_1",
				causationEventId: "evt_0",
				correlationId: "corr_1",
				adapterKey: "test",
				providerTurnId: "t1",
				synthetic: true,
				source: "test",
				sseBatchId: "batch_1",
				sseBatchSize: 5,
				schemaVersion: 2,
			};
			const result = Schema.decodeUnknownEither(EventMetadataSchema)(raw);
			expect(Either.isRight(result)).toBe(true);
		});

		it("decodes empty metadata", () => {
			const result = Schema.decodeUnknownEither(EventMetadataSchema)({});
			expect(Either.isRight(result)).toBe(true);
		});
	});

	describe("canonicalEvent factory", () => {
		it("produces valid message.created events", () => {
			const event = canonicalEvent("message.created", "s1", {
				role: "user",
				messageId: "m1",
				sessionId: "s1",
			});
			const result = Schema.decodeUnknownEither(CanonicalEventSchema)(event);
			expect(Either.isRight(result)).toBe(true);
		});

		it("produces valid text.delta events", () => {
			const event = canonicalEvent("text.delta", "s1", {
				text: "hello",
				messageId: "m1",
				partId: "p1",
			});
			const result = Schema.decodeUnknownEither(CanonicalEventSchema)(event);
			expect(Either.isRight(result)).toBe(true);
		});

		it("produces valid tool.started events", () => {
			const event = canonicalEvent("tool.started", "s1", {
				messageId: "m1",
				partId: "p1",
				toolName: "Bash",
				callId: "c1",
				input: { tool: "Bash", command: "ls" },
			});
			const result = Schema.decodeUnknownEither(CanonicalEventSchema)(event);
			expect(Either.isRight(result)).toBe(true);
		});

		it("produces valid turn.completed events with optional fields", () => {
			const event = canonicalEvent("turn.completed", "s1", {
				messageId: "m1",
				cost: 0.05,
				tokens: {
					input: 500,
					output: 200,
					cacheRead: 100,
					cacheWrite: 50,
				},
				duration: 3000,
			});
			const result = Schema.decodeUnknownEither(CanonicalEventSchema)(event);
			expect(Either.isRight(result)).toBe(true);
		});
	});
});
