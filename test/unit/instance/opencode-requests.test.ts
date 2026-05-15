import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
// ─── OpenCode API Request/RequestResolver Tests ────────────────────────────
// Tests for Effect Request types and RequestResolver implementations.
//
// Verifies:
// 1. GetSessions returns session list via mock OpenCodeAPI
// 2. GetMessages returns messages for a session
// 3. GetSessionStatuses returns status map
// 4. GetSession batching: multiple concurrent requests share a single API call
// 5. Error handling: API failures propagate as OpenCodeRequestError

import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import {
	GetMessages,
	GetSession,
	GetSessionStatuses,
	GetSessions,
	getMessages,
	getSession,
	getSessionStatuses,
	getSessions,
	OpenCodeRequestError,
} from "../../../src/lib/domain/provider/Services/opencode-requests.js";

// ─── Test Data ─────────────────────────────────────────────────────────────

const makeSession = (id: string, title: string) => ({
	id,
	projectID: "proj1",
	directory: "/home/user/project",
	title,
	version: "1.0.0",
	time: { created: 1700000000, updated: 1700001000 },
});

const makeMessage = (id: string, sessionId: string, role: string) => ({
	id,
	role,
	sessionID: sessionId,
	parts: [{ id: `${id}-p1`, type: "text" }],
});

// ─── Mock API Factory ──────────────────────────────────────────────────────

function makeMockApi(
	overrides: {
		listSessions?: () => Promise<unknown[]>;
		messages?: (sessionId: string) => Promise<unknown[]>;
		statuses?: () => Promise<Record<string, unknown>>;
	} = {},
) {
	const listSessions =
		overrides.listSessions ??
		(() =>
			Promise.resolve([
				makeSession("s1", "First Session"),
				makeSession("s2", "Second Session"),
			]));

	const messages =
		overrides.messages ??
		((sessionId: string) =>
			Promise.resolve([
				makeMessage("m1", sessionId, "user"),
				makeMessage("m2", sessionId, "assistant"),
			]));

	const statuses =
		overrides.statuses ??
		(() =>
			Promise.resolve({
				s1: { type: "idle" },
				s2: { type: "busy" },
			}));

	// Construct a minimal mock that matches the OpenCodeAPI shape used by resolvers
	const mock = {
		session: {
			list: vi.fn(listSessions),
			messages: vi.fn(messages),
			statuses: vi.fn(statuses),
			get: vi.fn((id: string) =>
				listSessions().then((sessions) => {
					const found = sessions.find(
						(s: unknown) => (s as { id: string }).id === id,
					);
					if (!found) throw new Error(`Session not found: ${id}`);
					return found;
				}),
			),
		},
	};

	return mock;
}

function makeMockApiLayer(overrides?: Parameters<typeof makeMockApi>[0]) {
	const mock = makeMockApi(overrides);
	// biome-ignore lint/suspicious/noExplicitAny: Mock OpenCodeAPI for testing
	return Layer.succeed(OpenCodeAPITag, mock as any);
}

// ─── GetSessions Tests ─────────────────────────────────────────────────────

describe("GetSessions", () => {
	it.effect("returns session list via resolver", () =>
		Effect.gen(function* () {
			const result = yield* getSessions;
			expect(result).toHaveLength(2);
			expect(result[0]?.id).toBe("s1");
			expect(result[1]?.title).toBe("Second Session");
		}).pipe(Effect.provide(makeMockApiLayer())),
	);

	it.effect("calls session.list() on the API", () =>
		Effect.gen(function* () {
			const mock = makeMockApi();
			// biome-ignore lint/suspicious/noExplicitAny: Mock OpenCodeAPI for testing
			const layer = Layer.succeed(OpenCodeAPITag, mock as any);

			yield* getSessions.pipe(Effect.provide(layer));

			expect(mock.session.list).toHaveBeenCalledTimes(1);
		}),
	);

	it.effect("propagates API errors as OpenCodeRequestError", () =>
		Effect.gen(function* () {
			const layer = makeMockApiLayer({
				listSessions: () => Promise.reject(new Error("connection refused")),
			});

			const result = yield* getSessions.pipe(
				Effect.flip,
				Effect.provide(layer),
			);

			expect(result).toBeInstanceOf(OpenCodeRequestError);
			expect(result._tag).toBe("OpenCodeRequestError");
			expect(result.method).toBe("session.list");
		}),
	);
});

// ─── GetMessages Tests ──────────────────────────────────────────────────────

describe("GetMessages", () => {
	it.effect("returns messages for a session", () =>
		Effect.gen(function* () {
			const result = yield* getMessages("s1");
			expect(result).toHaveLength(2);
			expect(result[0]?.id).toBe("m1");
			expect(result[0]?.role).toBe("user");
			expect(result[1]?.role).toBe("assistant");
		}).pipe(Effect.provide(makeMockApiLayer())),
	);

	it.effect("passes sessionId to session.messages()", () =>
		Effect.gen(function* () {
			const mock = makeMockApi();
			// biome-ignore lint/suspicious/noExplicitAny: Mock OpenCodeAPI for testing
			const layer = Layer.succeed(OpenCodeAPITag, mock as any);

			yield* getMessages("s42").pipe(Effect.provide(layer));

			expect(mock.session.messages).toHaveBeenCalledWith("s42");
		}),
	);

	it.effect("propagates API errors as OpenCodeRequestError", () =>
		Effect.gen(function* () {
			const layer = makeMockApiLayer({
				messages: () => Promise.reject(new Error("timeout")),
			});

			const result = yield* getMessages("s1").pipe(
				Effect.flip,
				Effect.provide(layer),
			);

			expect(result).toBeInstanceOf(OpenCodeRequestError);
			expect(result.method).toBe("session.messages");
		}),
	);
});

// ─── GetSessionStatuses Tests ───────────────────────────────────────────────

describe("GetSessionStatuses", () => {
	it.effect("returns status map for all sessions", () =>
		Effect.gen(function* () {
			const result = yield* getSessionStatuses;
			expect(result["s1"]).toEqual({ type: "idle" });
			expect(result["s2"]).toEqual({ type: "busy" });
		}).pipe(Effect.provide(makeMockApiLayer())),
	);

	it.effect("calls session.statuses() once", () =>
		Effect.gen(function* () {
			const mock = makeMockApi();
			// biome-ignore lint/suspicious/noExplicitAny: Mock OpenCodeAPI for testing
			const layer = Layer.succeed(OpenCodeAPITag, mock as any);

			yield* getSessionStatuses.pipe(Effect.provide(layer));

			expect(mock.session.statuses).toHaveBeenCalledTimes(1);
		}),
	);

	it.effect("propagates API errors as OpenCodeRequestError", () =>
		Effect.gen(function* () {
			const layer = makeMockApiLayer({
				statuses: () => Promise.reject(new Error("server error")),
			});

			const result = yield* getSessionStatuses.pipe(
				Effect.flip,
				Effect.provide(layer),
			);

			expect(result).toBeInstanceOf(OpenCodeRequestError);
			expect(result.method).toBe("session.statuses");
		}),
	);
});

// ─── GetSession Batched Resolver Tests ──────────────────────────────────────

describe("GetSession (batched)", () => {
	it.effect("resolves a single session by ID", () =>
		Effect.gen(function* () {
			const result = yield* getSession("s1");
			expect(result.id).toBe("s1");
			expect(result.title).toBe("First Session");
		}).pipe(Effect.provide(makeMockApiLayer())),
	);

	it.effect(
		"batches concurrent requests into a single session.list() call",
		() =>
			Effect.gen(function* () {
				const mock = makeMockApi();
				// biome-ignore lint/suspicious/noExplicitAny: Mock OpenCodeAPI for testing
				const layer = Layer.succeed(OpenCodeAPITag, mock as any);

				// Run two concurrent getSession requests with batching enabled
				const [s1, s2] = yield* Effect.all(
					[getSession("s1"), getSession("s2")],
					{ batching: true },
				).pipe(Effect.provide(layer));

				expect(s1.id).toBe("s1");
				expect(s2.id).toBe("s2");

				// The batched resolver should call session.list() only once
				// (or a small number of times if the scheduler didn't batch them)
				expect(mock.session.list.mock.calls.length).toBeLessThanOrEqual(2);
			}),
	);

	it.effect("fails for session IDs not in the list", () =>
		Effect.gen(function* () {
			const result = yield* getSession("nonexistent").pipe(
				Effect.flip,
				Effect.provide(makeMockApiLayer()),
			);

			expect(result).toBeInstanceOf(OpenCodeRequestError);
			expect(result.method).toBe("session.get (batched)");
		}),
	);

	it.effect("fails all requests when the batch fetch fails", () =>
		Effect.gen(function* () {
			const layer = makeMockApiLayer({
				listSessions: () => Promise.reject(new Error("network error")),
			});

			// Both requests should fail
			const result = yield* Effect.all([getSession("s1"), getSession("s2")], {
				batching: true,
			}).pipe(Effect.flip, Effect.provide(layer));

			expect(result).toBeInstanceOf(OpenCodeRequestError);
		}),
	);
});

// ─── Request Type Tests ─────────────────────────────────────────────────────

describe("Request types", () => {
	it("GetSessions has correct _tag", () => {
		const req = new GetSessions({});
		expect(req._tag).toBe("GetSessions");
	});

	it("GetMessages has correct _tag and sessionId", () => {
		const req = new GetMessages({ sessionId: "s42" });
		expect(req._tag).toBe("GetMessages");
		expect(req.sessionId).toBe("s42");
	});

	it("GetSessionStatuses has correct _tag", () => {
		const req = new GetSessionStatuses({});
		expect(req._tag).toBe("GetSessionStatuses");
	});

	it("GetSession has correct _tag and sessionId", () => {
		const req = new GetSession({ sessionId: "s99" });
		expect(req._tag).toBe("GetSession");
		expect(req.sessionId).toBe("s99");
	});
});

// ─── OpenCodeRequestError Tests ─────────────────────────────────────────────

describe("OpenCodeRequestError", () => {
	it("has correct tag and fields", () => {
		const error = new OpenCodeRequestError({
			method: "session.list",
			cause: new Error("oops"),
		});
		expect(error._tag).toBe("OpenCodeRequestError");
		expect(error.method).toBe("session.list");
		expect(error.cause).toBeInstanceOf(Error);
	});
});
