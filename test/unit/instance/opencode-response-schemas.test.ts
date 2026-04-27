// ─── OpenCode API Response Schema Tests ──────────────────────────────────────
// Tests for Effect Schema validation of OpenCode REST API responses.
// These schemas replace untyped `as any` casts with runtime validation,
// producing ParseError instead of runtime crashes on malformed data.
//
// Actual response shapes verified against:
// - @opencode-ai/sdk/dist/gen/types.gen.d.ts (SDK type definitions)
// - src/lib/instance/opencode-api.ts (API adapter with response handling)
// - src/lib/instance/sdk-types.ts (relay's Message interface)

import { describe, it } from "@effect/vitest";
import { Effect, Either, Schema } from "effect";
import { expect } from "vitest";

import {
	decodeMessageList,
	decodeSessionList,
	decodeSessionStatusMap,
	FlatMessageSchema,
	MessageListResponseSchema,
	MessageWithPartsSchema,
	SessionDetailSchema,
	SessionListResponseSchema,
	SessionSchema,
	SessionStatusMapSchema,
} from "../../../src/lib/effect/opencode-response-schemas.js";

// ─── SessionSchema ──────────────────────────────────────────────────────────

describe("SessionSchema", () => {
	it("decodes a valid session with all required fields", () => {
		const raw = {
			id: "s1",
			projectID: "proj1",
			directory: "/home/user/project",
			title: "Test Session",
			version: "1.0.0",
			time: { created: 1700000000, updated: 1700001000 },
		};
		const result = Schema.decodeUnknownEither(SessionSchema)(raw);
		expect(Either.isRight(result)).toBe(true);
	});

	it("decodes session with optional fields", () => {
		const raw = {
			id: "s2",
			projectID: "proj1",
			directory: "/home/user/project",
			title: "Parent Session",
			version: "1.0.0",
			time: {
				created: 1700000000,
				updated: 1700001000,
				compacting: 1700002000,
			},
			parentID: "s1",
			summary: { additions: 5, deletions: 2, files: 3 },
			share: { url: "https://share.example.com/s2" },
			revert: { messageID: "m1" },
		};
		const result = Schema.decodeUnknownEither(SessionSchema)(raw);
		expect(Either.isRight(result)).toBe(true);
	});

	it("rejects session without id", () => {
		const raw = {
			projectID: "proj1",
			directory: "/home",
			title: "No ID",
			version: "1.0.0",
			time: { created: 1, updated: 2 },
		};
		const result = Schema.decodeUnknownEither(SessionSchema)(raw);
		expect(Either.isLeft(result)).toBe(true);
	});

	it("rejects session without title", () => {
		const raw = {
			id: "s1",
			projectID: "proj1",
			directory: "/home",
			version: "1.0.0",
			time: { created: 1, updated: 2 },
		};
		const result = Schema.decodeUnknownEither(SessionSchema)(raw);
		expect(Either.isLeft(result)).toBe(true);
	});

	it("rejects session without time", () => {
		const raw = {
			id: "s1",
			projectID: "proj1",
			directory: "/home",
			title: "No Time",
			version: "1.0.0",
		};
		const result = Schema.decodeUnknownEither(SessionSchema)(raw);
		expect(Either.isLeft(result)).toBe(true);
	});
});

// ─── SessionDetailSchema ────────────────────────────────────────────────────

describe("SessionDetailSchema", () => {
	it("decodes session with relay extension fields", () => {
		const raw = {
			id: "s1",
			projectID: "proj1",
			directory: "/home/user/project",
			title: "Extended Session",
			version: "1.0.0",
			time: { created: 1700000000, updated: 1700001000 },
			modelID: "claude-3-opus",
			providerID: "anthropic",
			agentID: "build",
			slug: "my-session",
			archived: false,
		};
		const result = Schema.decodeUnknownEither(SessionDetailSchema)(raw);
		expect(Either.isRight(result)).toBe(true);
	});

	it("decodes session without extension fields (backward compat)", () => {
		const raw = {
			id: "s1",
			projectID: "proj1",
			directory: "/home/user/project",
			title: "Basic Session",
			version: "1.0.0",
			time: { created: 1700000000, updated: 1700001000 },
		};
		const result = Schema.decodeUnknownEither(SessionDetailSchema)(raw);
		expect(Either.isRight(result)).toBe(true);
	});
});

// ─── FlatMessageSchema ──────────────────────────────────────────────────────
// The relay's flattened message shape (from opencode-api.ts flattenMessage).

describe("FlatMessageSchema", () => {
	it("decodes a minimal flat message", () => {
		const raw = { id: "m1", role: "user", sessionID: "s1" };
		const result = Schema.decodeUnknownEither(FlatMessageSchema)(raw);
		expect(Either.isRight(result)).toBe(true);
	});

	it("decodes an assistant message with cost and tokens", () => {
		const raw = {
			id: "m2",
			role: "assistant",
			sessionID: "s1",
			parts: [{ id: "p1", type: "text" }],
			cost: 0.003,
			tokens: { input: 100, output: 50, cache: { read: 10, write: 5 } },
			time: { created: 1700000000, completed: 1700000001 },
		};
		const result = Schema.decodeUnknownEither(FlatMessageSchema)(raw);
		expect(Either.isRight(result)).toBe(true);
	});

	it("rejects message without id", () => {
		const raw = { role: "user", sessionID: "s1" };
		const result = Schema.decodeUnknownEither(FlatMessageSchema)(raw);
		expect(Either.isLeft(result)).toBe(true);
	});

	it("rejects message without role", () => {
		const raw = { id: "m1", sessionID: "s1" };
		const result = Schema.decodeUnknownEither(FlatMessageSchema)(raw);
		expect(Either.isLeft(result)).toBe(true);
	});

	it("rejects message without sessionID", () => {
		const raw = { id: "m1", role: "user" };
		const result = Schema.decodeUnknownEither(FlatMessageSchema)(raw);
		expect(Either.isLeft(result)).toBe(true);
	});
});

// ─── MessageWithPartsSchema ─────────────────────────────────────────────────
// The SDK's raw response shape: { info: Message, parts: Part[] }

describe("MessageWithPartsSchema", () => {
	it("decodes SDK-shaped message with info and parts", () => {
		const raw = {
			info: {
				id: "m1",
				sessionID: "s1",
				role: "user",
				time: { created: 1700000000 },
			},
			parts: [{ id: "p1", type: "text", text: "hello" }],
		};
		const result = Schema.decodeUnknownEither(MessageWithPartsSchema)(raw);
		expect(Either.isRight(result)).toBe(true);
	});

	it("decodes message with empty parts array", () => {
		const raw = {
			info: {
				id: "m1",
				sessionID: "s1",
				role: "assistant",
				time: { created: 1 },
			},
			parts: [],
		};
		const result = Schema.decodeUnknownEither(MessageWithPartsSchema)(raw);
		expect(Either.isRight(result)).toBe(true);
	});

	it("rejects missing info", () => {
		const raw = { parts: [] };
		const result = Schema.decodeUnknownEither(MessageWithPartsSchema)(raw);
		expect(Either.isLeft(result)).toBe(true);
	});

	it("rejects missing parts", () => {
		const raw = {
			info: { id: "m1", sessionID: "s1", role: "user", time: { created: 1 } },
		};
		const result = Schema.decodeUnknownEither(MessageWithPartsSchema)(raw);
		expect(Either.isLeft(result)).toBe(true);
	});
});

// ─── SessionListResponseSchema ──────────────────────────────────────────────
// The API returns Array<Session>, not { sessions: [...] }

describe("SessionListResponseSchema", () => {
	it.effect("decodes session list array", () =>
		Effect.gen(function* () {
			const raw = [
				{
					id: "s1",
					projectID: "p1",
					directory: "/home",
					title: "A",
					version: "1.0.0",
					time: { created: 1, updated: 2 },
				},
				{
					id: "s2",
					projectID: "p1",
					directory: "/home",
					title: "B",
					version: "1.0.0",
					time: { created: 3, updated: 4 },
				},
			];
			const result = yield* decodeSessionList(raw);
			expect(result).toHaveLength(2);
			expect(result.at(0)?.id).toBe("s1");
			expect(result.at(1)?.title).toBe("B");
		}),
	);

	it("rejects non-array input", () => {
		const raw = { sessions: [] };
		const result = Schema.decodeUnknownEither(SessionListResponseSchema)(raw);
		expect(Either.isLeft(result)).toBe(true);
	});

	it("rejects array with malformed session", () => {
		const raw = [{ notAnId: "x" }];
		const result = Schema.decodeUnknownEither(SessionListResponseSchema)(raw);
		expect(Either.isLeft(result)).toBe(true);
	});
});

// ─── MessageListResponseSchema ──────────────────────────────────────────────
// The API returns Array<{ info: Message, parts: Part[] }>

describe("MessageListResponseSchema", () => {
	it.effect("decodes message list array", () =>
		Effect.gen(function* () {
			const raw = [
				{
					info: {
						id: "m1",
						sessionID: "s1",
						role: "user",
						time: { created: 1 },
					},
					parts: [{ id: "p1", type: "text", text: "hello" }],
				},
				{
					info: {
						id: "m2",
						sessionID: "s1",
						role: "assistant",
						time: { created: 2 },
					},
					parts: [],
				},
			];
			const result = yield* decodeMessageList(raw);
			expect(result).toHaveLength(2);
			expect(result.at(0)?.info.id).toBe("m1");
		}),
	);

	it("rejects non-array input", () => {
		const raw = { messages: [] };
		const result = Schema.decodeUnknownEither(MessageListResponseSchema)(raw);
		expect(Either.isLeft(result)).toBe(true);
	});

	it("rejects array with missing info field", () => {
		const raw = [{ parts: [] }];
		const result = Schema.decodeUnknownEither(MessageListResponseSchema)(raw);
		expect(Either.isLeft(result)).toBe(true);
	});
});

// ─── SessionStatusMapSchema ─────────────────────────────────────────────────
// The API returns Record<string, SessionStatus>

describe("SessionStatusMapSchema", () => {
	it.effect("decodes session status map", () =>
		Effect.gen(function* () {
			const raw = {
				s1: { type: "idle" },
				s2: { type: "busy" },
				s3: {
					type: "retry",
					attempt: 2,
					message: "rate limited",
					next: 1700000000,
				},
			};
			const result = yield* decodeSessionStatusMap(raw);
			expect(result["s1"]?.type).toBe("idle");
			expect(result["s2"]?.type).toBe("busy");
			expect(result["s3"]?.type).toBe("retry");
		}),
	);

	it("decodes empty status map", () => {
		const raw = {};
		const result = Schema.decodeUnknownEither(SessionStatusMapSchema)(raw);
		expect(Either.isRight(result)).toBe(true);
	});
});
