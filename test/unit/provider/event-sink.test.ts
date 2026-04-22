// test/unit/provider/event-sink.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalEvent } from "../../../src/lib/persistence/events.js";
import { EventSinkImpl } from "../../../src/lib/provider/event-sink.js";
import type {
	PermissionRequest,
	QuestionRequest,
} from "../../../src/lib/provider/types.js";

// ─── Mock dependencies ─────────────────────────────────────────────────────

function makeMockEventStore() {
	const appendedEvents: CanonicalEvent[] = [];
	return {
		append: vi.fn((event: CanonicalEvent) => {
			appendedEvents.push(event);
			return {
				...event,
				sequence: appendedEvents.length,
				streamVersion: 1,
			};
		}),
		appendedEvents,
	};
}

function makeMockProjectionRunner() {
	return {
		projectEvent: vi.fn(),
	};
}

function makeEvent(overrides?: Partial<CanonicalEvent>): CanonicalEvent {
	return {
		eventId: "evt-1",
		type: "text.delta",
		sessionId: "s1",
		createdAt: Date.now(),
		metadata: {},
		provider: "opencode",
		data: { messageId: "m1", partId: "p1", text: "hello" },
		...overrides,
	} as CanonicalEvent;
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
			await sink.push(event);

			expect(eventStore.append).toHaveBeenCalledWith(event);
			expect(projectionRunner.projectEvent).toHaveBeenCalledTimes(1);
		});

		it("projects the stored event (with sequence)", async () => {
			const event = makeEvent();
			await sink.push(event);

			const projected = projectionRunner.projectEvent.mock.calls[0]?.[0];
			expect(projected.sequence).toBe(1);
		});

		it("handles multiple sequential pushes", async () => {
			await sink.push(makeEvent({ eventId: "e1" }));
			await sink.push(makeEvent({ eventId: "e2" }));
			await sink.push(makeEvent({ eventId: "e3" }));

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
			const resultPromise = sink.requestPermission(request);

			// Verify the permission.asked event was pushed
			expect(eventStore.append).toHaveBeenCalledTimes(1);
			const pushed = eventStore.append.mock.calls[0]?.[0] as CanonicalEvent;
			expect(pushed.type).toBe("permission.asked");
			expect(pushed.data).toMatchObject({
				id: "perm-1",
				toolName: "bash",
			});

			// Resolve it
			sink.resolvePermission("perm-1", { decision: "once" });

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

			const resultPromise = sink.requestPermission(request);
			sink.resolvePermission("perm-2", { decision: "always" });

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

			const resultPromise = sink.requestPermission(request);
			sink.resolvePermission("perm-3", { decision: "reject" });

			const result = await resultPromise;
			expect(result.decision).toBe("reject");
		});

		it("handles multiple concurrent permission requests", async () => {
			const p1 = sink.requestPermission({
				requestId: "r1",
				toolName: "bash",
				toolInput: { patterns: [], metadata: {} },
				sessionId: "s1",
				turnId: "t1",
				providerItemId: "item-r1",
			});
			const p2 = sink.requestPermission({
				requestId: "r2",
				toolName: "write",
				toolInput: { patterns: [], metadata: {} },
				sessionId: "s1",
				turnId: "t1",
				providerItemId: "item-r2",
			});

			sink.resolvePermission("r2", { decision: "always" });
			sink.resolvePermission("r1", { decision: "once" });

			const [res1, res2] = await Promise.all([p1, p2]);
			expect(res1.decision).toBe("once");
			expect(res2.decision).toBe("always");
		});

		it("emits permission.resolved event on resolution", async () => {
			const resultPromise = sink.requestPermission({
				requestId: "perm-4",
				toolName: "bash",
				toolInput: { patterns: [], metadata: {} },
				sessionId: "s1",
				turnId: "t1",
				providerItemId: "item-4",
			});

			sink.resolvePermission("perm-4", { decision: "once" });
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

			const resultPromise = sink.requestQuestion(request);

			expect(eventStore.append).toHaveBeenCalledTimes(1);
			const pushed = eventStore.append.mock.calls[0]?.[0] as CanonicalEvent;
			expect(pushed.type).toBe("question.asked");

			sink.resolveQuestion("q1", { answer: "Yes" });

			const result = await resultPromise;
			expect(result).toEqual({ answer: "Yes" });
		});

		it("emits question.resolved event on resolution", async () => {
			const resultPromise = sink.requestQuestion({
				requestId: "q2",
				questions: [
					{
						question: "Pick one",
						header: "Choose",
						options: [{ label: "A", description: "Option A" }],
					},
				],
			});

			sink.resolveQuestion("q2", { choice: "A" });
			await resultPromise;

			expect(eventStore.append).toHaveBeenCalledTimes(2);
			const resolvedEvent = eventStore.append.mock
				.calls[1]?.[0] as CanonicalEvent;
			expect(resolvedEvent.type).toBe("question.resolved");
		});
	});

	describe("abort handling", () => {
		it("rejects pending permissions when aborted", async () => {
			const resultPromise = sink.requestPermission({
				requestId: "perm-abort",
				toolName: "bash",
				toolInput: { patterns: [], metadata: {} },
				sessionId: "s1",
				turnId: "t1",
				providerItemId: "item-abort",
			});

			sink.abort();

			await expect(resultPromise).rejects.toThrow("aborted");
		});

		it("rejects pending questions when aborted", async () => {
			const resultPromise = sink.requestQuestion({
				requestId: "q-abort",
				questions: [
					{
						question: "Continue?",
						header: "Test",
						options: [],
					},
				],
			});

			sink.abort();

			await expect(resultPromise).rejects.toThrow("aborted");
		});

		it("has no pending requests after abort", () => {
			sink
				.requestPermission({
					requestId: "perm-x",
					toolName: "bash",
					toolInput: { patterns: [], metadata: {} },
					sessionId: "s1",
					turnId: "t1",
					providerItemId: "item-x",
				})
				.catch(() => {}); // Swallow rejection

			sink.abort();

			expect(sink.pendingCount).toBe(0);
		});
	});
});
