// test/unit/provider/event-sink.test.ts
import { Effect, Fiber } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderRuntimeEvent } from "../../../src/lib/contracts/providers/provider-runtime-event.js";
import type { CanonicalEvent } from "../../../src/lib/persistence/events.js";
import { EventSinkImpl } from "../../../src/lib/provider/event-sink.js";
import type {
	PermissionRequest,
	QuestionRequest,
} from "../../../src/lib/provider/types.js";
import { providerRuntimeEvent } from "../../helpers/provider-runtime-event.js";

// ─── Mock dependencies ─────────────────────────────────────────────────────

function makeMockEventStore() {
	const appendedEvents: CanonicalEvent[] = [];
	const store = {
		append: vi.fn((event: CanonicalEvent) => {
			appendedEvents.push(event);
			return {
				...event,
				sequence: appendedEvents.length,
				streamVersion: 1,
			};
		}),
		appendBatch: vi.fn((events: readonly CanonicalEvent[]) =>
			events.map((event) => store.append(event)),
		),
		appendedEvents,
	};
	return store;
}

function makeMockProjectionRunner() {
	const runner = {
		projectEvent: vi.fn(),
		projectBatch: vi.fn((events: readonly unknown[]) => {
			for (const event of events) {
				// Keep the old tests observing projectEvent calls while production uses batch projection.
				runner.projectEvent(event);
			}
		}),
	};
	return runner;
}

function makeEvent(
	overrides?: Partial<ProviderRuntimeEvent>,
): ProviderRuntimeEvent {
	return {
		...providerRuntimeEvent(
			"text.delta",
			"s1",
			{ messageId: "m1", partId: "p1", text: "hello" },
			{ eventId: "evt-1", providerId: "opencode" },
		),
		...overrides,
	};
}

describe("EventSinkImpl", () => {
	let eventStore: ReturnType<typeof makeMockEventStore>;
	let projectionRunner: ReturnType<typeof makeMockProjectionRunner>;
	let sink: EventSinkImpl;

	beforeEach(() => {
		eventStore = makeMockEventStore();
		projectionRunner = makeMockProjectionRunner();
		sink = new EventSinkImpl({
			// biome-ignore lint/suspicious/noExplicitAny: mock objects don't implement full interface
			eventStore: eventStore as any,
			// biome-ignore lint/suspicious/noExplicitAny: mock objects don't implement full interface
			projectionRunner: projectionRunner as any,
			sessionId: "s1",
			provider: "opencode",
		});
	});

	describe("push", () => {
		it("appends event to store and projects it", async () => {
			const event = makeEvent();
			await Effect.runPromise(sink.push(event));

			expect(eventStore.append).toHaveBeenCalledWith(
				expect.objectContaining({
					eventId: event.eventId,
					type: event.type,
					sessionId: event.sessionId,
					provider: event.providerId,
				}),
			);
			expect(projectionRunner.projectEvent).toHaveBeenCalledTimes(1);
		});

		it("projects the stored event (with sequence)", async () => {
			const event = makeEvent();
			await Effect.runPromise(sink.push(event));

			const projected = projectionRunner.projectEvent.mock.calls[0]?.[0];
			expect(projected.sequence).toBe(1);
		});

		it("handles multiple sequential pushes", async () => {
			await Effect.runPromise(sink.push(makeEvent({ eventId: "e1" })));
			await Effect.runPromise(sink.push(makeEvent({ eventId: "e2" })));
			await Effect.runPromise(sink.push(makeEvent({ eventId: "e3" })));

			expect(eventStore.append).toHaveBeenCalledTimes(3);
			expect(projectionRunner.projectEvent).toHaveBeenCalledTimes(3);
		});
	});

	describe("requestPermission", () => {
		it("emits permission.asked event and blocks until resolved", async () => {
			const request: PermissionRequest = {
				requestId: "perm-1",
				toolName: "bash",
				toolInput: { patterns: ["*.sh"], metadata: { cmd: "rm" } },
				sessionId: "s1",
				turnId: "t1",
				providerItemId: "item-1",
			};

			// Start the permission request (it will block)
			const resultPromise = Effect.runPromise(sink.requestPermission(request));

			// Verify the permission.asked event was pushed
			expect(eventStore.append).toHaveBeenCalledTimes(1);
			const pushed = eventStore.append.mock.calls[0]?.[0] as CanonicalEvent;
			expect(pushed.type).toBe("permission.asked");
			expect(pushed.data).toMatchObject({
				id: "perm-1",
				toolName: "bash",
			});

			// Resolve it
			await Effect.runPromise(
				sink.resolvePermission("perm-1", { decision: "once" }),
			);

			const result = await resultPromise;
			expect(result.decision).toBe("once");
		});

		it("resolves with 'always' decision", async () => {
			const request: PermissionRequest = {
				requestId: "perm-2",
				toolName: "write",
				toolInput: { patterns: [], metadata: {} },
				sessionId: "s1",
				turnId: "t1",
				providerItemId: "item-2",
			};

			const resultPromise = Effect.runPromise(sink.requestPermission(request));
			await Effect.runPromise(
				sink.resolvePermission("perm-2", { decision: "always" }),
			);

			const result = await resultPromise;
			expect(result.decision).toBe("always");
		});

		it("resolves with 'reject' decision", async () => {
			const request: PermissionRequest = {
				requestId: "perm-3",
				toolName: "bash",
				toolInput: { patterns: [], metadata: {} },
				sessionId: "s1",
				turnId: "t1",
				providerItemId: "item-3",
			};

			const resultPromise = Effect.runPromise(sink.requestPermission(request));
			await Effect.runPromise(
				sink.resolvePermission("perm-3", { decision: "reject" }),
			);

			const result = await resultPromise;
			expect(result.decision).toBe("reject");
		});

		it("handles multiple concurrent permission requests", async () => {
			const p1 = Effect.runPromise(
				sink.requestPermission({
					requestId: "r1",
					toolName: "bash",
					toolInput: { patterns: [], metadata: {} },
					sessionId: "s1",
					turnId: "t1",
					providerItemId: "item-r1",
				}),
			);
			const p2 = Effect.runPromise(
				sink.requestPermission({
					requestId: "r2",
					toolName: "write",
					toolInput: { patterns: [], metadata: {} },
					sessionId: "s1",
					turnId: "t1",
					providerItemId: "item-r2",
				}),
			);

			await Effect.runPromise(
				sink.resolvePermission("r2", { decision: "always" }),
			);
			await Effect.runPromise(
				sink.resolvePermission("r1", { decision: "once" }),
			);

			const [res1, res2] = await Promise.all([p1, p2]);
			expect(res1.decision).toBe("once");
			expect(res2.decision).toBe("always");
		});

		it("emits permission.resolved event on resolution", async () => {
			const resultPromise = Effect.runPromise(
				sink.requestPermission({
					requestId: "perm-4",
					toolName: "bash",
					toolInput: { patterns: [], metadata: {} },
					sessionId: "s1",
					turnId: "t1",
					providerItemId: "item-4",
				}),
			);

			await Effect.runPromise(
				sink.resolvePermission("perm-4", { decision: "once" }),
			);
			await resultPromise;

			// Two events: permission.asked + permission.resolved
			expect(eventStore.append).toHaveBeenCalledTimes(2);
			const resolvedEvent = eventStore.append.mock
				.calls[1]?.[0] as CanonicalEvent;
			expect(resolvedEvent.type).toBe("permission.resolved");
			expect(resolvedEvent.data).toMatchObject({
				id: "perm-4",
				decision: "once",
			});
		});

		it("removes pending permissions when the waiting fiber is interrupted", async () => {
			await Effect.runPromise(
				Effect.gen(function* () {
					const fiber = yield* Effect.fork(
						sink.requestPermission({
							requestId: "perm-interrupt",
							toolName: "bash",
							toolInput: { patterns: [], metadata: {} },
							sessionId: "s1",
							turnId: "t1",
							providerItemId: "item-interrupt",
						}),
					);

					yield* Effect.yieldNow();
					expect(sink.pendingCount).toBe(1);

					yield* Fiber.interrupt(fiber);
					expect(sink.pendingCount).toBe(0);
				}),
			);
		});
	});

	describe("requestQuestion", () => {
		it("emits question.asked event and blocks until resolved", async () => {
			const request: QuestionRequest = {
				requestId: "q1",
				questions: [
					{
						question: "Continue?",
						header: "Confirmation",
						options: [
							{ label: "Yes", description: "Proceed" },
							{ label: "No", description: "Cancel" },
						],
					},
				],
			};

			const resultPromise = Effect.runPromise(sink.requestQuestion(request));

			expect(eventStore.append).toHaveBeenCalledTimes(1);
			const pushed = eventStore.append.mock.calls[0]?.[0] as CanonicalEvent;
			expect(pushed.type).toBe("question.asked");

			await Effect.runPromise(sink.resolveQuestion("q1", { answer: "Yes" }));

			const result = await resultPromise;
			expect(result).toEqual({ answer: "Yes" });
		});

		it("emits question.resolved event on resolution", async () => {
			const resultPromise = Effect.runPromise(
				sink.requestQuestion({
					requestId: "q2",
					questions: [
						{
							question: "Pick one",
							header: "Choose",
							options: [{ label: "A", description: "Option A" }],
						},
					],
				}),
			);

			await Effect.runPromise(sink.resolveQuestion("q2", { choice: "A" }));
			await resultPromise;

			expect(eventStore.append).toHaveBeenCalledTimes(2);
			const resolvedEvent = eventStore.append.mock
				.calls[1]?.[0] as CanonicalEvent;
			expect(resolvedEvent.type).toBe("question.resolved");
		});
	});

	describe("abort handling", () => {
		it("rejects pending permissions when aborted", async () => {
			const resultPromise = Effect.runPromise(
				sink.requestPermission({
					requestId: "perm-abort",
					toolName: "bash",
					toolInput: { patterns: [], metadata: {} },
					sessionId: "s1",
					turnId: "t1",
					providerItemId: "item-abort",
				}),
			);

			sink.abort();

			await expect(resultPromise).rejects.toThrow("aborted");
		});

		it("rejects pending questions when aborted", async () => {
			const resultPromise = Effect.runPromise(
				sink.requestQuestion({
					requestId: "q-abort",
					questions: [
						{
							question: "Continue?",
							header: "Test",
							options: [],
						},
					],
				}),
			);

			sink.abort();

			await expect(resultPromise).rejects.toThrow("aborted");
		});

		it("has no pending requests after abort", () => {
			void Effect.runPromise(
				sink.requestPermission({
					requestId: "perm-x",
					toolName: "bash",
					toolInput: { patterns: [], metadata: {} },
					sessionId: "s1",
					turnId: "t1",
					providerItemId: "item-x",
				}),
			).catch(() => {}); // Swallow rejection

			sink.abort();

			expect(sink.pendingCount).toBe(0);
		});
	});
});
