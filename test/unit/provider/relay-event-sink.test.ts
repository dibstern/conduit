import { Effect, Fiber } from "effect";
import { SqlError, UnknownError } from "effect/sql/SqlError";
import { describe, expect, it, vi } from "vitest";
import type {
	ProviderRuntimeEventPayloadMap,
	ProviderRuntimeEventType,
} from "../../../src/lib/contracts/providers/provider-runtime-event.js";
import { PendingInteractionCancelled } from "../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import type { CanonicalEvent } from "../../../src/lib/persistence/events.js";
import type { MissingPendingInteractions } from "../../../src/lib/provider/errors.js";
import { createRelayEventSink } from "../../../src/lib/provider/relay-event-sink.js";

function makeEvent<T extends ProviderRuntimeEventType>(
	type: T,
	data: ProviderRuntimeEventPayloadMap[T],
	metadata: Record<string, unknown> = {},
) {
	return {
		eventId: `evt_${Math.random()}`,
		sessionId: "ses-1",
		type,
		data,
		metadata,
		providerId: "claude",
		providerRefs: {},
		rawSource: { kind: "test.provider-runtime" },
		createdAt: Date.now(),
	};
}

describe("createRelayEventSink — processing timeouts", () => {
	it("clears timeout on turn.completed", async () => {
		const clearTimeout = vi.fn();
		const sink = createRelayEventSink({
			sessionId: "ses-1",
			clearTimeout,
		});
		await Effect.runPromise(
			sink.push(
				makeEvent("turn.completed", {
					messageId: "msg_1",
					tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
					cost: 0.01,
					duration: 1234,
				}),
			),
		);
		expect(clearTimeout).toHaveBeenCalled();
	});

	it("clears timeout on turn.error", async () => {
		const clearTimeout = vi.fn();
		const sink = createRelayEventSink({
			sessionId: "ses-1",
			clearTimeout,
		});
		await Effect.runPromise(
			sink.push(
				makeEvent("turn.error", {
					messageId: "msg_1",
					error: "boom",
					code: "provider_error",
				}),
			),
		);
		expect(clearTimeout).toHaveBeenCalled();
	});

	// A retry is transient status on the shell row (C1), not a relay message;
	// it must still keep the turn alive while the SDK retries.
	it("keeps the turn alive while the SDK retries", async () => {
		const clearTimeout = vi.fn();
		const resetTimeout = vi.fn();
		const sink = createRelayEventSink({
			sessionId: "ses-1",
			clearTimeout,
			resetTimeout,
		});
		await Effect.runPromise(
			sink.push(
				makeEvent("session.status", {
					sessionId: "ses-1",
					status: "retry",
					message: "Retrying (attempt 3/10) · HTTP 502 · next in 2.2s",
				}),
			),
		);
		// A retry is NON-terminal — must NOT clear the processing timeout.
		expect(clearTimeout).not.toHaveBeenCalled();
		// It DOES reset the timeout (activity observed).
		expect(resetTimeout).toHaveBeenCalled();
	});

	// The orchestration reactor streams provider output straight to ingestion,
	// bypassing this sink's push(); noteActivity is how it keeps the relay's
	// processing timeout alive so long turns don't emit a false timeout error,
	// and ends it with the turn so a reconnecting client is not told the
	// finished turn is still processing.
	it("noteActivity resets the timeout mid-turn and clears it at turn end", () => {
		const resetTimeout = vi.fn();
		const clearTimeout = vi.fn();
		const sink = createRelayEventSink({
			sessionId: "ses-1",
			clearTimeout,
			resetTimeout,
		});
		sink.noteActivity?.(
			makeEvent("text.delta", { messageId: "msg_1", partId: "p", text: "a" }),
		);
		expect(resetTimeout).toHaveBeenCalledTimes(1);
		expect(clearTimeout).not.toHaveBeenCalled();
		sink.noteActivity?.(
			makeEvent("turn.completed", {
				messageId: "msg_1",
				tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
				cost: 0,
				duration: 1,
			}),
		);
		expect(clearTimeout).toHaveBeenCalledTimes(1);
		expect(resetTimeout).toHaveBeenCalledTimes(1);
	});

	it("does not clear timeout on idle/busy session.status", async () => {
		const clearTimeout = vi.fn();
		const sink = createRelayEventSink({
			sessionId: "ses-1",
			clearTimeout,
		});
		await Effect.runPromise(
			sink.push(
				makeEvent("session.status", { sessionId: "ses-1", status: "idle" }),
			),
		);
		await Effect.runPromise(
			sink.push(
				makeEvent("session.status", { sessionId: "ses-1", status: "busy" }),
			),
		);
		expect(clearTimeout).not.toHaveBeenCalled();
	});
});

describe("createRelayEventSink — persistence", () => {
	it("delegates provider output to ProviderRuntimeIngestion when provided", async () => {
		const persistEvent = vi.fn(() => Effect.void);
		const event = makeEvent("text.delta", {
			messageId: "msg_1",
			partId: "part_1",
			text: "Hello",
		});
		const ingestion = {
			ingest: vi.fn(() => Effect.succeed(1)),
		};
		const sink = createRelayEventSink({
			sessionId: "ses-1",
			persist: { persistEvent },
			ingestion,
		});

		await Effect.runPromise(sink.push(event));
		expect(ingestion.ingest).toHaveBeenCalledWith(event);
		expect(persistEvent).not.toHaveBeenCalled();
	});

	it("returns ProviderRuntimeIngestion failures in the Effect error channel", async () => {
		const event = makeEvent("text.delta", {
			messageId: "msg_1",
			partId: "part_1",
			text: "Hello",
		});
		const ingestionError = new SqlError({
			reason: new UnknownError({
				cause: "ingestion failed",
				message: "ingestion failed",
			}),
		});
		const sink = createRelayEventSink({
			sessionId: "ses-1",
			ingestion: {
				ingest: vi.fn(() => Effect.fail(ingestionError)),
			},
		});

		const result = await Effect.runPromise(Effect.result(sink.push(event)));

		expect(result._tag).toBe("Failure");
		if (result._tag === "Failure") {
			expect(result.failure).toBe(ingestionError);
		}
	});

	it("runs Effect persistence when persist deps are provided", async () => {
		const persistEvent = vi.fn(() => Effect.void);

		const sink = createRelayEventSink({
			sessionId: "ses-1",
			persist: { persistEvent },
		});

		const event = makeEvent("text.delta", {
			messageId: "msg_1",
			partId: "part_1",
			text: "Hello",
		});
		await Effect.runPromise(sink.push(event));

		expect(persistEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				eventId: event.eventId,
				type: event.type,
				sessionId: event.sessionId,
				provider: event.providerId,
				data: event.data,
				metadata: {},
			}),
		);
	});

	it("runs Effect-native persistence programs", async () => {
		const persisted: string[] = [];
		const sink = createRelayEventSink({
			sessionId: "ses-1",
			persist: {
				persistEvent: (event) =>
					Effect.sync(() => {
						persisted.push(event.type);
					}),
			},
		});

		await Effect.runPromise(
			sink.push(
				makeEvent("text.delta", {
					messageId: "msg_1",
					partId: "part_1",
					text: "Hello",
				}),
			),
		);

		expect(persisted).toEqual(["text.delta"]);
	});

	it("uses batch persistence for runtime events that map to multiple domain events", async () => {
		const persistEvent = vi.fn(() => Effect.void);
		const persistEvents = vi.fn(() => Effect.void);
		const sink = createRelayEventSink({
			sessionId: "ses-1",
			persist: { persistEvent, persistEvents },
		});

		await Effect.runPromise(
			sink.push(
				makeEvent("tool.completed", {
					messageId: "msg_1",
					partId: "tool_1",
					result: "ok",
					duration: 1,
				}),
			),
		);

		expect(persistEvent).not.toHaveBeenCalled();
		expect(persistEvents).toHaveBeenCalledWith([
			expect.objectContaining({ type: "tool.started" }),
			expect.objectContaining({ type: "tool.completed" }),
		]);
	});
});

describe("createRelayEventSink — permission/question", () => {
	it("rejects permission and question requests with a typed error when the pending interaction port is missing", async () => {
		const sink = createRelayEventSink({ sessionId: "ses-1" });

		const permissionResult = await Effect.runPromise(
			Effect.result(
				sink.requestPermission({
					requestId: "req_1",
					toolName: "Bash",
					toolInput: { command: "whoami" },
					sessionId: "ses-1",
					turnId: "turn_1",
					providerItemId: "toolu_1",
				}),
			),
		);
		expect(permissionResult).toMatchObject({
			_tag: "Failure",
			failure: {
				_tag: "MissingPendingInteractions",
				operation: "requestPermission",
				sessionId: "ses-1",
			} satisfies Partial<MissingPendingInteractions>,
		});

		const questionResult = await Effect.runPromise(
			Effect.result(
				sink.requestQuestion({
					requestId: "que_1",
					questions: [
						{
							question: "Continue?",
							header: "Confirm",
							options: [{ label: "Yes", description: "Continue" }],
						},
					],
				}),
			),
		);
		expect(questionResult).toMatchObject({
			_tag: "Failure",
			failure: {
				_tag: "MissingPendingInteractions",
				operation: "requestQuestion",
				sessionId: "ses-1",
			} satisfies Partial<MissingPendingInteractions>,
		});
	});

	it.each([
		"once",
		"reject",
	] as const)("tracks permission=%s and question replay state through the pending interaction port", async (decision) => {
		let resolvePermission:
			| ((response: { decision: "once" | "always" | "reject" }) => void)
			| undefined;
		let resolveQuestion:
			| ((answers: Record<string, unknown>) => void)
			| undefined;
		const pendingInteractions = {
			beginPermissionRequest: vi.fn((_entry: { requestId: string }) =>
				Effect.sync(() => {
					const promise = new Promise<{
						decision: "once" | "always" | "reject";
					}>((resolve) => {
						resolvePermission = resolve;
					});
					return {
						awaitResponse: Effect.promise(() => promise),
					};
				}),
			),
			resolvePermissionRequest: vi.fn((_requestId, response) =>
				Effect.sync(() => {
					resolvePermission?.(response);
					return true;
				}),
			),
			beginQuestionRequest: vi.fn((_entry: { requestId: string }) =>
				Effect.sync(() => {
					const promise = new Promise<Record<string, unknown>>((resolve) => {
						resolveQuestion = resolve;
					});
					return {
						awaitAnswers: Effect.promise(() => promise),
					};
				}),
			),
			resolveQuestionRequest: vi.fn((_requestId, answers) =>
				Effect.sync(() => {
					resolveQuestion?.(answers);
					return true;
				}),
			),
		};
		const sink = createRelayEventSink({
			sessionId: "ses-1",
			pendingInteractions,
		});

		const permission = Effect.runPromise(
			sink.requestPermission({
				requestId: "req_1",
				toolName: "Bash",
				toolInput: { command: "whoami" },
				sessionId: "ses-1",
				turnId: "turn_1",
				providerItemId: "toolu_1",
				always: ["Bash"],
			}),
		);
		const permissionId =
			pendingInteractions.beginPermissionRequest.mock.calls[0]?.[0].requestId;
		expect(permissionId).toBeTypeOf("string");
		expect(permissionId).not.toBe("req_1");
		expect(pendingInteractions.beginPermissionRequest).toHaveBeenCalledWith({
			requestId: permissionId,
			sessionId: "ses-1",
			toolName: "Bash",
			toolInput: { command: "whoami" },
			always: ["Bash"],
		});
		await Effect.runPromise(
			sink.resolvePermission(permissionId ?? "", { decision }),
		);
		await expect(permission).resolves.toEqual({ decision });
		expect(pendingInteractions.resolvePermissionRequest).toHaveBeenCalledWith(
			permissionId,
			{ decision },
		);

		const question = Effect.runPromise(
			sink.requestQuestion({
				requestId: "que_1",
				questions: [
					{
						question: "Continue?",
						header: "Confirm",
						options: [{ label: "Yes", description: "Continue" }],
						multiSelect: false,
						custom: true,
					},
				],
			}),
		);
		const questionId =
			pendingInteractions.beginQuestionRequest.mock.calls[0]?.[0].requestId;
		expect(questionId).toBeTypeOf("string");
		expect(questionId).not.toBe("que_1");
		expect(pendingInteractions.beginQuestionRequest).toHaveBeenCalledWith({
			requestId: questionId,
			sessionId: "ses-1",
			questions: [
				{
					question: "Continue?",
					header: "Confirm",
					options: [{ label: "Yes", description: "Continue" }],
					multiSelect: false,
				},
			],
		});
		await Effect.runPromise(
			sink.resolveQuestion(questionId ?? "", { "0": "Yes" }),
		);
		await expect(question).resolves.toEqual({ "0": "Yes" });
		expect(pendingInteractions.resolveQuestionRequest).toHaveBeenCalledWith(
			questionId,
			{ "0": "Yes" },
		);
	});

	it("clears the processing timeout while a question awaits the user", async () => {
		// The turn is blocked on the human, so the 2-minute no-activity timeout
		// must not be running: restarting it fires a bogus PROCESSING_TIMEOUT
		// while the question is still on screen.
		const clearTimeout = vi.fn();
		const resetTimeout = vi.fn();
		const pendingInteractions = {
			beginPermissionRequest: vi.fn(() =>
				Effect.sync(() => ({ awaitResponse: Effect.never })),
			),
			resolvePermissionRequest: vi.fn(() => Effect.succeed(true)),
			beginQuestionRequest: vi.fn(() =>
				Effect.sync(() => ({ awaitAnswers: Effect.never })),
			),
			resolveQuestionRequest: vi.fn(() => Effect.succeed(true)),
		};
		const sink = createRelayEventSink({
			sessionId: "ses-1",
			clearTimeout,
			resetTimeout,
			pendingInteractions,
		});

		const fiber = Effect.runFork(
			sink.requestQuestion({
				requestId: "que_1",
				questions: [
					{
						question: "Continue?",
						header: "Confirm",
						options: [{ label: "Yes", description: "Continue" }],
						multiSelect: false,
						custom: true,
					},
				],
			}),
		);
		await vi.waitFor(() =>
			expect(pendingInteractions.beginQuestionRequest).toHaveBeenCalled(),
		);

		expect(clearTimeout).toHaveBeenCalled();
		expect(resetTimeout).not.toHaveBeenCalled();

		await Effect.runPromise(Fiber.interrupt(fiber));
	});
});

describe("createRelayEventSink — permission delegation", () => {
	// Conduit passes the real permissionMode to the SDK, which resolves the
	// escalating modes (acceptEdits / bypassPermissions / auto / dontAsk) before
	// canUseTool is reached. So anything arriving here is a genuine ask, whatever
	// the session's mode -- conduit no longer re-decides it with a tool taxonomy
	// of its own, which is what used to make "acceptEdits" disagree with the SDK
	// about which tools count as edits.
	const request = {
		requestId: "req_auto",
		toolName: "Edit",
		toolInput: { file_path: "/tmp/example.ts" },
		sessionId: "ses-1",
		turnId: "turn_1",
		providerItemId: "toolu_1",
	};

	const makePendingInteractions = () => {
		const beginPermissionRequest = vi.fn(() =>
			Effect.succeed({
				awaitResponse: Effect.succeed({ decision: "once" as const }),
			}),
		);
		return {
			beginPermissionRequest,
			port: {
				beginPermissionRequest,
				resolvePermissionRequest: vi.fn(() => Effect.succeed(true)),
				beginQuestionRequest: vi.fn(() =>
					Effect.succeed({ awaitAnswers: Effect.succeed({}) }),
				),
				resolveQuestionRequest: vi.fn(() => Effect.succeed(true)),
			},
		};
	};

	// The sink takes no permission-mode input at all any more, so there is no
	// mode axis left to vary -- that absence IS the delegation. What remains is
	// the tool axis, which is where conduit's own taxonomy used to disagree with
	// the SDK's: "Edit"/"Write"/"NotebookEdit" were auto-approved under
	// acceptEdits and everything else was not.
	it.each([
		{ toolName: "Edit" },
		{ toolName: "Write" },
		{ toolName: "NotebookEdit" },
		{ toolName: "Bash" },
		{ toolName: "mcp__foo__bar" },
	])("surfaces the ask for tool=$toolName", async ({ toolName }) => {
		const { beginPermissionRequest, port } = makePendingInteractions();
		const sink = createRelayEventSink({
			sessionId: "ses-1",
			pendingInteractions: port,
		});

		await expect(
			Effect.runPromise(sink.requestPermission({ ...request, toolName })),
		).resolves.toEqual({ decision: "once" });

		expect(beginPermissionRequest).toHaveBeenCalledOnce();
	});

	// The ask and however it ends are canonical events, as for OpenCode: they
	// wake a snoozed session and clear its pending approval. Nothing more: the
	// SDK's own auto-allows never reach here, so none is fabricated.
	const recorded = async (
		ask: (
			sink: ReturnType<typeof createRelayEventSink>,
		) => Effect.Effect<unknown, unknown>,
		port: Parameters<typeof createRelayEventSink>[0]["pendingInteractions"],
	) => {
		const persistEvents = vi.fn(
			(_events: readonly CanonicalEvent[]) => Effect.void,
		);
		const sink = createRelayEventSink({
			sessionId: "ses-1",
			providerId: "claude",
			persist: { persistEvent: () => Effect.void, persistEvents },
			...(port ? { pendingInteractions: port } : {}),
		});
		await Effect.runPromise(Effect.exit(ask(sink)));
		return persistEvents.mock.calls
			.flatMap(([events]) => events)
			.map((event) => ({
				type: event.type,
				data: event.data as Record<string, unknown>,
			}));
	};

	it("records the ask and the answer", async () => {
		const { port } = makePendingInteractions();
		const events = await recorded(
			(sink) => sink.requestPermission(request),
			port,
		);
		const asked = events[0];
		expect(asked?.data["id"]).not.toBe("req_auto");
		expect(events).toEqual([
			{
				type: "permission.asked",
				data: {
					id: expect.any(String),
					providerRequestId: "req_auto",
					providerProcessId: expect.any(String),
					sessionId: "ses-1",
					toolName: "Edit",
					input: { file_path: "/tmp/example.ts" },
					always: [],
				},
			},
			{
				type: "permission.resolved",
				data: {
					id: asked?.data["id"],
					providerRequestId: "req_auto",
					providerProcessId: asked?.data["providerProcessId"],
					decision: "once",
				},
			},
		]);
	});

	it("records an ask that ends unanswered as rejected", async () => {
		const { port } = makePendingInteractions();
		const cancelled = {
			...port,
			beginPermissionRequest: () =>
				Effect.succeed({
					awaitResponse: Effect.fail(
						new PendingInteractionCancelled({
							requestId: "req_auto",
							sessionId: "ses-1",
							reason: "disposed",
						}),
					),
				}),
		};
		const events = await recorded(
			(sink) => sink.requestPermission(request),
			cancelled,
		);
		expect(events[0]?.data["id"]).not.toBe("req_auto");
		expect(events.at(-1)).toEqual({
			type: "permission.resolved",
			data: {
				id: events[0]?.data["id"],
				providerRequestId: "req_auto",
				providerProcessId: events[0]?.data["providerProcessId"],
				decision: "reject",
			},
		});
	});

	const question = {
		requestId: "toolu_q",
		toolUseId: "toolu_q",
		questions: [{ question: "Carry on?", header: "Carry on", options: [] }],
	};
	const cancelledQuestion = (recovered: boolean) => {
		const { port } = makePendingInteractions();
		return {
			...port,
			beginQuestionRequest: () =>
				Effect.succeed({
					awaitAnswers: Effect.fail(
						new PendingInteractionCancelled({
							requestId: "toolu_q",
							sessionId: "ses-1",
							reason: "disposed",
							...(recovered ? { recovered: true as const } : {}),
						}),
					),
				}),
		};
	};

	it("leaves a question kept for recovery pending", async () => {
		expect(
			(
				await recorded(
					(sink) => sink.requestQuestion(question),
					cancelledQuestion(true),
				)
			).map((event) => event.type),
		).toEqual(["question.asked"]);
	});

	it("records a question cancelled for good as resolved with no answers", async () => {
		const events = await recorded(
			(sink) => sink.requestQuestion(question),
			cancelledQuestion(false),
		);
		expect(events[0]?.data["id"]).not.toBe("toolu_q");
		expect(events.at(-1)).toEqual({
			type: "question.resolved",
			data: {
				id: events[0]?.data["id"],
				providerRequestId: "toolu_q",
				providerProcessId: events[0]?.data["providerProcessId"],
				answers: {},
			},
		});
	});
});
